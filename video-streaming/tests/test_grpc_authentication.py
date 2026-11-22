"""Tests for gRPC bearer authentication and request-scoped identity."""
import gc
import importlib.util
import threading
import unittest
from concurrent import futures
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import grpc

from video_streaming.grpc.authentication import (
    OIDCBearerInterceptor,
    get_request_principal,
)
from video_streaming.security import RequestPrincipal


class AbortCall(Exception):
    def __init__(self, code, details):
        self.code = code
        self.details = details


class FakeContext:
    def abort(self, code, details):
        raise AbortCall(code, details)


class FakeAuthenticator:
    def __init__(self, principal=None, error=False):
        self.principal = principal
        self.error = error

    def authenticate(self, token):
        if self.error or token != "valid-token":
            from video_streaming.security.oidc import AuthenticationError
            raise AuthenticationError("invalid")
        return self.principal


def make_principal(tenant="tenant-1", subject="subject-1", scopes=(), **kwargs):
    values = {
        "issuer": "https://issuer.example.test/",
        "subject": subject,
        "tenant_id": tenant,
        "scopes": frozenset(scopes or ("video.jobs:create",)),
        "roles": frozenset(),
        "authentication_method": "bearer",
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=5),
    }
    values.update(kwargs)
    return RequestPrincipal(**values)


