import { analyzeTrack } from "./analyzer.js";
import { AutoDjPlayer } from "./player.js?v=20260605-1";
import {
  saveTrackRecord,
  deleteTrackRecord,
  clearTrackRecords,
  getAllTrackRecords,
  saveMeta,
  getMeta
} from "./db.js";
import { initMidi, describeMessage } from "./midi.js";

const KEY_TO_CAMELOT = {
  "C":   { n: 8,  w: "B" }, "Am":  { n: 8,  w: "A" },
  "G":   { n: 9,  w: "B" }, "Em":  { n: 9,  w: "A" },
  "D":   { n: 10, w: "B" }, "Bm":  { n: 10, w: "A" },
  "A":   { n: 11, w: "B" }, "F#m": { n: 11, w: "A" }, "Gbm": { n: 11, w: "A" },
  "E":   { n: 12, w: "B" }, "C#m": { n: 12, w: "A" }, "Dbm": { n: 12, w: "A" },
  "B":   { n: 1,  w: "B" }, "G#m": { n: 1,  w: "A" }, "Abm": { n: 1,  w: "A" },
  "F#":  { n: 2,  w: "B" }, "Gb":  { n: 2,  w: "B" }, "D#m": { n: 2,  w: "A" }, "Ebm": { n: 2,  w: "A" },
  "Db":  { n: 3,  w: "B" }, "C#":  { n: 3,  w: "B" }, "A#m": { n: 3,  w: "A" }, "Bbm": { n: 3,  w: "A" },
  "Ab":  { n: 4,  w: "B" }, "G#":  { n: 4,  w: "B" }, "Fm":  { n: 4,  w: "A" },
  "Eb":  { n: 5,  w: "B" }, "D#":  { n: 5,  w: "B" }, "Cm":  { n: 5,  w: "A" },
  "Bb":  { n: 6,  w: "B" }, "A#":  { n: 6,  w: "B" }, "Gm":  { n: 6,  w: "A" },
  "F":   { n: 7,  w: "B" }, "Dm":  { n: 7,  w: "A" },
};

function toCamelot(key) {
  const c = KEY_TO_CAMELOT[key];
  return c ? `${c.n}${c.w}` : null;
}

function keyCompatibility(keyA, keyB) {
  if (!keyA || !keyB) return 0.5;
  const a = KEY_TO_CAMELOT[keyA];
  const b = KEY_TO_CAMELOT[keyB];
  if (!a || !b) return 0.5;
  if (a.n === b.n && a.w === b.w) return 1.0;
  if (a.n === b.n) return 0.8;
  const diff = Math.min(Math.abs(a.n - b.n), 12 - Math.abs(a.n - b.n));
  if (diff === 1 && a.w === b.w) return 0.85;
  if (diff === 1) return 0.6;
  return 0.1;
}

function bpmCompatibility(bpmA, bpmB) {
  if (!bpmA || !bpmB) return 0.35;
  const diff = Math.min(
    Math.abs(bpmA - bpmB),
    Math.abs(bpmA - bpmB * 2),
    Math.abs(bpmA * 2 - bpmB)
  );
  return 1 - Math.min(1, diff / 14);
}

const state = {
  tracks: [],
  queue: [],
  playingTrackId: null,
  focusedTrackId: null,
  analyzingCount: 0
};

const elements = {
  fileInput: document.querySelector("#fileInput"),
  libraryList: document.querySelector("#libraryList"),
  queueList: document.querySelector("#queueList"),
  addAllBtn: document.querySelector("#addAllBtn"),
  autoOrderBtn: document.querySelector("#autoOrderBtn"),
  clearQueueBtn: document.querySelector("#clearQueueBtn"),
  clearLogBtn: document.querySelector("#clearLogBtn"),
  startBtn: document.querySelector("#startBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  skipBtn: document.querySelector("#skipBtn"),
  crossfadeInput: document.querySelector("#crossfadeInput"),
  crossfadeAutoInput: document.querySelector("#crossfadeAutoInput"),
  crossfadeCurveInput: document.querySelector("#crossfadeCurveInput"),
  smartModeInput: document.querySelector("#smartModeInput"),
  radioEditInput: document.querySelector("#radioEditInput"),
  beatmatchInput: document.querySelector("#beatmatchInput"),
  tempoTolInput: document.querySelector("#tempoTolInput"),
  tempoTolVal: document.querySelector("#tempoTolVal"),
  bassSwapInput: document.querySelector("#bassSwapInput"),
  levelerInput: document.querySelector("#levelerInput"),
  energyArcInput: document.querySelector("#energyArcInput"),
  arcPeakInput: document.querySelector("#arcPeakInput"),
  arcPeakVal: document.querySelector("#arcPeakVal"),
  arcWeightInput: document.querySelector("#arcWeightInput"),
  arcWeightVal: document.querySelector("#arcWeightVal"),
  nowTitle: document.querySelector("#nowTitle"),
  nowMeta: document.querySelector("#nowMeta"),
  log: document.querySelector("#log"),
  deckAMeter: document.querySelector("#deckAMeter"),
  deckBMeter: document.querySelector("#deckBMeter"),
  deckAPeak: document.querySelector("#deckAPeak"),
  deckBPeak: document.querySelector("#deckBPeak"),
  deckADb: document.querySelector("#deckADb"),
  deckBDb: document.querySelector("#deckBDb"),
  platterA: document.querySelector("#platterA"),
  platterB: document.querySelector("#platterB"),
  midiStatus: document.querySelector("#midiStatus"),
  midiMap: document.querySelector("#midiMap"),
  mixDebugPanel: document.querySelector("#mixDebugPanel"),
  mixDebug: document.querySelector("#mixDebug")
};

const peakHold = { A: 0, B: 0 };
const platterAngles = { A: 0, B: 0 };
const platterScratch = new Map();

const player = new AutoDjPlayer({
  onLog: log,
  onNowPlaying: setNowPlaying,
  onMeter: (deck, level, db) => {
    const bar = deck === "A" ? elements.deckAMeter : elements.deckBMeter;
    const peak = deck === "A" ? elements.deckAPeak : elements.deckBPeak;
    const readout = deck === "A" ? elements.deckADb : elements.deckBDb;

    bar.style.width = `${Math.round(level * 100)}%`;

    // Peak-hold marker that decays slowly.
    peakHold[deck] = Math.max(level, peakHold[deck] - 0.015);
    peak.style.left = `${Math.round(peakHold[deck] * 100)}%`;

    readout.textContent = Number.isFinite(db) ? `${db.toFixed(1)} dB` : "-∞ dB";
    readout.classList.toggle("hot", db > -3);
  },
  onProgress: (currentTime, duration, track, deckName) => {
    // The playhead follows playback on whichever deck shows the playing track.
    if (track) deckScrubbers.forEach((s) => s.updatePlayhead(track, currentTime, duration));
    updatePlatterMotion(deckName, currentTime, !!track);
  }
});

function updatePlatterMotion(deckName, currentTime, active) {
  const displayDeck = deckName === player.decks?.[player.activeDeckIndex]?.name ? "A" : "B";
  const platter = displayDeck === "A" ? elements.platterA : elements.platterB;
  const disc = platter?.querySelector(".platter-disc");
  if (!platter || !disc || platterScratch.has(displayDeck)) return;

  const rpm = 33.333;
  platterAngles[displayDeck] = (currentTime * rpm * 6) % 360;
  disc.style.transform = `rotate(${platterAngles[displayDeck].toFixed(2)}deg)`;
  platter.classList.toggle("is-spinning", active);
}

function bindPlatter(platter, displayDeck) {
  if (!platter) return;

  const angleFromEvent = (event) => {
    const rect = platter.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return Math.atan2(event.clientY - cy, event.clientX - cx);
  };

  const endScratch = (event) => {
    const scratch = platterScratch.get(displayDeck);
    if (!scratch) return;
    platterScratch.delete(displayDeck);
    platter.classList.remove("is-held");
    try {
      platter.releasePointerCapture(event.pointerId);
    } catch {}
    player.setDisplayDeckHold(displayDeck, false);
  };

  platter.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    platter.setPointerCapture(event.pointerId);
    platterScratch.set(displayDeck, {
      lastAngle: angleFromEvent(event),
      moved: false
    });
    platter.classList.add("is-held");
    player.setDisplayDeckHold(displayDeck, true);
  });

  platter.addEventListener("pointermove", (event) => {
    const scratch = platterScratch.get(displayDeck);
    if (!scratch) return;
    const angle = angleFromEvent(event);
    let delta = angle - scratch.lastAngle;
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    scratch.lastAngle = angle;
    scratch.moved = scratch.moved || Math.abs(delta) > 0.003;

    const secondsPerRevolution = 1.8;
    const deltaSeconds = (delta / (Math.PI * 2)) * secondsPerRevolution;
    if (player.scratchDisplayDeck(displayDeck, deltaSeconds)) {
      platterAngles[displayDeck] = (platterAngles[displayDeck] + (delta * 180) / Math.PI) % 360;
      const disc = platter.querySelector(".platter-disc");
      if (disc) disc.style.transform = `rotate(${platterAngles[displayDeck].toFixed(2)}deg)`;
    }
  });

  platter.addEventListener("pointerup", endScratch);
  platter.addEventListener("pointercancel", endScratch);
  platter.addEventListener("lostpointercapture", (event) => {
    if (platterScratch.has(displayDeck)) endScratch(event);
  });
}

