import json
from celery.result import AsyncResult
from video_streaming.celery import celery_app
from video_streaming.cache import RedisCache
from video_streaming.core.constants import CacheKeysTemplates
from video_streaming.grpc.protos import streaming_pb2
from video_streaming.security import AuthorizationError, \
    authorize_tenant_resource
from video_streaming.workflows.service import get_workflow_repository


class RevokeJobsMixin(object):
    """Force-stop jobs for authenticated, tenant-authorized callers.

    The trusted authentication boundary (server interceptor) must attach
    the verified ``RequestPrincipal`` to the servicer context as the
    ``principal`` attribute before this handler runs. Requests without a
    verified principal, with an expired credential, without the required
    scope, or targeting a job owned by another tenant (or by no tenant)
    all receive the same REQUEST_NOT_FOUND result, so this RPC never
    reveals whether a tracking_id exists.
    """

    # scope required to force-stop a job
    REVOKE_REQUIRED_SCOPE = "video.jobs:cancel"

    cache: RedisCache
    pb2: streaming_pb2

    @staticmethod
    def _request_principal(context):
        """Return the verified principal attached by the authenticator."""
        return getattr(context, "principal", None)

    def _job_owner_tenant_id(self, request_id):
        """Owning tenant of the durable job; None when unknown/unowned."""
        repository = get_workflow_repository(required=False)
        if repository is None:
            # Durable ownership records are the source of truth for tenant
            # authorization; without them no job can be proven to belong
            # to the caller's tenant, so fail closed.
            return None
        return repository.get_job_owner_tenant_id(request_id)

    def _request_not_found_details(self, request_id: str):
        revoke_details = dict(
            tracking_id=request_id,
            has_been_sent=self.pb2.RevokeSignalStatus.REQUEST_NOT_FOUND
        )
        return self.pb2.RevokeDetails(**revoke_details)

    def _revoke_job(self,
                    request_id: str,
                    principal=None
                    ) -> None or streaming_pb2.RevokeDetails:

        # Authenticate the principal (live credential, required scope) and
        # authorize it against the job's owning tenant using the shared
        # security primitives. Any failure is reported exactly like an
        # unknown tracking id to avoid leaking job existence.
        try:
            authorize_tenant_resource(
                principal,
                self._job_owner_tenant_id(request_id),
                self.REVOKE_REQUIRED_SCOPE)
        except AuthorizationError:
            return self._request_not_found_details(request_id)

        job_details: dict = self.cache.get(
            CacheKeysTemplates.JOB_DETAILS.format(
                request_id=request_id))
        if not job_details:
            return self._request_not_found_details(request_id)

        reference_id: str = job_details['reference_id']

        # Atomic claim: exactly one concurrent caller writes the stop
        # marker and triggers the Celery revoke; every other caller only
        # observes the already-sent state.
        signal_claimed: bool = self.cache.set_if_not_exists(
            CacheKeysTemplates.FORCE_STOP_REQUEST.format(
                request_id=request_id),
            json.dumps(True))
        if signal_claimed:
            # celery result id
            result_id: str = self.cache.get(
                CacheKeysTemplates.REQUEST_RESULT_ID.format(
                    request_id=request_id), decode=False)
            if result_id:
                async_result = AsyncResult(result_id, app=celery_app)
                if async_result and not async_result.ready():
                    async_result.revoke()

        revoke_details = dict(
            tracking_id=request_id,
            reference_id=reference_id,
            has_been_sent=self.pb2.RevokeSignalStatus.REVOKE_SIGNAL_SENT
        )
        return self.pb2.RevokeDetails(**revoke_details)

    def _revoke_jobs(self, request, context):
        principal = self._request_principal(context)
        results: list[streaming_pb2.RevokeDetails] = []
        for request_id in request.tracking_ids:
            result = self._revoke_job(request_id, principal=principal)
            if result:
                results.append(result)
        response = self.pb2.RevokeJobsResponse(results=results)
        return response
