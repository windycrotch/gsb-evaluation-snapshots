"""Contract tests for the gRPC Job/playback authorization adapter.

These tests drive the adapter through the real authentication interceptor so
that principal propagation, token expiry and the denial contract are exercised
together rather than in isolation.
"""

import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import grpc

from video_streaming.grpc import exceptions
from video_streaming.grpc.authentication import OIDCBearerInterceptor
from video_streaming.grpc.servicers.mixins import job_authorization
from video_streaming.grpc.servicers.mixins.job_authorization import (
    require_job_access,
    require_playback_session_access,
)
from video_streaming.security import (
    RESOURCE_DENIED_MESSAGE,
    AuthorizationError,
    RequestPrincipal,
)

ADAPTER_MODULE = "video_streaming.grpc.servicers.mixins.job_authorization"


class AbortCall(Exception):
    pass


class RecordingContext:
    def __init__(self):
        self.code = None
        self.details = None

    def set_code(self, code):
        self.code = code

    def set_details(self, details):
        self.details = details

    def abort(self, code, details):
        self.code = code
        self.details = details
        raise AbortCall()


class StaticAuthenticator:
    def __init__(self, principal):
        self.principal = principal

    def authenticate(self, token):
        from video_streaming.security.oidc import AuthenticationError

        if token != "valid-token":
            raise AuthenticationError("invalid")
        return self.principal


class RecordingRepository:
    def __init__(self, error=None):
        self.error = error
        self.job_calls = []
        self.playback_calls = []

    def authorize_job_access(self, job_id, principal, required_scope):
        self.job_calls.append((job_id, principal, required_scope))
        if self.error is not None:
            raise self.error
        return True

    def authorize_playback_session_access(
            self, session_id, principal, required_scope):
        self.playback_calls.append((session_id, principal, required_scope))
        if self.error is not None:
            raise self.error
        return True


def make_principal(**overrides):
    values = {
        "issuer": "https://issuer.example.test/",
        "subject": "subject-a",
        "tenant_id": "tenant-a",
        "scopes": frozenset(["video.jobs:read", "video.playback:write"]),
        "roles": frozenset(),
        "authentication_method": "bearer",
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=5),
    }
    values.update(overrides)
    return RequestPrincipal(**values)