// Snap a time to the nearest beat of a track's grid (the chosen snap mode).
function snapToBeat(seconds, analysis) {
  const interval = analysis?.beatInterval;
  if (!interval) return seconds;
  const first = analysis.firstBeat ?? 0;
  return first + Math.round((seconds - first) / interval) * interval;
}

// Estimate the crossfade length for one track, mirroring the player's logic so
// the mix marker matches what will actually happen.
function estimateFade(analysis) {
  const cap = Math.max(4, Number(elements.crossfadeInput.value) || 24);
  let fade = cap;
  if (elements.crossfadeAutoInput.checked && analysis?.bpm) {
    const beatSec = 60 / analysis.bpm;
    const energy = analysis.energy ?? 0.5;
    const beats = energy > 0.66 ? 16 : energy > 0.4 ? 32 : 48;
    fade = Math.min(Math.max(beats * beatSec, 8), Math.max(8, cap));
  }
  if (Number.isFinite(analysis?.mixableOutro) && analysis.mixableOutro > 0) {
    fade = Math.min(fade, analysis.mixableOutro);
  }
  return Math.max(2, fade);
}

// Where the auto crossfade starts, mirroring the player's logic, for the marker.
function autoMixPoint(analysis, duration) {
  if (!analysis) return NaN;
  if (elements.radioEditInput?.checked) {
    const radio = radioMixPoint(analysis, duration);
    if (Number.isFinite(radio)) return radio;
  }
  return standardMixPoint(analysis, duration);
}

function standardMixPoint(analysis, duration) {
  const fade = estimateFade(analysis);
  const cueIn = analysis.cueIn ?? 0;
  const cueOut = analysis.cueOut ?? duration;
  const conservativeCueOut = duration
    ? Math.min(duration, Math.max(cueOut, cueIn + (duration - cueIn) * 0.78))
    : cueOut;
  return Math.max(cueIn, conservativeCueOut - fade);
}

// Best automatic entry point for an incoming track: the first phrase boundary at
// or after the (vocal-free) cue-in, snapped to the beat grid. Mirrors the player.
function autoEntry(analysis) {
  if (!analysis) return 0;
  if (elements.radioEditInput?.checked) {
    const radio = radioEntryPoint(analysis);
    if (Number.isFinite(radio)) return radio;
  }
  return standardEntryPoint(analysis);
}

function standardEntryPoint(analysis) {
  const cue = analysis.cueIn ?? 0;
  const anchor = analysis.phraseAnchor ?? analysis.downbeat ?? analysis.firstBeat;
  const interval = analysis.phraseInterval ?? analysis.barInterval ?? analysis.beatInterval;
  if (anchor == null || !interval) return cue;
  const k = Math.max(0, Math.round((cue - anchor) / interval));
  let entry = anchor + k * interval;
  if (entry < cue) entry += interval;
  if (entry - cue > interval) entry -= interval;
  return Math.max(0, entry);
}

// A scrubber bound to one deck. `getTrack` returns the track it should display;
// `seekable` says whether click/drag seeks (only the live deck). Cue markers are
// always editable and snapped to the beat grid.
function createScrubber(suffix, getDeckTrack, seekable, entryMode = false) {
  const el = {
    bar: document.querySelector(`#seekBar${suffix}`),
    grid: document.querySelector(`#seekGrid${suffix}`),
    fill: document.querySelector(`#seekFill${suffix}`),
    handle: document.querySelector(`#seekHandle${suffix}`),
    timeCur: document.querySelector(`#timeCurrent${suffix}`),
    timeTot: document.querySelector(`#timeTotal${suffix}`),
    name: document.querySelector(`#track${suffix}`),
    markIn: document.querySelector(`#markIn${suffix}`),
    markOut: document.querySelector(`#markOut${suffix}`),
    markMix: document.querySelector(`#markMix${suffix}`),
    waveform: document.querySelector(`#waveform${suffix}`)
  };
  let dragging = null;
  let scrubbing = false;
  let duration = 0;
  let renderedWaveformSignature = null;

  const hideMarker = (node) => {
    if (node) node.style.display = "none";
  };

  const fractionFromEvent = (event) => {
    const rect = el.bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  };
  const pct = (seconds) =>
    duration ? `${Math.min(100, Math.max(0, (seconds / duration) * 100)).toFixed(3)}%` : "0%";

  function draw() {
    const track = getDeckTrack();
    const analysis = track?.analysis;
    duration = analysis?.duration ?? 0;
    el.name.textContent = track ? track.name : "—";
    el.timeTot.textContent = formatSeconds(duration);
    const waveformWidth = Math.round(el.waveform?.getBoundingClientRect().width ?? 0);
    const waveformSignature = `${track?.id ?? "empty"}:${analysis?.waveform?.peaks?.length ?? 0}:${duration}:${waveformWidth}`;
    if (waveformSignature !== renderedWaveformSignature) {
      renderedWaveformSignature = waveformSignature;
      try {
        drawWaveform(el.waveform, analysis, entryMode);
      } catch (error) {
        drawWaveformFallback(el.waveform, "errore waveform");
        log(`Waveform non disegnata (${track?.name ?? suffix}): ${error?.message ?? error}`);
      }
    }

    const place = (node, seconds) => {
      if (!node) return;
      if (!analysis || !duration || !Number.isFinite(seconds)) {
        node.style.display = "none";
        return;
      }
      node.style.display = "block";
      node.style.left = pct(seconds);
    };
    // On Deck B the green marker is the auto-chosen entry/mix-in point (editable);
    // on Deck A it is the track's own cue-in.
    const inSeconds = entryMode ? (analysis?.entryPoint ?? autoEntry(analysis)) : analysis?.cueIn;
    place(el.markIn, inSeconds);
    place(el.markOut, analysis?.cueOut);
    place(el.markMix, analysis?.mixPoint ?? autoMixPoint(analysis, duration));

    if (analysis?.beatInterval && duration) {
      const beat = (analysis.beatInterval / duration) * 100;
      const bar = beat * 4;
      const phrase = beat * (analysis.beatsPerPhrase ?? 16);
      const offset = ((analysis.firstBeat ?? 0) / duration) * 100;
      el.grid.style.backgroundImage = [
        `repeating-linear-gradient(90deg, rgba(255,243,223,0.10) 0 1px, transparent 1px ${beat}%)`,
        `repeating-linear-gradient(90deg, rgba(255,243,223,0.22) 0 1px, transparent 1px ${bar}%)`,
        `repeating-linear-gradient(90deg, rgba(93,211,158,0.5) 0 1.5px, transparent 1.5px ${phrase}%)`
      ].join(",");
      el.grid.style.backgroundPositionX = `${offset}%, ${offset}%, ${offset}%`;
      el.grid.style.display = "block";
    } else {
      el.grid.style.display = "none";
    }

    // The playhead only makes sense on the deck that is playing. On the other
    // deck hide it so it doesn't sit on top of the (draggable) cue-in marker.
    const isLive = !!track && track.id === state.playingTrackId;
    el.handle.style.display = isLive ? "block" : "none";
    if (!isLive) {
      const start = analysis?.cueIn ?? 0;
      el.fill.style.width = "0%";
      el.timeCur.textContent = formatSeconds(start);
    }
  }

  function updatePlayhead(playingTrack, currentTime, dur) {
    const track = getDeckTrack();
    if (!track || track.id !== playingTrack.id || scrubbing || dragging) return;
    duration = dur || duration;
    const frac = duration > 0 ? Math.min(1, currentTime / duration) : 0;
    el.fill.style.width = `${(frac * 100).toFixed(2)}%`;
    el.handle.style.left = `${(frac * 100).toFixed(2)}%`;
    el.timeCur.textContent = formatSeconds(currentTime);
  }

  function moveCue(event, commit = false) {
    const track = getDeckTrack();
    const analysis = track?.analysis;
    if (!analysis?.duration) return;
    let seconds = snapToBeat(fractionFromEvent(event) * analysis.duration, analysis);
    seconds = Math.min(analysis.duration, Math.max(0, seconds));

    if (dragging === "in") {
      if (entryMode) {
        analysis.entryPoint = Math.min(Math.max(seconds, 0), (analysis.cueOut ?? analysis.duration) - 1);
      } else {
        analysis.cueIn = Math.min(seconds, (analysis.cueOut ?? analysis.duration) - 1);
      }
    } else if (dragging === "out") {
      analysis.cueOut = Math.max(seconds, (analysis.cueIn ?? 0) + 1);
    } else if (dragging === "mix") {
      analysis.mixPoint = Math.min(Math.max(seconds, analysis.cueIn ?? 0), analysis.cueOut ?? analysis.duration);
    }
    draw();
    if (commit) {
      persistTrack(track);
      log(`Cue ${dragging} (${track.name}) -> ${formatSeconds(seconds)}`);
      render(); // refresh library/queue meta and both decks
    }
  }

  for (const marker of [el.markIn, el.markOut, el.markMix]) {
    if (!marker) continue;
    marker.addEventListener("pointerdown", (event) => {
      if (!getDeckTrack()?.analysis?.duration) return;
      event.stopPropagation();
      dragging = marker.dataset.cue;
      marker.setPointerCapture(event.pointerId);
      moveCue(event);
    });
    marker.addEventListener("pointermove", (event) => {
      if (dragging === marker.dataset.cue) moveCue(event);
    });
    marker.addEventListener("pointerup", (event) => {
      if (dragging !== marker.dataset.cue) return;
      moveCue(event, true);
      dragging = null;
    });
  }

  // Double-click the entry marker on Deck B to drop the manual override and let
  // the app pick the best entry point again.
  if (entryMode) {
    el.markIn?.addEventListener("dblclick", () => {
      const track = getDeckTrack();
      if (!track?.analysis) return;
      delete track.analysis.entryPoint;
      persistTrack(track);
      draw();
      render();
      log(`Entry point (${track.name}): tornato automatico`);
    });
  }

  const seekFromEvent = (event) => {
    const fraction = fractionFromEvent(event);
    el.fill.style.width = `${(fraction * 100).toFixed(2)}%`;
    el.handle.style.left = `${(fraction * 100).toFixed(2)}%`;
    el.timeCur.textContent = formatSeconds(fraction * duration);
    return fraction;
  };

  el.bar.addEventListener("pointerdown", (event) => {
    if (dragging) return;
    const track = getDeckTrack();
    if (!seekable() || !duration || !track || track.id !== state.playingTrackId) return;
    scrubbing = true;
    el.bar.setPointerCapture(event.pointerId);
    seekFromEvent(event);
  });
  el.bar.addEventListener("pointermove", (event) => {
    if (scrubbing) seekFromEvent(event);
  });
  el.bar.addEventListener("pointerup", (event) => {
    if (!scrubbing) return;
    const fraction = seekFromEvent(event);
    scrubbing = false;
    player.seek(fraction * duration);
  });

  return { render: draw, updatePlayhead };
}

