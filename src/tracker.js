// tracker.js — 帧级结果的时间平滑，抑制八度跳变与画面闪烁。
// 不依赖时钟：帧序由 pushFrame 的调用顺序决定，测试里完全确定性。

import { STABLE_FRAMES, MAX_STABLE_CENTS } from './dsp.js';
import { freqToMidi } from './tuning.js';

export class PitchTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.candidate = null;  // 正在累积确认的音高
    this.locked = null;     // 已锁定、对外报告的音高
    this.history = [];      // 最近帧的原始结果（含 null）
  }

  // frame 为 analyzeFrame 的返回值（null 表示该帧不可靠）。
  // 返回当前应显示的状态：
  //   { stable: true, frequency, confidence }  稳定可报告
  //   { stable: false }                        暂不可靠，不要硬报
  pushFrame(frame) {
    this.history.push(frame);
    if (this.history.length > 12) this.history.shift();

    if (!frame) {
      // 连续 2 帧丢失才释放锁定，避免单帧丢包导致闪烁
      const recent = this.history.slice(-2);
      if (recent.every((f) => f === null)) {
        this.candidate = null;
        this.locked = null;
      }
      return this.locked
        ? { stable: true, frequency: this.locked.frequency, confidence: this.locked.confidence }
        : { stable: false };
    }

    // --- 候选累积：新帧必须与当前候选（或锁定值）在音分上接近 ---
    const anchor = this.locked ?? this.candidate;
    if (anchor) {
      const cents = 1200 * (freqToMidi(frame.frequency) - freqToMidi(anchor.frequency));
      if (Math.abs(cents) > MAX_STABLE_CENTS) {
        // 偏离过大（典型是八度跳变）：降权处理，不立刻切换
        if (this.locked && Math.abs(cents) > 1200 - MAX_STABLE_CENTS &&
            Math.abs(cents) < 1200 + MAX_STABLE_CENTS) {
          // 明确的八度候选：直接忽略这一帧，维持锁定
          return { stable: true, frequency: this.locked.frequency, confidence: this.locked.confidence };
        }
        // 非八度的新音高：重新开始累积
        this.candidate = { frequency: frame.frequency, count: 1, confidence: frame.confidence };
      } else {
        const count = (this.candidate?.count ?? (this.locked ? STABLE_FRAMES : 0)) + 1;
        this.candidate = {
          frequency: frame.frequency,
          count,
          confidence: frame.confidence,
        };
      }
    } else {
      this.candidate = { frequency: frame.frequency, count: 1, confidence: frame.confidence };
    }

    // --- 锁定判定：连续足够多帧收敛到同一音高 ---
    if (!this.locked && this.candidate && this.candidate.count >= STABLE_FRAMES) {
      this.locked = {
        frequency: this._medianFrequency(),
        confidence: this.candidate.confidence,
      };
    }

    // --- 锁定后用中值做平滑跟随（允许揉弦等小幅变化）---
    if (this.locked) {
      const smoothed = this._medianFrequency();
      const valid = this.history.filter(Boolean);
      const avgConf = valid.reduce((s, f) => s + f.confidence, 0) / valid.length;
      this.locked = { frequency: smoothed, confidence: avgConf };
      return { stable: true, frequency: smoothed, confidence: avgConf };
    }
    return { stable: false };
  }

  // 最近有效帧频率的中值，对单帧异常值天然鲁棒。
  _medianFrequency() {
    const freqs = this.history.filter(Boolean).map((f) => f.frequency).sort((a, b) => a - b);
    if (freqs.length === 0) return this.candidate?.frequency ?? 0;
    const mid = freqs.length >> 1;
    return freqs.length % 2 ? freqs[mid] : (freqs[mid - 1] + freqs[mid]) / 2;
  }
}
