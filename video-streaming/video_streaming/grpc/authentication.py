"""gRPC bearer authentication interceptor and request principal scope.

Every non-health RPC is authenticated before its business handler runs. The
verified principal is exposed through :func:`get_request_principal` for the
lifetime of the call and removed afterwards, including when a streaming
response is cancelled or raises.

Identity is tracked as a per-context stack rather than a single mutable slot
so that:

* several RPCs interleaved on one thread each see their own principal;
* a streaming RPC can be advanced after another stream yielded, and its own
  handler still observes the correct identity;
* cleanup only removes the entry owned by the finishing invocation, so a
  nested or resumed invocation never clears somebody else's identity.
"""
import contextvars

import grpc

from video_streaming.security import RequestPrincipal
from video_streaming.security.oidc import AuthenticationError


# Entries are (identity, principal). The identity object is never serialized
# or exposed; it only lets one invocation remove exactly its own entry.
_request_principals = contextvars.ContextVar(
    "video_request_principals", default=()
)


def get_request_principal():
    """Return the principal for the currently executing RPC, if authenticated."""
    stack = _request_principals.get()
    return stack[-1][1] if stack else None


def _enter(principal):
    entry = object()
    stack = _request_principals.get()
    _request_principals.set(stack + ((entry, principal),))
    return entry


def _focus(entry, principal):
    """Make ``entry`` the innermost active identity without dropping others."""
    remaining = tuple(
        item for item in _request_principals.get() if item[0] is not entry
    )
    _request_principals.set(remaining + ((entry, principal),))


def _leave(entry):
    _request_principals.set(tuple(
        item for item in _request_principals.get() if item[0] is not entry
    ))


def _invoke_unary(principal, callback, request_or_iterator, context):
    entry = _enter(principal)
    try:
        return callback(request_or_iterator, context)
    finally:
        _leave(entry)


class _PrincipalStream:
    """Iterator wrapper that scopes one streaming RPC's identity.

    gRPC may stop consuming a response iterator without calling ``close()``
    (for example when the client cancels or the deadline expires). Tracking
    the identity through an explicit iterator object means the reference
    count dropping at the end of the RPC also clears the principal, so no
    identity can outlive the call.
    """

    __slots__ = ("_principal", "_entry", "_iterator", "_finished")

    def __init__(self, principal, callback, requests, context):
        self._principal = principal
        self._iterator = None
        self._finished = False
        self._entry = _enter(principal)
        try:
            _focus(self._entry, principal)
            self._iterator = callback(requests, context)
        except BaseException:
            self._cleanup()
            raise

    def __iter__(self):
        return self

    def __next__(self):
        if self._finished:
            raise StopIteration
        _focus(self._entry, self._principal)
        try:
            return next(self._iterator)
        except StopIteration:
            self._cleanup()
            raise
        except BaseException:
            self._cleanup()
            raise

    def close(self):
        self._cleanup()

    def __del__(self):
        self._cleanup()

    def _cleanup(self):
        if self._finished:
            return
        self._finished = True
        close = getattr(getattr(self, "_iterator", None), "close", None)
        if close is not None:
            try:
                close()
            except Exception:  # pragma: no cover - cleanup must not mask
                pass
        try:
            _leave(self._entry)
        except Exception:  # pragma: no cover - interpreter shutdown
            pass


class OIDCBearerInterceptor(grpc.ServerInterceptor):
    """Authenticate every RPC except the explicitly public health service."""

    _PUBLIC_METHODS = frozenset((
        "/grpc.health.v1.Health/Check",
        "/grpc.health.v1.Health/Watch",
    ))

    def __init__(self, authenticator):
        if authenticator is None or not callable(
                getattr(authenticator, "authenticate", None)):
            raise ValueError("A configured authenticator is required")
        self._authenticator = authenticator

    def intercept_service(self, continuation, handler_call_details):
        handler = continuation(handler_call_details)
        if handler is None:
            return None
        if handler_call_details.method in self._PUBLIC_METHODS:
            return handler

        try:
            principal = self._authenticator.authenticate(
                self._authorization_from_details(handler_call_details)
            )
            if not isinstance(principal, RequestPrincipal) or principal.is_expired():
                raise AuthenticationError("Invalid access token")
        except Exception:
            # Any verifier or metadata failure must fail closed and must not
            # reach the business handler.
            return self._unauthenticated_handler(handler)

        if handler.unary_unary:
            callback = handler.unary_unary
            return grpc.unary_unary_rpc_method_handler(
                lambda request, context: _invoke_unary(
                    principal, callback, request, context),
                request_deserializer=handler.request_deserializer,
                response_serializer=handler.response_serializer,
            )
        if handler.unary_stream:
            callback = handler.unary_stream
            return grpc.unary_stream_rpc_method_handler(
                lambda request, context: _PrincipalStream(
                    principal, callback, request, context),
                request_deserializer=handler.request_deserializer,
                response_serializer=handler.response_serializer,
            )
        if handler.stream_unary:
            callback = handler.stream_unary
            return grpc.stream_unary_rpc_method_handler(
                lambda requests, context: _invoke_unary(
                    principal, callback, requests, context),
                request_deserializer=handler.request_deserializer,
                response_serializer=handler.response_serializer,
            )
        if handler.stream_stream:
            callback = handler.stream_stream
            return grpc.stream_stream_rpc_method_handler(
                lambda requests, context: _PrincipalStream(
                    principal, callback, requests, context),
                request_deserializer=handler.request_deserializer,
                response_serializer=handler.response_serializer,
            )
        return handler

    @staticmethod
    def _authorization_from_details(details):
        # gRPC metadata entries expose key/value attributes. Accept tuple pairs
        # as well to keep the parsing contract straightforward in unit tests.
        values = details.invocation_metadata or ()
        matches = []
        for item in values:
            if hasattr(item, "key") and hasattr(item, "value"):
                key, value = item.key, item.value
            else:
                try:
                    key, value = item
                except (TypeError, ValueError):
                    raise AuthenticationError("Invalid access token")
            if isinstance(key, str) and key.lower() == "authorization":
                matches.append(value)
        if len(matches) != 1:
            raise AuthenticationError("Invalid access token")
        value = matches[0]
        if not isinstance(value, str):
            raise AuthenticationError("Invalid access token")
        scheme, separator, token = value.partition(" ")
        if not separator or scheme.lower() != "bearer":
            raise AuthenticationError("Invalid access token")
        token = token.strip()
        if not token or any(character.isspace() for character in token):
            raise AuthenticationError("Invalid access token")
        return token

    @staticmethod
    def _unauthenticated_handler(handler):
        def abort(request_or_iterator, context):
            context.abort(grpc.StatusCode.UNAUTHENTICATED, "Unauthenticated")

        if handler.unary_unary:
            return grpc.unary_unary_rpc_method_handler(
                abort, request_deserializer=handler.request_deserializer,
                response_serializer=handler.response_serializer)
        if handler.unary_stream:
            return grpc.unary_stream_rpc_method_handler(
                abort, request_deserializer=handler.request_deserializer,
                response_serializer=handler.response_serializer)
        if handler.stream_unary:
            return grpc.stream_unary_rpc_method_handler(
                abort, request_deserializer=handler.request_deserializer,
                response_serializer=handler.response_serializer)
        if handler.stream_stream:
            return grpc.stream_stream_rpc_method_handler(
                abort, request_deserializer=handler.request_deserializer,
                response_serializer=handler.response_serializer)
        return handler
