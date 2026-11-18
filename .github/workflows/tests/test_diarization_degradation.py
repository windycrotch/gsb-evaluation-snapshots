"""Observable diarization degradation in verbose_json and /health.

Covers the four required scenarios end to end (successful diarization, download
failure, hash mismatch and missing models with WHISPER_LOCAL_ONLY) plus the API
contract: transcript/segments stay usable, verbose_json reports why speakers are
absent, other output formats are unchanged, and /health reports effective
availability.
"""
import asyncio
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

from test_api_validation import api_server
import diarization_models as models

DEFAULT = models.DEFAULT_EMBEDDING_MODEL


class _Segment:
    def __init__(self, start=0.0, end=1.0, text=" hello "):
        self.seek = 0
        self.start = start
        self.end = end
        self.text = text
        self.tokens = [1]
        self.temperature = 0.0
        self.avg_logprob = -0.1
        self.compression_ratio = 1.0
        self.no_speech_prob = 0.1
        self.words = None


class _Info:
    language = "en"
    language_probability = 1.0
    duration = 1.0
    duration_after_vad = 1.0


class _Model:
    def transcribe(self, _path, **_kwargs):
        return iter([_Segment()]), _Info()


class _Upload:
    filename = "audio.wav"

    def __init__(self, data=b"audio"):
        self._data = data

    async def read(self, _size):
        data = self._data
        self._data = b""
        return data


def _fake_diarizer(diarize=None, assign=None):
    module = types.ModuleType("diarizer")
    module.diarize = diarize or (lambda _path: [(0.0, 1.0, "SPEAKER_00")])
    if assign is None:
        def assign(segments, _turns):
            for seg in segments:
                seg["speaker"] = "SPEAKER_00"
            return segments
    module.assign_speakers = assign
    return module


