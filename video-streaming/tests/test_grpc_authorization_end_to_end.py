"""End-to-end authorization contract through a real gRPC server.

The server runs the production ``Streaming`` servicer, the production bearer
interceptor and a SQLite-backed durable repository. Only Redis and object
storage are replaced, so the tests prove the authentication, principal
propagation and tenant-authorization chain agree on one observable response.
"""

import importlib.util
import tempfile
import threading
import unittest
from concurrent import futures
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

_REQUIRED_MODULES = ("grpc", "grpc_health", "sqlalchemy", "redis", "celery")
_HAS_RUNTIME = all(
    importlib.util.find_spec(module_name) is not None
    for module_name in _REQUIRED_MODULES
)

if _HAS_RUNTIME:
    import grpc
    from sqlalchemy import create_engine, event

    from video_streaming.grpc.authentication import (
        OIDCBearerInterceptor,
        get_request_principal,
    )
    from video_streaming.grpc.protos import streaming_pb2, streaming_pb2_grpc
    from video_streaming.grpc.servicers.streaming_servicer import Streaming
    from video_streaming.security import RequestPrincipal
    from video_streaming.workflows.repository import WorkflowRepository


ADAPTER_MODULE = "video_streaming.grpc.servicers.mixins.job_authorization"

# Expected public denial text; deliberately independent of the constants under
# test so a wording change is caught rather than silently mirrored.
DENIED_MESSAGE = "Resource not found or access denied"

ALL_SCOPES = frozenset([
    "video.jobs:create",
    "video.jobs:read",
    "video.jobs:cancel",
    "video.jobs:outputs:revoke",
    "video.playback:write",
    "video.qoe:read",
])

ISSUER = "https://issuer.example.test/"


def _principal(tenant, subject=None, scopes=None, expires_in=300):
    return RequestPrincipal(
        issuer=ISSUER,
        subject=subject or "subject-{}".format(tenant),
        tenant_id=tenant,
        scopes=frozenset(scopes if scopes is not None else ALL_SCOPES),
        roles=frozenset(),
        authentication_method="bearer",
        expires_at=datetime.now(timezone.utc) + timedelta(seconds=expires_in),
    )


class InMemoryCache:
    """Minimal RedisCache replacement recording every write."""

    def __init__(self):
        self.values = {}
        self.writes = []

    def get(self, key, decode=True):
        return self.values.get(key)

    def set(self, key, value, timeout=None):
        self.writes.append(key)
        self.values[key] = value

    def incr(self, key, amount=1):
        self.writes.append(key)
        return amount


class TokenAuthenticator:
    """Map opaque test tokens to principals; reject everything else."""

    def __init__(self, principals):
        self._principals = principals

    def authenticate(self, token):
        from video_streaming.security.oidc import AuthenticationError

        try:
            return self._principals[token]
        except KeyError:
            raise AuthenticationError("invalid")


