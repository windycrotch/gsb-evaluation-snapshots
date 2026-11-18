"""Offline, synthetic-audio tests for the heuristic vocal-bound fallback.

The acceptance scenario: `/analyze?stems=false` (Demucs unavailable) must still
report a usable vocal window so the frontend can avoid fading one vocal over
another, and the mix candidate scorer must demote sung bars. Nothing here loads
a real Demucs model: the authoritative path is exercised with a stub.
"""

from __future__ import annotations

import io
import math

import numpy as np
import pytest

from backend import app as analyzer
from backend import stems


SAMPLE_RATE = 22050
DURATION = 30.0
VOCAL_START = 3.0
VOCAL_END = 16.0


def _write_wav(path, samples, sr=SAMPLE_RATE) -> str:
    import soundfile

    soundfile.write(str(path), samples.astype(np.float32), sr, subtype="PCM_16")
    return str(path)


def _synthetic_vocal_track(path) -> str:
    """3s of silence, then a clearly vocal-band, tonal section until 16s."""
    n = int(SAMPLE_RATE * DURATION)
    t = np.arange(n) / SAMPLE_RATE
    rng = np.random.default_rng(7)
    audio = np.zeros(n, dtype=np.float64)

    mask = (t >= VOCAL_START) & (t < VOCAL_END)
    f0 = 220.0 * (1.0 + 0.01 * np.sin(2 * np.pi * 5.0 * t))
    phase = 2 * np.pi * np.cumsum(f0) / SAMPLE_RATE
    voice = sum(np.sin(h * phase) / h for h in range(1, 7))
    envelope = 0.55 + 0.45 * np.sin(2 * np.pi * 0.7 * t) ** 2
    audio[mask] += (voice * envelope)[mask]

    audio += 0.25 * np.sin(2 * np.pi * 90.0 * t)
    audio += 0.10 * rng.standard_normal(n) * (t > VOCAL_START)
    audio *= 0.5 / max(1e-9, float(np.max(np.abs(audio))))
    return _write_wav(path, audio)


def _stationary_noise_track(path) -> str:
    """No tonal structure at all: the heuristic must report 'no evidence'."""
    n = SAMPLE_RATE * 12
    rng = np.random.default_rng(3)
    return _write_wav(path, rng.standard_normal(n) * 1e-4, sr=16000)


@pytest.fixture(scope="module")
def vocal_track(tmp_path_factory) -> str:
    return _synthetic_vocal_track(tmp_path_factory.mktemp("audio") / "vocal.wav")


@pytest.fixture(scope="module")
def noise_track(tmp_path_factory) -> str:
    return _stationary_noise_track(tmp_path_factory.mktemp("audio") / "noise.wav")


# --- heuristic bounds -------------------------------------------------------


def test_degraded_analysis_reports_heuristic_vocal_window(vocal_track):
    result = analyzer.analyze_file(vocal_track, use_stems=False)

    assert result["vocalSource"] == "heuristic"
    assert result["timeline"]["vocalSource"] == "heuristic"
    first, last = result["firstVocalAt"], result["lastVocalAt"]
    assert first is not None and last is not None
    assert 0.0 <= first <= last <= result["duration"]

    # The synthesized voice really does start at 3s and stop at 16s.
    assert abs(first - VOCAL_START) <= 1.0
    assert abs(last - (VOCAL_END - 1.0)) <= 2.0


def test_no_vocal_evidence_spans_whole_track(noise_track):
    result = analyzer.analyze_file(noise_track, use_stems=False)

    assert result["vocalSource"] == "heuristic"
    assert result["firstVocalAt"] == 0.0
    assert result["lastVocalAt"] == pytest.approx(result["duration"])


def test_bounds_are_clamped_and_ordered():
    timeline = {"t": [0.0, 1.0, 2.0], "vocalRisk": [0.9, 0.9, 0.9], "mid": [0.5, 0.5, 0.5]}
    first, last = analyzer.heuristic_vocal_bounds(timeline, 1.5)
    assert (first, last) == (0.0, 1.5)

    timeline = {"t": [0.0, 1.0, 2.0], "vocalRisk": [0.0, 0.0, 0.0], "mid": [0.1, 0.1, 0.1]}
    assert analyzer.heuristic_vocal_bounds(timeline, 9.0) == (0.0, 9.0)

    assert analyzer.heuristic_vocal_bounds({}, 12.0) == (0.0, 12.0)


