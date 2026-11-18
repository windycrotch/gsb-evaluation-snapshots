"""Offline tests for the multi-output job state aggregation.

The VOD workflow processes several outputs (HLS/DASH playlists, thumbnails,
watermarked video) per input.  These tests drive the real aggregation code used
by ``BaseOutputMixin`` with an in-memory cache stand-in, so they run without
Redis, Celery, S3, FFmpeg or application settings.
"""

import json
import unittest
from pathlib import Path
import sys


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


from video_streaming.core.constants.cache_keys import CacheKeysTemplates
from video_streaming.core.constants.status import (  # noqa: E402
    OutputStatus,
    PrimaryStatus,
)
from video_streaming.core.output_state import (  # noqa: E402
    OutputLifecycleCoordinator,
    OutputStateAggregator,
    is_settled_output_status,
    is_terminal_output_status,
)


class InMemoryCache:
    """Cache stand-in with the semantics of ``video_streaming.cache``.

    Values are stored as text, ``get(decode=True)`` parses JSON and
    ``incr`` returns through ``get`` like the Redis-backed implementation.
    """

    def __init__(self):
        self.store = {}
        self.set_calls = []
        self.deleted_keys = []

    def set(self, key, value, timeout=None):
        self.set_calls.append(key)
        self.store[key] = str(value)

    def get(self, key, decode=True):
        value = self.store.get(key)
        if not decode or value is None:
            return value
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return value

    def incr(self, key, amount=1):
        current = int(self.store.get(key, 0))
        self.store[key] = str(current + amount)

    def delete(self, *keys):
        for key in keys:
            self.deleted_keys.append(key)
            self.store.pop(key, None)


REQUEST_ID = 'request-1'

# A job with one playlist, one thumbnail and one watermarked video: three
# outputs derived from the same input.
PLAYLIST_ID = 'p0'
THUMBNAIL_ID = 't0'
WATERMARKED_VIDEO_ID = 'wv0'
OUTPUT_IDS = (PLAYLIST_ID, THUMBNAIL_ID, WATERMARKED_VIDEO_ID)