function drawWaveform(canvas, analysis, accent = false) {
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);

  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "rgba(8, 12, 27, 0.95)");
  background.addColorStop(1, "rgba(17, 20, 42, 0.88)");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  const peaks = analysis?.waveform?.peaks;
  if (!Array.isArray(peaks) || peaks.length === 0) {
    drawWaveformMessage(ctx, width, height, ratio, "waveform non disponibile");
    return;
  }

  const duration = analysis?.duration ?? 0;
  const sections = normalizedWaveformSections(analysis, duration);

  for (const section of sections) {
    drawWaveformSection(ctx, peaks, section, analysis, width, height, ratio, accent);
  }

  const center = height / 2;
  ctx.strokeStyle = "rgba(238, 242, 255, 0.22)";
  ctx.lineWidth = Math.max(1, ratio);
  ctx.beginPath();
  ctx.moveTo(0, center);
  ctx.lineTo(width, center);
  ctx.stroke();

  drawBeatRulers(ctx, analysis, width, height, ratio);
  drawSectionLabels(ctx, analysis, width, height, ratio);
}

function drawWaveformFallback(canvas, message) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  drawWaveformMessage(ctx, width, height, ratio, message);
}

function drawWaveformMessage(ctx, width, height, ratio, message) {
  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "rgba(8, 12, 27, 0.95)");
  background.addColorStop(1, "rgba(17, 20, 42, 0.88)");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "rgba(238, 242, 255, 0.18)";
  ctx.font = `${Math.round(12 * ratio)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(message, width / 2, height / 2 + 4 * ratio);
}

function normalizedWaveformSections(analysis, duration) {
  const sections = Array.isArray(analysis?.sections) ? analysis.sections : [];
  if (!duration || sections.length === 0) {
    return [{ start: 0, end: duration || 1, type: "body" }];
  }
  const normalized = sections
    .filter((section) => section && typeof section === "object")
    .map((section) => {
      const start = Number(section.start);
      const end = Number(section.end);
      return {
        start: clamp(Number.isFinite(start) ? start : 0, 0, duration),
        end: clamp(Number.isFinite(end) ? end : duration, 0, duration),
        type: typeof section.type === "string" ? section.type : "body"
      };
    })
    .filter((section) => section.end > section.start);
  return normalized.length ? normalized.slice(0, 128) : [{ start: 0, end: duration, type: "body" }];
}

function drawWaveformSection(ctx, peaks, section, analysis, width, height, ratio, accent) {
  const duration = analysis?.duration || 1;
  const startX = Math.max(0, Math.floor((section.start / duration) * width));
  const endX = Math.min(width, Math.ceil((section.end / duration) * width));
  if (endX <= startX) return;

  const center = height / 2;
  const maxAmp = height * 0.43;
  const fill = ctx.createLinearGradient(startX, 0, endX, height);
  const base = sectionRgb(section.type, accent);
  fill.addColorStop(0, `rgba(${base[0]}, ${base[1]}, ${base[2]}, 0.82)`);
  fill.addColorStop(0.48, `rgba(${base[0]}, ${base[1]}, ${base[2]}, 0.98)`);
  fill.addColorStop(1, `rgba(${base[0]}, ${base[1]}, ${base[2]}, 0.68)`);

  // Soft coloured section bed, like commercial DJ waveforms.
  ctx.fillStyle = `rgba(${base[0]}, ${base[1]}, ${base[2]}, 0.08)`;
  ctx.fillRect(startX, 0, endX - startX, height);

  ctx.beginPath();
  for (let x = startX; x <= endX; x += 1) {
    const peak = interpolatedPeak(peaks, x / width);
    const y = center - Math.max(0.018, peak) * maxAmp;
    if (x === startX) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  for (let x = endX; x >= startX; x -= 1) {
    const peak = interpolatedPeak(peaks, x / width);
    ctx.lineTo(x, center + Math.max(0.018, peak) * maxAmp);
  }
  ctx.closePath();

  ctx.save();
  ctx.shadowColor = `rgba(${base[0]}, ${base[1]}, ${base[2]}, 0.42)`;
  ctx.shadowBlur = 9 * ratio;
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = `rgba(${base[0]}, ${base[1]}, ${base[2]}, 0.72)`;
  ctx.lineWidth = Math.max(1, 0.7 * ratio);
  ctx.stroke();
}

function interpolatedPeak(peaks, fraction) {
  if (!peaks.length) return 0;
  const position = clamp(fraction, 0, 1) * (peaks.length - 1);
  const left = Math.floor(position);
  const right = Math.min(peaks.length - 1, left + 1);
  const mix = position - left;
  const value = (peaks[left] ?? 0) * (1 - mix) + (peaks[right] ?? 0) * mix;
  return clamp(value, 0, 1);
}

function waveformColor(seconds, analysis, accent) {
  const section = sectionAt(seconds, analysis?.sections);
  if (section) return sectionColor(section.type, seconds, analysis);

  const beatInterval = analysis?.beatInterval;
  const firstBeat = analysis?.firstBeat ?? 0;
  if (!beatInterval || seconds < firstBeat) {
    return accent ? "rgba(244, 114, 182, 0.82)" : "rgba(34, 211, 238, 0.82)";
  }

  const beat = Math.floor((seconds - firstBeat) / beatInterval);
  const beatsPerPhrase = analysis?.beatsPerPhrase ?? 16;
  if (beat % beatsPerPhrase === 0) return "rgba(244, 114, 182, 0.98)";
  if (beat % 4 === 0) return "rgba(34, 211, 238, 0.96)";
  if (beat % 2 === 0) return "rgba(74, 222, 128, 0.88)";
  return accent ? "rgba(168, 85, 247, 0.78)" : "rgba(238, 242, 255, 0.72)";
}

function sectionAt(seconds, sections) {
  if (!Array.isArray(sections)) return null;
  return sections.find((section) => (
    section &&
    Number.isFinite(section.start) &&
    Number.isFinite(section.end) &&
    seconds >= section.start &&
    seconds < section.end
  )) ?? null;
}

function sectionColor(type, seconds, analysis) {
  const rgb = sectionRgb(type);
  const beatInterval = analysis?.beatInterval;
  const firstBeat = analysis?.firstBeat ?? 0;
  let alpha = 0.72;

  if (beatInterval && seconds >= firstBeat) {
    const beat = Math.floor((seconds - firstBeat) / beatInterval);
    const beatsPerPhrase = analysis?.beatsPerPhrase ?? 16;
    if (beat % beatsPerPhrase === 0) alpha = 1;
    else if (beat % 4 === 0) alpha = 0.92;
    else if (beat % 2 === 0) alpha = 0.8;
  }

  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

function sectionRgb(type, accent = false) {
  const palette = {
    intro: [34, 211, 238],
    build: [250, 204, 21],
    drop: [244, 63, 94],
    break: [168, 85, 247],
    body: accent ? [244, 114, 182] : [238, 242, 255],
    outro: [74, 222, 128]
  };
  return palette[type] ?? palette.body;
}

function drawBeatRulers(ctx, analysis, width, height, ratio) {
  const duration = analysis?.duration;
  const beatInterval = analysis?.beatInterval;
  if (!Number.isFinite(duration) || !Number.isFinite(beatInterval) || duration <= 0 || beatInterval <= 0.08) return;

  const firstBeat = analysis.firstBeat ?? 0;
  const beatsPerPhrase = Math.max(1, Math.round(analysis.beatsPerPhrase ?? 16));
  const startBeat = Math.ceil((0 - firstBeat) / beatInterval);
  const endBeat = Math.floor((duration - firstBeat) / beatInterval);
  if (endBeat - startBeat > 2000) return;

  for (let beat = startBeat; beat <= endBeat; beat += 1) {
    const seconds = firstBeat + beat * beatInterval;
    const x = (seconds / duration) * width;
    if (x < 0 || x > width) continue;

    const isPhrase = beat % beatsPerPhrase === 0;
    const isBar = beat % 4 === 0;
    if (!isPhrase && !isBar) continue;

    ctx.strokeStyle = isPhrase ? "rgba(244, 114, 182, 0.65)" : "rgba(34, 211, 238, 0.42)";
    ctx.lineWidth = isPhrase ? 2 * ratio : 1 * ratio;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

function drawSectionLabels(ctx, analysis, width, height, ratio) {
  const duration = analysis?.duration;
  const sections = analysis?.sections;
  if (!Number.isFinite(duration) || duration <= 0 || !Array.isArray(sections)) return;

  ctx.font = `${Math.round(10 * ratio)}px sans-serif`;
  ctx.textBaseline = "top";
  for (const section of sections.slice(0, 128)) {
    if (!section || !Number.isFinite(section.start) || !Number.isFinite(section.end)) continue;
    const startX = (section.start / duration) * width;
    const endX = (section.end / duration) * width;
    const labelWidth = endX - startX;
    if (labelWidth < 42 * ratio) continue;

    const type = typeof section.type === "string" ? section.type : "body";
    const label = type.toUpperCase();
    ctx.fillStyle = "rgba(6, 7, 15, 0.52)";
    ctx.fillRect(startX + 4 * ratio, 5 * ratio, Math.min(labelWidth - 8 * ratio, 54 * ratio), 16 * ratio);
    ctx.fillStyle = sectionColor(type, section.start, analysis).replace(/, [0-9.]+\)$/, ", 0.95)");
    ctx.fillText(label, startX + 8 * ratio, 8 * ratio);
  }
}

// Deck A shows the live track (or a track focused for editing); Deck B shows the
// next track that will be mixed in, so its intro/cues are adjustable in advance.
function deckATrack() {
  return getTrack(state.focusedTrackId) ?? getTrack(state.playingTrackId);
}

function deckBTrack() {
  return getTrack(selectNextTrackId(selectionAnchorTrack()));
}

const deckScrubbers = [
  createScrubber("A", deckATrack, () => true),
  createScrubber("B", deckBTrack, () => false, true)
];

bindPlatter(elements.platterA, "A");
bindPlatter(elements.platterB, "B");

function renderScrubber() {
  for (const scrubber of deckScrubbers) {
    try {
      scrubber.render();
    } catch (error) {
      log(`Deck non aggiornato: ${error?.message ?? error}`);
    }
  }
}

elements.fileInput.addEventListener("change", async (event) => {
  const files = Array.from(event.target.files ?? []);
  for (const file of files) {
    addTrack(file);
  }
  render();
  analyzePendingTracks();
  elements.fileInput.value = "";
});

elements.addAllBtn.addEventListener("click", () => {
  for (const track of state.tracks) {
    if (!state.queue.includes(track.id) && track.id !== state.playingTrackId) {
      state.queue.push(track.id);
    }
  }
  render();
});

elements.clearQueueBtn.addEventListener("click", () => {
  state.queue = [];
  render();
});

elements.autoOrderBtn.addEventListener("click", () => {
  autoOrderQueue();
});

elements.arcPeakInput.addEventListener("input", () => {
  elements.arcPeakVal.textContent = `${Math.round(Number(elements.arcPeakInput.value) * 100)}%`;
});

elements.arcWeightInput.addEventListener("input", () => {
  elements.arcWeightVal.textContent = `${Math.round(Number(elements.arcWeightInput.value) * 100)}%`;
});

elements.clearLogBtn.addEventListener("click", () => {
  elements.log.textContent = "";
});

elements.startBtn.addEventListener("click", async () => {
  if (player.currentTrack) {
    log("Riproduzione già attiva.");
    return;
  }

  if (!state.queue.length && state.tracks.length) {
    state.queue = state.tracks
      .filter((track) => track.id !== state.playingTrackId)
      .map((track) => track.id);
  }

  const first = popNextTrack(null, { allowUnanalyzed: true });
  if (!first) {
    log("Playlist vuota: importa o aggiungi brani alla coda.");
    return;
  }

  try {
    log(`Avvio: ${first.name}`);
    await player.start(first, popNextTrack, Number(elements.crossfadeInput.value));
  } catch (error) {
    state.playingTrackId = null;
    if (!state.queue.includes(first.id)) state.queue.unshift(first.id);
    log(`Errore avvio audio: ${error?.message ?? error}`);
  } finally {
    render();
  }
});

elements.stopBtn.addEventListener("click", () => {
  player.stop();
  state.playingTrackId = null;
  renderScrubber();
  render();
});

elements.skipBtn.addEventListener("click", () => {
  player.skip();
});

elements.crossfadeInput.addEventListener("change", () => {
  player.setCrossfade(Number(elements.crossfadeInput.value));
  renderScrubber();
});

elements.crossfadeAutoInput.addEventListener("change", () => {
  const auto = elements.crossfadeAutoInput.checked;
  player.setAutoCrossfade(auto);
  elements.crossfadeInput.title = auto ? "Durata massima del crossfade automatico" : "Durata fissa del crossfade";
  renderScrubber();
});

elements.crossfadeCurveInput?.addEventListener("change", () => {
  player.setCrossfadeCurve(elements.crossfadeCurveInput.value);
});

player.setAutoCrossfade(elements.crossfadeAutoInput.checked);
player.setCrossfadeCurve(elements.crossfadeCurveInput?.value ?? "power");
player.setRadioEditMode(elements.radioEditInput?.checked ?? true);

elements.radioEditInput?.addEventListener("change", () => {
  player.setRadioEditMode(elements.radioEditInput.checked);
  renderScrubber();
  render();
});

elements.beatmatchInput.addEventListener("change", () => {
  player.setBeatmatch(elements.beatmatchInput.checked);
});

elements.bassSwapInput.addEventListener("change", () => {
  player.setBassSwap(elements.bassSwapInput.checked);
});

elements.levelerInput.addEventListener("change", () => {
  player.setLeveler(elements.levelerInput.checked);
});

elements.tempoTolInput.addEventListener("input", () => {
  const value = Number(elements.tempoTolInput.value);
  player.setTempoTolerance(value);
  elements.tempoTolVal.textContent = `±${Math.round(value * 100)}%`;
});

player.setBeatmatch(elements.beatmatchInput.checked);
player.setBassSwap(elements.bassSwapInput.checked);
player.setTempoTolerance(Number(elements.tempoTolInput.value));
player.leveler = elements.levelerInput.checked;

function addTrack(file) {
  const id = crypto.randomUUID();
  const track = {
    id,
    file,
    name: stripExtension(file.name),
    url: URL.createObjectURL(file),
    status: "pending",
    analysis: null,
    error: null
  };

  state.tracks.push(track);
  state.queue.push(track.id);
  persistTrack(track);
}

// Persist a track's data (minus the session-only object URL) to IndexedDB.
function persistTrack(track) {
  saveTrackRecord({
    id: track.id,
    file: track.file,
    name: track.name,
    status: track.status,
    analysis: track.analysis,
    error: track.error
  }).catch((error) => log(`Persistenza non riuscita: ${error?.message ?? error}`));
}

let queueSaveTimer = null;
function persistQueue() {
  window.clearTimeout(queueSaveTimer);
  queueSaveTimer = window.setTimeout(() => {
    saveMeta("queue", [...state.queue]).catch(() => {});
  }, 300);
}

function removeTrackFromLibrary(id) {
  const track = getTrack(id);
  if (track?.url) URL.revokeObjectURL(track.url);
  state.tracks = state.tracks.filter((item) => item.id !== id);
  state.queue = state.queue.filter((item) => item !== id);
  if (state.playingTrackId === id) state.playingTrackId = null;
  deleteTrackRecord(id).catch(() => {});
}

// Restore the library and playlist saved in a previous session.
async function restoreLibrary() {
  let records = [];
  try {
    records = (await getAllTrackRecords()) ?? [];
  } catch {
    return;
  }
  if (!records.length) return;

  for (const record of records) {
    state.tracks.push({
      id: record.id,
      file: record.file,
      name: record.name,
      url: URL.createObjectURL(record.file),
      // Tracks interrupted mid-analysis are re-queued for analysis.
      status: record.status === "ready" || record.status === "error" ? record.status : "pending",
      analysis: record.analysis ?? null,
      error: record.error ?? null
    });
  }

  const savedQueue = await getMeta("queue").catch(() => null);
  if (Array.isArray(savedQueue)) {
    state.queue = savedQueue.filter((id) => getTrack(id));
  } else {
    state.queue = state.tracks.map((track) => track.id);
  }

  log(`Libreria ripristinata: ${state.tracks.length} brani.`);
  render();
  analyzePendingTracks();
}

async function analyzePendingTracks() {
  const pending = state.tracks.filter((track) => track.status === "pending");
  if (!pending.length) return;

  for (const track of pending) {
    track.status = "analyzing";
    state.analyzingCount += 1;
  }
  render();

  // Essentia/MusicExtractor is CPU-heavy and the local FastAPI server is a
  // single worker. Parallel requests make the backend look frozen, so analyze
  // sequentially and let the browser fallback handle backend timeouts.
  const CONCURRENCY = 1;
  const pool = [...pending];

  async function analyzeOne() {
    while (pool.length > 0) {
      const track = pool.shift();
      if (!track) break;
      try {
        track.analysis = await analyzeTrack(track.file);
        track.status = "ready";
        log(`Analizzato: ${track.name} | ${formatTrackAnalysis(track.analysis)}`);
      } catch (error) {
        track.status = "error";
        track.error = error instanceof Error ? error.message : String(error);
        log(`Errore analisi: ${track.name} | ${track.error}`);
      } finally {
        state.analyzingCount -= 1;
        persistTrack(track);
        render();
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, analyzeOne));
}

function popNextTrack(currentTrack, options = {}) {
  if (options.commitId) {
    const committed = getTrack(options.commitId);
    if (!committed) return null;
    state.queue = state.queue.filter((id) => id !== options.commitId);
    state.playingTrackId = options.commitId;
    render();
    return committed;
  }

  const nextId = selectNextTrackId(currentTrack, options);
  if (!nextId) return null;

  const next = getTrack(nextId);
  if (options.peek) return next;

  state.queue = state.queue.filter((id) => id !== nextId);
  state.playingTrackId = nextId;
  render();
  return next;
}

function readyQueueIds(options = {}) {
  return state.queue.filter((id) => {
    const track = getTrack(id);
    if (!track || id === state.playingTrackId) return false;
    return options.allowUnanalyzed || track.status === "ready";
  });
}

function selectionAnchorTrack() {
  return player.currentTrack ?? getTrack(state.playingTrackId) ?? null;
}

// Single source of truth for "what comes next". Deck B preview, queue highlight,
// auto transition and manual MIDI crossfade all use this exact selector.
function selectNextTrackId(currentTrack, options = {}) {
  let readyIds = readyQueueIds(options);
  if (!readyIds.length && options.allowUnanalyzed) {
    readyIds = state.tracks
      .filter((track) => track.id !== state.playingTrackId)
      .map((track) => track.id);
  }
  if (!readyIds.length) return null;

  if (!elements.smartModeInput.checked || !currentTrack?.analysis) {
    return readyIds[0];
  }

  const scored = readyIds
    .filter((id) => getTrack(id)?.analysis)
    .map((id) => ({ id, score: scoreTransition(currentTrack, getTrack(id)) }))
    .sort((a, b) => b.score - a.score)[0]?.id ?? readyIds[0];
  // Build the shared plannedTransition for the chosen next track and hand it to
  // the player + debug panel. Recomputed each time the selection is evaluated.
  const chosen = getTrack(scored);
  if (chosen) {
    const plan = planTransition(currentTrack, chosen);
    player.plannedTransition = plan;
    updateDebugPanel(currentTrack, chosen, plan);
  }
  return scored;
}

function scoreTransition(current, candidate) {
  const a = current.analysis;
  const b = candidate.analysis;
  if (!a || !b) return 0;

  const bpmScore = bpmCompatibility(a.bpm, b.bpm);
  const keyScore = keyCompatibility(a.key, b.key);
  // Weight key by confidence: uncertain key means score relies more on BPM/energy
  const keyConf = Math.max(0.5, a.keyConfidence ?? 0.5) * Math.max(0.5, b.keyConfidence ?? 0.5);
  // Penalize energy drops more than rises — DJ sets should build, not collapse
  const energyDelta = b.energy - a.energy;
  const energyScore = energyDelta >= 0
    ? 1 - Math.min(1, energyDelta / 0.6)
    : 1 - Math.min(1, Math.abs(energyDelta) / 0.35);

  // Need enough crossfade room: both the outgoing outro and the incoming intro
  // must offer a usable mix window (vocal-free when Demucs analyzed them).
  const fade = Math.max(4, Number(elements.crossfadeInput.value) || 24);
  const introScore = Math.min(1, (b.mixableIntro ?? 0) / fade);
  const outroScore = Math.min(1, (a.mixableOutro ?? 0) / fade);
  const radioEdit = !!elements.radioEditInput?.checked;
  // Prefer the backend's scored candidates (version>=2); fall back to the
  // section-based radio points for older analyses.
  const entryPoint = radioEdit
    ? (bestCandidate(b, "entryPoint", NaN)?.t ?? radioEntryPoint(b))
    : NaN;
  const mixPoint = radioEdit
    ? (bestCandidate(a, "mixPoint", NaN)?.t ?? radioMixPoint(a, a.duration ?? b.duration ?? 0))
    : NaN;
  const entryScore = Number.isFinite(entryPoint)
    ? Math.min(1, Math.max(0, (entryPoint - (b.cueIn ?? 0)) / Math.max(1, fade)))
    : 0;
  const mixScore = Number.isFinite(mixPoint)
    ? Math.min(1, Math.max(0, ((a.cueOut ?? a.duration ?? 0) - mixPoint) / Math.max(1, fade)))
    : 0;

  // Vocal-clash guard: when stem data exists, heavily reward instrumental
  // intro/outro so we never fade a vocal over another vocal.
  let vocalScore = 0.5;
  if (a.vocals?.available && b.vocals?.available) {
    const outroSafe = clamp01((a.vocals.vocalOutro ?? 0) / fade);
    const introSafe = clamp01((b.vocals.vocalIntro ?? 0) / fade);
    const clashPenalty = (a.vocals.vocalDensityOutro ?? 0) * (b.vocals.vocalDensityIntro ?? 0);
    vocalScore = clamp01((outroSafe + introSafe) / 2 - clashPenalty);
  }

  return (
    bpmScore * 32 +
    keyScore * keyConf * 20 +
    energyScore * 16 +
    introScore * 10 +
    outroScore * 7 +
    vocalScore * 15 +
    entryScore * (radioEdit ? 10 : 0) +
    mixScore * (radioEdit ? 10 : 0)
  );
}

// Pick the best candidate time of a kind from the backend, falling back to the
// legacy single field, then to a supplied default. Works with version<2 analyses.
function bestCandidate(analysis, kind, fallback) {
  const list = analysis?.candidates?.[kind];
  // The single field (analysis.entryPoint/mixPoint/cueIn/cueOut) is BOTH the
  // back-compat default (= top candidate) and the target of manual marker drags.
  // Prefer it, so dragging a point actually changes the planned mix. When it
  // matches a candidate we keep that candidate's reasons, otherwise label manual.
  const manual = analysis?.[kind];
  if (Number.isFinite(manual)) {
    const match = Array.isArray(list) ? list.find((c) => Math.abs(c.t - manual) < 0.05) : null;
    return { t: manual, reasons: match ? (match.reasons ?? []) : ["punto impostato manualmente"] };
  }
  if (Array.isArray(list) && list.length && Number.isFinite(list[0].t)) {
    return { t: list[0].t, reasons: list[0].reasons ?? [] };
  }
  if (Number.isFinite(fallback)) return { t: fallback, reasons: [] };
  return null;
}

// Assemble the shared mix decision from BOTH tracks' candidates. This single
// object is consumed by the player (entry/mix points, duration, curve, EQ) and
// shown in the debug panel with its Italian reasons.
function planTransition(current, candidate) {
  const a = current?.analysis;
  const b = candidate?.analysis;
  if (!a || !b) return null;
  const radioEdit = !!elements.radioEditInput?.checked;

  const fromMix = bestCandidate(a, "mixPoint", autoMixPoint(a, a.duration ?? 0));
  const toEntry = bestCandidate(b, "entryPoint", autoEntry(b));
  if (!fromMix || !toEntry) return null;

  const reasons = [];
  // Crossfade duration: in radio-edit mode it is short and precise, independent
  // from the club crossfade slider; otherwise mirror the player's auto/club fade.
  const beat = a.beatInterval ?? (a.bpm ? 60 / a.bpm : 0.5);
  const energy = ((a.energy ?? 0.5) + (b.energy ?? 0.5)) / 2;
  let durationBeats;
  if (radioEdit) {
    durationBeats = 16; // one clean phrase: precise but still musical, not a chop
    reasons.push("radio edit: transizione di una frase, precisa ma musicale");
  } else {
    durationBeats = energy > 0.66 ? 16 : energy > 0.4 ? 32 : 48;
    reasons.push(`durata ${durationBeats} beat in base all'energia`);
  }

  // Vocal-clash risk at the two mix zones (from the always-on timeline VAD).
  const fromVocal = vocalRiskAt(a, fromMix.t);
  const toVocal = vocalRiskAt(b, toEntry.t);
  const bothVocal = fromVocal > 0.45 && toVocal > 0.45;

  // Curve: power with mid-duck on vocal clash (no brutal cut); smooth for long
  // harmonic mixes; power as the safe default.
  let curve = "power";
  if (bothVocal) {
    // Voci su entrambi i lati: niente taglio brutale. Crossfade equal-power piu
    // corto + EQ mid-duck per togliere lo scontro tra le voci, restando melodico.
    durationBeats = Math.max(8, Math.min(durationBeats, 16));
    reasons.push("voce su entrambi i brani: power breve con mid-duck (niente taglio)");
  } else if (durationBeats >= 24 && keyCompatibility(a.key, b.key) > 0.6) {
    curve = "smooth";
    reasons.push("smooth: mix armonico lungo");
  } else {
    reasons.push("power: curva di default equal-power");
  }
  if (fromVocal < 0.35) reasons.push("uscita su zona poco vocale");

  // The mix MUST complete by the end of the incoming track's intro, otherwise it
  // would play over the body and the song is lost. Cap the duration to the intro
  // window of the entering track (measured in its own beats).
  const beatB = b.beatInterval ?? (b.bpm ? 60 / b.bpm : beat);
  if (Number.isFinite(b.introEnd) && b.introEnd > toEntry.t) {
    const introBeats = Math.floor((b.introEnd - toEntry.t) / beatB);
    if (introBeats >= 4 && introBeats < durationBeats) {
      durationBeats = introBeats;
      reasons.push("durata limitata alla fine dell'intro entrante (canzone non persa)");
    }
  }
  // The crossfade must finish by the OUTGOING track's end, so the song is heard
  // almost to the end instead of being cut at 2/3.
  const outEnd = a.cueOut ?? a.duration;
  if (Number.isFinite(outEnd) && outEnd > fromMix.t) {
    const outBeats = Math.floor((outEnd - fromMix.t) / beat);
    if (outBeats >= 4 && outBeats < durationBeats) {
      durationBeats = outBeats;
      reasons.push("durata limitata alla fine del brano uscente (suona fino in fondo)");
    }
  }

  // Beatmatch only when BPMs are close enough (octave-folded) to time-stretch.
  const beatmatch = !!elements.beatmatchInput?.checked && bpmCompatibility(a.bpm, b.bpm) > 0.4;
  reasons.push(beatmatch ? "beatmatch attivo" : "nessun beatmatch (BPM distanti)");

  // EQ strategy from the spectral band overlap of the two tracks.
  const eqStrategy = bothVocal ? "bass-swap-mid-duck" : "bass-swap";

  return {
    fromMixPoint: fromMix.t,
    toEntryPoint: toEntry.t,
    durationBeats,
    durationSeconds: Math.max(2, durationBeats * beat),
    curve,
    beatmatch,
    eqStrategy,
    reasons: [...reasons, ...fromMix.reasons.slice(0, 1).map((r) => `uscita: ${r}`),
      ...toEntry.reasons.slice(0, 1).map((r) => `ingresso: ${r}`)]
  };
}

