import sys
import types
from types import SimpleNamespace
from unittest import mock

import numpy as np
import torch

from ssak.utils import vad

from .utils import Test


def _segments_in_analysis_samples(segments):
    """Fake silero detector: `segments` are expressed in samples of the analysis timeline."""
    calls = []

    def fake_get_speech_ts(audio, model, **kwargs):
        calls.append({"length": int(audio.shape[-1]), "kwargs": kwargs})
        return [{"start": float(s), "end": float(e)} for s, e in segments]

    fake_get_speech_ts.calls = calls
    return fake_get_speech_ts


def _fake_auditok_module(segments):
    """Fake `auditok` module whose `split` returns `segments` (in seconds)."""
    module = types.ModuleType("auditok")
    module.__version__ = "0.3.0"
    calls = []

    def split(data, **kwargs):
        calls.append({"nbytes": len(data), "kwargs": kwargs})
        return [SimpleNamespace(start=s, end=e) for s, e in segments]

    module.split = split
    module.calls = calls
    return module


class _FakePipeline:
    def __init__(self, segments):
        self.segments = segments
        self.calls = []

    def __call__(self, data):
        self.calls.append({"num_samples": int(data["waveform"].shape[-1]), "sample_rate": data["sample_rate"]})
        return SimpleNamespace(get_timeline=lambda: SimpleNamespace(support=lambda: [SimpleNamespace(start=s, end=e) for s, e in self.segments]))


