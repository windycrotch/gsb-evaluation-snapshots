from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
from pathlib import Path
from typing import Any

import essentia.standard as es
import librosa
import numpy as np
from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="AutoDJ AI local analyzer")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Full-track Demucs vocal mapping is the authoritative vocal signal, so stems are
# ON by default. Slow on CPU, but the analysis cache makes it one-time per track.
# Override with ?stems=false per-request or AUTODJ_STEMS=0 globally.
STEMS_DEFAULT = os.environ.get("AUTODJ_STEMS", "1") not in {"0", "false", "no"}

# Best-effort on-disk cache so whole-track Demucs runs only once per track.
CACHE_DIR = Path(os.path.expanduser("~/.cache/par8dj-ai/analysis"))


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "analyzer": ANALYZER_ID,
        "version": ANALYSIS_VERSION,
        "stemsDefault": STEMS_DEFAULT,
        "stemsOn": STEMS_DEFAULT,
    }


@app.post("/analyze")
async def analyze(file: UploadFile = File(...), stems: bool | None = None) -> dict[str, Any]:
    suffix = Path(file.filename or "track").suffix or ".audio"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp:
        temp.write(await file.read())
        temp_path = temp.name

    use_stems = STEMS_DEFAULT if stems is None else stems
    try:
        return analyze_file(temp_path, use_stems=use_stems)
    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            pass


# Target integrated loudness for normalization. -16 LUFS keeps most masters
# attenuated (never boosted into clipping) while matching perceived level.
TARGET_LUFS = -16.0

# Analysis schema version. Bump whenever the JSON shape changes so the frontend
# (and any cache) can migrate or fall back gracefully.
ANALYSIS_VERSION = 2
ANALYZER_ID = "par8dj-mixengine-v2"


def _cache_key(path: str, use_stems: bool) -> str | None:
    """md5 of file bytes + analysis version + stems mode. None if unreadable."""
    try:
        digest = hashlib.md5()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
        digest.update(str(ANALYSIS_VERSION).encode())
        digest.update(b"stems" if use_stems else b"nostems")
        return digest.hexdigest()
    except OSError:
        return None


