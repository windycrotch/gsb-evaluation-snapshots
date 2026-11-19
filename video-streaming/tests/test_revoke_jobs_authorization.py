"""Tests for authenticated, tenant-scoped, idempotent job revocation."""

import json
import os
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from uuid import uuid4

# The servicer import chain builds S3/Redis/Celery clients at import time.
# Provide harmless defaults before any video_streaming module is imported;
# real deployments override these through their own environment.
_ENV_DEFAULTS = {
    "S3_ENDPOINT_URL": "http://localhost:9000",
    "S3_ACCESS_KEY_ID": "test-access-key",
    "S3_SECRET_ACCESS_KEY": "test-secret-key",
    "S3_REGION_NAME": "us-east-1",
    "S3_DEFAULT_BUCKET": "test-bucket",
    "REDIS_URL": "redis://localhost:6379/0",
    "CELERY_BROKER_URL": "amqp://guest:guest@localhost:5672//",
    "CELERY_RESULT_BACKEND": "redis://localhost:6379/1",
}
for _key, _value in _ENV_DEFAULTS.items():
    os.environ.setdefault(_key, _value)

import video_streaming.env_config as _env_config

if not Path(_env_config.ENV_FILE_PATH).exists():
    # settings requires a readable .env file; point it at an empty one.
    _env_config.ENV_FILE_PATH = str(
        Path(tempfile.mkdtemp(prefix="revoke-jobs-tests-")) / ".env")
    Path(_env_config.ENV_FILE_PATH).write_text("", encoding="utf-8")

from video_streaming.core.constants import CacheKeysTemplates
from video_streaming.grpc.protos import streaming_pb2
from video_streaming.grpc.servicers.mixins import revoke_jobs as revoke_jobs_module
from video_streaming.grpc.servicers.mixins.revoke_jobs import RevokeJobsMixin
from video_streaming.security import RequestPrincipal
from video_streaming.workflows.repository import WorkflowRepository


class FakeCache:
    """Thread-safe in-memory stand-in for RedisCache."""

    def __init__(self):
        self._data = {}
        self._lock = threading.Lock()
        self.write_counts = {}

    def get(self, key, decode=True):
        with self._lock:
            value = self._data.get(key)
        if value is None:
            return None
        if decode:
            try:
                return json.loads(value)
            except (TypeError, ValueError):
                return value
        return value

    def set(self, key, value, timeout=None):
        with self._lock:
            self._data[key] = value
            self.write_counts[key] = self.write_counts.get(key, 0) + 1

    def set_if_not_exists(self, key, value, timeout=None):
        with self._lock:
            if key in self._data:
                return False
            self._data[key] = value
            self.write_counts[key] = self.write_counts.get(key, 0) + 1
            return True

    def delete(self, *keys):
        with self._lock:
            for key in keys:
                self._data.pop(key, None)

    def writes(self, key):
        with self._lock:
            return self.write_counts.get(key, 0)


class RevokeJobsServicer(RevokeJobsMixin):
    pb2 = streaming_pb2

    def __init__(self, cache):
        self.cache = cache