class JobHarness:
    """Wire a multi-output job to the production aggregation code."""

    def __init__(self, test_case, total_outputs=None, delete_inputs=True,
                 delete_outputs=True):
        self.test_case = test_case
        self.cache = InMemoryCache()
        self.removed_inputs = []
        self.removed_outputs = []
        self.primary_status_writes = []
        self.setup_job(
            total_outputs if total_outputs is not None else len(OUTPUT_IDS))
        self.coordinator = OutputLifecycleCoordinator(
            cache=self.cache,
            delete_inputs=delete_inputs,
            delete_outputs=delete_outputs,
            remove_inputs=self._remove_inputs,
            remove_outputs=self._remove_outputs,
            save_primary_status=self._save_primary_status,
        )

    # --------------------------------------------------------------
    # job setup / side-effect recorders
    # --------------------------------------------------------------
    def setup_job(self, total_outputs, output_ids=OUTPUT_IDS):
        job_details = dict(
            reference_id='reference-1',
            webhook_url=None,
            total_checks=0,
            total_inputs=1,
            total_outputs=total_outputs,
            no_watermarked_playlists_ids=[
                output_id for output_id in output_ids
                if output_id == PLAYLIST_ID],
            no_watermarked_thumbnails_ids=[
                output_id for output_id in output_ids
                if output_id == THUMBNAIL_ID],
            watermarked_outputs_ids=[
                output_id for output_id in output_ids
                if output_id == WATERMARKED_VIDEO_ID],
        )
        self.cache.set(
            CacheKeysTemplates.JOB_DETAILS.format(request_id=REQUEST_ID),
            json.dumps(job_details))

    def _remove_inputs(self, request_id=None):
        self.removed_inputs.append(request_id)

    def _remove_outputs(self, request_id=None):
        self.removed_outputs.append(request_id)

    def _save_primary_status(self, status_name, request_id):
        # Mirrors BaseStreamingTask.save_primary_status: final statuses cannot
        # be overwritten, and a job without details is not written.
        if not self.cache.get(
                CacheKeysTemplates.JOB_DETAILS.format(
                    request_id=request_id)):
            return None
        if self.cache.get(
                CacheKeysTemplates.PRIMARY_STATUS.format(
                    request_id=request_id),
                decode=False) in [
                    PrimaryStatus.FINISHED,
                    PrimaryStatus.FAILED,
                    PrimaryStatus.REVOKED]:
            return None
        self.cache.set(
            CacheKeysTemplates.PRIMARY_STATUS.format(request_id=request_id),
            status_name)
        self.primary_status_writes.append(status_name)
        return True

    # --------------------------------------------------------------
    # helpers mirroring the Celery task chains
    # --------------------------------------------------------------
    def save(self, status_name, output_id):
        return self.coordinator.save_output_status(
            status_name=status_name,
            output_id=output_id,
            request_id=REQUEST_ID)

    def process(self, output_id):
        self.save(OutputStatus.PREPARATION_PROCESSING, output_id)
        self.save(OutputStatus.PROCESSING, output_id)
        return self.save(OutputStatus.PROCESSING_FINISHED, output_id)

    def upload(self, output_id):
        self.save(OutputStatus.UPLOADING, output_id)
        return self.save(OutputStatus.UPLOADING_FINISHED, output_id)

    def finish(self, output_id):
        self.process(output_id)
        return self.upload(output_id)

    def fail(self, output_id):
        return self.save(OutputStatus.OUTPUT_FAILED, output_id)

    def revoke(self, output_id):
        return self.save(OutputStatus.OUTPUT_REVOKED, output_id)

    def primary_status(self):
        return self.cache.get(
            CacheKeysTemplates.PRIMARY_STATUS.format(request_id=REQUEST_ID),
            decode=False)

    def counter(self, counter_name):
        return self.cache.get(
            getattr(CacheKeysTemplates, counter_name).format(
                request_id=REQUEST_ID)) or 0

    def progress_key(self, output_id):
        return CacheKeysTemplates.OUTPUT_PROGRESS.format(
            request_id=REQUEST_ID,
            output_id=output_id)

    def set_progress(self, output_id, current=1, total=10):
        self.cache.set(
            self.progress_key(output_id),
            json.dumps(dict(total=total, current=current)))


