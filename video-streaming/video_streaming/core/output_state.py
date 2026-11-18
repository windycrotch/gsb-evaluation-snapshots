"""Aggregation of per-output terminal states into job-level state.

The VOD workflow derives several outputs from one input.  Each output is
processed and uploaded by its own Celery chain and writes its status to the
cache.  This module owns the rules that turn those per-output statuses into:

* whether the shared local input directory may be deleted;
* whether the shared local output directory may be deleted;
* the final job ("primary") status.

Terminology used here:

* *terminal* output status: processing finished, uploading finished, failed or
  revoked.  From that point on the output no longer reads the shared inputs.
* *settled* output status: uploading finished, failed or revoked.  The output
  will not change state anymore, so the local output files can be removed and
  the job can be completed.

A processed output that is still uploading is therefore terminal for input
cleanup but not settled for job completion.

The aggregation reads the per-job counters that are incremented exactly once
per output.  Counting is deduplicated per output so a retried terminal status
cannot inflate a counter and end the job early.

This module deliberately depends only on the cache-key/status constants and on
a small duck-typed cache interface (``get``/``set``/``incr``/``delete``).  It
must not import Celery, S3, FFmpeg or application settings so that it can be
unit tested offline with an in-memory cache stand-in.
"""

import json
from dataclasses import dataclass
from typing import Callable, Optional, Sequence

from .constants.cache_keys import CacheKeysTemplates
from .constants.status import OutputStatus, PrimaryStatus


__all__ = [
    'TERMINAL_OUTPUT_STATUSES',
    'SETTLED_OUTPUT_STATUSES',
    'LOCKED_OUTPUT_STATUSES',
    'TERMINAL_PRIMARY_STATUSES',
    'OUTCOME_COUNTERS',
    'OutputSummary',
    'StatusUpdate',
    'OutputStateAggregator',
    'OutputLifecycleCoordinator',
    'can_set_primary_status',
    'is_terminal_output_status',
    'is_settled_output_status',
]


# An output has reached a state in which the shared inputs are not needed
# anymore.  PROCESSING_FINISHED is terminal for input cleanup but not settled
# for job completion, because the output still has to be uploaded.
TERMINAL_OUTPUT_STATUSES = frozenset({
    OutputStatus.PROCESSING_FINISHED,
    OutputStatus.UPLOADING_FINISHED,
    OutputStatus.OUTPUT_FAILED,
    OutputStatus.OUTPUT_REVOKED,
})

# An output will not change state anymore, so the local output files can be
# removed and the job can be completed.
SETTLED_OUTPUT_STATUSES = frozenset({
    OutputStatus.UPLOADING_FINISHED,
    OutputStatus.OUTPUT_FAILED,
    OutputStatus.OUTPUT_REVOKED,
})

# Statuses that must never be overwritten by a later update.  A status that
# precedes uploading may still move to PROCESSING_FINISHED and then to a
# settled status; once settled, the output is final.
LOCKED_OUTPUT_STATUSES = SETTLED_OUTPUT_STATUSES

# Job ("primary") statuses that are final and must never be overwritten.
TERMINAL_PRIMARY_STATUSES = frozenset({
    PrimaryStatus.FINISHED,
    PrimaryStatus.FAILED,
    PrimaryStatus.REVOKED,
})

# Output status -> counter key template recording how many outputs reached it.
# These counters are also exposed through the results API.
OUTCOME_COUNTERS = {
    OutputStatus.OUTPUT_REVOKED: 'REVOKED_OUTPUTS',
    OutputStatus.PROCESSING_FINISHED: 'PROCESSED_OUTPUTS',
    OutputStatus.UPLOADING_FINISHED: 'READY_OUTPUTS',
    OutputStatus.OUTPUT_FAILED: 'FAILED_OUTPUTS',
}

# Output ids are deduplicated when a job lists them in several buckets.
OUTPUT_ID_LIST_KEYS = (
    'no_watermarked_playlists_ids',
    'watermarked_playlists_ids',
    'no_watermarked_thumbnails_ids',
    'watermarked_thumbnails_ids',
    'watermarked_outputs_ids',
)


def is_terminal_output_status(status_name: Optional[str]) -> bool:
    return status_name in TERMINAL_OUTPUT_STATUSES