class RevokeJobsAuthorizationTests(unittest.TestCase):

    def setUp(self):
        self.cache = FakeCache()
        self.servicer = RevokeJobsServicer(self.cache)
        self._temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp_dir.cleanup)
        database_url = "sqlite:///{}".format(
            Path(self._temp_dir.name) / "workflow.db")
        self.repository = WorkflowRepository(database_url, create_schema=True)
        self.addCleanup(self.repository.close)
        repository_patcher = mock.patch.object(
            revoke_jobs_module,
            "get_workflow_repository",
            lambda required=True: self.repository,
        )
        repository_patcher.start()
        self.addCleanup(repository_patcher.stop)

    def make_principal(
            self,
            tenant="tenant-a",
            subject="subject-1",
            scopes=("video.jobs:cancel",),
            expires_delta=timedelta(minutes=5)):
        return RequestPrincipal(
            issuer="https://issuer.example.test/",
            subject=subject,
            tenant_id=tenant,
            scopes=frozenset(scopes),
            roles=frozenset(),
            authentication_method="bearer",
            expires_at=datetime.now(timezone.utc) + expires_delta,
        )

    def create_job(self, owner_principal=None, reference_id="ref-1"):
        job_id = str(uuid4())
        self.repository.create_job(
            job_id=job_id,
            idempotency_key="idem-{}".format(job_id),
            request_hash="a" * 64,
            reference_id=reference_id,
            owner_principal=owner_principal,
        )
        self.cache.set(
            CacheKeysTemplates.JOB_DETAILS.format(request_id=job_id),
            json.dumps({"reference_id": reference_id}),
        )
        return job_id

    def force_stop_key(self, job_id):
        return CacheKeysTemplates.FORCE_STOP_REQUEST.format(
            request_id=job_id)

    def revoke(self, tracking_ids, principal):
        request = streaming_pb2.RevokeJobsRequest(tracking_ids=tracking_ids)
        context = SimpleNamespace(principal=principal)
        return self.servicer._revoke_jobs(request, context)

    def test_same_tenant_revoke_sends_signal_and_keeps_ids(self):
        principal = self.make_principal()
        job_id = self.create_job(
            owner_principal=principal, reference_id="ref-same-tenant")

        response = self.revoke([job_id], principal)

        self.assertEqual(len(response.results), 1)
        result = response.results[0]
        self.assertEqual(result.tracking_id, job_id)
        self.assertEqual(result.reference_id, "ref-same-tenant")
        self.assertEqual(
            result.has_been_sent,
            streaming_pb2.RevokeSignalStatus.REVOKE_SIGNAL_SENT)
        self.assertEqual(self.cache.writes(self.force_stop_key(job_id)), 1)
        self.assertTrue(self.cache.get(self.force_stop_key(job_id)))

    def test_cross_tenant_revoke_is_denied_like_not_found(self):
        owner = self.make_principal(tenant="tenant-a")
        job_id = self.create_job(
            owner_principal=owner, reference_id="ref-cross-tenant")
        attacker = self.make_principal(tenant="tenant-b")

        response = self.revoke([job_id], attacker)

        self.assertEqual(len(response.results), 1)
        result = response.results[0]
        self.assertEqual(result.tracking_id, job_id)
        # no reference_id and no signal: identical to an unknown job
        self.assertEqual(result.reference_id, "")
        self.assertEqual(
            result.has_been_sent,
            streaming_pb2.RevokeSignalStatus.REQUEST_NOT_FOUND)
        self.assertEqual(self.cache.writes(self.force_stop_key(job_id)), 0)
        self.assertIsNone(self.cache.get(self.force_stop_key(job_id)))

    def test_expired_principal_is_denied_like_not_found(self):
        owner = self.make_principal()
        job_id = self.create_job(
            owner_principal=owner, reference_id="ref-expired")
        expired = self.make_principal(
            expires_delta=timedelta(seconds=-1))

        response = self.revoke([job_id], expired)

        result = response.results[0]
        self.assertEqual(result.reference_id, "")
        self.assertEqual(
            result.has_been_sent,
            streaming_pb2.RevokeSignalStatus.REQUEST_NOT_FOUND)
        self.assertEqual(self.cache.writes(self.force_stop_key(job_id)), 0)

    def test_missing_scope_is_denied_like_not_found(self):
        owner = self.make_principal()
        job_id = self.create_job(
            owner_principal=owner, reference_id="ref-no-scope")
        reader = self.make_principal(scopes=("video.jobs:read",))

        response = self.revoke([job_id], reader)

        result = response.results[0]
        self.assertEqual(result.reference_id, "")
        self.assertEqual(
            result.has_been_sent,
            streaming_pb2.RevokeSignalStatus.REQUEST_NOT_FOUND)
        self.assertEqual(self.cache.writes(self.force_stop_key(job_id)), 0)

    def test_missing_principal_is_denied_like_not_found(self):
        owner = self.make_principal()
        job_id = self.create_job(
            owner_principal=owner, reference_id="ref-anonymous")

        response = self.revoke([job_id], None)

        result = response.results[0]
        self.assertEqual(result.reference_id, "")
        self.assertEqual(
            result.has_been_sent,
            streaming_pb2.RevokeSignalStatus.REQUEST_NOT_FOUND)
        self.assertEqual(self.cache.writes(self.force_stop_key(job_id)), 0)

    def test_unowned_job_is_denied_like_not_found(self):
        job_id = self.create_job(
            owner_principal=None, reference_id="ref-unowned")
        principal = self.make_principal()

        response = self.revoke([job_id], principal)

        result = response.results[0]
        self.assertEqual(result.reference_id, "")
        self.assertEqual(
            result.has_been_sent,
            streaming_pb2.RevokeSignalStatus.REQUEST_NOT_FOUND)
        self.assertEqual(self.cache.writes(self.force_stop_key(job_id)), 0)

    def test_unknown_tracking_id_returns_request_not_found(self):
        principal = self.make_principal()
        unknown_id = str(uuid4())

        response = self.revoke([unknown_id], principal)

        self.assertEqual(len(response.results), 1)
        result = response.results[0]
        self.assertEqual(result.tracking_id, unknown_id)
        self.assertEqual(result.reference_id, "")
        self.assertEqual(
            result.has_been_sent,
            streaming_pb2.RevokeSignalStatus.REQUEST_NOT_FOUND)
        self.assertEqual(self.cache.writes(self.force_stop_key(unknown_id)), 0)

    def test_concurrent_revoke_writes_signal_and_revokes_once(self):
        principal = self.make_principal()
        job_id = self.create_job(
            owner_principal=principal, reference_id="ref-concurrent")
        self.cache.set(
            CacheKeysTemplates.REQUEST_RESULT_ID.format(request_id=job_id),
            "celery-result-id")

        async_result = mock.Mock()
        async_result.ready.return_value = False
        with mock.patch.object(
                revoke_jobs_module, "AsyncResult",
                return_value=async_result) as async_result_cls:
            thread_count = 8
            barrier = threading.Barrier(thread_count)
            responses = [None] * thread_count

            def revoke_in_thread(index):
                barrier.wait(timeout=10)
                responses[index] = self.revoke([job_id], principal)

            threads = [
                threading.Thread(target=revoke_in_thread, args=(index,))
                for index in range(thread_count)
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=30)

        for response in responses:
            self.assertIsNotNone(response)
            self.assertEqual(len(response.results), 1)
            result = response.results[0]
            # every caller observes the sent state and the job identity
            self.assertEqual(result.tracking_id, job_id)
            self.assertEqual(result.reference_id, "ref-concurrent")
            self.assertEqual(
                result.has_been_sent,
                streaming_pb2.RevokeSignalStatus.REVOKE_SIGNAL_SENT)

        # exactly one caller wrote the stop marker and triggered Celery
        self.assertEqual(self.cache.writes(self.force_stop_key(job_id)), 1)
        self.assertEqual(async_result_cls.call_count, 1)
        self.assertEqual(async_result.revoke.call_count, 1)


if __name__ == "__main__":
    unittest.main()