@unittest.skipUnless(_HAS_RUNTIME, "gRPC and workflow runtime are required")
class GrpcAuthorizationEndToEndTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        # SQLite's in-memory engine gives each connection an empty database,
        # which breaks the server's worker threads. Use a file-backed temp DB.
        cls._temp_dir = tempfile.TemporaryDirectory()
        cls._db_path = Path(cls._temp_dir.name) / "authorization.sqlite3"
        cls.engine = create_engine(
            "sqlite:///{}".format(cls._db_path.as_posix()),
            connect_args={"check_same_thread": False},
            future=True,
        )

        @event.listens_for(cls.engine, "connect")
        def _enable_foreign_keys(connection, _record):
            connection.execute("PRAGMA foreign_keys=ON")

        cls.repository = WorkflowRepository(
            None, engine=cls.engine, create_schema=True
        )

        cls.tenant_a = _principal("tenant-a")
        cls.tenant_b = _principal("tenant-b")
        cls.scope_limited = _principal(
            "tenant-a", scopes=["video.jobs:create"]
        )
        cls.read_only = _principal(
            "tenant-a", scopes=["video.jobs:read"]
        )
        cls.expired = _principal("tenant-a", expires_in=-60)
        cls.tokens = {
            "token-a": cls.tenant_a,
            "token-b": cls.tenant_b,
            "token-no-scope": cls.scope_limited,
            "token-read-only": cls.read_only,
            "token-expired": cls.expired,
        }

        cls.job_a = cls._create_job(cls.tenant_a)
        cls.job_b = cls._create_job(cls.tenant_b)
        cls.job_legacy = cls._create_job(None)

        cls.cache = InMemoryCache()
        Streaming.cache = cls.cache
        cls.servicer = Streaming()

        from grpc_health.v1 import health, health_pb2_grpc
        cls.health_servicer = health.HealthServicer()

        cls.server = grpc.server(
            futures.ThreadPoolExecutor(max_workers=8),
            interceptors=(
                OIDCBearerInterceptor(TokenAuthenticator(cls.tokens)),
            ),
        )
        cls.servicer._add_to_server(cls.server)
        health_pb2_grpc.add_HealthServicer_to_server(
            cls.health_servicer, cls.server
        )
        cls.port = cls.server.add_insecure_port("127.0.0.1:0")
        cls.server.start()
        cls.channel = grpc.insecure_channel("127.0.0.1:{}".format(cls.port))
        cls.stub = streaming_pb2_grpc.StreamingStub(cls.channel)

    @classmethod
    def tearDownClass(cls):
        cls.channel.close()
        cls.server.stop(0)
        cls.repository.close()
        cls._temp_dir.cleanup()

    @classmethod
    def _create_job(cls, principal):
        job_id = str(uuid4())
        cls.repository.create_job(
            job_id=job_id,
            idempotency_key="idem-{}".format(job_id),
            request_hash="a" * 64,
            reference_id="ref-{}".format(job_id),
            stage_specs=[{
                "stage_key": "playlist-0",
                "operation": "video.package_and_publish",
            }],
            owner_principal=principal,
        )
        return job_id

    def metadata(self, token):
        return (("authorization", "Bearer {}".format(token)),)

    def get_results(self, tracking_ids, token="token-a"):
        return self.stub.get_results(
            streaming_pb2.JobsResultsRequest(tracking_ids=tracking_ids),
            metadata=self.metadata(token),
        )

    def assert_denied(self, callable_, *args, **kwargs):
        with self.assertRaises(grpc.RpcError) as caught:
            callable_(*args, **kwargs)
        self.assertEqual(caught.exception.code(), grpc.StatusCode.NOT_FOUND)
        self.assertEqual(caught.exception.details(), DENIED_MESSAGE)
        return caught.exception

    def setUp(self):
        type(self).cache = InMemoryCache()
        Streaming.cache = self.cache

    def _patch_repository(self):
        return patch(
            "{}.get_workflow_repository".format(ADAPTER_MODULE),
            return_value=self.repository,
        )

    # -- authentication ---------------------------------------------------

    def test_missing_duplicate_non_bearer_and_expired_are_unauthenticated(self):
        request = streaming_pb2.JobsResultsRequest(tracking_ids=[self.job_a])
        cases = {
            "missing": (),
            "duplicate": (
                ("authorization", "Bearer token-a"),
                ("authorization", "Bearer token-b"),
            ),
            "non-bearer": (("authorization", "Basic token-a"),),
            "expired": self.metadata("token-expired"),
            "unknown": self.metadata("token-unknown"),
        }
        for name, metadata in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(grpc.RpcError) as caught:
                    self.stub.get_results(request, metadata=metadata)
                self.assertEqual(
                    caught.exception.code(), grpc.StatusCode.UNAUTHENTICATED
                )
        # No rejection may have reached the business handler.
        self.assertEqual(self.cache.writes, [])

    def test_health_check_is_public_without_a_token(self):
        from grpc_health.v1 import health_pb2

        self.health_servicer.set(
            "", health_pb2.HealthCheckResponse.SERVING
        )
        response = self.channel.unary_unary(
            "/grpc.health.v1.Health/Check",
            request_serializer=health_pb2.HealthCheckRequest.SerializeToString,
            response_deserializer=health_pb2.HealthCheckResponse.FromString,
        )(health_pb2.HealthCheckRequest(), metadata=())
        self.assertEqual(
            response.status, health_pb2.HealthCheckResponse.SERVING
        )

    # -- authorization ----------------------------------------------------

    def test_same_tenant_with_scope_is_allowed(self):
        with self._patch_repository():
            response = self.get_results([self.job_a])
        self.assertEqual(list(response.results), [])
        self.assertIsNone(get_request_principal())

    def test_cross_tenant_owned_unowned_and_missing_share_one_denial(self):
        with self._patch_repository():
            # Same tenant token, foreign Job.
            self.assert_denied(self.get_results, [self.job_b])
            # Foreign tenant token over this tenant's Job.
            self.assert_denied(self.get_results, [self.job_a], token="token-b")
            # Legacy-unowned Job.
            self.assert_denied(self.get_results, [self.job_legacy])
            # Nonexistent Job must be indistinguishable from the above.
            self.assert_denied(self.get_results, [str(uuid4())])
        # Denials happen before any cache read/write side effect.
        self.assertEqual(self.cache.writes, [])

    def test_missing_scope_is_denied_without_side_effects(self):
        with self._patch_repository():
            self.assert_denied(
                self.get_results, [self.job_a], token="token-no-scope"
            )
        self.assertEqual(self.cache.writes, [])

    def test_create_job_requires_the_create_scope(self):
        request = streaming_pb2.JobRequest(
            reference_id="denied-create",
            webhook_url="https://callback.invalid/hook",
        )
        with self._patch_repository() as factory:
            self.assert_denied(
                self.stub.create_job,
                request,
                metadata=self.metadata("token-read-only"),
            )
        factory.assert_not_called()
        self.assertEqual(self.cache.writes, [])

    def test_batch_read_authorizes_every_id_before_reading(self):
        class ExplodingCache(InMemoryCache):
            def get(self, key, decode=True):
                raise AssertionError("cache read before full authorization")

        Streaming.cache = ExplodingCache()
        try:
            with self._patch_repository():
                self.assert_denied(
                    self.get_results, [self.job_a, self.job_b]
                )
        finally:
            Streaming.cache = self.cache

    def test_revoke_is_denied_before_cancellation_side_effects(self):
        request = streaming_pb2.RevokeJobsRequest(tracking_ids=[self.job_b])
        with self._patch_repository():
            self.assert_denied(
                self.stub.revoke_jobs, request, metadata=self.metadata("token-a")
            )
        self.assertEqual(self.cache.writes, [])

    def test_playback_session_start_is_denied_across_tenants(self):
        request = streaming_pb2.StartPlaybackSessionRequest(
            tracking_id=self.job_b, output_id="playlist-0"
        )
        with self._patch_repository():
            self.assert_denied(
                self.stub.start_playback_session,
                request,
                metadata=self.metadata("token-a"),
            )
        self.assertEqual(self.cache.writes, [])

    def test_qoe_report_is_denied_across_tenants(self):
        request = streaming_pb2.GetPlaybackQoEReportRequest(
            tracking_id=self.job_b, output_id="playlist-0"
        )
        with self._patch_repository():
            self.assert_denied(
                self.stub.get_playback_qoe_report,
                request,
                metadata=self.metadata("token-a"),
            )

    def test_owned_playback_qoe_read_is_allowed(self):
        from unittest.mock import MagicMock

        repository = MagicMock()
        repository.authorize_job_access.return_value = True
        repository.get_playback_qoe_report.return_value = {
            "job_id": self.job_a,
            "stage_key": "playlist-0",
            "stage_status": "FINISHED",
            "session_count": 0,
            "playback_started_count": 0,
            "average_startup_ms": None,
            "rebuffer_count": 0,
            "total_buffering_ms": 0,
            "decoder_error_count": 0,
            "buffering_ratio_percent": 0.0,
            "total_cpu_seconds": 0.0,
            "total_estimated_cost": 0.0,
            "partial_estimated_cost": 0.0,
            "cost_estimate_complete": True,
            "cost_currency": "RUNIT",
            "pricing_model_id": "relative-resource-index-v1",
            "priced_attempt_count": 0,
            "total_attempt_count": 0,
            "cost_coverage": {},
        }
        request = streaming_pb2.GetPlaybackQoEReportRequest(
            tracking_id=self.job_a, output_id="playlist-0"
        )
        with patch(
            "{}.get_workflow_repository".format(ADAPTER_MODULE),
            return_value=repository,
        ):
            response = self.stub.get_playback_qoe_report(
                request, metadata=self.metadata("token-a")
            )
        self.assertEqual(response.tracking_id, self.job_a)
        repository.authorize_job_access.assert_called_once_with(
            self.job_a, self.tenant_a, "video.qoe:read"
        )

    # -- concurrency ------------------------------------------------------

    def test_interleaved_tenants_never_observe_foreign_identity(self):
        outcomes = {}
        barrier = threading.Barrier(6)

        def call(name, job_id, token, expect_denied):
            barrier.wait()
            try:
                self.get_results([job_id], token=token)
                outcomes[name] = "allowed"
            except grpc.RpcError as error:
                outcomes[name] = error.code()

        cases = {
            "a-own-1": (self.job_a, "token-a", False),
            "a-own-2": (self.job_a, "token-a", False),
            "b-own": (self.job_b, "token-b", False),
            "a-on-b": (self.job_b, "token-a", True),
            "b-on-a": (self.job_a, "token-b", True),
            "a-on-legacy": (self.job_legacy, "token-a", True),
        }
        # Patch once for the whole fan-out: concurrent patch enter/exit would
        # race on restoring the module attribute.
        with self._patch_repository():
            threads = [
                threading.Thread(target=call, args=(name,) + values)
                for name, values in cases.items()
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=20)

        for name, (_, _, expect_denied) in cases.items():
            with self.subTest(case=name):
                if expect_denied:
                    self.assertEqual(
                        outcomes[name], grpc.StatusCode.NOT_FOUND
                    )
                else:
                    self.assertEqual(outcomes[name], "allowed")


if __name__ == "__main__":
    unittest.main()