def test_windows_inside_a_sung_window_are_flagged():
    """`heuristic_vocal_bounds` adds timestamps, not spans."""
    timeline = {
        "t": [0.0, 1.0, 2.0, 3.0],
        "vocalRisk": [0.1, 0.8, 0.2, 0.9],
        "mid": [0.10, 0.40, 0.10, 0.40],
    }
    assert analyzer.heuristic_vocal_bounds(timeline, 4.0) == (1.0, 3.0)


def test_windows_without_band_contrast_are_not_vocal():
    """A stationary track normalized to 0..1 must not fake a sung window."""
    timeline = {
        "t": [0.0, 1.0, 2.0, 3.0],
        "vocalRisk": [1.0, 0.0, 0.8, 0.0],
        "mid": [0.30, 0.30, 0.3005, 0.30],
    }
    assert analyzer.heuristic_vocal_bounds(timeline, 4.0) == (0.0, 4.0)


# --- Demucs precedence ------------------------------------------------------


def test_demucs_window_wins_over_heuristic(vocal_track, monkeypatch):
    def fake_timeline(path, duration, step=1.0):
        n = max(1, int(math.ceil(duration / step)))
        return {
            "vocalRisk": [0.9 if 10.0 <= i * step <= 20.0 else 0.0 for i in range(n)],
            "firstVocalAt": 10.0,
            "lastVocalAt": 20.0,
        }

    def fake_regions(path, duration):
        return {
            "available": True,
            "vocalIntro": 10.0,
            "vocalOutro": 10.0,
            "firstVocalAt": 10.0,
            "lastVocalAt": 20.0,
            "vocalDensityIntro": 0.0,
            "vocalDensityOutro": 0.0,
        }

    monkeypatch.setattr(stems, "vocal_activity_timeline", fake_timeline)
    monkeypatch.setattr(stems, "analyze_vocals", fake_regions)

    result = analyzer.analyze_file(vocal_track, use_stems=True)

    assert result["vocalSource"] == "demucs"
    assert result["timeline"]["vocalSource"] == "demucs"
    # Stubbed boundaries, NOT the heuristic 3.0/15.0.
    assert (result["firstVocalAt"], result["lastVocalAt"]) == (10.0, 20.0)


def test_failed_separation_falls_back_to_heuristic(vocal_track, monkeypatch):
    monkeypatch.setattr(stems, "vocal_activity_timeline", lambda *a, **k: None)
    monkeypatch.setattr(
        stems, "analyze_vocals", lambda *a, **k: {"available": False, "reason": "boom"}
    )

    result = analyzer.analyze_file(vocal_track, use_stems=True)

    assert result["vocalSource"] == "heuristic"
    assert result["firstVocalAt"] is not None and result["lastVocalAt"] is not None


def test_demucs_partial_window_is_completed(vocal_track, monkeypatch):
    """A Demucs map without boundaries must not leave the fields null."""
    def fake_timeline(path, duration, step=1.0):
        n = max(1, int(math.ceil(duration / step)))
        return {"vocalRisk": [0.9 if 8.0 <= i * step <= 18.0 else 0.0 for i in range(n)]}

    monkeypatch.setattr(stems, "vocal_activity_timeline", fake_timeline)
    monkeypatch.setattr(
        stems, "analyze_vocals", lambda *a, **k: {"available": False}
    )

    result = analyzer.analyze_file(vocal_track, use_stems=True)

    assert result["vocalSource"] == "demucs"
    assert result["firstVocalAt"] is not None and result["lastVocalAt"] is not None
    # Boundaries come from the stem curve itself, uncluttered by the spectral
    # band check that exists to sanity-check the heuristic VAD.
    assert (result["firstVocalAt"], result["lastVocalAt"]) == (8.0, 18.0)


# --- candidate scoring ------------------------------------------------------


def _timeline_for(sung: tuple[float, float], duration: float = 64.0):
    step = analyzer.TIMELINE_STEP
    n = int(duration / step)
    times = [i * step for i in range(n)]
    inside = lambda t: sung[0] <= t <= sung[1]
    return {
        "step": step,
        "t": times,
        "rms": [0.9 if inside(t) else 0.45 for t in times],
        "onset": [0.5] * n,
        "vocalRisk": [0.9 if inside(t) else 0.05 for t in times],
        "mid": [0.35 if inside(t) else 0.15 for t in times],
        "tension": [0.5] * n,
    }


PHRASING = {
    "barInterval": 2.0,
    "downbeat": 0.0,
    "phraseAnchor": 0.0,
    "phraseInterval": 8.0,
    "beatsPerPhrase": 16,
}


