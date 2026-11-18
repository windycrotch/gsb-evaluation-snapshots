import os
from celery import states, Task
from video_streaming.core.constants.cache_keys import CacheKeysTemplates
from video_streaming.core.output_state import OutputLifecycleCoordinator
from video_streaming.ffmpeg.tasks.base import BaseStreamingTask


class BaseOutputMixin(object):
    delete_inputs: bool
    delete_outputs: bool

    error_messages: BaseStreamingTask.error_messages
    primary_status: BaseStreamingTask.primary_status
    output_status: BaseStreamingTask.output_status
    cache: BaseStreamingTask.cache
    logger: BaseStreamingTask.logger

    incr: BaseStreamingTask.incr
    save_primary_status: BaseStreamingTask.save_primary_status
    inputs_remover: BaseStreamingTask.inputs_remover
    outputs_remover: BaseStreamingTask.outputs_remover
    get_outputs_root_directory: BaseStreamingTask.\
        get_outputs_root_directory

    request: Task.request

    def _output_lifecycle(self) -> OutputLifecycleCoordinator:
        """Build the state aggregator bound to this task instance.

        The coordinator is task-independent, so the same rules run offline in
        tests with an in-memory cache stand-in.  A fresh coordinator is built
        per call: Celery task instances are shared between requests, and the
        "already removed" markers live in the cache so idempotency still
        holds across workers and retries.
        """
        return OutputLifecycleCoordinator(
            cache=self.cache,
            delete_inputs=self.delete_inputs,
            delete_outputs=self.delete_outputs,
            remove_inputs=self.inputs_remover,
            remove_outputs=self.outputs_remover,
            save_primary_status=self.save_primary_status,
            logger=self.logger,
        )

    def save_failed(self, request_id, output_id):
        """
        please rewrite this method to add stop_reason
        """
        self.save_output_status(
            self.output_status.OUTPUT_FAILED,
            output_id,
            request_id
        )

    def on_failure(self, *request_args, **request_kwargs):
        request_id = request_kwargs.get('request_id', None)
        output_id = request_kwargs.get('output_id', None)
        if request_id is not None and output_id is not None:
            self.save_failed(
                request_id,
                output_id
            )
        return super().on_failure(*request_args, **request_kwargs)

    def raise_ignore(self,
                     message=None,
                     state=states.FAILURE,
                     request_kwargs: dict = None):
        if request_kwargs:
            request_id = request_kwargs.get('request_id', None)
            output_id = request_kwargs.get('output_id', None)
            if request_id is not None and output_id is not None:
                if state == states.FAILURE:
                    self.save_failed(
                        request_id,
                        output_id
                    )
                elif state == states.REVOKED:
                    # Revoking one output only settles that output.  The job
                    # becomes REVOKED only when every output is revoked,
                    # which the aggregator decides from the output statuses.
                    self.save_output_status(
                        self.output_status.OUTPUT_REVOKED,
                        output_id,
                        request_id
                    )
        super().raise_ignore(
            message=message,
            state=state,
            request_kwargs=request_kwargs)

    def save_output_status(self, status_name, output_id, request_id):
        """Save the status of one output and aggregate the job state.

        Aggregation only acts on terminal output statuses:

        * the local inputs are removed once every output is terminal;
        * the local outputs are removed and the job status is finalized
          (FINISHED / FAILED / REVOKED) once every output is settled;
        * a terminal job status is written once and never overwritten.
        """
        update = self._output_lifecycle().save_output_status(
            status_name=status_name,
            output_id=output_id,
            request_id=request_id)
        return update

    def can_set_output_status(self,
                              output_id,
                              request_id) -> None or bool:
        """to check output current status of job is not a terminal one

        A settled status (uploaded, failed or revoked) is final and must not
        be overwritten by a late or repeated status update.
        """
        if request_id is None:
            return None
        if output_id is None:
            return None
        return self._output_lifecycle().can_set_output_status(
            output_id, request_id)

    def check_to_delete_inputs(self, request_id):
        """Delete the local inputs once every output reached a terminal state.

        Terminal means processing finished, uploading finished, failed or
        revoked.  A partially processed job keeps its inputs: another output
        may still need them.
        """
        return self._output_lifecycle().check_to_delete_inputs(request_id)

    def check_all_outputs_are_finished(self, request_id):
        """Finalize the job once all outputs are settled.

        1. check all outputs are settled (uploaded, failed or revoked)
        2. set primary status to 'FINISHED' or 'REVOKED' or 'FAILED'
        3. remove local outputs files if delete_outputs flag is True
        """
        return self._output_lifecycle().check_all_outputs_are_finished(
            request_id)

    def is_output_forced_to_stop(
            self,
            request_id,
            output_id) -> None or bool:
        force_stop = self.cache.get(
            CacheKeysTemplates.FORCE_STOP_OUTPUT_REQUEST.format(
                request_id=request_id,
                output_id=output_id))
        return force_stop

    def raise_revoke_output(
            self,
            request_id,
            output_id):
        raise self.raise_ignore(
            message=self.error_messages.TASK_WAS_FORCIBLY_STOPPED,
            state=states.REVOKED,
            request_kwargs=self.request.kwargs)

    def ensure_set_output_location(self,
                                   request_id: str,
                                   output_id: str,
                                   output_path: str = None,
                                   s3_output_key: str = None
                                   ) -> tuple[str, str]:
        """ensure set directory and output_path

           1. check requirement : output_path or s3_output_key
           2. using output_path to set directory
           3. when output_path is None, using s3_output_key
             to set directory and output_path

            returns a tuple of output_path and directory
        """

        # using self.output_path to set self.directory
        if output_path:
            directory = output_path.rpartition('/')[0]
            return output_path, directory

        # when self.output_path is None, using self.s3_output_key
        #  to set self.directory and output_path

        # s3_output_key : "/foo/bar/example.mpd"
        output_filename = s3_output_key.rpartition('/')[-1]

        directory = os.path.join(
            self.get_outputs_root_directory(request_id),
            str(output_id))

        output_path = os.path.join(directory, output_filename)
        return output_path, directory