def is_settled_output_status(status_name: Optional[str]) -> bool:
    return status_name in SETTLED_OUTPUT_STATUSES


def can_set_primary_status(current_status: Optional[str]) -> bool:
    """Return whether the primary status may still change.

    Once a job reaches FINISHED, FAILED or REVOKED the decision is final.  A
    lagging or retried task must not move the job back to a processing status.
    """
    return current_status not in TERMINAL_PRIMARY_STATUSES


@dataclass(frozen=True)
class OutputSummary:
    """Snapshot of the aggregated state of every output of a job."""

    total_outputs: int
    terminal_outputs: int
    ready_outputs: int
    revoked_outputs: int
    failed_outputs: int

    @property
    def settled_outputs(self) -> int:
        return self.ready_outputs + self.revoked_outputs + self.failed_outputs

    @property
    def all_terminal(self) -> bool:
        """Every output reached a terminal state; inputs can be removed."""
        return self.total_outputs > 0 and \
            self.terminal_outputs >= self.total_outputs

    @property
    def all_settled(self) -> bool:
        """Every output reached a settled state; the job is over."""
        return self.total_outputs > 0 and \
            self.settled_outputs >= self.total_outputs

    @property
    def all_failed(self) -> bool:
        return self.total_outputs > 0 and \
            self.failed_outputs >= self.total_outputs

    @property
    def all_revoked(self) -> bool:
        return self.total_outputs > 0 and \
            self.revoked_outputs >= self.total_outputs

    @property
    def final_primary_status(self) -> Optional[str]:
        """Return the final job status, or None while the job is running."""
        if not self.all_settled:
            return None
        if self.all_failed:
            return PrimaryStatus.FAILED
        if self.all_revoked:
            return PrimaryStatus.REVOKED
        return PrimaryStatus.FINISHED


@dataclass(frozen=True)
class StatusUpdate:
    """Outcome of applying one output status update."""

    applied: bool
    is_terminal: bool
    outcome_counted: bool
    can_delete_inputs: bool
    can_delete_outputs: bool
    final_primary_status: Optional[str]
    summary: Optional[OutputSummary]