// Heuristic vocal risk (0..1) at an absolute time, read from the per-second
// timeline. Returns 0 for version<1 analyses without a timeline.
function vocalRiskAt(analysis, seconds) {
  const tl = analysis?.timeline;
  if (!tl?.vocalRisk?.length || !Number.isFinite(seconds)) return 0;
  const step = tl.step || 1;
  const i = Math.max(0, Math.min(tl.vocalRisk.length - 1, Math.round(seconds / step)));
  return tl.vocalRisk[i] ?? 0;
}

function sectionWeight(type) {
  if (type === "intro" || type === "outro") return 1;
  if (type === "break") return 0.85;
  if (type === "build") return 0.65;
  if (type === "body") return 0.5;
  if (type === "drop") return 0.2;
  return 0.4;
}

function radioEntryPoint(analysis) {
  if (!analysis) return NaN;
  const cue = analysis.cueIn ?? 0;
  const beat = analysis.beatInterval ?? 0;
  const sections = Array.isArray(analysis.sections) ? analysis.sections : [];
  const candidates = [];
  for (const section of sections) {
    if (!section || section.end <= cue) continue;
    const boundary = snapToBeat(Math.max(cue, section.start ?? cue), analysis);
    const vocalPenalty = analysis.vocals?.available
      ? clamp01(((analysis.vocals.vocalDensityIntro ?? 0) + (analysis.vocals.vocalIntro ?? 0)) / 2)
      : 0.35;
    const distancePenalty = Math.max(0, boundary - cue) / Math.max(1, beat || 8);
    const score = sectionWeight(section.type) * 2 - vocalPenalty - distancePenalty * 0.4;
    candidates.push({ boundary, score });
  }
  if (!candidates.length) return standardEntryPoint(analysis);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].boundary;
}

