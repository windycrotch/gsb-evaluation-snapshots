import logging
import traceback
from video_streaming.cache import RedisCache
from video_streaming.core.constants import ErrorMessages
from video_streaming.grpc import exceptions
from video_streaming.grpc.protos import streaming_pb2_grpc, \
    streaming_pb2
from .mixins import (
    CreateJobMixin,
    GetResultsMixin,
    PlaybackQoEMixin,
    RevokeJobsMixin,
    RevokeOutputsMixin,
)


logger = logging.getLogger(__name__)


class Streaming(
        RevokeOutputsMixin,
        RevokeJobsMixin,
        GetResultsMixin,
        CreateJobMixin,
        PlaybackQoEMixin,
        streaming_pb2_grpc.StreamingServicer):

    cache = RedisCache()
    pb2 = streaming_pb2

    def _add_to_server(self, server):
        streaming_pb2_grpc.add_StreamingServicer_to_server(
            self,
            server)

    @staticmethod
    def _exception_handler(exc: Exception, context=None):
        if isinstance(exc, exceptions.ResourceNotFoundOrDeniedException):
            # Terminate with the single non-enumerating denial instead of an
            # INTERNAL error or an exception log line.
            if context is not None:
                context.abort(exc.status_code, exc.message)
            raise exc
        if isinstance(exc, exceptions.GrpcBaseException):
            raise exc
        # context.abort() raises a bare Exception after setting the status.
        # Preserve that application status and stay quiet instead of
        # reporting an INTERNAL failure and logging a spurious stack trace.
        if context is not None:
            code = getattr(context, "code", None)
            if callable(code) and code() is not None:
                raise exc
        # Request and exception values may contain secrets or signed URLs.
        # Keep stack context without interpolating untrusted values.
        logger.error(
            "Unhandled gRPC service failure",
            extra={
                "error_type": type(exc).__name__,
                "traceback": traceback.format_tb(exc.__traceback__),
            },
        )
        raise exceptions.GrpcBaseException(
            ErrorMessages.INTERNAL_ERROR)

    def create_job(self, request, context):
        # The request can contain private storage and callback information.
        try:
            return self._create_job(request, context)
        except Exception as exc:
            self._exception_handler(exc, context)

    def get_results(self, request, context):
        """get results for a list of jobs"""
        try:
            return self._get_results(request, context)
        except Exception as exc:
            self._exception_handler(exc, context)

    def revoke_jobs(self, request, context):
        """force stop a list of jobs
        to kill job outputs processes and delete all local files
        """
        try:
            return self._revoke_jobs(request, context)
        except Exception as exc:
            self._exception_handler(exc, context)

    def revoke_job_outputs(self, request, context):
        """force stop a list of outputs for one job"""
        try:
            return self._revoke_job_outputs(request, context)
        except Exception as exc:
            self._exception_handler(exc, context)

    def start_playback_session(self, request, context):
        """start a playback session for a finished output"""
        try:
            return self._start_playback_session(request, context)
        except Exception as exc:
            self._exception_handler(exc, context)

    def record_playback_event(self, request, context):
        """record one idempotent playback QoE event"""
        try:
            return self._record_playback_event(request, context)
        except Exception as exc:
            self._exception_handler(exc, context)

    def get_playback_qoe_report(self, request, context):
        """return the aggregated QoE report for one output"""
        try:
            return self._get_playback_qoe_report(request, context)
        except Exception as exc:
            self._exception_handler(exc, context)