class AuthorizationAdapterTests(unittest.TestCase):
    """Invoke the adapter as a real authenticated unary handler."""

    def run_handler(self, handler, principal):
        wrapped = OIDCBearerInterceptor(
            StaticAuthenticator(principal)
        ).intercept_service(
            lambda _: grpc.unary_unary_rpc_method_handler(handler),
            SimpleNamespace(
                method="/video.Streaming/GetResults",
                invocation_metadata=(("authorization", "Bearer valid-token"),),
            ),
        )
        return wrapped.unary_unary("request", RecordingContext())

    def invoke_job(self, principal, repository, scope="video.jobs:read"):
        captured = {}

        def handler(request, context):
            captured["repository"] = require_job_access(
                "job-1", scope, context
            )
            return "ok"

        with patch(
            "{}.get_workflow_repository".format(ADAPTER_MODULE),
            return_value=repository,
        ) as factory:
            try:
                result = self.run_handler(handler, principal)
                captured["result"] = result
            except exceptions.ResourceNotFoundOrDeniedException as error:
                captured["error"] = error
            captured["factory"] = factory
        return captured

    def test_same_tenant_with_scope_is_allowed(self):
        repository = RecordingRepository()
        principal = make_principal()
        captured = self.invoke_job(principal, repository)

        self.assertEqual(captured["result"], "ok")
        self.assertIs(captured["repository"], repository)
        self.assertEqual(
            repository.job_calls,
            [("job-1", principal, "video.jobs:read")],
        )

    def test_missing_scope_denies_before_any_repository_access(self):
        repository = RecordingRepository()
        principal = make_principal(scopes=["video.jobs:create"])
        captured = self.invoke_job(principal, repository)

        self.assertIsInstance(
            captured["error"], exceptions.ResourceNotFoundOrDeniedException
        )
        captured["factory"].assert_not_called()
        self.assertEqual(repository.job_calls, [])

    def test_token_expiring_mid_request_is_denied_at_authorization(self):
        # The token is still valid when the interceptor admits the call. The
        # clock then advances past its expiry before the adapter authorizes.
        repository = RecordingRepository()
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=2)
        principal = make_principal(expires_at=expires_at)

        class AdvancedClock(datetime):
            @classmethod
            def now(cls, tz=None):
                return expires_at + timedelta(seconds=1)

        def handler(request, context):
            with patch(
                "video_streaming.security.principal.datetime", AdvancedClock
            ):
                require_job_access("job-1", "video.jobs:read", context)
            return "must not run"

        with patch(
            "{}.get_workflow_repository".format(ADAPTER_MODULE),
            return_value=repository,
        ) as factory:
            with self.assertRaises(
                    exceptions.ResourceNotFoundOrDeniedException):
                self.run_handler(handler, principal)

        factory.assert_not_called()
        self.assertEqual(repository.job_calls, [])

    def test_unauthenticated_principal_denies_before_repository_access(self):
        repository = RecordingRepository()
        self.assertIsNone(job_authorization.get_request_principal())

        # Call the adapter directly, as a misconfigured server without the
        # authentication interceptor would.
        context = RecordingContext()
        with patch(
            "{}.get_workflow_repository".format(ADAPTER_MODULE),
            return_value=repository,
        ) as factory:
            with self.assertRaises(
                    exceptions.ResourceNotFoundOrDeniedException):
                require_job_access("job-1", "video.jobs:read", context)
        factory.assert_not_called()
        self.assertEqual(repository.job_calls, [])
        self.assertEqual(context.code, grpc.StatusCode.NOT_FOUND)

    def test_repository_denial_maps_to_non_enumerating_response(self):
        repository = RecordingRepository(
            error=AuthorizationError(RESOURCE_DENIED_MESSAGE)
        )
        captured = self.invoke_job(make_principal(), repository)

        self.assertIsInstance(
            captured["error"], exceptions.ResourceNotFoundOrDeniedException
        )

    def test_missing_unowned_and_cross_tenant_share_one_response(self):
        responses = []
        for scenario in ("missing", "unowned", "cross-tenant"):
            # The repository reports every non-authorized resource with the
            # same AuthorizationError; the adapter must not embellish it.
            repository = RecordingRepository(
                error=AuthorizationError(RESOURCE_DENIED_MESSAGE)
            )
            context = RecordingContext()
            with self.subTest(scenario=scenario):
                with patch(
                    "{}.get_workflow_repository".format(ADAPTER_MODULE),
                    return_value=repository,
                ):
                    with self.assertRaises(
                            exceptions.ResourceNotFoundOrDeniedException
                    ) as caught:
                        self.run_handler(
                            lambda request, ctx: require_job_access(
                                "job-1", "video.jobs:read", ctx
                            ),
                            make_principal(),
                        )
                error = caught.exception
                responses.append((error.status_code, error.message))
        self.assertEqual(len(set(responses)), 1)
        self.assertEqual(
            responses[0],
            (grpc.StatusCode.NOT_FOUND, RESOURCE_DENIED_MESSAGE),
        )

    def test_playback_adapter_authorizes_session_ownership(self):
        repository = RecordingRepository()
        principal = make_principal()

        def handler(request, context):
            require_playback_session_access(
                "session-1", "video.playback:write", context
            )
            return "ok"

        with patch(
            "{}.get_workflow_repository".format(ADAPTER_MODULE),
            return_value=repository,
        ):
            self.assertEqual(self.run_handler(handler, principal), "ok")

        self.assertEqual(
            repository.playback_calls,
            [("session-1", principal, "video.playback:write")],
        )

    def test_playback_denial_is_not_found(self):
        repository = RecordingRepository(
            error=AuthorizationError(RESOURCE_DENIED_MESSAGE)
        )
        context = RecordingContext()

        def handler(request, ctx):
            require_playback_session_access(
                "session-1", "video.playback:write", ctx
            )

        with patch(
            "{}.get_workflow_repository".format(ADAPTER_MODULE),
            return_value=repository,
        ):
            with self.assertRaises(
                    exceptions.ResourceNotFoundOrDeniedException) as caught:
                self.run_handler(handler, make_principal())

        self.assertEqual(caught.exception.status_code, grpc.StatusCode.NOT_FOUND)
        self.assertEqual(caught.exception.message, RESOURCE_DENIED_MESSAGE)


class AuthorizationDenialContractTests(unittest.TestCase):
    """The denial exception must not leak resource existence or type."""

    def test_exception_exposes_one_message_and_status(self):
        exception = exceptions.ResourceNotFoundOrDeniedException()
        self.assertEqual(exception.status_code, grpc.StatusCode.NOT_FOUND)
        self.assertEqual(exception.message, RESOURCE_DENIED_MESSAGE)

    def test_security_and_transport_messages_match(self):
        from video_streaming.security.authorization import _DENIED_MESSAGE

        self.assertEqual(_DENIED_MESSAGE, RESOURCE_DENIED_MESSAGE)
        self.assertEqual(
            exceptions.ResourceNotFoundOrDeniedException.message,
            RESOURCE_DENIED_MESSAGE,
        )


if __name__ == "__main__":
    unittest.main()