class GrpcAuthenticationInterceptorTests(unittest.TestCase):
    def setUp(self):
        self.principal = make_principal()

    def handler(self, callback):
        return grpc.unary_unary_rpc_method_handler(callback)

    def details(self, metadata=(), method="/video.Streaming/CreateJob"):
        return SimpleNamespace(
            method=method,
            invocation_metadata=metadata,
        )

    def test_valid_token_attaches_principal_only_during_handler(self):
        seen = []
        handler = self.handler(
            lambda request, context: seen.append(get_request_principal()) or "ok"
        )
        interceptor = OIDCBearerInterceptor(FakeAuthenticator(self.principal))
        wrapped = interceptor.intercept_service(
            lambda _: handler,
            self.details((("authorization", "Bearer valid-token"),)),
        )

        self.assertEqual(wrapped.unary_unary("request", FakeContext()), "ok")
        self.assertEqual(seen, [self.principal])
        self.assertIsNone(get_request_principal())

    def test_missing_or_invalid_bearer_is_unauthenticated(self):
        handler = self.handler(lambda request, context: "must not run")
        interceptor = OIDCBearerInterceptor(FakeAuthenticator(self.principal))
        wrapped = interceptor.intercept_service(lambda _: handler, self.details())

        with self.assertRaises(AbortCall) as caught:
            wrapped.unary_unary("request", FakeContext())
        self.assertEqual(caught.exception.code, grpc.StatusCode.UNAUTHENTICATED)

    def test_rejected_credentials_never_reach_the_handler(self):
        invoked = []
        interceptor = OIDCBearerInterceptor(FakeAuthenticator(self.principal))
        cases = {
            "missing": (),
            "duplicate": (
                ("authorization", "Bearer valid-token"),
                ("authorization", "Bearer valid-token"),
            ),
            "non-bearer": (("authorization", "Basic valid-token"),),
            "empty-token": (("authorization", "Bearer "),),
            "internal-space": (
                ("authorization", "Bearer valid token"),
            ),
        }
        for name, metadata in cases.items():
            with self.subTest(case=name):
                wrapped = interceptor.intercept_service(
                    lambda _, metadata=metadata: self.handler(
                        lambda request, context: invoked.append(True) or "x"
                    ),
                    self.details(metadata),
                )
                with self.assertRaises(AbortCall) as caught:
                    wrapped.unary_unary("request", FakeContext())
                self.assertEqual(
                    caught.exception.code, grpc.StatusCode.UNAUTHENTICATED
                )
        self.assertEqual(invoked, [])

    def test_adaptive_metadata_objects_are_supported(self):
        handler = self.handler(
            lambda request, context: get_request_principal().tenant_id
        )
        interceptor = OIDCBearerInterceptor(FakeAuthenticator(self.principal))
        wrapped = interceptor.intercept_service(
            lambda _: handler,
            self.details((SimpleNamespace(
                key="authorization", value="Bearer valid-token"),)),
        )
        self.assertEqual(wrapped.unary_unary("request", FakeContext()), "tenant-1")

    def test_health_check_is_explicitly_public(self):
        handler = self.handler(lambda request, context: "healthy")
        interceptor = OIDCBearerInterceptor(FakeAuthenticator(error=True))
        wrapped = interceptor.intercept_service(
            lambda _: handler,
            self.details(method="/grpc.health.v1.Health/Check"),
        )
        self.assertIs(wrapped, handler)
        self.assertEqual(wrapped.unary_unary("request", FakeContext()), "healthy")

    def test_health_watch_is_explicitly_public(self):
        handler = self.handler(lambda request, context: "healthy")
        interceptor = OIDCBearerInterceptor(FakeAuthenticator(error=True))
        wrapped = interceptor.intercept_service(
            lambda _: handler,
            self.details(method="/grpc.health.v1.Health/Watch"),
        )
        self.assertIs(wrapped, handler)

    def test_unary_stream_keeps_principal_during_iteration(self):
        def service(request, context):
            yield get_request_principal().tenant_id
            yield get_request_principal().subject

        handler = grpc.unary_stream_rpc_method_handler(service)
        interceptor = OIDCBearerInterceptor(FakeAuthenticator(self.principal))
        wrapped = interceptor.intercept_service(
            lambda _: handler,
            self.details((("authorization", "Bearer valid-token"),)),
        )
        self.assertEqual(
            list(wrapped.unary_stream("request", FakeContext())),
            ["tenant-1", "subject-1"],
        )
        self.assertIsNone(get_request_principal())

    def test_interrupted_stream_clears_principal(self):
        def service(request, context):
            yield get_request_principal().tenant_id
            yield get_request_principal().tenant_id

        handler = grpc.unary_stream_rpc_method_handler(service)
        interceptor = OIDCBearerInterceptor(FakeAuthenticator(self.principal))
        wrapped = interceptor.intercept_service(
            lambda _: handler,
            self.details((("authorization", "Bearer valid-token"),)),
        )
        iterator = wrapped.unary_stream("request", FakeContext())
        self.assertEqual(next(iterator), "tenant-1")
        self.assertEqual(get_request_principal(), self.principal)
        # gRPC stops consuming when the client cancels; closing must clean up.
        iterator.close()
        self.assertIsNone(get_request_principal())

    def test_abandoned_stream_clears_principal_when_discarded(self):
        def service(request, context):
            yield get_request_principal().tenant_id
            yield get_request_principal().tenant_id

        handler = grpc.unary_stream_rpc_method_handler(service)
        interceptor = OIDCBearerInterceptor(FakeAuthenticator(self.principal))
        wrapped = interceptor.intercept_service(
            lambda _: handler,
            self.details((("authorization", "Bearer valid-token"),)),
        )
        iterator = wrapped.unary_stream("request", FakeContext())
        self.assertEqual(next(iterator), "tenant-1")
        self.assertEqual(get_request_principal(), self.principal)
        # A cancelled RPC may drop the iterator without gRPC closing it.
        del iterator
        gc.collect()
        self.assertIsNone(get_request_principal())

    def test_stream_that_raises_clears_principal(self):
        def service(request, context):
            yield get_request_principal().tenant_id
            raise RuntimeError("downstream failure")

        handler = grpc.unary_stream_rpc_method_handler(service)
        interceptor = OIDCBearerInterceptor(FakeAuthenticator(self.principal))
        wrapped = interceptor.intercept_service(
            lambda _: handler,
            self.details((("authorization", "Bearer valid-token"),)),
        )
        iterator = wrapped.unary_stream("request", FakeContext())
        self.assertEqual(next(iterator), "tenant-1")
        with self.assertRaises(RuntimeError):
            next(iterator)
        self.assertIsNone(get_request_principal())

    def test_handler_exception_clears_principal(self):
        def service(request, context):
            self.assertEqual(get_request_principal(), self.principal)
            raise RuntimeError("handler failure")

        handler = grpc.unary_unary_rpc_method_handler(service)
        interceptor = OIDCBearerInterceptor(FakeAuthenticator(self.principal))
        wrapped = interceptor.intercept_service(
            lambda _: handler,
            self.details((("authorization", "Bearer valid-token"),)),
        )
        with self.assertRaises(RuntimeError):
            wrapped.unary_unary("request", FakeContext())
        self.assertIsNone(get_request_principal())

    def test_interleaved_streams_do_not_cross_identities(self):
        principal_a = make_principal(tenant="tenant-a", subject="subject-a")
        principal_b = make_principal(tenant="tenant-b", subject="subject-b")

        def service(request, context):
            for index in range(3):
                yield (get_request_principal().tenant_id, request, index)

        handler = grpc.unary_stream_rpc_method_handler(service)
        interceptor = OIDCBearerInterceptor(FakeAuthenticator(principal_a))
        stream_a = interceptor.intercept_service(
            lambda _: handler,
            self.details((("authorization", "Bearer valid-token"),)),
        ).unary_stream("request", FakeContext())

        interceptor_b = OIDCBearerInterceptor(FakeAuthenticator(principal_b))
        stream_b = interceptor_b.intercept_service(
            lambda _: handler,
            self.details((("authorization", "Bearer valid-token"),)),
        ).unary_stream("request", FakeContext())

        self.assertEqual(next(stream_a), ("tenant-a", "request", 0))
        self.assertEqual(next(stream_b), ("tenant-b", "request", 0))
        self.assertEqual(next(stream_a), ("tenant-a", "request", 1))
        self.assertEqual(next(stream_b), ("tenant-b", "request", 1))
        self.assertEqual(next(stream_a), ("tenant-a", "request", 2))
        self.assertEqual(next(stream_b), ("tenant-b", "request", 2))
        with self.assertRaises(StopIteration):
            next(stream_a)
        with self.assertRaises(StopIteration):
            next(stream_b)
        self.assertIsNone(get_request_principal())

    def test_closing_one_stream_keeps_the_other_identity(self):
        principal_a = make_principal(tenant="tenant-a", subject="subject-a")
        principal_b = make_principal(tenant="tenant-b", subject="subject-b")

        def service(request, context):
            for index in range(3):
                yield get_request_principal().tenant_id

        handler = grpc.unary_stream_rpc_method_handler(service)
        stream_a = OIDCBearerInterceptor(
            FakeAuthenticator(principal_a)
        ).intercept_service(
            lambda _: handler,
            self.details((("authorization", "Bearer valid-token"),)),
        ).unary_stream("request", FakeContext())
        stream_b = OIDCBearerInterceptor(
            FakeAuthenticator(principal_b)
        ).intercept_service(
            lambda _: handler,
            self.details((("authorization", "Bearer valid-token"),)),
        ).unary_stream("request", FakeContext())

        self.assertEqual(next(stream_a), "tenant-a")
        self.assertEqual(next(stream_b), "tenant-b")
        stream_b.close()
        # B's identity is gone, but A's in-flight call is still active, so A
        # must remain current rather than being cleared along with B.
        self.assertEqual(get_request_principal(), principal_a)
        self.assertEqual(next(stream_a), "tenant-a")
        self.assertEqual(get_request_principal(), principal_a)
        stream_a.close()
        self.assertIsNone(get_request_principal())

    def test_concurrent_threads_do_not_share_identity(self):
        barrier = threading.Barrier(4)
        observed = {}

        def run(name, principal):
            barrier.wait()
            def service(request, context):
                barrier.wait()
                observed[name] = get_request_principal()
                return name
            handler = grpc.unary_unary_rpc_method_handler(service)
            interceptor = OIDCBearerInterceptor(FakeAuthenticator(principal))
            wrapped = interceptor.intercept_service(
                lambda _: handler,
                self.details((("authorization", "Bearer valid-token"),)),
            )
            wrapped.unary_unary("request", FakeContext())

        principals = [
            make_principal(tenant="tenant-{}".format(index))
            for index in range(4)
        ]
        threads = [
            threading.Thread(target=run, args=(index, principal))
            for index, principal in enumerate(principals)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertEqual(len(observed), 4)
        for index, principal in enumerate(principals):
            self.assertIs(observed[index], principal)
        self.assertIsNone(get_request_principal())

    def test_stream_unary_receives_principal(self):
        def service(requests, context):
            return get_request_principal().tenant_id, list(requests)

        handler = grpc.stream_unary_rpc_method_handler(service)
        interceptor = OIDCBearerInterceptor(FakeAuthenticator(self.principal))
        wrapped = interceptor.intercept_service(
            lambda _: handler,
            self.details((("authorization", "Bearer valid-token"),)),
        )
        self.assertEqual(
            wrapped.stream_unary(iter((1, 2)), FakeContext()),
            ("tenant-1", [1, 2]),
        )
        self.assertIsNone(get_request_principal())

    def test_stream_stream_keeps_principal_during_iteration(self):
        def service(requests, context):
            for request in requests:
                yield get_request_principal().tenant_id, request

        handler = grpc.stream_stream_rpc_method_handler(service)
        interceptor = OIDCBearerInterceptor(FakeAuthenticator(self.principal))
        wrapped = interceptor.intercept_service(
            lambda _: handler,
            self.details((("authorization", "Bearer valid-token"),)),
        )
        self.assertEqual(
            list(wrapped.stream_stream(iter(("a", "b")), FakeContext())),
            [("tenant-1", "a"), ("tenant-1", "b")],
        )
        self.assertIsNone(get_request_principal())

    def test_authenticator_must_return_a_live_request_principal(self):
        expired = make_principal(
            expires_at=datetime.now(timezone.utc) - timedelta(minutes=1),
        )
        for principal in (object(), expired):
            handler = self.handler(lambda request, context: "must not run")
            interceptor = OIDCBearerInterceptor(FakeAuthenticator(principal))
            wrapped = interceptor.intercept_service(
                lambda _: handler,
                self.details((("authorization", "Bearer valid-token"),)),
            )
            with self.assertRaises(AbortCall) as caught:
                wrapped.unary_unary("request", FakeContext())
            self.assertEqual(caught.exception.code, grpc.StatusCode.UNAUTHENTICATED)

    def test_unauthorized_streaming_handler_is_not_invoked(self):
        invoked = []

        def service(request, context):
            invoked.append(True)
            yield "response"

        handler = grpc.unary_stream_rpc_method_handler(service)
        interceptor = OIDCBearerInterceptor(FakeAuthenticator(error=True))
        wrapped = interceptor.intercept_service(lambda _: handler, self.details())
        with self.assertRaises(AbortCall) as caught:
            list(wrapped.unary_stream("request", FakeContext()))
        self.assertEqual(caught.exception.code, grpc.StatusCode.UNAUTHENTICATED)
        self.assertEqual(invoked, [])


_HAS_GRPC_RUNTIME = importlib.util.find_spec("grpc") is not None


@unittest.skipUnless(_HAS_GRPC_RUNTIME, "grpcio is required")
class GrpcServerInterceptorIntegrationTests(unittest.TestCase):
    """Exercise the interceptor through a real in-process gRPC server."""

    @classmethod
    def setUpClass(cls):
        cls.principal = make_principal(tenant="tenant-a", subject="subject-a")
        cls.calls = []

        def echo(request, context):
            cls.calls.append(request)
            return get_request_principal().tenant_id.encode("utf-8")

        def stream(request, context):
            cls.calls.append(request)
            for index in range(3):
                yield "{}:{}".format(
                    get_request_principal().tenant_id, index
                ).encode("utf-8")

        def health_check(request, context):
            return b"serving"

        service = grpc.method_handlers_generic_handler(
            "video.Test",
            {
                "Echo": grpc.unary_unary_rpc_method_handler(
                    echo,
                    request_deserializer=lambda value: value.decode("utf-8"),
                    response_serializer=lambda value: value,
                ),
                "Stream": grpc.unary_stream_rpc_method_handler(
                    stream,
                    request_deserializer=lambda value: value.decode("utf-8"),
                    response_serializer=lambda value: value,
                ),
            },
        )
        health = grpc.method_handlers_generic_handler(
            "grpc.health.v1.Health",
            {
                "Check": grpc.unary_unary_rpc_method_handler(
                    health_check,
                    request_deserializer=lambda value: value.decode("utf-8"),
                    response_serializer=lambda value: value,
                ),
            },
        )

        cls.server = grpc.server(
            futures.ThreadPoolExecutor(max_workers=4),
            interceptors=(OIDCBearerInterceptor(
                FakeAuthenticator(cls.principal)),),
        )
        cls.server.add_generic_rpc_handlers((service, health))
        cls.port = cls.server.add_insecure_port("127.0.0.1:0")
        cls.server.start()
        cls.channel = grpc.insecure_channel("127.0.0.1:{}".format(cls.port))

    @classmethod
    def tearDownClass(cls):
        cls.channel.close()
        cls.server.stop(0)

    def setUp(self):
        type(self).calls = []

    def echo(self, metadata=None):
        return self.channel.unary_unary(
            "/video.Test/Echo",
            request_serializer=lambda value: value.encode("utf-8"),
            response_deserializer=lambda value: value.decode("utf-8"),
        )("ping", metadata=metadata)

    def test_authenticated_call_reaches_handler(self):
        self.assertEqual(
            self.echo((("authorization", "Bearer valid-token"),)),
            "tenant-a",
        )
        self.assertEqual(self.calls, ["ping"])
        self.assertIsNone(get_request_principal())

    def test_duplicate_authorization_metadata_is_rejected(self):
        with self.assertRaises(grpc.RpcError) as caught:
            self.echo((
                ("authorization", "Bearer valid-token"),
                ("authorization", "Bearer valid-token"),
            ))
        self.assertEqual(caught.exception.code(), grpc.StatusCode.UNAUTHENTICATED)
        self.assertEqual(self.calls, [])

    def test_missing_metadata_is_rejected_and_handler_not_called(self):
        with self.assertRaises(grpc.RpcError) as caught:
            self.echo()
        self.assertEqual(caught.exception.code(), grpc.StatusCode.UNAUTHENTICATED)
        self.assertEqual(self.calls, [])

    def test_health_check_is_public_over_the_wire(self):
        response = self.channel.unary_unary(
            "/grpc.health.v1.Health/Check",
            request_serializer=lambda value: value.encode("utf-8"),
            response_deserializer=lambda value: value.decode("utf-8"),
        )("", metadata=())
        self.assertEqual(response, "serving")

    def test_streaming_rpc_exposes_identity_then_clears_it(self):
        stream = self.channel.unary_stream(
            "/video.Test/Stream",
            request_serializer=lambda value: value.encode("utf-8"),
            response_deserializer=lambda value: value.decode("utf-8"),
        )
        responses = list(stream(
            "request", metadata=(("authorization", "Bearer valid-token"),)
        ))
        self.assertEqual(
            responses, ["tenant-a:0", "tenant-a:1", "tenant-a:2"]
        )
        self.assertIsNone(get_request_principal())


if __name__ == "__main__":
    unittest.main()