class OutputStateAggregator:
    """Reads and writes per-output state and aggregates it per job."""

    def __init__(self, cache):
        self.cache = cache
        self.cache_keys = CacheKeysTemplates

    # ------------------------------------------------------------------
    # cache helpers
    # ------------------------------------------------------------------
    def job_details(self, request_id: str) -> Optional[dict]:
        if request_id is None:
            return None
        return self.cache.get(
            self.cache_keys.JOB_DETAILS.format(request_id=request_id))

    def get_output_status(
            self,
            request_id: str,
            output_id: str) -> Optional[str]:
        if request_id is None or output_id is None:
            return None
        return self.cache.get(
            self.cache_keys.OUTPUT_STATUS.format(
                request_id=request_id,
                output_id=output_id),
            decode=False)

    def _counter(self, counter_name: str, request_id: str) -> int:
        value = self.cache.get(
            getattr(self.cache_keys, counter_name).format(
                request_id=request_id))
        try:
            return int(value or 0)
        except (TypeError, ValueError):
            return 0

    def can_set_output_status(
            self,
            request_id: str,
            output_id: str) -> Optional[bool]:
        """An output status may change until it reaches a locked status."""
        if request_id is None or output_id is None:
            return None
        return self.get_output_status(
            request_id, output_id) not in LOCKED_OUTPUT_STATUSES

    def current_primary_status(self, request_id: str) -> Optional[str]:
        if request_id is None:
            return None
        return self.cache.get(
            self.cache_keys.PRIMARY_STATUS.format(request_id=request_id),
            decode=False)

    def can_set_primary_status(self, request_id: str) -> Optional[bool]:
        if request_id is None:
            return None
        return can_set_primary_status(self.current_primary_status(request_id))

    # ------------------------------------------------------------------
    # aggregation
    # ------------------------------------------------------------------
    def summary(self, request_id: str) -> Optional[OutputSummary]:
        job_details = self.job_details(request_id)
        if not job_details:
            return None
        return OutputSummary(
            total_outputs=self.total_outputs(job_details),
            terminal_outputs=self._counter('TERMINAL_OUTPUTS', request_id),
            ready_outputs=self._counter('READY_OUTPUTS', request_id),
            revoked_outputs=self._counter('REVOKED_OUTPUTS', request_id),
            failed_outputs=self._counter('FAILED_OUTPUTS', request_id),
        )

    @staticmethod
    def total_outputs(job_details: Optional[dict]) -> int:
        if not job_details:
            return 0
        total = job_details.get('total_outputs')
        if total is not None:
            try:
                return int(total)
            except (TypeError, ValueError):
                return 0
        return len(OutputStateAggregator.output_ids(job_details))

    @staticmethod
    def output_ids(job_details: Optional[dict]) -> Sequence[str]:
        """Return the distinct output ids listed by a job, in order.

        The same id can appear in more than one list (the watermarked video id
        is also part of ``watermarked_outputs_ids``), so ids are de-duplicated.
        """
        if not job_details:
            return ()
        output_ids = []
        seen = set()
        for key in OUTPUT_ID_LIST_KEYS:
            for output_id in job_details.get(key) or ():
                if output_id in seen:
                    continue
                seen.add(output_id)
                output_ids.append(output_id)
        return output_ids

    def apply_output_status(
            self,
            request_id: str,
            output_id: str,
            status_name: str) -> StatusUpdate:
        """Persist an output status and aggregate the resulting job state.

        The status is not written when the output already reached a locked
        (settled) status, so a late update cannot reopen a finished output.
        The progress key of an output is removed on every terminal status,
        even when the status itself could not be written.
        """
        terminal = is_terminal_output_status(status_name)
        not_applied = StatusUpdate(
            applied=False,
            is_terminal=terminal,
            outcome_counted=False,
            can_delete_inputs=False,
            can_delete_outputs=False,
            final_primary_status=None,
            summary=None,
        )

        if request_id is None or output_id is None:
            return not_applied

        if terminal:
            # The progress of a terminal output is no longer reported.
            self.cache.delete(
                self.cache_keys.OUTPUT_PROGRESS.format(
                    request_id=request_id,
                    output_id=output_id))

        if not self.job_details(request_id):
            return not_applied

        if not self.can_set_output_status(request_id, output_id):
            return not_applied

        self.cache.set(
            self.cache_keys.OUTPUT_STATUS.format(
                request_id=request_id,
                output_id=output_id),
            status_name,
        )
        counted = self._count_outcome(
            request_id, output_id, status_name) if terminal else False

        summary = self.summary(request_id)
        return StatusUpdate(
            applied=True,
            is_terminal=terminal,
            outcome_counted=counted,
            can_delete_inputs=bool(summary and summary.all_terminal),
            can_delete_outputs=bool(summary and summary.all_settled),
            final_primary_status=(
                summary.final_primary_status if summary else None),
            summary=summary,
        )

    def _counted_outcomes(
            self,
            request_id: str,
            output_id: str) -> Sequence[str]:
        outcomes = self.cache.get(
            self.cache_keys.OUTPUT_COUNTED_OUTCOMES.format(
                request_id=request_id,
                output_id=output_id))
        if isinstance(outcomes, list):
            return outcomes
        return []

    def _count_outcome(
            self,
            request_id: str,
            output_id: str,
            status_name: str) -> bool:
        """Increment the counters of a terminal status exactly once per output.

        Processing and uploading can be retried, so the same terminal status
        may be saved several times for one output.  Counting it twice would
        make the aggregate reach the total output count too early.
        """
        counter_name = OUTCOME_COUNTERS.get(status_name)
        if counter_name is None:
            return False

        outcomes = list(self._counted_outcomes(request_id, output_id))
        if status_name in outcomes:
            return False

        already_terminal = any(
            is_terminal_output_status(outcome) for outcome in outcomes)

        outcomes.append(status_name)
        self.cache.set(
            self.cache_keys.OUTPUT_COUNTED_OUTCOMES.format(
                request_id=request_id,
                output_id=output_id),
            json.dumps(outcomes),
        )
        self.cache.incr(
            getattr(self.cache_keys, counter_name).format(
                request_id=request_id))
        if not already_terminal:
            self.cache.incr(
                self.cache_keys.TERMINAL_OUTPUTS.format(
                    request_id=request_id))
        return True