function radioMixPoint(analysis, duration) {
  if (!analysis) return NaN;
  const cueIn = analysis.cueIn ?? 0;
  const cueOut = analysis.cueOut ?? duration ?? 0;
  const beat = analysis.beatInterval ?? 0;
  const sections = Array.isArray(analysis.sections) ? analysis.sections : [];
  const candidates = [];
  for (const section of sections) {
    if (!section || section.start < cueIn || section.end > cueOut) continue;
    const boundary = snapToBeat(section.end ?? cueOut, analysis);
    const vocalSafe = analysis.vocals?.available
      ? 1 - clamp01((analysis.vocals.vocalDensityOutro ?? 0) * 0.9)
      : 0.5;
    const distancePenalty = Math.max(0, cueOut - boundary) / Math.max(1, beat || 8);
    const score = sectionWeight(section.type) * 2 + vocalSafe - distancePenalty * 0.4;
    candidates.push({ boundary, score });
  }
  if (!candidates.length) return standardMixPoint(analysis, duration);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].boundary;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Reorder the playlist into a coherent set: greedy nearest-neighbour on the same
// transition score (BPM, key/Camelot, energy curve, mix windows, vocal clash).
function autoOrderQueue() {
  const ready = state.queue.filter((id) => {
    const track = getTrack(id);
    return track?.status === "ready" && track.analysis;
  });
  const rest = state.queue.filter((id) => !ready.includes(id));

  if (ready.length < 2) {
    log("Servono almeno 2 brani analizzati per ordinare il set.");
    return;
  }

  const useArc = elements.energyArcInput.checked;
  const peakAt = Number(elements.arcPeakInput.value) || 0.65;
  const arcWeight = Number(elements.arcWeightInput.value); // 0 = solo compat, 1 = solo energia
  const total = ready.length;
  const pool = new Set(ready);
  const ordered = [];

  // Seed: continue from the track on air if any, otherwise open with the
  // lowest-energy track so the set builds upward.
  let current = getTrack(state.playingTrackId);
  if (!current || !pool.has(state.playingTrackId)) {
    let seedId = ready[0];
    let lowest = Infinity;
    for (const id of ready) {
      const energy = getTrack(id).analysis.energy ?? 1;
      if (energy < lowest) {
        lowest = energy;
        seedId = id;
      }
    }
    ordered.push(seedId);
    pool.delete(seedId);
    current = getTrack(seedId);
  }

  while (pool.size) {
    const position = ordered.length;
    const target = energyArcTarget(position, total, peakAt);

    let bestId = null;
    let bestScore = -Infinity;
    for (const id of pool) {
      const candidate = getTrack(id);
      // Compatibility (0..1) plus, optionally, how well the candidate's energy
      // matches the desired point on the arc, blended by the user's weight.
      const compat = scoreTransition(current, candidate) / 100;
      const arcFit = 1 - Math.abs((candidate.analysis.energy ?? 0.5) - target);
      const score = useArc ? compat * (1 - arcWeight) + arcFit * arcWeight : compat;
      if (score > bestScore) {
        bestScore = score;
        bestId = id;
      }
    }
    ordered.push(bestId);
    pool.delete(bestId);
    current = getTrack(bestId);
  }

  state.queue = [...ordered, ...rest];
  render();
  log(
    useArc
      ? `Set ordinato: ${ordered.length} brani con arco di energia (calmo → picco → chiusura).`
      : `Set ordinato: ${ordered.length} brani per flusso armonico.`
  );
}

