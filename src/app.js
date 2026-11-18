// app.js — UI 控制器：开始/停止、调弦切换、麦克风与合成源、状态展示、练习判定。

import { PitchEngine } from './engine.js';
import { MicCapture, SyntheticCapture } from './audio.js';
import { FretboardRenderer } from './fretboard.js';
import { TUNINGS, NOTE_NAMES, freqToMidi, mapFrequencyToFret } from './tuning.js';

const $ = (id) => document.getElementById(id);

export class FretsenseApp {
  constructor() {
    this.tuningKey = 'standard';
    const tuning = TUNINGS[this.tuningKey];
    this.engine = new PitchEngine(tuning.strings);
    this.capture = null;
    this.renderer = new FretboardRenderer($('fretboard'), tuning.strings.length, tuning.names);
    this.active = false;
    this.lastDetectedKey = null;
    this.targetMidi = null;
    this._wire();
    this._renderReadout(null);
  }

  _wire() {
    const tuningSelect = $('tuningSelect');
    for (const [key, t] of Object.entries(TUNINGS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = t.label;
      tuningSelect.appendChild(opt);
    }
    tuningSelect.addEventListener('change', () => {
      this.tuningKey = tuningSelect.value;
      const t = TUNINGS[this.tuningKey];
      this.engine.setTuning(t.strings);
      // 换调弦后旧的平滑历史不再适用，重置追踪器重新累积
      this.engine.tracker.reset();
      this.renderer.setTuning(t.strings.length, t.names);
      this.lastDetectedKey = null;
      if ($('modeSelect').value === 'target') this._applyTarget();
    });

    $('startStop').addEventListener('click', () => (this.active ? this.stop() : this.start()));

    $('modeSelect').addEventListener('change', (e) => {
      const on = e.target.value === 'target';
      $('targetPanel').hidden = !on;
      this.renderer.setTarget(null);
      this.targetMidi = null;
      if (on) this._applyTarget();
    });
    $('targetNote').addEventListener('change', () => this._applyTarget());
    $('targetOctave').addEventListener('change', () => this._applyTarget());

    // 合成演示参数（验收允许用本地谐波叠加信号代替真实吉他）
    $('demoFreq').addEventListener('change', (e) => {
      if (this.capture instanceof SyntheticCapture) this.capture.setFrequency(Number(e.target.value));
    });
    $('demoHarmonics').addEventListener('change', (e) => {
      $('harmonicsHint').textContent = e.target.selectedOptions[0].dataset.hint || '';
    });
  }

  _applyTarget() {
    const name = $('targetNote').value;
    const octave = Number($('targetOctave').value);
    const pitchClass = NOTE_NAMES.indexOf(name);
    this.targetMidi = (octave + 1) * 12 + pitchClass;
    // 在当前调弦上找到该音高的一个把位作为目标格
    const freq = 440 * Math.pow(2, (this.targetMidi - 69) / 12);
    const mapping = mapFrequencyToFret(freq, TUNINGS[this.tuningKey].strings);
    if (mapping.inRange) {
      this.renderer.setTarget({ string: mapping.string, fret: mapping.fret });
    } else {
      this.renderer.setTarget(null);
      this._showBanner(`目标音 ${name}${octave} 超出当前调弦的指板范围。`, 'warn');
    }
  }

  async start() {
    this._showBanner('', 'info');
    const source = $('sourceSelect').value;
    this.engine.start();

    try {
      if (source === 'mic') {
        this.capture = new MicCapture((samples, rate) => this._onFrame(samples, rate));
        await this.capture.start();
      } else {
        const profile = $('demoHarmonics').value;
        const harmonics = {
          pure: [1],
          strong2nd: [1, 1.5, 0.6, 0.3],   // 二次谐波强于基频
          guitarish: [1, 0.8, 0.5, 0.35, 0.2],
        }[profile];
        this.capture = new SyntheticCapture(
          (samples, rate) => this._onFrame(samples, rate),
          { frequency: Number($('demoFreq').value), harmonics },
        );
        await this.capture.start();
      }
    } catch (err) {
      this.engine.stop();
      this.capture = null;
      this._showBanner(err.message || String(err), 'error');
      this._setButton(false);
      return;
    }

    this.active = true;
    this._setButton(true);
    $('statusText').textContent = source === 'mic' ? '正在聆听麦克风…' : '正在分析本地合成信号…';
  }

  stop() {
    this.capture?.stop();
    this.capture = null;
    this.engine.stop();   // 此后 processFrame 不再产生新结果
    this.active = false;
    this._setButton(false);
    $('statusText').textContent = '已停止';
    this._renderReadout(null);
    this.renderer.clearMarkers();
    // 练习目标格保留在画布上，仅清掉检测点亮标记
  }

  // 麦克风与合成源共用的唯一帧入口
  _onFrame(samples, sampleRate) {
    const result = this.engine.processFrame(samples, sampleRate);
    this._renderReadout(result);

    if (!result.detected) {
      this.lastDetectedKey = null;
      return;
    }

    const key = `${result.string}-${result.fret}`;
    let state = 'detected';
    if ($('modeSelect').value === 'target' && this.targetMidi != null) {
      const detectedMidi = Math.round(freqToMidi(result.frequency));
      state = detectedMidi === this.targetMidi ? 'correct' : 'error';
    }
    this.renderer.show(result.string, result.fret, state);
    this.lastDetectedKey = key;
  }

  _renderReadout(r) {
    const reliable = r && r.detected;
    $('noteName').textContent = reliable ? r.noteName : '—';
    $('frequency').textContent = reliable ? `${r.frequency.toFixed(1)} Hz` : '— Hz';
    $('stringFret').textContent = reliable ? `${r.string} 弦 / ${r.fret} 品` : '— 弦 / — 品';
    $('confidence').textContent = r ? `${Math.round((r.confidence || 0) * 100)}%` : '0%';
    $('confidenceBar').style.width = `${Math.round((r?.confidence || 0) * 100)}%`;
    if (r && !r.detected && r.confidence > 0 && r.frequency && r.noteName) {
      $('statusText').textContent = `听到声音但无法可靠定位（${r.noteName}，置信度不足）`;
    }
  }

  _setButton(running) {
    const btn = $('startStop');
    btn.textContent = running ? '■ 停止' : '▶ 开始';
    btn.classList.toggle('running', running);
    $('sourceSelect').disabled = running;
    $('tuningSelect').disabled = false; // 调弦允许运行中切换
  }

  _showBanner(message, kind) {
    const el = $('banner');
    el.textContent = message;
    el.className = kind === 'error' ? 'banner error' : kind === 'warn' ? 'banner warn' : 'banner hidden';
  }
}
