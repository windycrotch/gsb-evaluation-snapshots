const RMS_FRAME_SECONDS = 0.05;

export async function analyzeTrack(file) {
  const backendAnalysis = await tryBackendAnalysis(file);
  if (backendAnalysis) {
    if (!backendAnalysis.waveform?.peaks?.length) {
      backendAnalysis.waveform = await analyzeWaveform(file).catch(() => null);
    }
    return backendAnalysis;
  }

  const arrayBuffer = await file.arrayBuffer();
  const context = new AudioContext();
  const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
  await context.close();

  const mono = downmix(audioBuffer);
  const duration = audioBuffer.duration;
  const rmsFrames = buildRmsFrames(mono, audioBuffer.sampleRate, RMS_FRAME_SECONDS);
  const cue = detectCuePoints(rmsFrames, duration);
  const energy = estimateEnergy(rmsFrames);
  const bpm = estimateBpm(rmsFrames, RMS_FRAME_SECONDS);
  const waveform = buildWaveform(mono);
  const sections = buildSections(rmsFrames, duration, cue);
  const mixableIntro = Math.max(0, Math.min(cue.vocalRiskStart, duration) - cue.cueIn);
  const mixableOutro = Math.max(0, cue.cueOut - cue.outroStart);

  return {
    duration,
    cueIn: cue.cueIn,
    cueOut: cue.cueOut,
    outroStart: cue.outroStart,
    vocalRiskStart: cue.vocalRiskStart,
    bpm: bpm.value,
    bpmConfidence: bpm.confidence,
    energy,
    mixableIntro,
    mixableOutro,
    key: null,
    keyConfidence: 0,
    camelot: null,
    // No beat-grid phase, phrasing, loudness or band split without the backend.
    firstBeat: null,
    beatInterval: bpm.value ? Math.round((60 / bpm.value) * 10000) / 10000 : null,
    downbeat: null,
    barInterval: null,
    phraseAnchor: null,
    phraseInterval: null,
    beatsPerPhrase: 16,
    loudnessLufs: null,
    gain: 1,
    bandEnergy: null,
    vocals: { available: false },
    waveform,
    sections,
    analyzer: "web-audio-dsp-v1"
  };
}

async function analyzeWaveform(file) {
  const arrayBuffer = await file.arrayBuffer();
  const context = new AudioContext();
  const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
  await context.close();
  return buildWaveform(downmix(audioBuffer));
}