// Desired energy at a given position in the set: rises to a peak at `peakAt`
// (fraction of the set), then comes down — the classic DJ-set energy arc.
function energyArcTarget(position, total, peakAt = 0.65) {
  if (total <= 1) return 0.6;
  const t = position / (total - 1);
  if (t <= peakAt) return 0.25 + (1.0 - 0.25) * (t / Math.max(0.001, peakAt));
  return 1.0 - (1.0 - 0.5) * ((t - peakAt) / Math.max(0.001, 1 - peakAt));
}

function render() {
  renderLibrary();
  renderQueue();
  updateStartButton();
  elements.addAllBtn.disabled = state.tracks.length === 0;
  renderScrubber();
  persistQueue();
}

function updateStartButton() {
  const isPlaying = !!player.currentTrack;
  const hasTracks = state.tracks.length > 0;
  const hasQueue = state.queue.length > 0;
  const hasReady = state.queue.some((id) => getTrack(id)?.status === "ready");

  elements.startBtn.disabled = false;
  elements.startBtn.classList.toggle("is-playing", isPlaying);
  elements.startBtn.classList.toggle("is-ready", !isPlaying && (hasQueue || hasTracks));
  elements.startBtn.classList.toggle("is-empty", !isPlaying && !hasQueue && !hasTracks);
  elements.startBtn.textContent = isPlaying ? "In onda" : "Start";
  elements.startBtn.title = isPlaying
    ? "Riproduzione attiva"
    : hasReady
      ? "Avvia la playlist"
      : hasTracks
        ? "Avvia anche se l'analisi non e' ancora pronta"
        : "Importa o aggiungi brani alla playlist";
}