def _build(timeline, sung, heuristic):
    return analyzer.build_candidates(
        timeline,
        PHRASING,
        64.0,
        cue_in=0.0,
        cue_out=52.0,
        outro_start=52.0,
        beat_interval=0.5,
        struct_boundaries=[],
        first_vocal_at=sung[0],
        last_vocal_at=sung[1],
        vocal_bounds_heuristic=heuristic,
    )


def test_mixpoint_demotes_sung_bars_below_clean_bars():
    sung = (32.0, 44.0)
    candidates = _build(_timeline_for(sung), sung, heuristic=True)["mixPoint"]

    inside = [c for c in candidates if sung[0] <= c["t"] <= sung[1]]
    outside = [c for c in candidates if not (sung[0] <= c["t"] <= sung[1])]
    assert inside and outside
    assert max(c["score"] for c in inside) < min(c["score"] for c in outside)
    assert min(c["score"] for c in outside) - max(c["score"] for c in inside) >= 0.2

    for candidate in inside:
        assert any("cantato su cantato" in reason for reason in candidate["reasons"])
        assert any("finestra vocale stimata" in reason for reason in candidate["reasons"])


def test_demucs_sourced_window_uses_non_heuristic_wording():
    sung = (32.0, 44.0)
    candidates = _build(_timeline_for(sung), sung, heuristic=False)["mixPoint"]
    inside = [c for c in candidates if sung[0] <= c["t"] <= sung[1]]
    assert inside
    reasons = [reason for c in inside for reason in c["reasons"]]
    assert any("finestra vocale rilevata" in reason for reason in reasons)
    assert not any("stimata" in reason for reason in reasons)


def test_candidate_contract_is_unchanged():
    sung = (32.0, 44.0)
    candidates = _build(_timeline_for(sung), sung, heuristic=True)

    for kind in ("cueIn", "entryPoint", "mixPoint", "cueOut"):
        entries = candidates[kind]
        assert entries, kind
        scores = [c["score"] for c in entries]
        assert scores == sorted(scores, reverse=True), kind
        times = [c["t"] for c in entries]
        for left, right in zip(times, times[1:]):
            assert abs(left - right) > 1.5, kind
        for entry in entries:
            assert set(entry) == {"t", "score", "reasons"}, entry
            assert isinstance(entry["reasons"], list) and entry["reasons"]
            assert 0.0 <= entry["score"] <= 1.0


def test_intro_end_only_snaps_for_demucs_bounds():
    """The introEnd snap must fire for Demucs bounds but not for heuristic ones."""
    sung = (12.0, 24.0)
    timeline = _timeline_for(sung)

    def intro_end(heuristic, first_vocal_at):
        return analyzer.build_candidates(
            timeline,
            PHRASING,
            64.0,
            cue_in=0.0,
            cue_out=52.0,
            outro_start=52.0,
            beat_interval=0.5,
            struct_boundaries=[],
            first_vocal_at=first_vocal_at,
            last_vocal_at=sung[1],
            vocal_bounds_heuristic=heuristic,
        )["introEnd"]

    reference = intro_end(True, None)
    # The heuristic window never shortens the intro...
    assert intro_end(True, 6.0) == reference
    # ...while a Demucs window snaps introEnd to the bar just before the voice.
    assert intro_end(False, 6.0) != reference
    assert intro_end(False, 6.0) <= 6.0


# --- HTTP surface -----------------------------------------------------------


def test_analyze_endpoint_without_stems(vocal_track):
    from fastapi.testclient import TestClient

    payload = open(vocal_track, "rb").read()
    response = TestClient(analyzer.app).post(
        "/analyze?stems=false",
        files={"file": ("track.wav", io.BytesIO(payload), "audio/wav")},
    )
    assert response.status_code == 200
    data = response.json()

    assert data["vocalSource"] == "heuristic"
    first, last = data["firstVocalAt"], data["lastVocalAt"]
    assert isinstance(first, (int, float)) and isinstance(last, (int, float))
    assert 0.0 <= first <= last <= data["duration"]


def test_stale_cache_entries_are_ignored(monkeypatch, tmp_path):
    """Pre-v3 entries with null boundaries must not be served."""
    monkeypatch.setattr(analyzer, "CACHE_DIR", tmp_path)
    stale = {"firstVocalAt": None, "lastVocalAt": None, "vocalSource": "heuristic"}
    (tmp_path / "abc.json").write_text(__import__("json").dumps(stale), encoding="utf-8")

    assert analyzer._cache_read("abc") is None