async function tryBackendAnalysis(file) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 45000);
  const body = new FormData();
  body.append("file", file, file.name);

  try {
    const response = await fetch("http://127.0.0.1:8765/analyze", {
      method: "POST",
      body,
      signal: controller.signal
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

function downmix(audioBuffer) {
  const length = audioBuffer.length;
  const channels = audioBuffer.numberOfChannels;
  const mono = new Float32Array(length);

  for (let channel = 0; channel < channels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      mono[index] += data[index] / channels;
    }
  }

  return mono;
}

function buildWaveform(samples, bins = 1024) {
  const peaks = [];
  const samplesPerBin = Math.max(1, Math.floor(samples.length / bins));
  let maxPeak = 0;

  for (let bin = 0; bin < bins; bin += 1) {
    const start = bin * samplesPerBin;
    const end = bin === bins - 1 ? samples.length : Math.min(samples.length, start + samplesPerBin);
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      peak = Math.max(peak, Math.abs(samples[index] ?? 0));
    }
    peaks.push(peak);
    maxPeak = Math.max(maxPeak, peak);
  }

  const normalizer = maxPeak > 0 ? maxPeak : 1;
  return {
    bins,
    peaks: peaks.map((peak) => Math.round((peak / normalizer) * 1000) / 1000)
  };
}

function buildSections(rmsFrames, duration, cue) {
  if (!duration || !rmsFrames.length) return [];

  const sections = [];
  const introEnd = clamp(Math.max(cue.cueIn, Math.min(cue.vocalRiskStart, duration * 0.22)), 0, duration);
  const outroStart = clamp(cue.outroStart || duration * 0.82, introEnd, duration);

  if (introEnd > 2) sections.push(section(0, introEnd, "intro", 0.55));

  const window = Math.max(6, Math.min(16, duration / 12));
  const windows = [];
  for (let start = introEnd; start < outroStart - 1; start += window) {
    const end = Math.min(outroStart, start + window);
    windows.push({
      start,
      end,
      energy: average(
        rmsFrames,
        Math.floor(start / RMS_FRAME_SECONDS),
        Math.ceil(end / RMS_FRAME_SECONDS)
      )
    });
  }

  const energies = windows.map((item) => item.energy);
  const minEnergy = Math.min(...energies, 0);
  const maxEnergy = Math.max(...energies, 1e-6);
  let previousType = null;

  for (let index = 0; index < windows.length; index += 1) {
    const item = windows[index];
    const energy = (item.energy - minEnergy) / Math.max(1e-6, maxEnergy - minEnergy);
    const prev = index > 0 ? (windows[index - 1].energy - minEnergy) / Math.max(1e-6, maxEnergy - minEnergy) : energy;
    const next = index + 1 < windows.length ? (windows[index + 1].energy - minEnergy) / Math.max(1e-6, maxEnergy - minEnergy) : energy;
    const slope = next - prev;
    const type = energy < 0.35 ? "break" : slope > 0.2 ? "build" : energy > 0.72 ? "drop" : "body";

    if (previousType === type && sections.at(-1)?.type === type) {
      sections.at(-1).end = roundTime(item.end);
    } else {
      sections.push(section(item.start, item.end, type, 0.45));
    }
    previousType = type;
  }

  if (outroStart < duration - 1) sections.push(section(outroStart, duration, "outro", 0.6));
  return sections;
}

function section(start, end, type, confidence) {
  return {
    start: roundTime(start),
    end: roundTime(end),
    type,
    confidence
  };
}

function roundTime(value) {
  return Math.round(value * 100) / 100;
}

function buildRmsFrames(samples, sampleRate, frameSeconds) {
  const frameSize = Math.max(256, Math.floor(sampleRate * frameSeconds));
  const frameCount = Math.ceil(samples.length / frameSize);
  const frames = new Float32Array(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * frameSize;
    const end = Math.min(samples.length, start + frameSize);
    let sum = 0;

    for (let index = start; index < end; index += 1) {
      sum += samples[index] * samples[index];
    }

    frames[frame] = Math.sqrt(sum / Math.max(1, end - start));
  }

  return frames;
}

function detectCuePoints(rmsFrames, duration) {
  const sorted = Array.from(rmsFrames).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const median = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const threshold = Math.max(0.006, floor * 3.2, median * 0.18);
  const holdFrames = Math.ceil(0.35 / RMS_FRAME_SECONDS);

  const cueInFrame = findSustainedForward(rmsFrames, threshold, holdFrames);
  const cueOutFrame = findSustainedBackward(rmsFrames, threshold, holdFrames);
  const cueIn = Math.min(duration, cueInFrame * RMS_FRAME_SECONDS);
  const cueOut = Math.max(cueIn, Math.min(duration, cueOutFrame * RMS_FRAME_SECONDS));

  const outroSearchStart = Math.floor(rmsFrames.length * 0.55);
  const outroThreshold = Math.max(threshold * 1.4, median * 0.34);
  const outroFrame = findLastEnergyDropStart(rmsFrames, outroSearchStart, outroThreshold);
  const vocalRiskFrame = findFirstDenseRegion(rmsFrames, cueInFrame, Math.ceil(24 / RMS_FRAME_SECONDS));

  return {
    cueIn,
    cueOut,
    outroStart: Math.min(cueOut, Math.max(cueIn, outroFrame * RMS_FRAME_SECONDS)),
    vocalRiskStart: Math.min(duration, Math.max(cueIn + 8, vocalRiskFrame * RMS_FRAME_SECONDS))
  };
}

function findSustainedForward(frames, threshold, holdFrames) {
  for (let index = 0; index < frames.length - holdFrames; index += 1) {
    let hits = 0;
    for (let offset = 0; offset < holdFrames; offset += 1) {
      if (frames[index + offset] >= threshold) hits += 1;
    }
    if (hits >= holdFrames * 0.75) return index;
  }
  return 0;
}

function findSustainedBackward(frames, threshold, holdFrames) {
  for (let index = frames.length - holdFrames - 1; index >= 0; index -= 1) {
    let hits = 0;
    for (let offset = 0; offset < holdFrames; offset += 1) {
      if (frames[index + offset] >= threshold) hits += 1;
    }
    if (hits >= holdFrames * 0.75) return Math.min(frames.length - 1, index + holdFrames);
  }
  return frames.length - 1;
}

function findLastEnergyDropStart(frames, start, threshold) {
  const window = Math.ceil(10 / RMS_FRAME_SECONDS);
  for (let index = start; index < frames.length - window; index += 1) {
    const before = average(frames, Math.max(0, index - window), index);
    const after = average(frames, index, Math.min(frames.length, index + window));
    if (before > threshold && after < before * 0.68) return index;
  }
  return Math.floor(frames.length * 0.82);
}

function findFirstDenseRegion(frames, cueInFrame, searchFrames) {
  const end = Math.min(frames.length, cueInFrame + searchFrames);
  const window = Math.ceil(3 / RMS_FRAME_SECONDS);
  let bestFrame = cueInFrame + Math.ceil(16 / RMS_FRAME_SECONDS);
  let bestScore = 0;

  for (let index = cueInFrame; index < end - window; index += 1) {
    const local = variance(frames, index, index + window) * average(frames, index, index + window);
    if (local > bestScore) {
      bestScore = local;
      bestFrame = index;
    }
  }

  return bestFrame;
}

function estimateEnergy(rmsFrames) {
  // Map loudness (dBFS) onto 0..1; the old log formula saturated to 1.0 for
  // every mastered track. -28 dBFS -> 0, -6 dBFS -> 1.
  const mean = average(rmsFrames, 0, rmsFrames.length);
  const sorted = Array.from(rmsFrames).sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? mean;
  const level = 0.5 * mean + 0.5 * p90;
  if (level <= 0) return 0;
  const db = 20 * Math.log10(level);
  return clamp((db + 28) / 22, 0, 1);
}

function estimateBpm(rmsFrames, frameSeconds) {
  if (rmsFrames.length < 80) return { value: null, confidence: 0 };

  const onset = new Float32Array(rmsFrames.length - 1);
  for (let index = 1; index < rmsFrames.length; index += 1) {
    onset[index - 1] = Math.max(0, rmsFrames[index] - rmsFrames[index - 1]);
  }

  normalizeInPlace(onset);

  let bestLag = 0;
  let bestScore = 0;
  let totalScore = 0;
  const minBpm = 80;
  const maxBpm = 180;
  const minLag = Math.floor((60 / maxBpm) / frameSeconds);
  const maxLag = Math.ceil((60 / minBpm) / frameSeconds);

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let score = 0;
    for (let index = 0; index < onset.length - lag; index += 1) {
      score += onset[index] * onset[index + lag];
    }
    totalScore += score;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (!bestLag || bestScore <= 0) return { value: null, confidence: 0 };

  const rawBpm = 60 / (bestLag * frameSeconds);
  const bpm = normalizeDanceBpm(rawBpm);
  const confidence = clamp(bestScore / Math.max(0.0001, totalScore / (maxLag - minLag + 1)) / 8, 0, 1);

  return {
    value: Math.round(bpm * 10) / 10,
    confidence: Math.round(confidence * 100) / 100
  };
}

function normalizeDanceBpm(bpm) {
  let value = bpm;
  while (value < 85) value *= 2;
  while (value > 180) value /= 2;
  return value;
}

function normalizeInPlace(values) {
  let max = 0;
  for (const value of values) max = Math.max(max, value);
  if (max <= 0) return;
  for (let index = 0; index < values.length; index += 1) {
    values[index] /= max;
  }
}

function average(values, start, end) {
  let sum = 0;
  const safeEnd = Math.max(start, end);
  for (let index = start; index < safeEnd; index += 1) {
    sum += values[index] ?? 0;
  }
  return sum / Math.max(1, safeEnd - start);
}

function variance(values, start, end) {
  const mean = average(values, start, end);
  let sum = 0;
  const safeEnd = Math.max(start, end);
  for (let index = start; index < safeEnd; index += 1) {
    const diff = (values[index] ?? 0) - mean;
    sum += diff * diff;
  }
  return sum / Math.max(1, safeEnd - start);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