function renderLibrary() {
  if (!state.tracks.length) {
    elements.libraryList.className = "track-list empty";
    elements.libraryList.innerHTML = "<p>Nessun brano importato.</p>";
    return;
  }

  elements.libraryList.className = "track-list";
  elements.libraryList.innerHTML = state.tracks.map((track) => trackTemplate(track, "library")).join("");
  bindTrackActions(elements.libraryList);
}

function renderQueue() {
  if (!state.queue.length) {
    elements.queueList.className = "track-list empty";
    elements.queueList.innerHTML = "<p>Playlist vuota.</p>";
    return;
  }

  elements.queueList.className = "track-list";
  elements.queueList.innerHTML = state.queue
    .map((id, index) => trackTemplate(getTrack(id), "queue", index))
    .join("");
  bindTrackActions(elements.queueList);
}

function trackTemplate(track, context, index = -1) {
  if (!track) return "";

  const analysis = track.analysis;
  const meta = analysis
    ? [
        `${formatSeconds(analysis.duration)}`,
        analysis.bpm ? `${analysis.bpm} BPM` : "BPM n/d",
        analysis.key ? (toCamelot(analysis.key) ?? `key ${analysis.key}`) : "key n/d",
        `energia ${Math.round(analysis.energy * 100)}%`,
        `in ${formatSeconds(analysis.cueIn)}`,
        `out ${formatSeconds(analysis.cueOut)}`,
        `intro ${formatSeconds(analysis.mixableIntro)}`
      ]
    : [statusLabel(track)];

  const isPlaying = state.playingTrackId === track.id;
  const isFocused = state.focusedTrackId === track.id;
  const isNext = context === "queue" && track.id === selectNextTrackId(selectionAnchorTrack());
  const editBtn = track.status === "ready"
    ? `<button data-action="focus" data-id="${track.id}" title="Modifica cue / griglia">✎</button>`
    : "";
  const queueActions = context === "queue"
    ? `
      ${editBtn}
      <button data-action="up" data-id="${track.id}" title="Su" ${index <= 0 ? "disabled" : ""}>↑</button>
      <button data-action="down" data-id="${track.id}" title="Giù" ${index >= state.queue.length - 1 ? "disabled" : ""}>↓</button>
      <button data-action="remove" data-id="${track.id}" title="Rimuovi">×</button>
    `
    : `
      ${editBtn}
      <button data-action="enqueue" data-id="${track.id}" title="Aggiungi">+</button>
      <button data-action="delete" data-id="${track.id}" title="Elimina dalla libreria">🗑</button>
    `;

  return `
    <div class="track ${isPlaying ? "playing" : ""} ${isFocused ? "focused" : ""} ${isNext ? "next-up" : ""}">
      <div>
        <h3>${escapeHtml(track.name)}</h3>
        <div class="track-meta">
          ${meta.map((item) => `<span class="pill">${escapeHtml(item)}</span>`).join("")}
        </div>
      </div>
      <div class="track-actions">${queueActions}</div>
    </div>
  `;
}

function bindTrackActions(root) {
  root.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      const id = button.dataset.id;

      if (action === "enqueue" && id && !state.queue.includes(id)) state.queue.push(id);
      if (action === "remove" && id) state.queue = state.queue.filter((item) => item !== id);
      if (action === "delete" && id) removeTrackFromLibrary(id);
      if (action === "up" && id) moveQueueItem(id, -1);
      if (action === "down" && id) moveQueueItem(id, 1);
      if (action === "focus" && id) {
        state.focusedTrackId = id;
        renderScrubber();
      }

      render();
    });
  });
}