class DiarizationAPITests(unittest.TestCase):
    def setUp(self):
        for patch in (
            mock.patch.object(api_server, "_model", _Model()),
            mock.patch.object(api_server, "_model_name", "tiny"),
            mock.patch.object(api_server, "_max_upload_bytes", 0),
            mock.patch.object(api_server, "_word_timestamps", False),
            mock.patch.object(api_server, "_condition_on_previous_text", True),
            mock.patch.object(api_server, "_no_repeat_ngram_size", 0),
            mock.patch.object(api_server, "_diarization_enabled", False),
            mock.patch.object(api_server, "_diarization_requested", False),
            mock.patch.object(api_server, "_diarization_error", None),
            mock.patch.dict(os.environ, {"WHISPER_LANGUAGE": "auto"}),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def _request(self, response_format="verbose_json", diarizer=None):
        modules = {"diarizer": diarizer} if diarizer is not None else {}
        with mock.patch.dict(sys.modules, modules):
            return asyncio.run(api_server._handle_audio(
                task="transcribe",
                file=_Upload(),
                model="whisper-1",
                language=None,
                prompt=None,
                response_format=response_format,
                temperature=0,
                stream=None,
                beam=None,
            ))

    def test_successful_diarization_has_speakers_and_no_degradation_field(self):
        api_server._diarization_enabled = True
        api_server._diarization_requested = True
        response = self._request(diarizer=_fake_diarizer())
        self.assertEqual(response.content["segments"][0]["speaker"], "SPEAKER_00")
        self.assertNotIn("diarization", response.content)
        self.assertEqual(response.content["text"], "hello")

    def test_inference_failure_keeps_transcript_and_reports_reason(self):
        api_server._diarization_enabled = True
        api_server._diarization_requested = True

        def boom(_path):
            raise RuntimeError("audio decode failed: fixture")

        response = self._request(diarizer=_fake_diarizer(diarize=boom))
        content = response.content
        self.assertEqual(content["text"], "hello")
        self.assertNotIn("speaker", content["segments"][0])
        self.assertEqual(content["diarization"]["status"], "unavailable")
        self.assertEqual(content["diarization"]["reason"], "inference_failed")
        self.assertIn("audio decode failed", content["diarization"]["detail"])
        self.assertNotIn("\n", content["diarization"]["detail"])

    def test_startup_failure_is_reported_on_every_verbose_response(self):
        api_server._diarization_error = {
            "reason": "verification_failed",
            "detail": "Cached model verification failed (SHA-256 mismatch): /cache/model.onnx",
        }
        api_server._diarization_requested = True
        response = self._request(diarizer=_fake_diarizer())
        self.assertNotIn("speaker", response.content["segments"][0])
        self.assertEqual(response.content["diarization"], {
            "status": "unavailable",
            "reason": "verification_failed",
            "detail": "Cached model verification failed (SHA-256 mismatch): /cache/model.onnx",
        })

    def test_missing_models_offline_reports_not_cached(self):
        api_server._diarization_error = {
            "reason": "model_not_cached",
            "detail": "WHISPER_LOCAL_ONLY prevents downloading missing diarization model: /cache/x.onnx",
        }
        api_server._diarization_requested = True
        response = self._request(diarizer=_fake_diarizer())
        self.assertEqual(response.content["diarization"]["reason"], "model_not_cached")

    def test_degradation_field_is_verbose_json_only(self):
        api_server._diarization_requested = True
        api_server._diarization_error = {"reason": "download_failed", "detail": "curl failed"}
        diarizer = _fake_diarizer()
        text = self._request("text", diarizer)
        self.assertEqual(text.content, "hello")
        srt = self._request("srt", diarizer)
        self.assertNotIn("SPEAKER_", srt.content)
        self.assertNotIn("diarization", srt.content)
        vtt = self._request("vtt", diarizer)
        self.assertNotIn("SPEAKER_", vtt.content)
        self.assertNotIn("diarization", vtt.content)
        plain = self._request("json", diarizer)
        self.assertEqual(plain.content, {"text": "hello"})

    def test_successful_speaker_output_formats_are_unchanged(self):
        api_server._diarization_enabled = True
        api_server._diarization_requested = True
        diarizer = _fake_diarizer()
        self.assertEqual(self._request("text", diarizer).content, "[SPEAKER_00] hello")
        self.assertIn("[SPEAKER_00] hello", self._request("srt", diarizer).content)
        self.assertIn("[SPEAKER_00] hello", self._request("vtt", diarizer).content)

    def test_health_reports_effective_diarization_state(self):
        self.assertEqual(
            asyncio.run(api_server.health())["diarization"], {"status": "disabled"})

        api_server._diarization_requested = True
        api_server._diarization_enabled = True
        self.assertEqual(
            asyncio.run(api_server.health())["diarization"], {"status": "available"})

        api_server._diarization_enabled = False
        api_server._diarization_error = {"reason": "verification_failed", "detail": "bad hash"}
        health = asyncio.run(api_server.health())
        self.assertEqual(health["status"], "ok")
        self.assertEqual(health["diarization"], {
            "status": "unavailable", "reason": "verification_failed", "detail": "bad hash",
        })

    def test_health_without_recorded_reason_still_reports_unavailable(self):
        api_server._diarization_requested = True
        api_server._diarization_error = None
        self.assertEqual(
            asyncio.run(api_server.health())["diarization"],
            {"status": "unavailable", "reason": "load_failed"},
        )


class LoaderStateTests(unittest.TestCase):
    def setUp(self):
        for name, value in (("_diarization_enabled", False),
                            ("_diarization_requested", False),
                            ("_diarization_error", None)):
            patch = mock.patch.object(api_server, name, value)
            patch.start()
            self.addCleanup(patch.stop)

    def test_model_verification_failure_records_reason_and_disables_pipeline(self):
        module = types.ModuleType("diarizer")
        module.load = mock.Mock(side_effect=models.ModelVerificationError(
            "Cached model verification failed (size mismatch): /cache/m.onnx has 1 bytes, expected 2.",
            path=Path("/cache/m.onnx"), check="size"))
        with mock.patch.dict(os.environ, {"WHISPER_DIARIZATION": "true"}), \
                mock.patch.dict(sys.modules, {"diarizer": module}), \
                mock.patch.object(api_server, "_diarize_embedding_model", DEFAULT):
            with self.assertLogs(api_server.logger, level="WARNING") as logs:
                api_server._load_diarizer()
        self.assertFalse(api_server._diarization_enabled)
        self.assertTrue(api_server._diarization_requested)
        self.assertEqual(api_server._diarization_error["reason"], "verification_failed")
        self.assertIn("/cache/m.onnx", api_server._diarization_error["detail"])
        self.assertIn("reason=verification_failed", " ".join(logs.output))

    def test_local_only_missing_model_records_not_cached(self):
        module = types.ModuleType("diarizer")
        module.load = mock.Mock(side_effect=models.ModelNotCachedError(
            "WHISPER_LOCAL_ONLY prevents downloading missing diarization model: /cache/x.onnx",
            path=Path("/cache/x.onnx")))
        with mock.patch.dict(os.environ, {"WHISPER_DIARIZATION": "true"}), \
                mock.patch.dict(sys.modules, {"diarizer": module}), \
                mock.patch.object(api_server, "_diarize_embedding_model", DEFAULT):
            api_server._load_diarizer()
        self.assertEqual(api_server._diarization_error["reason"], "model_not_cached")

    def test_successful_reload_clears_previous_error(self):
        api_server._diarization_error = {"reason": "download_failed", "detail": "stale"}
        module = types.ModuleType("diarizer")
        module.load = mock.Mock()
        with mock.patch.dict(os.environ, {"WHISPER_DIARIZATION": "true"}), \
                mock.patch.dict(sys.modules, {"diarizer": module}), \
                mock.patch.object(api_server, "_diarize_embedding_model", DEFAULT):
            api_server._load_diarizer()
        self.assertTrue(api_server._diarization_enabled)
        self.assertTrue(api_server._diarization_requested)
        self.assertIsNone(api_server._diarization_error)

    def test_disabled_diarization_reports_disabled(self):
        api_server._diarization_requested = True
        api_server._diarization_error = {"reason": "download_failed", "detail": "stale"}
        with mock.patch.dict(os.environ, {"WHISPER_DIARIZATION": "false"}):
            api_server._load_diarizer()
        self.assertFalse(api_server._diarization_requested)
        self.assertIsNone(api_server._diarization_error)


class VerificationBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        self.seg = b"segmentation fixture"
        self.payload = b"embedding fixture"
        self.asset = models.ModelAsset(len(self.payload), hashlib.sha256(self.payload).hexdigest())
        self.seg_asset = models.ModelAsset(len(self.seg), hashlib.sha256(self.seg).hexdigest())
        for patch in (mock.patch.dict(models.EMBEDDING_MODELS, {DEFAULT: self.asset}, clear=True),
                      mock.patch.object(models, "_SEGMENTATION_ASSET", self.seg_asset)):
            patch.start()
            self.addCleanup(patch.stop)
        seg_path = self.root / models.SEGMENTATION_MODEL
        seg_path.parent.mkdir()
        seg_path.write_bytes(self.seg)

    def test_size_mismatch_reports_path_and_preserves_file(self):
        path = self.root / DEFAULT
        path.write_bytes(b"short")
        with self.assertRaises(models.ModelVerificationError) as caught:
            models.ensure_models(str(self.root))
        error = caught.exception
        self.assertEqual(error.reason, "verification_failed")
        self.assertEqual(error.check, "size")
        self.assertIn(str(path), str(error))
        self.assertIn("size mismatch", str(error))
        self.assertIn("expected " + str(len(self.payload)), str(error))
        self.assertEqual(path.read_bytes(), b"short")

    def test_sha256_mismatch_reports_path_and_preserves_file(self):
        path = self.root / DEFAULT
        data = b"x" * len(self.payload)
        path.write_bytes(data)
        with self.assertRaises(models.ModelVerificationError) as caught:
            models.ensure_models(str(self.root))
        error = caught.exception
        self.assertEqual(error.check, "sha256")
        self.assertIn(str(path), str(error))
        self.assertIn("SHA-256 mismatch", str(error))
        self.assertEqual(path.read_bytes(), data)

    def test_download_failure_is_classified_and_leaves_no_cache(self):
        with mock.patch.object(models.subprocess, "run",
                               side_effect=subprocess.CalledProcessError(22, "curl")):
            with self.assertRaises(models.ModelDownloadError) as caught:
                models.ensure_models(str(self.root))
        self.assertEqual(caught.exception.reason, "download_failed")
        self.assertIn("speaker-recongition-models/" + DEFAULT, str(caught.exception))
        self.assertIn("download failed", str(caught.exception))
        self.assertFalse((self.root / DEFAULT).exists())
        self.assertFalse(list(self.root.rglob(".diarization-*")))

    def test_local_files_only_missing_model_reports_path(self):
        with mock.patch.object(models.subprocess, "run") as curl:
            with self.assertRaises(models.ModelNotCachedError) as caught:
                models.ensure_models(str(self.root), local_files_only=True)
            curl.assert_not_called()
        self.assertEqual(caught.exception.reason, "model_not_cached")
        self.assertIn(str(self.root / DEFAULT), str(caught.exception))

    def test_successful_cached_models_are_reused(self):
        (self.root / DEFAULT).write_bytes(self.payload)
        with mock.patch.object(models.subprocess, "run") as curl:
            seg_path, emb_path = models.ensure_models(str(self.root), local_files_only=True)
            curl.assert_not_called()
        self.assertEqual((Path(seg_path).read_bytes(), Path(emb_path).read_bytes()),
                         (self.seg, self.payload))

    def test_failed_download_verification_uses_verification_reason(self):
        def short_download(command, **_kwargs):
            Path(command[command.index("--output") + 1]).write_bytes(b"short")

        with mock.patch.object(models.subprocess, "run", side_effect=short_download):
            with self.assertRaises(models.ModelVerificationError) as caught:
                models.ensure_models(str(self.root))
        self.assertEqual(caught.exception.reason, "verification_failed")
        self.assertEqual(caught.exception.check, "size")
        self.assertFalse((self.root / DEFAULT).exists())


class EndToEndDegradationTests(unittest.TestCase):
    """Four scenarios driven through the real loader, /health and verbose_json."""

    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        self.seg = b"segmentation fixture"
        self.payload = b"embedding fixture"
        self.asset = models.ModelAsset(len(self.payload), hashlib.sha256(self.payload).hexdigest())
        self.seg_asset = models.ModelAsset(len(self.seg), hashlib.sha256(self.seg).hexdigest())
        for patch in (
            mock.patch.dict(models.EMBEDDING_MODELS, {DEFAULT: self.asset}, clear=True),
            mock.patch.object(models, "_SEGMENTATION_ASSET", self.seg_asset),
            mock.patch.object(api_server, "_model", _Model()),
            mock.patch.object(api_server, "_model_name", "tiny"),
            mock.patch.object(api_server, "_max_upload_bytes", 0),
            mock.patch.object(api_server, "_word_timestamps", False),
            mock.patch.object(api_server, "_condition_on_previous_text", True),
            mock.patch.object(api_server, "_no_repeat_ngram_size", 0),
            mock.patch.object(api_server, "_diarization_enabled", False),
            mock.patch.object(api_server, "_diarization_requested", False),
            mock.patch.object(api_server, "_diarization_error", None),
            mock.patch.object(api_server, "_diarize_embedding_model", DEFAULT),
            mock.patch.dict(os.environ, {"WHISPER_DIARIZATION": "true",
                                         "WHISPER_LANGUAGE": "auto"}),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def _loading_diarizer(self, *, prepare):
        """Stand-in diarizer that verifies models, like the real load() first step."""
        module = _fake_diarizer()

        def load(cache_dir, embedding_model, **_kwargs):
            if prepare:
                (self.root / DEFAULT).write_bytes(self.payload)
                seg_path = self.root / models.SEGMENTATION_MODEL
                seg_path.parent.mkdir(parents=True, exist_ok=True)
                seg_path.write_bytes(self.seg)
            models.ensure_models(cache_dir, embedding_model,
                                 local_files_only=bool(os.environ.get("WHISPER_LOCAL_ONLY")))

        module.load = load
        return module

    def _start(self, *, prepare, local_only=False):
        env = {"HF_HOME": str(self.root),
               "WHISPER_LOCAL_ONLY": "true" if local_only else ""}
        with mock.patch.dict(os.environ, env), \
                mock.patch.dict(sys.modules, {"diarizer": self._loading_diarizer(prepare=prepare)}):
            api_server._load_diarizer()

    def _verbose(self):
        with mock.patch.dict(sys.modules, {"diarizer": _fake_diarizer()}):
            return asyncio.run(api_server._handle_audio(
                task="transcribe", file=_Upload(), model="whisper-1", language=None,
                prompt=None, response_format="verbose_json", temperature=0,
                stream=None, beam=None,
            )).content

    def _prepare_segmentation(self):
        seg_path = self.root / models.SEGMENTATION_MODEL
        seg_path.parent.mkdir(parents=True, exist_ok=True)
        seg_path.write_bytes(self.seg)

    def test_success_reports_available_and_has_no_degradation_field(self):
        self._start(prepare=True)
        self.assertEqual(asyncio.run(api_server.health())["diarization"],
                         {"status": "available"})
        content = self._verbose()
        self.assertEqual(content["segments"][0]["speaker"], "SPEAKER_00")
        self.assertNotIn("diarization", content)

    def test_download_failure_degrades_verbosely_and_in_health(self):
        self._prepare_segmentation()
        with mock.patch.object(models.subprocess, "run",
                               side_effect=subprocess.CalledProcessError(22, "curl")):
            self._start(prepare=False)
        health = asyncio.run(api_server.health())
        self.assertEqual(health["status"], "ok")
        self.assertEqual(health["diarization"]["status"], "unavailable")
        self.assertEqual(health["diarization"]["reason"], "download_failed")
        self.assertIn("speaker-recongition-models/" + DEFAULT, health["diarization"]["detail"])
        content = self._verbose()
        self.assertEqual(content["text"], "hello")
        self.assertNotIn("speaker", content["segments"][0])
        self.assertEqual(content["diarization"]["reason"], "download_failed")

    def test_hash_mismatch_degrades_with_path_and_preserves_file(self):
        self._prepare_segmentation()
        corrupt = b"x" * len(self.payload)
        path = self.root / DEFAULT
        path.write_bytes(corrupt)
        with mock.patch.object(models.subprocess, "run") as curl:
            self._start(prepare=False)
            curl.assert_not_called()
        self.assertEqual(path.read_bytes(), corrupt)
        diarization = asyncio.run(api_server.health())["diarization"]
        self.assertEqual(diarization["status"], "unavailable")
        self.assertEqual(diarization["reason"], "verification_failed")
        self.assertIn(str(path), diarization["detail"])
        self.assertIn("SHA-256 mismatch", diarization["detail"])
        self.assertEqual(self._verbose()["diarization"]["reason"], "verification_failed")

    def test_local_files_only_missing_models_degrades_as_not_cached(self):
        self._prepare_segmentation()
        with mock.patch.object(models.subprocess, "run") as curl:
            self._start(prepare=False, local_only=True)
            curl.assert_not_called()
        diarization = asyncio.run(api_server.health())["diarization"]
        self.assertEqual(diarization["reason"], "model_not_cached")
        self.assertIn(str(self.root / DEFAULT), diarization["detail"])
        content = self._verbose()
        self.assertEqual(content["diarization"]["reason"], "model_not_cached")
        self.assertEqual(content["text"], "hello")


if __name__ == "__main__":
    unittest.main()
