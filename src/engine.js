// engine.js — 检测引擎：麦克风路径与合成音频测试路径共用的唯一入口。
// 输入 PCM 帧，输出可直接渲染的检测结果对象。

import { analyzeFrame, STABLE_CONF } from './dsp.js';
import { PitchTracker } from './tracker.js';
import { mapFrequencyToFret, freqToNoteName } from './tuning.js';

export class PitchEngine {
  constructor(tuningStrings) {
    this.tuningStrings = tuningStrings;
    this.tracker = new PitchTracker();
    this.running = false;
    this.lastResult = null;
  }

  setTuning(tuningStrings) {
    this.tuningStrings = tuningStrings;
  }

  start() {
    this.tracker.reset();
    this.running = true;
    this.lastResult = null;
  }

  stop() {
    // 停止后拒绝任何新帧，界面不会再被更新
    this.running = false;
    this.tracker.reset();
  }

  // samples: Float32Array/Float64Array，长度应为 2 的幂
  // sampleRate: 采样率（Hz）
  // 不可靠时返回 { detected:false, confidence:0, ... }，绝不硬报音高
  processFrame(samples, sampleRate) {
    if (!this.running) return this.lastResult;

    const frame = analyzeFrame(samples, sampleRate);
    const state = this.tracker.pushFrame(frame);

    if (!state.stable || state.confidence < STABLE_CONF) {
      this.lastResult = {
        detected: false,
        confidence: state.stable ? state.confidence : 0,
        frequency: null,
        noteName: null,
        string: null,
        fret: null,
        inRange: false,
      };
      return this.lastResult;
    }

    const mapping = mapFrequencyToFret(state.frequency, this.tuningStrings);
    this.lastResult = {
      detected: mapping.inRange,
      confidence: Math.max(0, Math.min(1, state.confidence)),
      frequency: state.frequency,
      noteName: mapping.inRange ? mapping.noteName : freqToNoteName(state.frequency),
      string: mapping.string,
      fret: mapping.fret,
      centsOff: mapping.centsOff,
      inRange: mapping.inRange,
    };
    return this.lastResult;
  }
}