class TestVAD(Test):
    """Tests for get_vad_segments / remove_non_speech that do not download any model."""

    def _enter(self, patcher):
        patcher.start()
        self.addCleanup(patcher.stop)

    def _patch_silero(self, segments):
        fake = _segments_in_analysis_samples(segments)
        self._enter(mock.patch.object(vad, "silero_vad_model", object()))
        self._enter(mock.patch.object(vad, "silero_get_speech_ts", fake))
        return fake

    def _patch_pyannote(self, segments):
        pipeline = _FakePipeline(segments)
        self._enter(mock.patch.object(vad, "pyannote_vad_pipeline", pipeline))
        return pipeline

    def _patch_auditok(self, segments):
        module = _fake_auditok_module(segments)
        self._enter(mock.patch.dict(sys.modules, {"auditok": module}))
        return module

    def assert_segments_valid(self, segments, total, sample_units):
        """Segments must be ordered, non-empty, and within [0, total]."""
        previous_end = 0
        for seg in segments:
            self.assertLessEqual(0, seg["start"])
            self.assertLessEqual(seg["start"], seg["end"])
            self.assertLessEqual(seg["end"], total)
            self.assertGreaterEqual(seg["start"], previous_end)
            previous_end = seg["end"]
            if sample_units:
                self.assertIsInstance(seg["start"], int)
                self.assertIsInstance(seg["end"], int)
            else:
                self.assertIsInstance(seg["start"], float)
                self.assertIsInstance(seg["end"], float)

    # ---------------------------------------------------------------- units / boundaries

    def test_silero_resampled_input_returns_original_timeline(self):
        # 1 second at 22050 Hz: analysis timeline is 16000 samples, original timeline 22050 samples.
        sample_rate = 22050
        audio = torch.zeros(22050)
        fake = self._patch_silero([(1600, 4800), (12800, 16500)])  # second segment ends past the analysis audio
        self.assertGreater(16500, 16000)

        segments = vad.get_vad_segments(audio, sample_rate=sample_rate, method="silero", output_sample=True)
        self.assertEqual(fake.calls[0]["length"], 16000)  # internally resampled
        self.assertEqual(len(segments), 2)
        self.assert_segments_valid(segments, 22050, sample_units=True)
        self.assertEqual(segments[0], {"start": 2205, "end": 6615})
        # The over-flowing end is clamped to the ORIGINAL audio length (not to 16000).
        self.assertEqual(segments[1]["end"], 22050)

        segments_seconds = vad.get_vad_segments(audio, sample_rate=sample_rate, method="silero", output_sample=False)
        self.assert_segments_valid(segments_seconds, 22050 / sample_rate, sample_units=False)
        self.assertAlmostEqual(segments_seconds[0]["start"], 0.1)
        self.assertAlmostEqual(segments_seconds[0]["end"], 0.3)
        self.assertAlmostEqual(segments_seconds[1]["start"], 0.8)
        self.assertAlmostEqual(segments_seconds[1]["end"], 1.0)
        # Both representations describe the same instants.
        for seg_s, seg_n in zip(segments_seconds, segments):
            self.assertAlmostEqual(seg_s["start"], seg_n["start"] / sample_rate, places=6)
            self.assertAlmostEqual(seg_s["end"], seg_n["end"] / sample_rate, places=6)

    def test_silero_non_integer_resampling_ratio(self):
        # 1000 samples at 22050 Hz are resampled to 726 samples at 16000 Hz.
        sample_rate = 22050
        audio = torch.zeros(1000)
        self._patch_silero([(0, 726)])

        segments = vad.get_vad_segments(audio, sample_rate=sample_rate, method="silero", output_sample=True)
        self.assertEqual(len(segments), 1)
        self.assert_segments_valid(segments, 1000, sample_units=True)
        # A naive "resampled length" implementation would return 726 here.
        self.assertEqual(segments[0]["end"], 1000)

        segments_seconds = vad.get_vad_segments(audio, sample_rate=sample_rate, method="silero", output_sample=False)
        self.assertAlmostEqual(segments_seconds[0]["end"], 1000 / sample_rate, places=6)

    def test_auditok_native_sample_rate_units(self):
        sample_rate = 16000
        audio = np.zeros(16000, dtype=np.float32)
        fake = self._patch_auditok([(0.25, 0.5), (0.75, 1.5)])  # second end is past the audio duration

        segments = vad.get_vad_segments(audio, sample_rate=sample_rate, method="auditok", output_sample=True)
        self.assertEqual(fake.calls[0]["kwargs"]["sampling_rate"], sample_rate)
        self.assert_segments_valid(segments, 16000, sample_units=True)
        self.assertEqual(segments[0], {"start": 4000, "end": 8000})
        self.assertEqual(segments[1]["start"], 12000)
        self.assertEqual(segments[1]["end"], 16000)  # clamped

        segments_seconds = vad.get_vad_segments(audio, sample_rate=sample_rate, method="auditok", output_sample=False)
        self.assert_segments_valid(segments_seconds, 1.0, sample_units=False)
        self.assertAlmostEqual(segments_seconds[1]["end"], 1.0)

    def test_pyannote_native_sample_rate_units(self):
        sample_rate = 8000
        audio = torch.zeros(8000)
        pipeline = self._patch_pyannote([(0.1, 0.2), (0.5, 2.0)])

        segments = vad.get_vad_segments(audio, sample_rate=sample_rate, method="pyannote", output_sample=True)
        self.assertEqual(pipeline.calls[0]["sample_rate"], sample_rate)
        self.assert_segments_valid(segments, 8000, sample_units=True)
        self.assertEqual(segments[0], {"start": 800, "end": 1600})
        self.assertEqual(segments[1]["end"], 8000)

    def test_dilatation_does_not_overflow(self):
        # 32000 Hz -> 16000 Hz is an exact ratio of 2, making expectations easy to write.
        sample_rate = 32000
        audio = torch.zeros(32000)
        self._patch_silero([(15000, 16000)])

        segments = vad.get_vad_segments(audio, sample_rate=sample_rate, method="silero", output_sample=True, dilatation=0.1)
        self.assert_segments_valid(segments, 32000, sample_units=True)
        # Analysis timeline: [15000 - 1600, 16000] (end clamped to the analysis audio).
        # Back in original samples (ratio 2): [26800, 32000].
        self.assertEqual(segments[0], {"start": 26800, "end": 32000})

        segments_seconds = vad.get_vad_segments(audio, sample_rate=sample_rate, method="silero", output_sample=False, dilatation=0.1)
        self.assert_segments_valid(segments_seconds, 1.0, sample_units=False)
        self.assertAlmostEqual(segments_seconds[0]["end"], 1.0)

    def test_dilatation_merges_adjacent_segments(self):
        sample_rate = 32000
        audio = torch.zeros(32000)
        # 0.1 s of dilatation = 1600 samples in the analysis timeline.
        self._patch_silero([(2000, 3000), (3200, 4000)])

        segments = vad.get_vad_segments(audio, sample_rate=sample_rate, method="silero", output_sample=True, dilatation=0.1)
        self.assertEqual(len(segments), 1)
        self.assert_segments_valid(segments, 32000, sample_units=True)
        self.assertEqual(segments[0], {"start": 800, "end": 11200})

    # ---------------------------------------------------------------- empty / silent audio

    def test_empty_audio_returns_empty_list(self):
        for output_sample in (False, True):
            self.assertEqual(vad.get_vad_segments(np.zeros(0, dtype=np.float32), sample_rate=16000, method="auditok", output_sample=output_sample), [])
            self.assertEqual(vad.get_vad_segments(np.zeros(0, dtype=np.float32), sample_rate=16000, method="silero", output_sample=output_sample), [])

    def test_silence_returns_empty_list_for_all_methods(self):
        sample_rate = 22050
        audio = torch.zeros(22050)
        self._patch_silero([])
        self.assertEqual(vad.get_vad_segments(audio, sample_rate=sample_rate, method="silero", output_sample=True), [])

        audio_np = np.zeros(22050, dtype=np.float32)
        self._patch_auditok([])
        self.assertEqual(vad.get_vad_segments(audio_np, sample_rate=sample_rate, method="auditok", output_sample=False), [])

        self._patch_pyannote([])
        self.assertEqual(vad.get_vad_segments(audio, sample_rate=sample_rate, method="pyannote", output_sample=True), [])

    def test_audio_shorter_than_min_speech_duration_returns_empty_list(self):
        # Too short to hold any speech: must not raise (auditok raises on its own here).
        for num_samples in (1, 10, 100):
            audio = np.zeros(num_samples, dtype=np.float32)
            self.assertEqual(vad.get_vad_segments(audio, sample_rate=16000, method="auditok", output_sample=True), [])

    def test_stereo_input_does_not_change_timeline(self):
        sample_rate = 22050
        fake = self._patch_silero([(0, 1600)])
        stereo_channels_first = np.tile(np.linspace(0.0, 1.0, 2205, dtype=np.float32), (2, 1))
        segments = vad.get_vad_segments(stereo_channels_first, sample_rate=sample_rate, method="silero", output_sample=True)
        self.assertEqual(fake.calls[0]["length"], 1600)  # resampled (N,), not (channels,)
        self.assert_segments_valid(segments, 2205, sample_units=True)
        self.assertEqual(segments[0]["end"], 2205)

        stereo_samples_first = stereo_channels_first.T  # (samples, channels)
        segments = vad.get_vad_segments(stereo_samples_first, sample_rate=sample_rate, method="silero", output_sample=False)
        self.assertEqual(fake.calls[1]["length"], 1600)
        self.assert_segments_valid(segments, 2205 / sample_rate, sample_units=False)
        self.assertAlmostEqual(segments[0]["end"], 0.1)

    # ---------------------------------------------------------------- remove_non_speech

    def _ramp_audio(self, num_samples):
        """Short deterministic audio whose sample values identify their index."""
        return torch.arange(num_samples, dtype=torch.float32) / num_samples

    def test_remove_non_speech_no_speech_keeps_whole_audio(self):
        # Silent (here: constant) audio resampled internally: the fallback must keep
        # the whole ORIGINAL audio, not the internally resampled one.
        sample_rate = 22050
        audio = self._ramp_audio(2205)
        self._patch_silero([])
        audio_speech, mapping = vad.remove_non_speech(audio, sample_rate=sample_rate, method="silero")

        self.assertEqual(audio_speech.shape, audio.shape)
        self.assertTrue(torch.equal(audio_speech, audio))
        self.assertEqual(mapping(0.0), 0.0)
        self.assertAlmostEqual(mapping(0.1), 0.1)
        self.assertLessEqual(mapping(0.2), 2205 / sample_rate)  # beyond the concatenated timeline: clamped
        self.assertEqual(mapping(0.0, 0.1), [0.0, 0.1])

    def test_remove_non_speech_single_segment_mapping(self):
        sample_rate = 16000
        audio = self._ramp_audio(1600)
        segments = [{"start": 400, "end": 800}]
        with mock.patch.object(vad, "get_vad_segments", return_value=segments):
            audio_speech, mapping = vad.remove_non_speech(audio, sample_rate=sample_rate, method="silero")

        self.assertEqual(audio_speech.shape[-1], 400)
        self.assertTrue(torch.equal(audio_speech, audio[400:800]))
        self.assertAlmostEqual(mapping(0.0), 0.025)
        self.assertAlmostEqual(mapping(400 / sample_rate), 0.05)
        # Past the end of the concatenated timeline, the result stays in the original range.
        self.assertLessEqual(mapping(0.1), 1600 / sample_rate)

    def test_remove_non_speech_multi_segment_mapping(self):
        sample_rate = 16000
        num_samples = 160000  # 10 s
        audio = self._ramp_audio(num_samples)
        segments = [{"start": 16000, "end": 32000}, {"start": 64000, "end": 96000}, {"start": 128000, "end": 160000}]
        with mock.patch.object(vad, "get_vad_segments", return_value=segments):
            audio_speech, mapping = vad.remove_non_speech(audio, sample_rate=sample_rate, method="silero")

        # 1 s + 2 s + 2 s of speech concatenated.
        self.assertEqual(audio_speech.shape[-1], 80000)
        self.assertTrue(torch.equal(audio_speech, torch.cat([audio[16000:32000], audio[64000:96000], audio[128000:160000]])))

        duration = num_samples / sample_rate
        self.assertAlmostEqual(mapping(0.0), 1.0)
        self.assertAlmostEqual(mapping(0.5), 1.5)  # still in the first segment
        self.assertAlmostEqual(mapping(1.0), 2.0)
        self.assertAlmostEqual(mapping(1.5), 4.5)  # second segment: 4 s + 0.5 s
        self.assertAlmostEqual(mapping(3.0), 6.0)
        self.assertAlmostEqual(mapping(5.0), 10.0)  # end of the concatenated timeline
        self.assertLessEqual(mapping(5.5), duration)  # past the end: stays within the original audio

        # Monotonic non-decreasing and in range, across all speech segments.
        previous = -1.0
        for t in np.linspace(0.0, 6.0, 601):
            value = mapping(float(t))
            self.assertGreaterEqual(value, previous)
            self.assertGreaterEqual(value, 0.0)
            self.assertLessEqual(value, duration)
            previous = value

        # Two timestamps are mapped in order and stay in range.
        for t, t2 in [(0.0, 0.5), (1.5, 3.0), (4.5, 5.0), (5.0, 6.0)]:
            start, end = mapping(t, t2)
            self.assertGreaterEqual(start, 0.0)
            self.assertLessEqual(end, duration)
            self.assertLessEqual(start, end)

    def test_remove_non_speech_multi_segment_mapping_in_samples(self):
        sample_rate = 16000
        num_samples = 160000
        audio = self._ramp_audio(num_samples)
        segments = [{"start": 16000, "end": 32000}, {"start": 64000, "end": 96000}, {"start": 128000, "end": 160000}]
        with mock.patch.object(vad, "get_vad_segments", return_value=segments):
            audio_speech, mapping = vad.remove_non_speech(audio, sample_rate=sample_rate, method="silero", use_sample=True)

        self.assertEqual(audio_speech.shape[-1], 80000)
        self.assertEqual(mapping(0), 16000)
        self.assertEqual(mapping(80000), 160000)  # end of the concatenated timeline
        self.assertLessEqual(mapping(90000), num_samples)
        previous = -1
        for t in range(0, 90001, 500):
            value = mapping(t)
            self.assertGreaterEqual(value, previous)
            self.assertLessEqual(value, num_samples)
            previous = value

    def test_remove_non_speech_gap_at_end_mapping(self):
        sample_rate = 16000
        audio = self._ramp_audio(4000)
        # Audio ends with 1500 samples of silence after the last speech segment.
        segments = [{"start": 0, "end": 1000}, {"start": 2000, "end": 2500}]
        with mock.patch.object(vad, "get_vad_segments", return_value=segments):
            audio_speech, mapping = vad.remove_non_speech(audio, sample_rate=sample_rate, method="silero")

        self.assertEqual(audio_speech.shape[-1], 1500)
        self.assertAlmostEqual(mapping(1500 / sample_rate), 2500 / sample_rate)
        self.assertGreaterEqual(mapping(2000 / sample_rate), mapping(1500 / sample_rate))
        self.assertLessEqual(mapping(2000 / sample_rate), 4000 / sample_rate)

    def test_remove_non_speech_empty_audio(self):
        audio = torch.zeros(0)
        with mock.patch.object(vad, "get_vad_segments", return_value=[]):
            audio_speech, mapping = vad.remove_non_speech(audio, sample_rate=16000, method="silero")
        self.assertEqual(audio_speech.shape[-1], 0)
        self.assertEqual(mapping(0.0), 0.0)

    def test_remove_non_speech_with_real_auditok_short_audio(self):
        # End-to-end on a synthetic short audio, no model download involved.
        try:
            import auditok  # noqa: F401
        except ImportError:
            self.skipTest("auditok is not installed")

        sample_rate = 8000
        rng = np.random.default_rng(0)
        audio = np.concatenate(
            [
                (0.3 * rng.standard_normal(int(0.3 * sample_rate))).astype(np.float32),  # speech-like noise
                np.zeros(int(0.2 * sample_rate), dtype=np.float32),  # silence
                (0.3 * np.sin(2 * np.pi * 300 * np.arange(int(0.3 * sample_rate)) / sample_rate)).astype(np.float32),
            ]
        )
        duration = len(audio) / sample_rate

        segments = vad.get_vad_segments(audio, sample_rate=sample_rate, method="auditok", output_sample=False)
        self.assertGreater(len(segments), 0)
        self.assert_segments_valid(segments, duration, sample_units=False)

        audio_speech, mapping = vad.remove_non_speech(audio, sample_rate=sample_rate, method="auditok")
        self.assertLessEqual(audio_speech.shape[-1], audio.shape[-1])
        previous = -1.0
        for t in np.linspace(0.0, duration * 2, 401):
            value = mapping(float(t))
            self.assertGreaterEqual(value, previous)
            self.assertGreaterEqual(value, 0.0)
            self.assertLessEqual(value, duration)
            previous = value

    def test_remove_non_speech_with_real_auditok_silent_audio(self):
        try:
            import auditok  # noqa: F401
        except ImportError:
            self.skipTest("auditok is not installed")

        sample_rate = 8000
        audio = np.zeros(sample_rate, dtype=np.float32)
        self.assertEqual(vad.get_vad_segments(audio, sample_rate=sample_rate, method="auditok"), [])

        audio_speech, mapping = vad.remove_non_speech(audio, sample_rate=sample_rate, method="auditok")
        # No speech: the whole audio is kept, and the mapping stays in range.
        self.assertEqual(audio_speech.shape, audio.shape)
        self.assertEqual(mapping(0.0), 0.0)
        self.assertAlmostEqual(mapping(1.0), 1.0)
        self.assertLessEqual(mapping(2.0), 1.0)