class OutputLifecycleCoordinator:
    """Applies output status updates and performs their side effects.

    This is the task-independent part of ``BaseOutputMixin``.  It receives the
    cache and callables for removing local directories and saving the primary
    status, which keeps it runnable offline without Celery, S3 or FFmpeg.
    """

    def __init__(
            self,
            cache,
            delete_inputs: bool = True,
            delete_outputs: bool = True,
            remove_inputs: Optional[Callable] = None,
            remove_outputs: Optional[Callable] = None,
            save_primary_status: Optional[Callable] = None,
            logger=None):
        self.aggregator = OutputStateAggregator(cache)
        self.cache = cache
        self.cache_keys = CacheKeysTemplates
        self.delete_inputs = delete_inputs
        self.delete_outputs = delete_outputs
        self.remove_inputs = remove_inputs
        self.remove_outputs = remove_outputs
        self.save_primary_status = save_primary_status
        self.logger = logger
        self._local_removed = {}

    # ------------------------------------------------------------------
    # public API used by the tasks
    # ------------------------------------------------------------------
    def save_output_status(
            self,
            status_name: str,
            output_id: str,
            request_id: str) -> StatusUpdate:

        update = self.aggregator.apply_output_status(
            request_id=request_id,
            output_id=output_id,
            status_name=status_name,
        )
        if not update.applied:
            return update

        self._log(
            f"output status: {status_name}"
            f" ,request id: {request_id}"
            f" ,output id: {output_id}")

        if update.can_delete_inputs:
            self.check_to_delete_inputs(request_id)

        if update.can_delete_outputs:
            self._remove_outputs(request_id)

        if update.final_primary_status is not None:
            self._save_final_primary_status(
                request_id, update.final_primary_status)

        return update

    def check_to_delete_inputs(self, request_id: str) -> bool:
        """Delete the local inputs once every output is terminal."""
        if not self.delete_inputs:
            return False
        if self._already_removed(
                request_id, self.cache_keys.INPUTS_REMOVED):
            return True

        summary = self.aggregator.summary(request_id)
        if not summary or not summary.all_terminal:
            return False

        self._mark_removed(request_id, self.cache_keys.INPUTS_REMOVED)
        if self.remove_inputs is not None:
            self.remove_inputs(request_id=request_id)
        return True

    def check_all_outputs_are_finished(self, request_id: str) -> bool:
        """Finalize the job once every output is settled."""
        summary = self.aggregator.summary(request_id)
        if not summary:
            return False

        if summary.all_settled:
            if self.delete_outputs:
                self._remove_outputs(request_id)
            final_status = summary.final_primary_status
            if final_status is not None:
                self._save_final_primary_status(request_id, final_status)
            return True
        return False

    def can_set_output_status(
            self,
            output_id: str,
            request_id: str) -> Optional[bool]:
        return self.aggregator.can_set_output_status(request_id, output_id)

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------
    def _remove_outputs(self, request_id: str):
        if not self.delete_outputs:
            return
        if self._already_removed(
                request_id, self.cache_keys.OUTPUTS_REMOVED):
            return
        self._mark_removed(request_id, self.cache_keys.OUTPUTS_REMOVED)
        if self.remove_outputs is not None:
            self.remove_outputs(request_id=request_id)

    def _already_removed(self, request_id: str, key_template: str) -> bool:
        if request_id is None:
            return bool(self._local_removed.get(key_template))
        return bool(self.cache.get(key_template.format(
            request_id=request_id)))

    def _mark_removed(self, request_id: str, key_template: str):
        if request_id is None:
            self._local_removed[key_template] = True
            return
        self.cache.set(
            key_template.format(request_id=request_id),
            json.dumps(True))

    def _save_final_primary_status(
            self,
            request_id: str,
            status_name: str):
        # A final status is written once; later tasks cannot overwrite it.
        if not self.aggregator.can_set_primary_status(request_id):
            return
        self._log(
            f"primary status: {status_name}"
            f" ,request id: {request_id}")
        if self.save_primary_status is not None:
            self.save_primary_status(status_name, request_id)

    def _log(self, message: str):
        if self.logger is not None:
            self.logger.info(message)