class OutputAggregationTestCase(unittest.TestCase):

    def harness(self, **kwargs):
        return JobHarness(self, **kwargs)

    def assert_no_primary_status(self, job):
        self.assertIsNone(
            job.primary_status(),
            'job must not reach a final status before every output settles')

    def assert_inputs_not_removed(self, job):
        self.assertEqual(job.removed_inputs, [])

    def assert_inputs_removed_once(self, job):
        self.assertEqual(job.removed_inputs, [REQUEST_ID])

    # ------------------------------------------------------------------
    # classification helpers
    # ------------------------------------------------------------------
    def test_terminal_and_settled_status_sets(self):
        for status in (
                OutputStatus.PROCESSING_FINISHED,
                OutputStatus.UPLOADING_FINISHED,
                OutputStatus.OUTPUT_FAILED,
                OutputStatus.OUTPUT_REVOKED):
            self.assertTrue(is_terminal_output_status(status))

        for status in (
                OutputStatus.PREPARATION_PROCESSING,
                OutputStatus.PROCESSING,
                OutputStatus.UPLOADING,
                OutputStatus.QUEUING_UPLOADING):
            self.assertFalse(is_terminal_output_status(status))

        # A processed but not-yet-uploaded output is terminal for input
        # cleanup but not settled for job completion.
        self.assertTrue(
            is_terminal_output_status(OutputStatus.PROCESSING_FINISHED))
        self.assertFalse(
            is_settled_output_status(OutputStatus.PROCESSING_FINISHED))
        for status in (
                OutputStatus.UPLOADING_FINISHED,
                OutputStatus.OUTPUT_FAILED,
                OutputStatus.OUTPUT_REVOKED):
            self.assertTrue(is_settled_output_status(status))

    # ------------------------------------------------------------------
    # partial failures
    # ------------------------------------------------------------------
    def test_inputs_wait_for_slowest_output_when_a_sibling_fails(self):
        job = self.harness()

        job.finish(PLAYLIST_ID)
        job.fail(THUMBNAIL_ID)
        job.process(WATERMARKED_VIDEO_ID)

        # The watermarked video is fully processed, so all three outputs are
        # terminal and the shared inputs are no longer needed.  It still has to
        # upload, so the job itself is not over.
        self.assert_inputs_removed_once(job)
        self.assert_no_primary_status(job)
        self.assertEqual(job.counter('FAILED_OUTPUTS'), 1)
        self.assertEqual(job.removed_outputs, [])

    def test_inputs_wait_for_slowest_output_while_it_is_processing(self):
        job = self.harness()

        job.finish(PLAYLIST_ID)
        job.fail(THUMBNAIL_ID)
        job.save(OutputStatus.PROCESSING, WATERMARKED_VIDEO_ID)

        # One output is still processing; two of three are terminal.
        self.assert_inputs_not_removed(job)
        self.assert_no_primary_status(job)
        self.assertEqual(job.counter('FAILED_OUTPUTS'), 1)
        self.assertEqual(job.removed_outputs, [])

    def test_partial_failure_deletes_inputs_only_after_all_terminal(self):
        job = self.harness()

        job.finish(PLAYLIST_ID)
        job.fail(THUMBNAIL_ID)
        job.save(OutputStatus.PROCESSING, WATERMARKED_VIDEO_ID)
        self.assert_inputs_not_removed(job)

        # The last output finishes processing: every output is now terminal.
        update = job.process(WATERMARKED_VIDEO_ID)
        self.assertTrue(update.can_delete_inputs)
        self.assert_inputs_removed_once(job)
        # The last output still has to upload, so the job is not over.
        self.assert_no_primary_status(job)
        self.assertEqual(job.removed_outputs, [])

        job.upload(WATERMARKED_VIDEO_ID)

        self.assert_inputs_removed_once(job)
        self.assertEqual(job.primary_status(), PrimaryStatus.FINISHED)
        self.assertEqual(job.removed_outputs, [REQUEST_ID])

    def test_failure_of_the_last_output_still_deletes_inputs(self):
        job = self.harness()

        job.finish(PLAYLIST_ID)
        job.process(THUMBNAIL_ID)

        # The last output fails instead of finishing processing; its failure is
        # still terminal, so the inputs must be removed.
        job.fail(WATERMARKED_VIDEO_ID)

        self.assert_inputs_removed_once(job)
        # A processed-but-not-uploaded sibling keeps the job running.
        self.assert_no_primary_status(job)

        job.upload(THUMBNAIL_ID)
        self.assertEqual(job.primary_status(), PrimaryStatus.FINISHED)
        self.assertEqual(job.removed_outputs, [REQUEST_ID])

    def test_revocation_of_the_last_output_deletes_inputs(self):
        job = self.harness()

        job.finish(PLAYLIST_ID)
        job.fail(THUMBNAIL_ID)

        job.revoke(WATERMARKED_VIDEO_ID)

        self.assert_inputs_removed_once(job)
        self.assertEqual(job.primary_status(), PrimaryStatus.FINISHED)
        self.assertEqual(job.counter('REVOKED_OUTPUTS'), 1)

    # ------------------------------------------------------------------
    # partial revocation
    # ------------------------------------------------------------------
    def test_revoking_one_output_does_not_revoke_the_job(self):
        job = self.harness()

        job.revoke(PLAYLIST_ID)

        self.assert_no_primary_status(job)
        self.assertEqual(job.counter('REVOKED_OUTPUTS'), 1)
        self.assertEqual(job.counter('FAILED_OUTPUTS'), 0)
        self.assertEqual(job.removed_outputs, [])
        self.assert_inputs_not_removed(job)

        job.finish(THUMBNAIL_ID)
        job.finish(WATERMARKED_VIDEO_ID)

        self.assertEqual(job.primary_status(), PrimaryStatus.FINISHED)
        self.assertEqual(job.counter('REVOKED_OUTPUTS'), 1)
        self.assert_inputs_removed_once(job)

    def test_single_output_force_revoke_only_marks_that_output(self):
        job = self.harness()

        job.finish(PLAYLIST_ID)
        job.revoke(THUMBNAIL_ID)
        job.revoke(WATERMARKED_VIDEO_ID)

        # The job now has every output settled (one ready, two revoked), so it
        # is FINISHED - not REVOKED: a partial revocation must not revoke the
        # whole job.  Only two outputs were revoked.
        self.assertEqual(job.counter('REVOKED_OUTPUTS'), 2)
        self.assertEqual(job.counter('READY_OUTPUTS'), 1)
        self.assertEqual(job.primary_status(), PrimaryStatus.FINISHED)

        # A late revocation of the already uploaded output is locked and does
        # not change the counts or the final status.
        update = job.revoke(PLAYLIST_ID)
        self.assertFalse(update.applied)
        self.assertEqual(job.counter('REVOKED_OUTPUTS'), 2)
        self.assertEqual(job.primary_status(), PrimaryStatus.FINISHED)

    # ------------------------------------------------------------------
    # all outputs end
    # ------------------------------------------------------------------
    def test_all_outputs_uploaded_finishes_the_job(self):
        job = self.harness()

        job.finish(PLAYLIST_ID)
        job.finish(THUMBNAIL_ID)
        self.assert_no_primary_status(job)
        self.assert_inputs_not_removed(job)

        job.finish(WATERMARKED_VIDEO_ID)

        self.assertEqual(job.primary_status(), PrimaryStatus.FINISHED)
        self.assertEqual(job.primary_status_writes, [PrimaryStatus.FINISHED])
        self.assert_inputs_removed_once(job)
        self.assertEqual(job.removed_outputs, [REQUEST_ID])

    def test_all_outputs_failed_is_failed_not_finished(self):
        job = self.harness()

        job.fail(PLAYLIST_ID)
        job.fail(THUMBNAIL_ID)
        self.assert_no_primary_status(job)
        self.assert_inputs_not_removed(job)

        job.fail(WATERMARKED_VIDEO_ID)

        self.assertEqual(job.primary_status(), PrimaryStatus.FAILED)
        self.assertEqual(job.primary_status_writes, [PrimaryStatus.FAILED])
        self.assert_inputs_removed_once(job)
        self.assertEqual(job.removed_outputs, [REQUEST_ID])

    def test_all_outputs_revoked_is_revoked(self):
        job = self.harness()

        job.revoke(PLAYLIST_ID)
        job.revoke(THUMBNAIL_ID)
        self.assert_no_primary_status(job)

        job.revoke(WATERMARKED_VIDEO_ID)

        self.assertEqual(job.primary_status(), PrimaryStatus.REVOKED)
        self.assertEqual(job.primary_status_writes, [PrimaryStatus.REVOKED])
        self.assert_inputs_removed_once(job)
        self.assertEqual(job.removed_outputs, [REQUEST_ID])

    def test_mixed_failure_and_revocation_finishes(self):
        job = self.harness()

        job.fail(PLAYLIST_ID)
        job.revoke(THUMBNAIL_ID)
        job.finish(WATERMARKED_VIDEO_ID)

        self.assertEqual(job.primary_status(), PrimaryStatus.FINISHED)
        self.assertEqual(job.counter('FAILED_OUTPUTS'), 1)
        self.assertEqual(job.counter('REVOKED_OUTPUTS'), 1)
        self.assertEqual(job.counter('READY_OUTPUTS'), 1)
        self.assert_inputs_removed_once(job)

    # ------------------------------------------------------------------
    # terminal state is final
    # ------------------------------------------------------------------
    def test_finished_job_is_not_reopened_by_late_status(self):
        job = self.harness()

        for output_id in OUTPUT_IDS:
            job.finish(output_id)
        self.assertEqual(job.primary_status(), PrimaryStatus.FINISHED)

        # A retried or lagging upload task tries to report progress again.
        update = job.save(OutputStatus.UPLOADING, PLAYLIST_ID)

        self.assertFalse(update.applied)
        self.assertEqual(job.primary_status(), PrimaryStatus.FINISHED)
        self.assertEqual(job.primary_status_writes, [PrimaryStatus.FINISHED])

    def test_failed_job_is_not_overwritten_by_a_later_success(self):
        job = self.harness()

        for output_id in OUTPUT_IDS:
            job.fail(output_id)
        self.assertEqual(job.primary_status(), PrimaryStatus.FAILED)

        update = job.finish(PLAYLIST_ID)

        self.assertFalse(update.applied)
        self.assertEqual(job.primary_status(), PrimaryStatus.FAILED)
        self.assertEqual(job.primary_status_writes, [PrimaryStatus.FAILED])

    def test_revoked_job_is_not_overwritten_by_finished(self):
        job = self.harness()

        for output_id in OUTPUT_IDS:
            job.revoke(output_id)
        self.assertEqual(job.primary_status(), PrimaryStatus.REVOKED)

        job.finish(PLAYLIST_ID)

        self.assertEqual(job.primary_status(), PrimaryStatus.REVOKED)
        self.assertEqual(job.primary_status_writes, [PrimaryStatus.REVOKED])

    def test_aggregator_blocks_final_primary_status_overwrite(self):
        job = self.harness()
        job.cache.set(
            CacheKeysTemplates.PRIMARY_STATUS.format(request_id=REQUEST_ID),
            PrimaryStatus.FINISHED)

        aggregator = OutputStateAggregator(job.cache)
        self.assertFalse(aggregator.can_set_primary_status(REQUEST_ID))
        self.assertEqual(aggregator.current_primary_status(REQUEST_ID),
                         PrimaryStatus.FINISHED)

    # ------------------------------------------------------------------
    # counters and progress keys
    # ------------------------------------------------------------------
    def test_repeated_terminal_status_is_counted_once(self):
        job = self.harness()

        # A retried playlist chain reports processing finished twice.
        job.process(PLAYLIST_ID)
        job.process(PLAYLIST_ID)
        self.assertEqual(job.counter('PROCESSED_OUTPUTS'), 1)

        job.fail(THUMBNAIL_ID)
        job.fail(THUMBNAIL_ID)  # duplicate failure notification
        self.assertEqual(job.counter('FAILED_OUTPUTS'), 1)

        # Duplicate statuses must not let the job end before the third output
        # is uploaded.
        self.assert_no_primary_status(job)

        job.upload(PLAYLIST_ID)
        job.finish(WATERMARKED_VIDEO_ID)
        self.assertEqual(job.counter('READY_OUTPUTS'), 2)
        self.assertEqual(job.primary_status(), PrimaryStatus.FINISHED)

    def test_progress_key_is_removed_on_every_terminal_status(self):
        for terminal_status in (
                OutputStatus.PROCESSING_FINISHED,
                OutputStatus.UPLOADING_FINISHED,
                OutputStatus.OUTPUT_FAILED,
                OutputStatus.OUTPUT_REVOKED):
            with self.subTest(status=terminal_status):
                job = self.harness()
                job.set_progress(PLAYLIST_ID)
                self.assertIsNotNone(
                    job.cache.get(job.progress_key(PLAYLIST_ID)))

                job.save(terminal_status, PLAYLIST_ID)

                self.assertIsNone(
                    job.cache.get(job.progress_key(PLAYLIST_ID)))
                self.assertIn(
                    job.progress_key(PLAYLIST_ID), job.cache.deleted_keys)

    def test_progress_key_is_kept_while_output_is_active(self):
        job = self.harness()
        job.set_progress(PLAYLIST_ID)

        job.save(OutputStatus.PROCESSING, PLAYLIST_ID)
        job.save(OutputStatus.UPLOADING, PLAYLIST_ID)

        self.assertIsNotNone(job.cache.get(job.progress_key(PLAYLIST_ID)))

    def test_duplicate_terminal_status_still_clears_progress(self):
        job = self.harness()
        job.finish(PLAYLIST_ID)
        job.set_progress(PLAYLIST_ID)

        # The output is already locked; the late status is not applied, but a
        # terminal update must still clear the stale progress key.
        update = job.save(OutputStatus.OUTPUT_FAILED, PLAYLIST_ID)

        self.assertFalse(update.applied)
        self.assertIsNone(job.cache.get(job.progress_key(PLAYLIST_ID)))
        self.assertEqual(job.counter('FAILED_OUTPUTS'), 0)

    # ------------------------------------------------------------------
    # cleanup is idempotent and respects the flags
    # ------------------------------------------------------------------
    def test_inputs_are_deleted_once_across_repeated_settlement(self):
        job = self.harness()

        for output_id in OUTPUT_IDS:
            job.finish(output_id)

        self.assert_inputs_removed_once(job)
        self.assertEqual(job.removed_outputs, [REQUEST_ID])

    def test_cleanup_flags_can_disable_deletion(self):
        job = self.harness(delete_inputs=False, delete_outputs=False)

        for output_id in OUTPUT_IDS:
            job.finish(output_id)

        self.assertEqual(job.removed_inputs, [])
        self.assertEqual(job.removed_outputs, [])
        self.assertEqual(job.primary_status(), PrimaryStatus.FINISHED)

    def test_unknown_job_does_not_write_or_delete_anything(self):
        job = self.harness()
        job.cache.delete(CacheKeysTemplates.JOB_DETAILS.format(
            request_id=REQUEST_ID))

        update = job.save(OutputStatus.OUTPUT_FAILED, PLAYLIST_ID)

        self.assertFalse(update.applied)
        self.assertIsNone(job.primary_status())
        self.assertEqual(job.removed_inputs, [])
        self.assertEqual(job.removed_outputs, [])

    def test_missing_output_id_does_not_affect_job_state(self):
        job = self.harness()

        update = job.save(OutputStatus.OUTPUT_FAILED, None)

        self.assertFalse(update.applied)
        self.assertEqual(job.counter('FAILED_OUTPUTS'), 0)
        self.assert_no_primary_status(job)

    # ------------------------------------------------------------------
    # total output count
    # ------------------------------------------------------------------
    def test_total_outputs_can_be_derived_from_output_id_lists(self):
        job = self.harness()
        job_details = job.cache.get(
            CacheKeysTemplates.JOB_DETAILS.format(request_id=REQUEST_ID))
        job_details.pop('total_outputs')
        job.cache.set(
            CacheKeysTemplates.JOB_DETAILS.format(request_id=REQUEST_ID),
            json.dumps(job_details))

        # The watermarked video appears in two lists and must be counted once.
        self.assertEqual(
            len(OutputStateAggregator.output_ids(job_details)),
            len(OUTPUT_IDS))
        self.assertEqual(
            OutputStateAggregator.total_outputs(job_details), len(OUTPUT_IDS))

    def test_job_with_no_outputs_never_finalizes(self):
        job = self.harness(total_outputs=0)

        update = job.save(OutputStatus.UPLOADING_FINISHED, PLAYLIST_ID)

        self.assertFalse(update.can_delete_inputs)
        self.assertIsNone(update.final_primary_status)
        self.assert_no_primary_status(job)
        self.assertEqual(job.removed_inputs, [])

    # ------------------------------------------------------------------
    # a full simulated multi-output job, in interleaved order
    # ------------------------------------------------------------------
    def test_interleaved_output_chains_keep_inputs_until_all_terminal(self):
        job = self.harness()

        # Playlist uploads first.
        job.finish(PLAYLIST_ID)
        # Thumbnail fails while the watermarked video is still encoding.
        job.fail(THUMBNAIL_ID)
        job.save(OutputStatus.PROCESSING, WATERMARKED_VIDEO_ID)

        self.assertEqual(job.counter('READY_OUTPUTS'), 1)
        self.assertEqual(job.counter('FAILED_OUTPUTS'), 1)
        self.assert_no_primary_status(job)
        # The watermarked video still reads the input, so it must stay.
        self.assert_inputs_not_removed(job)

        job.save(OutputStatus.PROCESSING_FINISHED, WATERMARKED_VIDEO_ID)
        # Encoding is done everywhere: the inputs are not needed anymore.
        self.assert_inputs_removed_once(job)
        self.assert_no_primary_status(job)

        job.save(OutputStatus.UPLOADING, WATERMARKED_VIDEO_ID)
        self.assert_no_primary_status(job)

        job.save(OutputStatus.UPLOADING_FINISHED, WATERMARKED_VIDEO_ID)

        self.assertEqual(job.primary_status(), PrimaryStatus.FINISHED)
        self.assert_inputs_removed_once(job)
        self.assertEqual(job.removed_outputs, [REQUEST_ID])


if __name__ == '__main__':
    unittest.main()