def _cache_read(key: str | None) -> dict[str, Any] | None:
    if not key:
        return None
    try:
        with open(CACHE_DIR / f"{key}.json", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def _cache_write(key: str | None, result: dict[str, Any]) -> None:
    if not key:
        return
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = CACHE_DIR / f"{key}.json.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(result, handle)
        tmp.replace(CACHE_DIR / f"{key}.json")
    except (OSError, ValueError, TypeError):
        pass


def analyze_file(path: str, use_stems: bool = False) -> dict[str, Any]:
    """Cached entry point. Whole-track Demucs runs only once per (track, version)."""
    key = _cache_key(path, use_stems)
    cached = _cache_read(key)
    if cached is not None:
        return cached
    result = _analyze_file_uncached(path, use_stems=use_stems)
    _cache_write(key, result)
    return result


def _analyze_file_uncached(path: str, use_stems: bool = False) -> dict[str, Any]:
    y, sr = librosa.load(path, sr=22050, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
    times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=512)

    cue_in, cue_out, outro_start = detect_cue_points(rms, times, duration)
    energy = estimate_energy(rms)
    vocal_risk_start = detect_dense_intro_region(rms, times, cue_in)

    # Single Essentia MusicExtractor pass: BPM, key, beat grid and loudness.
    music = extract_music_features(path)
    bpm = music["bpm"]
    bpm_confidence = music["bpmConfidence"]
    key = music["key"]
    key_confidence = music["keyConfidence"]

    # Fallback to the librosa onset estimator if Essentia could not find a tempo.
    if bpm is None:
        bpm, bpm_confidence = detect_bpm(y, sr)

    beat_interval = round(60.0 / bpm, 4) if bpm else None

    # Compact 1s musical timeline: the shared base for candidates, debug and the
    # tension profile. Always-on lightweight vocal VAD (no Demucs required).
    timeline = build_timeline(y, sr, duration)

    # Downbeat + multi-resolution phrase grid (16/32/64 beats), so transitions can
    # start on the most coherent musical phrase for this track.
    phrasing = detect_phrasing(y, sr, music["beats"], beat_interval, timeline)
    # Optional Demucs vocal-stem analysis of the intro/outro mix regions; when
    # present it refines the always-on heuristic vocal risk in the timeline.
    vocals: dict[str, Any] = {"available": False}
    # Full-track Demucs vocal timeline. When present it is the AUTHORITATIVE
    # vocalRisk (index-aligned with timeline.t); otherwise the heuristic VAD stays.
    timeline["vocalSource"] = "heuristic"
    first_vocal_at: float | None = None
    last_vocal_at: float | None = None
    if use_stems:
        from . import stems as stems_module

        vocal_tl = stems_module.vocal_activity_timeline(path, duration, TIMELINE_STEP)
        if vocal_tl is not None:
            risk = list(vocal_tl["vocalRisk"])
            n = len(timeline["t"])
            if len(risk) < n:
                risk = risk + [0.0] * (n - len(risk))
            timeline["vocalRisk"] = risk[:n]
            timeline["vocalSource"] = "demucs"
            first_vocal_at = vocal_tl.get("firstVocalAt")
            last_vocal_at = vocal_tl.get("lastVocalAt")

        vocals = stems_module.analyze_vocals(path, duration)
        # Only the legacy refine path is heuristic-based; skip it once the
        # full-track map is authoritative so it cannot overwrite real silence.
        if timeline.get("vocalSource") != "demucs":
            refine_vocal_risk(timeline, vocals, duration)

    # Structural boundaries (timbre+harmony self-similarity, beat-synced). The
    # inspectable DSP baseline for intro/outro: real musical section changes, not
    # raw energy thresholds. Used to snap intro_end and outro_start.
    struct_boundaries = structural_boundaries(y, sr, music["beats"], duration)
    outro_start = refine_outro_start(outro_start, struct_boundaries, timeline, duration)

    # Default mix windows from the spectral cue estimate.
    mixable_intro = max(0.0, min(vocal_risk_start, duration) - cue_in)
    mixable_outro = max(0.0, cue_out - outro_start)

    # When Demucs ran, the vocal-free windows are the authoritative mix zones:
    # the incoming intro must stay instrumental, and so must the outgoing outro.
    if vocals.get("available"):
        mixable_intro = max(0.0, float(vocals["vocalIntro"]) - cue_in)
        mixable_outro = float(vocals["vocalOutro"])

    # Explicit, scored, human-readable mix candidates on musical boundaries.
    candidates = build_candidates(
        timeline, phrasing, duration, cue_in, cue_out, outro_start, beat_interval,
        struct_boundaries, first_vocal_at,
    )
    # Back-compat single fields = the top candidate of each kind.
    cue_in = top_time(candidates["cueIn"], cue_in)
    cue_out = top_time(candidates["cueOut"], cue_out)
    entry_point = top_time(candidates["entryPoint"], None)
    mix_point = top_time(candidates["mixPoint"], None)

    return {
        "version": ANALYSIS_VERSION,
        "duration": duration,
        "cueIn": cue_in,
        "cueOut": cue_out,
        "outroStart": outro_start,
        "vocalRiskStart": vocal_risk_start,
        "firstVocalAt": first_vocal_at,
        "lastVocalAt": last_vocal_at,
        "vocalSource": timeline.get("vocalSource"),
        "bpm": bpm,
        "bpmConfidence": bpm_confidence,
        "energy": energy,
        "mixableIntro": mixable_intro,
        "mixableOutro": mixable_outro,
        "key": key,
        "keyConfidence": key_confidence,
        "camelot": to_camelot(key),
        "firstBeat": music["firstBeat"],
        "beatInterval": beat_interval,
        "downbeat": phrasing["downbeat"],
        "barInterval": phrasing["barInterval"],
        "phraseAnchor": phrasing["phraseAnchor"],
        "phraseInterval": phrasing["phraseInterval"],
        "beatsPerPhrase": phrasing["beatsPerPhrase"],
        "phraseGrid": phrasing["phraseGrid"],
        "entryPoint": entry_point,
        "mixPoint": mix_point,
        "introEnd": candidates.get("introEnd"),
        "candidates": candidates,
        "timeline": timeline,
        "loudnessLufs": music["loudnessLufs"],
        "gain": music["gain"],
        "truePeak": music["truePeak"],
        "lra": music["lra"],
        "crest": crest_factor(y, rms),
        "bandEnergy": music["bandEnergy"],
        "vocals": vocals,
        "waveform": waveform(y),
        "sections": structure_sections(
            y,
            sr,
            rms,
            times,
            duration,
            cue_in,
            cue_out,
            outro_start,
            vocal_risk_start,
            phrasing,
            candidates.get("introEnd"),
        ),
        "analyzer": ANALYZER_ID,
    }


def top_time(candidate_list: list[dict[str, Any]], fallback: float | None) -> float | None:
    """First (best) candidate time, or the supplied fallback."""
    if candidate_list:
        return candidate_list[0]["t"]
    return fallback


def waveform(y: np.ndarray, bins: int = 1024) -> dict[str, Any]:
    """Compact normalized peak envelope for deck waveform rendering."""
    if y.size == 0:
        return {"bins": bins, "peaks": []}
    chunks = np.array_split(np.abs(y), bins)
    peaks = np.array([float(np.max(chunk)) if chunk.size else 0.0 for chunk in chunks])
    max_peak = float(np.max(peaks)) if peaks.size else 0.0
    if max_peak > 0:
        peaks = peaks / max_peak
    return {
        "bins": bins,
        "peaks": [round(float(value), 3) for value in peaks],
    }


TIMELINE_STEP = 1.0  # seconds per timeline window


def build_timeline(y: np.ndarray, sr: int, duration: float) -> dict[str, Any]:
    """Compact per-second musical timeline shared by candidates/debug/tension.

    Every series is sampled on the same 1s grid so the frontend can read any of
    them by index. CPU-cheap: one onset envelope, one centroid, one flatness, one
    band split, all from a single STFT magnitude.
    """
    step = TIMELINE_STEP
    n = max(1, int(math.ceil(duration / step))) if duration > 0 else 1
    t = [round(i * step, 3) for i in range(n)]
    empty_series = [0.0] * n
    base = {
        "step": step,
        "t": t,
        "rms": list(empty_series),
        "onset": list(empty_series),
        "beatStrength": list(empty_series),
        "low": list(empty_series),
        "mid": list(empty_series),
        "high": list(empty_series),
        "brightness": list(empty_series),
        "vocalRisk": list(empty_series),
        "tension": list(empty_series),
    }
    if y.size == 0 or duration <= 0:
        return base

    hop = 512
    stft = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop))
    frame_times = librosa.frames_to_time(np.arange(stft.shape[1]), sr=sr, hop_length=hop)

    rms = librosa.feature.rms(S=stft, frame_length=2048, hop_length=hop)[0]
    onset_env = librosa.onset.onset_strength(S=librosa.amplitude_to_db(stft, ref=np.max), sr=sr)
    onset_times = librosa.times_like(onset_env, sr=sr)
    centroid = librosa.feature.spectral_centroid(S=stft, sr=sr)[0]
    flatness = librosa.feature.spectral_flatness(S=stft)[0]

    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    low_band = stft[freqs < 250, :].sum(axis=0)
    mid_band = stft[(freqs >= 250) & (freqs < 4000), :].sum(axis=0)
    high_band = stft[freqs >= 4000, :].sum(axis=0)
    band_total = low_band + mid_band + high_band + 1e-9
    # Vocal-band energy ratio (200-4000Hz) feeds the heuristic VAD.
    vocal_band = stft[(freqs >= 200) & (freqs < 4000), :].sum(axis=0) / band_total

    # Bin every frame to its 1s window and reduce.
    idx = np.clip((frame_times / step).astype(int), 0, n - 1)
    onset_idx = np.clip((onset_times / step).astype(int), 0, n - 1)

    def bin_mean(values: np.ndarray, indices: np.ndarray) -> np.ndarray:
        out = np.zeros(n)
        counts = np.zeros(n)
        np.add.at(out, indices, values)
        np.add.at(counts, indices, 1.0)
        return out / np.maximum(counts, 1.0)

    def bin_max(values: np.ndarray, indices: np.ndarray) -> np.ndarray:
        out = np.zeros(n)
        for i, v in zip(indices, values):
            if v > out[i]:
                out[i] = v
        return out

    rms_w = bin_mean(rms, idx)
    onset_w = bin_max(onset_env, onset_idx)
    centroid_w = bin_mean(centroid, idx)
    flatness_w = bin_mean(flatness, idx)
    low_w = bin_mean(low_band / band_total, idx)
    mid_w = bin_mean(mid_band / band_total, idx)
    high_w = bin_mean(high_band / band_total, idx)
    vocal_band_w = bin_mean(vocal_band, idx)

    energy_n = normalize_series(rms_w)
    onset_n = normalize_series(onset_w)
    bright_n = normalize_series(centroid_w)
    # Heuristic VAD: tonal (low flatness), energy in the vocal band, with real
    # level present. Bright tonal mid-band energy is the strongest vocal cue we
    # can get without separating stems.
    tonal = 1.0 - normalize_series(flatness_w)
    vocal_risk = np.clip(
        0.55 * normalize_series(vocal_band_w) + 0.30 * tonal + 0.15 * energy_n, 0, 1
    )
    vocal_risk = vocal_risk * np.clip(energy_n * 1.4, 0, 1)  # silence => no voice

    # Onset density over a short window approximates rising tension.
    density = bin_mean((onset_env > np.percentile(onset_env, 70)).astype(float), onset_idx)
    tension = np.clip(0.45 * energy_n + 0.35 * onset_n + 0.20 * normalize_series(density), 0, 1)

    def r(arr: np.ndarray) -> list[float]:
        return [round(float(v), 4) for v in arr]

    base.update(
        {
            "rms": r(rms_w),
            "onset": r(onset_n),
            "beatStrength": r(onset_n),
            "low": r(low_w),
            "mid": r(mid_w),
            "high": r(high_w),
            "brightness": r(bright_n),
            "vocalRisk": r(vocal_risk),
            "tension": r(tension),
        }
    )
    return base


