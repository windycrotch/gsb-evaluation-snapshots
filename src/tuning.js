// tuning.js — 调弦预设、音名换算、基频到弦号/品数的映射。

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const A4_HZ = 440;

// 弦序按指板从上到下（粗弦 → 细弦），物理弦号为 6 → 1（数组下标 0 = 6 弦）。
export const TUNINGS = {
  standard: {
    label: '标准调弦 E A D G B E',
    strings: [82.4069, 110.0, 146.8324, 195.9977, 246.9417, 329.6276], // E2 A2 D3 G3 B3 E4
    names: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'],
  },
  dropD: {
    label: 'Drop D (D2 A2 D3 G3 B3 E4)',
    strings: [73.4162, 110.0, 146.8324, 195.9977, 246.9417, 329.6276],
    names: ['D2', 'A2', 'D3', 'G3', 'B3', 'E4'],
  },
  openG: {
    label: 'Open G (D2 G2 D3 G3 B3 D4)',
    strings: [73.4162, 97.9989, 146.8324, 195.9977, 246.9417, 293.6648],
    names: ['D2', 'G2', 'D3', 'G3', 'B3', 'D4'],
  },
  halfStepDown: {
    label: '降半音 (Eb Ab Db Gb Bb Eb)',
    strings: [77.7817, 103.8262, 138.5913, 184.9972, 233.0819, 311.1270],
    names: ['Eb2', 'Ab2', 'Db3', 'Gb3', 'Bb3', 'Eb4'],
  },
};

export const MAX_FRET = 15;

export function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / A4_HZ);
}

export function midiToName(midi) {
  const rounded = Math.round(midi);
  return NOTE_NAMES[((rounded % 12) + 12) % 12] + (Math.floor(rounded / 12) - 1);
}

export function freqToNoteName(freq) {
  return midiToName(freqToMidi(freq));
}

// 把稳定基频映射到 (string, fret)。
// 同一音高可能出现在多根弦上时，优先粗弦（编号更小），保证结果确定。
// 返回 { string, fret, midi, noteName, centsOff, inRange }；
// 频率超出指板范围时 inRange=false，调用方不应硬报位置。
export function mapFrequencyToFret(freq, tuningStrings, maxFret = MAX_FRET) {
  const midi = freqToMidi(freq);
  const noteName = midiToName(midi);
  let best = null;

  for (let i = 0; i < tuningStrings.length; i++) {
    const openMidi = freqToMidi(tuningStrings[i]);
    const fret = Math.round(midi - openMidi);
    if (fret < 0 || fret > maxFret) continue;
    const fretFreq = tuningStrings[i] * Math.pow(2, fret / 12);
    const centsOff = 1200 * Math.log2(freq / fretFreq);
    // 偏差超过 60 音分说明离任何半音格子都太远
    if (Math.abs(centsOff) > 60) continue;
    // 决胜顺序：品位最低（空弦优先）→ 音分偏差最小 → 粗弦优先
    if (!best ||
        fret < best.fret ||
        (fret === best.fret && Math.abs(centsOff) < Math.abs(best.centsOff))) {
      best = { string: tuningStrings.length - i, fret, centsOff };
    }
  }

  if (!best) {
    return { string: null, fret: null, midi, noteName, centsOff: null, inRange: false };
  }
  // 归一化 -0 为 0，避免严格相等断言与 JSON 序列化出现怪异值
  return { ...best, fret: Math.abs(best.fret), midi, noteName, inRange: true };
}