function moveQueueItem(id, delta) {
  const index = state.queue.indexOf(id);
  const nextIndex = index + delta;
  if (index < 0 || nextIndex < 0 || nextIndex >= state.queue.length) return;
  const next = [...state.queue];
  [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
  state.queue = next;
}

function setNowPlaying(track) {
  state.playingTrackId = track?.id ?? null;
  // Follow the playing track in the scrubber (unless the user is editing another).
  if (track) state.focusedTrackId = track.id;
  elements.nowTitle.textContent = track?.name ?? "Nessun brano";
  elements.nowMeta.textContent = track?.analysis
    ? formatTrackAnalysis(track.analysis)
    : "Carica una playlist per iniziare.";
  renderScrubber();
  render();
}

function getTrack(id) {
  return state.tracks.find((track) => track.id === id);
}

function log(message) {
  const timestamp = new Date().toLocaleTimeString();
  elements.log.textContent = `[${timestamp}] ${message}\n${elements.log.textContent}`;
}

// Lightweight inspectable view of the chosen candidates and the plannedTransition
// reasons. Hidden until there is something to show.
function updateDebugPanel(current, next, plan) {
  const panel = elements.mixDebugPanel;
  const out = elements.mixDebug;
  if (!panel || !out) return;
  const a = current?.analysis;
  const b = next?.analysis;
  if (!a || !b) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const candBlock = (analysis, kind, label) => {
    const list = analysis?.candidates?.[kind];
    if (!Array.isArray(list) || !list.length) return `<div class="dbg-row"><b>${label}</b> n/d (analisi legacy)</div>`;
    const items = list.slice(0, 3).map((c) =>
      `<li>${formatSeconds(c.t)} · ${Math.round((c.score ?? 0) * 100)}% — ${escapeHtml((c.reasons ?? []).join(", "))}</li>`
    ).join("");
    return `<div class="dbg-row"><b>${label}</b><ol>${items}</ol></div>`;
  };

  const planBlock = plan
    ? `<div class="dbg-row"><b>plannedTransition</b><ul>
        <li>mix ${formatSeconds(plan.fromMixPoint)} → entry ${formatSeconds(plan.toEntryPoint)}</li>
        <li>durata ${plan.durationBeats} beat (${formatSeconds(plan.durationSeconds)}) · curva ${plan.curve} · beatmatch ${plan.beatmatch ? "sì" : "no"} · EQ ${plan.eqStrategy}</li>
        <li>${escapeHtml(plan.reasons.join(" · "))}</li>
      </ul></div>`
    : `<div class="dbg-row"><b>plannedTransition</b> n/d</div>`;

  out.innerHTML = `
    <div class="dbg-track">Uscente: ${escapeHtml(current.name)}</div>
    ${candBlock(a, "mixPoint", "Mix point (uscente)")}
    ${candBlock(a, "cueOut", "Cue out (uscente)")}
    <div class="dbg-track">Entrante: ${escapeHtml(next.name)}</div>
    ${candBlock(b, "entryPoint", "Entry point (entrante)")}
    ${candBlock(b, "cueIn", "Cue in (entrante)")}
    ${planBlock}
  `;
}

function statusLabel(track) {
  if (track.status === "pending") return "in attesa";
  if (track.status === "analyzing") return "analisi...";
  if (track.status === "error") return `errore: ${track.error}`;
  return "n/d";
}

function formatTrackAnalysis(analysis) {
  return [
    analysis.bpm ? `${analysis.bpm} BPM` : "BPM n/d",
    analysis.key ? (toCamelot(analysis.key) ?? `key ${analysis.key}`) : "key n/d",
    `energia ${Math.round(analysis.energy * 100)}%`,
    `cue ${formatSeconds(analysis.cueIn)}-${formatSeconds(analysis.cueOut)}`,
    `conf ${Math.round((analysis.bpmConfidence ?? 0) * 100)}%`
  ].join(" | ");
}

function formatSeconds(value) {
  if (!Number.isFinite(value)) return "0:00";
  const seconds = Math.max(0, Math.round(value));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// --- MIDI control (Web MIDI + learn) ---
const MIDI_ACTIONS = [
  { key: "start", label: "Start", kind: "trigger" },
  { key: "stop", label: "Stop", kind: "trigger" },
  { key: "skip", label: "Skip mix", kind: "trigger" },
  { key: "order", label: "Ordina set", kind: "trigger" },
  { key: "crossfade", label: "Crossfade (durata)", kind: "knob" },
  { key: "tolerance", label: "Tolleranza", kind: "knob" },
  { key: "xfader", label: "Crossfader manuale", kind: "knob" },
  { key: "eqLow", label: "EQ Bassi", kind: "knob" },
  { key: "eqMid", label: "EQ Medi", kind: "knob" },
  { key: "eqHigh", label: "EQ Alti", kind: "knob" },
  { key: "jog", label: "Jog (nudge)", kind: "relative" }
];

// Map a 0..127 EQ knob to dB: centre (64) = 0, full left = -26, full right = +6.
function eqKnobToDb(value) {
  return value <= 64 ? (value / 64 - 1) * 26 : ((value - 64) / 63) * 6;
}

let midiBindings = {};
try {
  midiBindings = JSON.parse(localStorage.getItem("midiBindings") || "{}");
} catch {
  midiBindings = {};
}
let midiLearn = null;

function saveMidiBindings() {
  localStorage.setItem("midiBindings", JSON.stringify(midiBindings));
}

function renderMidiMap() {
  elements.midiMap.innerHTML = MIDI_ACTIONS.map((action) => {
    const bound = midiBindings[action.key];
    const learning = midiLearn === action.key;
    const status = learning ? "premi un controllo…" : bound ?? "non assegnato";
    return `
      <div class="midi-row ${learning ? "learning" : ""}">
        <span class="midi-label">${action.label}</span>
        <span class="midi-bound">${escapeHtml(status)}</span>
        <button data-midi-learn="${action.key}">${learning ? "…" : "Learn"}</button>
        <button data-midi-clear="${action.key}" ${bound ? "" : "disabled"}>×</button>
      </div>
    `;
  }).join("");

  elements.midiMap.querySelectorAll("button[data-midi-learn]").forEach((button) => {
    button.addEventListener("click", () => {
      midiLearn = midiLearn === button.dataset.midiLearn ? null : button.dataset.midiLearn;
      renderMidiMap();
    });
  });
  elements.midiMap.querySelectorAll("button[data-midi-clear]").forEach((button) => {
    button.addEventListener("click", () => {
      delete midiBindings[button.dataset.midiClear];
      saveMidiBindings();
      renderMidiMap();
    });
  });
}

function handleMidiMessage(event) {
  const message = describeMessage(event.data);
  if (!message) return;

  if (midiLearn) {
    if (message.kind === "noteoff") return; // bind to the press, not the release
    midiBindings[midiLearn] = message.id;
    saveMidiBindings();
    log(`MIDI: "${midiLearn}" assegnato a ${message.label}`);
    midiLearn = null;
    renderMidiMap();
    return;
  }

  for (const [key, id] of Object.entries(midiBindings)) {
    if (id !== message.id) continue;
    dispatchMidiAction(key, message);
  }
}

function dispatchMidiAction(key, message) {
  if (message.kind === "note") {
    if (key === "start") elements.startBtn.click();
    if (key === "stop") elements.stopBtn.click();
    if (key === "skip") elements.skipBtn.click();
    if (key === "order") elements.autoOrderBtn.click();
  }
  if (message.kind === "cc") {
    const norm = message.value / 127;
    if (key === "crossfade") {
      elements.crossfadeInput.value = String(Math.round(4 + norm * (96 - 4)));
      elements.crossfadeInput.dispatchEvent(new Event("change"));
    }
    if (key === "tolerance") {
      elements.tempoTolInput.value = (0.02 + norm * (0.12 - 0.02)).toFixed(2);
      elements.tempoTolInput.dispatchEvent(new Event("input"));
    }
    if (key === "xfader") player.setManualCrossfade(norm);
    if (key === "eqLow") player.setManualEq("low", eqKnobToDb(message.value));
    if (key === "eqMid") player.setManualEq("mid", eqKnobToDb(message.value));
    if (key === "eqHigh") player.setManualEq("high", eqKnobToDb(message.value));
    if (key === "jog") {
      // Relative encoder: 1..63 = forward, 65..127 = backward (two's complement).
      const delta = message.value < 64 ? message.value : message.value - 128;
      player.nudge(delta * 0.002);
    }
  }
}

renderMidiMap();
initMidi({
  onMessage: handleMidiMessage,
  onStatus: (text) => {
    elements.midiStatus.textContent = text;
  }
});

render();
restoreLibrary();