def refine_vocal_risk(timeline: dict[str, Any], vocals: dict[str, Any], duration: float) -> None:
    """If Demucs stem data is present, raise vocalRisk in known sung regions."""
    if not vocals.get("available") or not timeline.get("t"):
        return
    first = vocals.get("firstVocalAt")
    last = vocals.get("lastVocalAt")
    risk = timeline["vocalRisk"]
    for i, t in enumerate(timeline["t"]):
        sung = (first is not None and t >= float(first)) and (
            last is None or t <= float(last)
        )
        if sung:
            risk[i] = round(min(1.0, max(risk[i], 0.7)), 4)


def crest_factor(y: np.ndarray, rms: np.ndarray) -> float | None:
    """Peak-to-RMS ratio in dB: high = dynamic/punchy, low = compressed/loud."""
    if y.size == 0 or rms.size == 0:
        return None
    peak = float(np.max(np.abs(y)))
    avg = float(np.sqrt(np.mean(np.square(rms))))
    if peak <= 0 or avg <= 0:
        return None
    return round(20.0 * math.log10(peak / avg), 2)


def build_candidates(
    timeline: dict[str, Any],
    phrasing: dict[str, Any],
    duration: float,
    cue_in: float,
    cue_out: float,
    outro_start: float,
    beat_interval: float | None,
    struct_boundaries: list[float] | None = None,
    first_vocal_at: float | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Generate scored, explained mix candidates on musical boundaries only.

    Returns lists sorted best-first under cueIn/entryPoint/mixPoint/cueOut. Each
    entry is {t, score (0..1), reasons: [italian strings]}.
    """
    t = np.asarray(timeline.get("t", []), dtype=float)
    if t.size == 0:
        return {"cueIn": [], "entryPoint": [], "mixPoint": [], "cueOut": []}

    rms = np.asarray(timeline["rms"], dtype=float)
    onset = np.asarray(timeline["onset"], dtype=float)
    vocal = np.asarray(timeline["vocalRisk"], dtype=float)
    tension = np.asarray(timeline["tension"], dtype=float)
    energy_n = normalize_series(rms)

    def sample(series: np.ndarray, time: float) -> float:
        if series.size == 0:
            return 0.0
        i = int(np.clip(round(time / TIMELINE_STEP), 0, series.size - 1))
        return float(series[i])

    boundaries = phrase_boundaries(phrasing, duration, beat_interval)
    # Finer bar-level grid (4 beats). Long phrase boundaries (16/32 beats) are too
    # coarse inside a short radio-edit intro: entry/intro-end must snap to bars,
    # otherwise they jump to the next phrase deep into the song.
    bar_iv = phrasing.get("barInterval") or ((beat_interval or 0.5) * 4)
    bar_anchor = phrasing.get("downbeat") or phrasing.get("phraseAnchor") or 0.0
    bar_boundaries = grid_boundaries(bar_anchor, bar_iv, duration)

    # --- cue-in: first musically useful point (RMS rise + onset + flux) -------
    cue_candidates: list[dict[str, Any]] = []
    flux = np.maximum(0.0, np.diff(rms, prepend=rms[:1]))
    flux_n = normalize_series(flux)
    half = max(1e-6, duration * 0.5)
    # The cue-in is the FIRST audible point, NOT the loudest one. Trim only true
    # leading silence: gate on RAW rms vs the track peak (~8%), never on energy
    # normalized to percentiles — a soft intro sits below the relative floor and
    # would be skipped, dragging the cue-in deep into the song (started mid-track).
    peak_rms = float(np.max(rms)) if rms.size else 0.0
    sound_floor = max(1e-9, 0.08 * peak_rms)
    for i in range(t.size):
        if t[i] > half:
            break
        # Require sound to hold for a beat so a 1s intro blip/click can't win.
        nxt_rms = rms[min(i + 1, rms.size - 1)]
        if rms[i] < sound_floor or nxt_rms < sound_floor:
            continue
        earliness = 1.0 - (t[i] / half)
        quality = 0.4 * energy_n[i] + 0.35 * onset[i] + 0.25 * flux_n[i]
        score = 0.7 * earliness + 0.3 * quality
        reasons = ["primo punto musicale utile"]
        if onset[i] > 0.4:
            reasons.append("attacco ritmico chiaro")
        if flux_n[i] > 0.4:
            reasons.append("salita di livello")
        cue_candidates.append(make_candidate(t[i], score, reasons))
    cue_candidates = dedupe_sort(cue_candidates)
    if not cue_candidates:
        cue_candidates = [make_candidate(cue_in, 0.3, ["fallback: primo livello utile"])]

    # --- intro end: where the body/vocal begins. The mix must COMPLETE here, so
    # the incoming song's body is never covered and the track is not lost. Prefer a
    # real STRUCTURAL boundary (section change) where energy/vocals rise to the body;
    # fall back to the first bar where vocals enter or energy jumps over the intro
    # baseline; finally ~8 bars of intro.
    cue_in_eff = cue_candidates[0]["t"]
    bars = (beat_interval or 0.5) * 4
    intro_baseline = sample(energy_n, cue_in_eff + bars)
    intro_end = cue_in_eff + bars * 8
    struct = struct_boundaries or []
    intro_from_struct = None
    for sb in struct:
        if sb <= cue_in_eff + bars * 0.5 or sb > duration * 0.6:
            continue
        if sample(vocal, sb) > 0.4 or sample(energy_n, sb) > intro_baseline + 0.2:
            intro_from_struct = sb
            break
    if intro_from_struct is not None:
        intro_end = intro_from_struct
    else:
        for b in bar_boundaries:
            if b <= cue_in_eff + bars * 0.5 or b > cue_in_eff + bars * 16:
                continue
            if sample(vocal, b) > 0.4 or sample(energy_n, b) > intro_baseline + 0.25:
                intro_end = b
                break
    # Snap the structural intro end to the nearest bar so entry/duration stay on grid.
    if intro_from_struct is not None and bar_boundaries:
        intro_end = min(bar_boundaries, key=lambda b: abs(b - intro_end))
    # When a reliable (Demucs) first-vocal time is known and vocals lead the song,
    # the intro MUST end before the singing starts: prefer the bar at/just before
    # firstVocalAt so the mix never spills onto the entering vocal.
    if (
        first_vocal_at is not None
        and float(first_vocal_at) > cue_in_eff + bars * 0.5
        and bar_boundaries
    ):
        fv = float(first_vocal_at)
        before = [b for b in bar_boundaries if b <= fv + 0.5 and b > cue_in_eff + bars * 0.5]
        if before:
            intro_end = before[-1]
    intro_end = float(min(intro_end, duration * 0.6))

    # --- entryPoint: the incoming track is cued at its clean intro phrase, never
    # in the body. We search only within the intro (cue-in .. intro_end) and let
    # earliness + low vocal decide; energy is NOT rewarded (it drags entry into
    # the body and starts the song mid-way).
    entry_candidates: list[dict[str, Any]] = []
    span = max(1.0, intro_end - cue_in_eff)
    for b in bar_boundaries:
        if b < cue_in_eff - 0.5 or b > intro_end + 0.5:
            continue
        v = sample(vocal, b)
        prox = 1.0 - min(1.0, (b - cue_in_eff) / span)
        score = 0.6 * prox + 0.4 * (1 - v)
        reasons = ["frase pulita nell'intro (canzone preservata)"]
        reasons.append("voce assente" if v < 0.35 else "rischio voce moderato")
        entry_candidates.append(make_candidate(b, score, reasons))
    entry_candidates = dedupe_sort(entry_candidates)
    if not entry_candidates:
        entry_candidates = [make_candidate(cue_in_eff, 0.3, ["fallback: cue-in su frase"])]

    # --- mixPoint: the outgoing track must play almost to its END. When the
    # crossfade completes the track is silenced, so the mix point IS where the
    # song ends for the listener: it must be LATE (near cue_out) and in a low-vocal
    # zone, never at 2/3 and never overlapping vocals on both sides. We leave ~4
    # bars after it so the crossfade can ride the real ending. Lateness + (1-vocal)
    # dominate the score.
    bars_v = (beat_interval or 0.5) * 4
    latest = cue_out - bars_v * 4
    exit_floor = max(cue_in + bars_v * 2, min(outro_start, latest) - bars_v * 8)
    if exit_floor >= latest:
        exit_floor = max(cue_in + 1.0, latest - bars_v * 4)
    span_out = max(1.0, latest - exit_floor)
    mix_candidates: list[dict[str, Any]] = []
    for b in bar_boundaries:
        if b < exit_floor or b > latest + 0.5:
            continue
        v = sample(vocal, b)
        ten = sample(tension, b)
        lateness = 1.0 - (latest - b) / span_out
        # Vocal avoidance dominates: raise the (1-vocal) weight and add a strong
        # penalty for any sung bar so the exit never lands on a vocal phrase.
        score = 0.55 * (1 - v) + 0.32 * lateness + 0.13 * (1 - ten)
        if v > 0.5:
            score -= 0.6
        reasons = ["uscita vicino alla fine del brano, su frase"]
        reasons.append(
            "zona senza voce (niente cantato su cantato)" if v < 0.35
            else "voce presente in uscita"
        )
        if b >= outro_start:
            reasons.append("dentro l'outro naturale")
        mix_candidates.append(make_candidate(b, score, reasons))
    mix_candidates = dedupe_sort(mix_candidates)
    if not mix_candidates:
        mix_candidates = [make_candidate(
            max(exit_floor, min(latest, outro_start)), 0.3, ["fallback: pre-outro"]
        )]

    # --- cueOut: before dead fade / abrupt change / non-mixable ---------------
    out_candidates: list[dict[str, Any]] = []
    for i in range(t.size - 1, 0, -1):
        if t[i] < duration * 0.5:
            break
        drop = energy_n[i - 1] - energy_n[i] if i > 0 else 0.0
        if energy_n[i] < 0.1 and energy_n[i - 1] >= 0.1:
            out_candidates.append(make_candidate(
                t[i], 0.7, ["prima del fade-out morto"]
            ))
        elif drop > 0.35:
            out_candidates.append(make_candidate(
                t[i], 0.6, ["prima di un calo brusco di energia"]
            ))
    out_candidates = dedupe_sort(out_candidates)
    if not out_candidates:
        out_candidates = [make_candidate(cue_out, 0.3, ["fallback: cue-out rilevato"])]

    return {
        "cueIn": cue_candidates[:5],
        "entryPoint": entry_candidates[:5],
        "mixPoint": mix_candidates[:5],
        "cueOut": out_candidates[:5],
        "introEnd": round(intro_end, 3),
    }


def phrase_boundaries(
    phrasing: dict[str, Any], duration: float, beat_interval: float | None
) -> list[float]:
    """Absolute times of every phrase boundary across the track."""
    anchor = phrasing.get("phraseAnchor") or phrasing.get("downbeat")
    interval = phrasing.get("phraseInterval") or phrasing.get("barInterval")
    if anchor is None or not interval:
        # No grid: fall back to bar-sized steps from the start.
        interval = (beat_interval or 0.5) * 4
        anchor = 0.0
    return grid_boundaries(anchor, interval, duration)


def grid_boundaries(anchor: float, interval: float, duration: float) -> list[float]:
    """Absolute times of a regular grid (anchor + k*interval) within [0, duration]."""
    if not interval or interval <= 0:
        return []
    out: list[float] = []
    k = -math.ceil(anchor / interval)
    t = anchor + k * interval
    while t <= duration:
        if t >= 0:
            out.append(round(t, 4))
        t += interval
    return out


def structural_boundaries(
    y: np.ndarray, sr: int, beat_times: Any, duration: float
) -> list[float]:
    """Beat-synchronous structural section boundaries.

    Inspectable DSP baseline for intro/outro: combine harmony (chroma) and timbre
    (MFCC), aggregate per beat, then agglomerative clustering of the self-similar
    structure. Returns boundary times — real section changes, not energy thresholds.
    """
    beats = np.asarray(beat_times, dtype=float)
    beats = beats[(beats >= 0) & (beats <= duration)]
    if beats.size < 8 or y.size == 0:
        return []
    hop = 512
    beat_frames = np.clip(librosa.time_to_frames(beats, sr=sr, hop_length=hop), 0, None)
    try:
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
        mfcc = librosa.feature.mfcc(y=y, sr=sr, hop_length=hop, n_mfcc=13)
        csync = librosa.util.sync(chroma, beat_frames, aggregate=np.median)
        msync = librosa.util.sync(mfcc, beat_frames, aggregate=np.mean)
        feat = np.vstack([
            librosa.util.normalize(csync, axis=0),
            librosa.util.normalize(msync, axis=0),
        ])
        n = feat.shape[1]
        if n < 6:
            return []
        k = int(np.clip(round(duration / 12.0), 3, min(12, n - 1)))
        bound_cols = librosa.segment.agglomerative(feat, k)
    except Exception:
        return []
    times: set[float] = set()
    for idx in np.atleast_1d(bound_cols):
        j = int(np.clip(idx, 0, beats.size - 1))
        t = float(beats[j])
        if 0 < t < duration:
            times.add(round(t, 3))
    return sorted(times)


def refine_outro_start(
    outro_start: float,
    boundaries: list[float],
    timeline: dict[str, Any],
    duration: float,
) -> float:
    """Snap the outro start to the structural boundary where the body's energy
    drops into a sustained quieter tail. Keeps the heuristic estimate otherwise."""
    t = np.asarray(timeline.get("t", []), dtype=float)
    if t.size == 0 or not boundaries:
        return outro_start
    en = normalize_series(np.asarray(timeline["rms"], dtype=float))

    def e_at(time: float) -> float:
        i = int(np.clip(round(time / TIMELINE_STEP), 0, en.size - 1))
        return float(en[i])

    mid = en[int(en.size * 0.2):int(en.size * 0.8)]
    body = float(np.median(mid)) if mid.size else float(np.median(en))
    for b in boundaries:
        if b < duration * 0.5 or b > duration * 0.97:
            continue
        after = float(np.mean([e_at(b + s) for s in (1, 3, 5, 8)]))
        if after < body * 0.6:
            return float(b)
    return outro_start


def make_candidate(time: float, score: float, reasons: list[str]) -> dict[str, Any]:
    return {
        "t": round(float(time), 3),
        "score": round(float(np.clip(score, 0, 1)), 3),
        "reasons": reasons,
    }


def dedupe_sort(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Sort best-first and drop near-duplicate times (within ~1.5s)."""
    candidates.sort(key=lambda c: c["score"], reverse=True)
    kept: list[dict[str, Any]] = []
    for c in candidates:
        if all(abs(c["t"] - k["t"]) > 1.5 for k in kept):
            kept.append(c)
    return kept


def structure_sections(
    y: np.ndarray,
    sr: int,
    rms: np.ndarray,
    times: np.ndarray,
    duration: float,
    cue_in: float,
    cue_out: float,
    outro_start: float,
    vocal_risk_start: float,
    phrasing: dict[str, Any],
    intro_end_hint: float | None = None,
) -> list[dict[str, Any]]:
    """Estimate musical sections for waveform colouring.

    This is intentionally heuristic: commercial DJ apps use proprietary models,
    but the useful signal is similar — level, transient density, brightness and
    phrase-sized windows.
    """
    if duration <= 0:
        return []

    phrase = phrasing.get("phraseInterval") or phrasing.get("barInterval") or 8.0
    window = float(np.clip(phrase, 6.0, 16.0))
    # Prefer the real detected intro end (bar where body/vocals start) so the
    # coloured intro matches the music, instead of a fixed 22%-of-duration cap.
    if intro_end_hint and intro_end_hint > cue_in + 1:
        intro_end = float(np.clip(intro_end_hint, 0, duration))
    else:
        intro_end = float(np.clip(max(cue_in, min(vocal_risk_start, duration * 0.22)), 0, duration))
    outro_begin = float(np.clip(outro_start or cue_out or duration * 0.82, intro_end, duration))

    sections: list[dict[str, Any]] = []
    if intro_end > 2:
        sections.append(section(0.0, intro_end, "intro", 0.75))

    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    onset_times = librosa.times_like(onset_env, sr=sr)
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    centroid_times = librosa.times_like(centroid, sr=sr)

    windows: list[dict[str, float]] = []
    cursor = intro_end
    while cursor < outro_begin - 1:
        end = min(outro_begin, cursor + window)
        windows.append(
            {
                "start": cursor,
                "end": end,
                "energy": mean_in_range(rms, times, cursor, end),
                "onset": mean_in_range(onset_env, onset_times, cursor, end),
                "centroid": mean_in_range(centroid, centroid_times, cursor, end),
            }
        )
        cursor = end

    if windows:
        energies = np.asarray([w["energy"] for w in windows], dtype=float)
        onsets = np.asarray([w["onset"] for w in windows], dtype=float)
        centroids = np.asarray([w["centroid"] for w in windows], dtype=float)
        # Flat series collapse to zeros under percentile normalization, which would
        # mislabel a steady loud body as "break". Use a neutral 0.5 when flat.
        def norm_or_neutral(values: np.ndarray) -> np.ndarray:
            if float(np.ptp(values)) < 1e-6:
                return np.full(values.shape, 0.5)
            return normalize_series(values)

        e_norm = norm_or_neutral(energies)
        o_norm = norm_or_neutral(onsets)
        c_norm = norm_or_neutral(centroids)

        last_type = None
        for index, item in enumerate(windows):
            prev_energy = e_norm[index - 1] if index > 0 else e_norm[index]
            next_energy = e_norm[index + 1] if index + 1 < len(windows) else e_norm[index]
            slope = next_energy - prev_energy
            kind = classify_section(e_norm[index], o_norm[index], c_norm[index], slope)
            confidence = float(np.clip(0.45 + abs(slope) + max(e_norm[index], o_norm[index]) * 0.35, 0.45, 0.95))

            # Merge adjacent windows of the same kind to keep the display readable.
            if sections and last_type == kind and sections[-1]["type"] == kind:
                sections[-1]["end"] = round(item["end"], 2)
                sections[-1]["confidence"] = round(max(sections[-1]["confidence"], confidence), 2)
            else:
                sections.append(section(item["start"], item["end"], kind, confidence))
            last_type = kind

    if outro_begin < duration - 1:
        sections.append(section(outro_begin, duration, "outro", 0.8))

    return clean_sections(sections, duration)


def classify_section(energy: float, onset: float, centroid: float, slope: float) -> str:
    if energy < 0.34 and onset < 0.48:
        return "break"
    if slope > 0.18 and (onset > 0.42 or centroid > 0.45):
        return "build"
    if energy > 0.70 and onset > 0.55:
        return "drop"
    return "body"


def mean_in_range(values: np.ndarray, times: np.ndarray, start: float, end: float) -> float:
    if values.size == 0 or times.size == 0:
        return 0.0
    mask = (times >= start) & (times < end)
    if not mask.any():
        return 0.0
    return float(np.mean(values[mask]))


def normalize_series(values: np.ndarray) -> np.ndarray:
    if values.size == 0:
        return values
    lo = float(np.percentile(values, 10))
    hi = float(np.percentile(values, 90))
    if hi <= lo:
        return np.zeros_like(values, dtype=float)
    return np.clip((values - lo) / (hi - lo), 0, 1)


def section(start: float, end: float, kind: str, confidence: float) -> dict[str, Any]:
    return {
        "start": round(float(start), 2),
        "end": round(float(end), 2),
        "type": kind,
        "confidence": round(float(confidence), 2),
    }


def clean_sections(sections: list[dict[str, Any]], duration: float) -> list[dict[str, Any]]:
    clean: list[dict[str, Any]] = []
    for item in sections:
        start = float(np.clip(item["start"], 0, duration))
        end = float(np.clip(item["end"], start, duration))
        if end - start < 0.75:
            continue
        if clean and clean[-1]["type"] == item["type"] and abs(clean[-1]["end"] - start) < 0.1:
            clean[-1]["end"] = round(end, 2)
            clean[-1]["confidence"] = round(max(clean[-1]["confidence"], item["confidence"]), 2)
        else:
            clean.append({**item, "start": round(start, 2), "end": round(end, 2)})
    return clean


def extract_music_features(path: str) -> dict[str, Any]:
    """BPM, key, beat grid and loudness from a single MusicExtractor decode."""
    empty = {
        "bpm": None, "bpmConfidence": 0.0, "key": None, "keyConfidence": 0.0,
        "firstBeat": None, "loudnessLufs": None, "gain": 1.0,
        "bandEnergy": None, "truePeak": None, "lra": None, "beats": [],
    }
    try:
        features, _ = es.MusicExtractor(
            lowlevelStats=["mean"],
            rhythmStats=["mean"],
            tonalStats=["mean"],
        )(path)
    except Exception:
        return empty

    # --- Tempo ---
    bpm_raw = descriptor_value(features, "rhythm.bpm")
    bpm = round(normalize_bpm(float(bpm_raw)), 1) if bpm_raw else None
    peak_weight = descriptor_value(features, "rhythm.bpm_histogram_first_peak_weight")
    bpm_confidence = round(float(np.clip((peak_weight or 0.0) * 3.0, 0, 1)), 2)

    # --- Beat grid (first beat, in original track time before any tempo scaling) ---
    first_beat = None
    beat_list: list[float] = []
    beats = descriptor_value(features, "rhythm.beats_position")
    if beats is not None and np.size(beats) > 0:
        beat_list = [float(b) for b in np.atleast_1d(beats)]
        first_beat = round(beat_list[0], 4)

    # --- Key (majority vote across the three Essentia profiles) ---
    key, key_confidence = vote_key(features)

    # --- Loudness normalization (EBU R128 integrated -> trim gain) ---
    loudness = descriptor_value(features, "lowlevel.loudness_ebu128.integrated")
    gain = 1.0
    loudness_out = None
    if loudness is not None and np.isfinite(float(loudness)):
        loudness_out = round(float(loudness), 1)
        gain_db = float(np.clip(TARGET_LUFS - float(loudness), -24.0, 6.0))
        gain = round(10.0 ** (gain_db / 20.0), 4)

    # Loudness range (LRA) and true peak help size fades and judge clip risk.
    lra = descriptor_value(features, "lowlevel.loudness_ebu128.loudness_range")
    lra_out = round(float(lra), 1) if lra is not None and np.isfinite(float(lra)) else None
    # MusicExtractor exposes momentary loudness max; use it as a true-peak proxy
    # (LUFS-scale). A dedicated dBTP meter would need a separate decode pass.
    true_peak = descriptor_value(features, "lowlevel.loudness_ebu128.momentary.max")
    true_peak_out = round(float(true_peak), 1) if true_peak is not None and np.isfinite(float(true_peak)) else None

    return {
        "bpm": bpm,
        "bpmConfidence": bpm_confidence,
        "key": key,
        "keyConfidence": key_confidence,
        "firstBeat": first_beat,
        "beats": beat_list,
        "loudnessLufs": loudness_out,
        "gain": gain,
        "lra": lra_out,
        "truePeak": true_peak_out,
        "bandEnergy": band_energy(features),
    }


def band_energy(features: Any) -> dict[str, float] | None:
    """Normalized low/mid/high spectral energy split for EQ-aware mixing."""
    low = descriptor_value(features, "lowlevel.spectral_energyband_low.mean")
    mid_low = descriptor_value(features, "lowlevel.spectral_energyband_middle_low.mean")
    mid_high = descriptor_value(features, "lowlevel.spectral_energyband_middle_high.mean")
    high = descriptor_value(features, "lowlevel.spectral_energyband_high.mean")
    if low is None and mid_low is None and mid_high is None and high is None:
        return None

    low = float(low or 0.0)
    mid = float(mid_low or 0.0) + float(mid_high or 0.0)
    high = float(high or 0.0)
    total = low + mid + high
    if total <= 0:
        return None
    return {
        "low": round(low / total, 4),
        "mid": round(mid / total, 4),
        "high": round(high / total, 4),
    }


def detect_phrasing(
    y: np.ndarray,
    sr: int,
    beats: list[float],
    beat_interval: float | None,
    timeline: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Estimate the downbeat phase (4/4) and a multi-resolution phrase grid.

    Without a dedicated downbeat model (madmom) we use two musical cues:
    the downbeat is the in-bar position carrying the most onset energy, and a
    phrase boundary is where timbre (MFCC) changes the most. We then evaluate
    16/32/64-beat phrases and keep the resolution whose boundaries align best
    with the track's novelty/energy peaks. Both are snapped to the Essentia beat
    grid so they stay perfectly on the beat.
    """
    empty = {
        "downbeat": None, "barInterval": None,
        "phraseAnchor": None, "phraseInterval": None, "beatsPerPhrase": 16,
        "phraseGrid": None,
    }
    beat_arr = np.asarray(beats, dtype=float)
    if beat_arr.size < 8 or not beat_interval:
        return empty

    # Onset strength sampled at each beat -> pick the strongest 4/4 phase.
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    onset_times = librosa.times_like(onset_env, sr=sr)
    beat_onset = np.interp(beat_arr, onset_times, onset_env)
    phase_scores = [float(np.mean(beat_onset[p::4])) for p in range(4)]
    down_phase = int(np.argmax(phase_scores))
    downbeats = beat_arr[down_phase::4]
    bar = 4 * beat_interval
    if downbeats.size < 2:
        return {**empty, "downbeat": round(float(beat_arr[down_phase]), 4),
                "barInterval": round(bar, 4),
                "phraseGrid": {
                    "beatInterval": round(beat_interval, 4),
                    "firstBeat": round(float(beat_arr[0]), 4),
                    "downbeat": round(float(beat_arr[down_phase]), 4),
                    "barInterval": round(bar, 4),
                    "beatsPerPhrase": 16,
                    "options": [],
                }}

    # Timbre novelty at each downbeat: distance between the bar before and after.
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
    mfcc_times = librosa.times_like(mfcc, sr=sr)
    novelty = np.array([_timbre_novelty(mfcc, mfcc_times, t, bar) for t in downbeats])

    # Evaluate 16/32/64-beat phrases: a resolution is "coherent" when its phrase
    # boundaries land on high novelty (timbre change) downbeats.
    tl_t = np.asarray((timeline or {}).get("t", []), dtype=float)
    tl_onset = np.asarray((timeline or {}).get("onset", []), dtype=float)
    options: list[dict[str, Any]] = []
    best = None
    for beats_per_phrase in (16, 32, 64):
        bars_per_phrase = beats_per_phrase // 4
        if downbeats.size < bars_per_phrase * 2:
            continue
        phase_novelty = [
            float(np.mean(novelty[p::bars_per_phrase])) for p in range(bars_per_phrase)
        ]
        phrase_phase = int(np.argmax(phase_novelty))
        bnds = downbeats[phrase_phase::bars_per_phrase]
        # Score = novelty contrast at boundaries + onset alignment from timeline.
        boundary_novelty = float(np.mean(novelty[phrase_phase::bars_per_phrase]))
        overall_novelty = float(np.mean(novelty)) + 1e-9
        contrast = boundary_novelty / overall_novelty
        align = 1.0
        if tl_t.size and tl_onset.size:
            vals = [tl_onset[int(np.clip(round(b / TIMELINE_STEP), 0, tl_onset.size - 1))] for b in bnds]
            align = float(np.mean(vals)) if vals else 0.0
        score = round(float(np.clip(0.6 * np.tanh(contrast) + 0.4 * align, 0, 1)), 3)
        options.append({
            "beatsPerPhrase": beats_per_phrase,
            "score": score,
            "anchor": round(float(bnds[0]), 4),
        })
        if best is None or score > best["score"]:
            best = {"beatsPerPhrase": beats_per_phrase, "score": score, "anchor": float(bnds[0])}

    if best is None:
        # Too short for even a 16-beat phrase; use the bar grid.
        best = {"beatsPerPhrase": 16, "score": 0.0, "anchor": float(downbeats[0])}

    beats_per_phrase = best["beatsPerPhrase"]
    anchor = best["anchor"]
    phrase_grid = {
        "beatInterval": round(beat_interval, 4),
        "firstBeat": round(float(beat_arr[0]), 4),
        "downbeat": round(float(downbeats[0]), 4),
        "barInterval": round(bar, 4),
        "beatsPerPhrase": beats_per_phrase,
        "options": [{"beatsPerPhrase": o["beatsPerPhrase"], "score": o["score"]} for o in options],
    }

    return {
        "downbeat": round(float(downbeats[0]), 4),
        "barInterval": round(bar, 4),
        "phraseAnchor": round(float(anchor), 4),
        "phraseInterval": round(beats_per_phrase * beat_interval, 4),
        "beatsPerPhrase": beats_per_phrase,
        "phraseGrid": phrase_grid,
    }


def _timbre_novelty(mfcc: np.ndarray, mfcc_times: np.ndarray, t: float, bar: float) -> float:
    """Cosine distance between the MFCC means of the bar before and after time t."""
    before = (mfcc_times >= t - bar) & (mfcc_times < t)
    after = (mfcc_times >= t) & (mfcc_times < t + bar)
    if not before.any() or not after.any():
        return 0.0
    a = mfcc[:, before].mean(axis=1)
    b = mfcc[:, after].mean(axis=1)
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom <= 0:
        return 0.0
    return float(1.0 - np.dot(a, b) / denom)


CAMELOT = {
    "C": "8B", "Am": "8A", "G": "9B", "Em": "9A", "D": "10B", "Bm": "10A",
    "A": "11B", "F#m": "11A", "E": "12B", "C#m": "12A", "B": "1B", "G#m": "1A",
    "F#": "2B", "Gb": "2B", "D#m": "2A", "Ebm": "2A", "Db": "3B", "C#": "3B",
    "A#m": "3A", "Bbm": "3A", "Ab": "4B", "G#": "4B", "Fm": "4A", "Eb": "5B",
    "D#": "5B", "Cm": "5A", "Bb": "6B", "A#": "6B", "Gm": "6A", "F": "7B", "Dm": "7A",
}


def to_camelot(key: str | None) -> str | None:
    return CAMELOT.get(key) if key else None


def detect_bpm(y: np.ndarray, sr: int) -> tuple[float | None, float]:
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    if onset_env.size < 8:
        return None, 0.0

    tempo_bt, _ = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr)
    raw_bpm = float(np.atleast_1d(tempo_bt)[0])
    if not np.isfinite(raw_bpm) or raw_bpm <= 0:
        return None, 0.0

    bpm = normalize_bpm(raw_bpm)
    confidence = float(np.clip(np.std(onset_env) / (np.mean(onset_env) + 1e-9) / 4, 0, 1))
    return round(bpm, 1), round(confidence, 2)


def vote_key(features: Any) -> tuple[str | None, float]:
    """Majority vote across the three Essentia key profiles in an extracted pool."""
    algo_descriptors = [
        ("tonal.key_edma.key", "tonal.key_edma.scale", "tonal.key_edma.strength"),
        ("tonal.key_krumhansl.key", "tonal.key_krumhansl.scale", "tonal.key_krumhansl.strength"),
        ("tonal.key_temperley.key", "tonal.key_temperley.scale", "tonal.key_temperley.strength"),
    ]

    results: list[tuple[str, float]] = []
    for key_name, scale_name, strength_name in algo_descriptors:
        key = descriptor_value(features, key_name)
        scale = descriptor_value(features, scale_name)
        strength = descriptor_value(features, strength_name)
        if key and scale:
            suffix = "m" if str(scale).lower().startswith("minor") else ""
            results.append((f"{key}{suffix}", float(strength or 0)))

    if not results:
        return None, 0.0

    from collections import Counter
    key_votes = Counter(r[0] for r in results)
    best_key, vote_count = key_votes.most_common(1)[0]
    matching = [r for r in results if r[0] == best_key]
    avg_strength = sum(r[1] for r in matching) / len(matching)
    # Scale confidence by agreement: 2-3 algorithms agreeing = full confidence
    agreement = vote_count / len(results)
    return best_key, round(avg_strength * agreement, 3)


def descriptor_value(pool: Any, key: str) -> Any:
    try:
        return pool[key]
    except Exception:
        return None


def detect_cue_points(rms: np.ndarray, times: np.ndarray, duration: float) -> tuple[float, float, float]:
    if rms.size == 0:
        return 0.0, duration, max(0.0, duration - 24.0)

    floor = float(np.percentile(rms, 10))
    median = float(np.median(rms))
    threshold = max(0.006, floor * 3.0, median * 0.18)
    cue_in_index = first_sustained(rms, threshold)
    cue_out_index = last_sustained(rms, threshold)
    cue_in = float(times[min(cue_in_index, len(times) - 1)])
    cue_out = float(times[min(cue_out_index, len(times) - 1)])

    search_start = int(len(rms) * 0.55)
    outro_index = find_outro_start(rms, search_start, max(threshold * 1.4, median * 0.34))
    outro_start = float(times[min(outro_index, len(times) - 1)])

    return cue_in, max(cue_in, min(duration, cue_out)), max(cue_in, min(cue_out, outro_start))


def first_sustained(values: np.ndarray, threshold: float, hold: int = 14) -> int:
    for index in range(max(1, len(values) - hold)):
        if np.mean(values[index : index + hold] >= threshold) >= 0.75:
            return index
    return 0


def last_sustained(values: np.ndarray, threshold: float, hold: int = 14) -> int:
    for index in range(max(0, len(values) - hold - 1), 0, -1):
        if np.mean(values[index : index + hold] >= threshold) >= 0.75:
            return min(len(values) - 1, index + hold)
    return len(values) - 1


def find_outro_start(values: np.ndarray, start: int, threshold: float) -> int:
    window = 430
    for index in range(start, max(start, len(values) - window)):
        before = float(np.mean(values[max(0, index - window) : index]))
        after = float(np.mean(values[index : index + window]))
        if before > threshold and after < before * 0.68:
            return index
    return int(len(values) * 0.82)


def detect_dense_intro_region(rms: np.ndarray, times: np.ndarray, cue_in: float) -> float:
    cue_index = int(np.searchsorted(times, cue_in))
    search_end = min(len(rms), cue_index + 1030)
    window = 130
    best_index = min(len(rms) - 1, cue_index + 690)
    best_score = 0.0

    for index in range(cue_index, max(cue_index, search_end - window)):
        segment = rms[index : index + window]
        score = float(np.var(segment) * np.mean(segment))
        if score > best_score:
            best_score = score
            best_index = index

    return float(times[min(best_index, len(times) - 1)])


def estimate_energy(rms: np.ndarray) -> float:
    # Map the loudness level (in dBFS) onto 0..1. The old log formula saturated
    # to 1.0 for any mastered track; a dB window spreads real tracks apart.
    if rms.size == 0:
        return 0.0
    mean = float(np.mean(rms))
    p90 = float(np.percentile(rms, 90))
    level = 0.5 * mean + 0.5 * p90
    if level <= 0:
        return 0.0
    db = 20.0 * math.log10(level)
    # -28 dBFS -> 0 (quiet), -6 dBFS -> 1 (hot); typical music spans this range.
    value = (db + 28.0) / 22.0
    return round(float(np.clip(value, 0, 1)), 3)


def normalize_bpm(bpm: float) -> float:
    value = bpm
    while value < 85:
        value *= 2
    while value > 180:
        value /= 2
    return value
