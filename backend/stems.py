"""Vocal-stem analysis of the mix regions (track intro and outro).

The single most common auto-DJ failure is fading one vocal over another. To
avoid it we separate the vocal stem with Demucs and measure where vocals are
present near the start and end of a track. Running Demucs on the whole file is
slow on CPU, so we only separate the head and tail windows that a crossfade can
ever touch.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

# Only analyze this many seconds at each end — a crossfade never reaches deeper.
REGION_SECONDS = 45.0
# Vocal frames louder than this fraction of the track's vocal peak count as "sung".
VOCAL_ACTIVE_RATIO = 0.12
FRAME_SECONDS = 0.1

_model = None


def _get_model():
    """Lazily load htdemucs once so importing this module stays cheap."""
    global _model
    if _model is not None:
        return _model
    from demucs.pretrained import get_model

    model = get_model("htdemucs")
    model.eval()
    _model = model
    return model


def analyze_vocals(path: str, duration: float) -> dict[str, Any]:
    """Return vocal-free intro/outro lengths and density for the mix regions."""
    try:
        model = _get_model()
    except Exception as exc:  # demucs missing or model download blocked
        return {"available": False, "reason": str(exc)}

    try:
        from demucs.audio import AudioFile

        # Demucs' own ffmpeg-backed loader handles mp3/m4a/wav and resampling,
        # avoiding the TorchCodec dependency newer torchaudio.load now requires.
        sr = model.samplerate
        wav = AudioFile(path).read(
            samplerate=sr,
            channels=model.audio_channels,
        )
        if wav.dim() == 3:  # (streams, channels, length) -> (channels, length)
            wav = wav[0]
        region = int(REGION_SECONDS * sr)

        head = wav[:, :region]
        tail = wav[:, -region:] if wav.shape[1] > region else wav

        intro = _vocal_envelope(model, head, sr)
        outro = _vocal_envelope(model, tail, sr)

        intro_free = _leading_silence(intro)
        # In the tail, vocals end somewhere; the vocal-free outro is the trailing run.
        outro_free = _trailing_silence(outro)

        return {
            "available": True,
            "vocalIntro": round(intro_free, 2),
            "vocalOutro": round(outro_free, 2),
            "introVocalFreeSeconds": round(intro_free, 2),
            "outroVocalFreeSeconds": round(outro_free, 2),
            "firstVocalAt": round(intro_free, 2),
            "lastVocalAt": round(max(0.0, duration - outro_free), 2),
            "vocalDensityIntro": round(_density(intro), 3),
            "vocalDensityOutro": round(_density(outro), 3),
        }
    except Exception as exc:
        return {"available": False, "reason": str(exc)}


def _vocal_envelope(model, wav, sr) -> np.ndarray:
    """RMS envelope (per 100ms frame) of the separated vocal stem.

    `wav` may be a head/tail window (head/tail-only API) or the whole track
    (full-track timeline); htdemucs auto-splits internally on CPU either way.
    """
    import torch
    from demucs.apply import apply_model

    ref = wav.mean(dim=0)
    std = ref.std() + 1e-8
    normalized = (wav - ref.mean()) / std

    with torch.no_grad():
        sources = apply_model(model, normalized[None], device="cpu", progress=False)[0]
    sources = sources * std + ref.mean()

    vocals = sources[model.sources.index("vocals")]
    mono = vocals.mean(dim=0) if vocals.dim() > 1 else vocals

    frame = max(1, int(FRAME_SECONDS * sr))
    samples = mono.detach().cpu().numpy().astype(np.float32)
    n = len(samples) // frame
    if n == 0:
        return np.zeros(1, dtype=np.float32)
    trimmed = samples[: n * frame].reshape(n, frame)
    return np.sqrt(np.mean(trimmed * trimmed, axis=1))


# Soft gate mapping the normalized vocal envelope (vs the track's vocal peak)
# onto a 0..1 risk: clearly-silent -> 0, clearly-sung -> 1, graded between.
VOCAL_GATE_LO = 0.06
VOCAL_GATE_HI = 0.40


def _aggregate_vocal_risk(
    env: np.ndarray, frame_seconds: float, step: float, n_windows: int
) -> list[float]:
    """Aggregate a 100ms vocal RMS envelope into `n_windows` of `step` seconds.

    Normalizes vs the envelope peak, applies the soft gate, then takes the max
    risk inside each window so a sung phrase anywhere in the second wins. Returns
    a list of length `n_windows` (index-aligned with analysis.timeline.t).
    """
    out = [0.0] * n_windows
    if env.size == 0 or n_windows <= 0:
        return out
    peak = float(np.max(env))
    if peak <= 1e-6:
        return out
    env_norm = env / peak
    risk = np.clip((env_norm - VOCAL_GATE_LO) / (VOCAL_GATE_HI - VOCAL_GATE_LO), 0.0, 1.0)
    frames_per_window = max(1, int(round(step / frame_seconds)))
    for w in range(n_windows):
        start = w * frames_per_window
        end = min(risk.size, start + frames_per_window)
        if start >= risk.size:
            break
        out[w] = round(float(np.max(risk[start:end])), 4)
    return out


def vocal_activity_timeline(
    path: str, duration: float, step: float = 1.0
) -> dict[str, Any] | None:
    """Full-track per-second vocal-presence timeline from the Demucs vocal stem.

    Runs Demucs on the WHOLE track (htdemucs auto-splits on CPU), extracts the
    vocal stem, computes a 100ms RMS envelope and aggregates it into `step`-second
    windows. Returns {"vocalRisk": [0..1] of length == timeline windows,
    "firstVocalAt", "lastVocalAt"} or None on ANY failure so the caller falls back
    to the heuristic VAD. Never crashes analysis.
    """
    try:
        model = _get_model()
    except Exception:  # demucs missing or model download blocked
        return None

    try:
        from demucs.audio import AudioFile

        sr = model.samplerate
        wav = AudioFile(path).read(samplerate=sr, channels=model.audio_channels)
        if wav.dim() == 3:  # (streams, channels, length) -> (channels, length)
            wav = wav[0]

        env = _vocal_envelope(model, wav, sr)

        n_windows = max(1, int(math.ceil(duration / step))) if duration > 0 else 1
        risk = _aggregate_vocal_risk(env, FRAME_SECONDS, step, n_windows)

        first_vocal = duration
        last_vocal = 0.0
        any_vocal = False
        for w, r in enumerate(risk):
            if r > 0.5:
                t = w * step
                if not any_vocal:
                    first_vocal = t
                last_vocal = t
                any_vocal = True
        if not any_vocal:
            first_vocal, last_vocal = 0.0, duration

        return {
            "vocalRisk": risk,
            "firstVocalAt": round(float(first_vocal), 2),
            "lastVocalAt": round(float(last_vocal), 2),
        }
    except Exception:
        return None


def _active_mask(env: np.ndarray) -> np.ndarray:
    peak = float(np.max(env)) if env.size else 0.0
    if peak <= 1e-6:
        return np.zeros_like(env, dtype=bool)
    return env >= peak * VOCAL_ACTIVE_RATIO


def _leading_silence(env: np.ndarray) -> float:
    mask = _active_mask(env)
    idx = int(np.argmax(mask)) if mask.any() else len(mask)
    return idx * FRAME_SECONDS


def _trailing_silence(env: np.ndarray) -> float:
    mask = _active_mask(env)
    if not mask.any():
        return len(mask) * FRAME_SECONDS
    last = len(mask) - 1 - int(np.argmax(mask[::-1]))
    return (len(mask) - 1 - last) * FRAME_SECONDS


def _density(env: np.ndarray) -> float:
    mask = _active_mask(env)
    return float(np.mean(mask)) if mask.size else 0.0
