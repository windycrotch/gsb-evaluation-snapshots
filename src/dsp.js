// dsp.js — 纯 DSP 原语与单帧基频分析。
// 不依赖任何 DOM / Web Audio API，因此浏览器与 Node 测试共用完全相同的代码路径。

export const FFT_SIZE = 8192;        // 44.1kHz 下约 5.4Hz 分辨率，可覆盖低至 E2(82.4Hz)
export const HOP_SIZE = 2048;        // 约 46ms 一帧，延迟与稳定性的折中
export const MIN_F0_HZ = 65;         // 略低于 C2，覆盖 Drop C 等低调弦
export const MAX_F0_HZ = 1400;       // 高于最高把位的实际音高（~F6）
export const HARMONICS = 8;          // 参与打分的谐波数
export const MIN_RMS = 0.006;        // 静音门限（归一化满幅为 1）
export const MIN_SNR = 1.8;          // 谐波带内/带外能量比（dB），低于则视为噪声
export const MIN_FRAME_CONF = 0.22;  // 单帧置信度门限
export const STABLE_FRAMES = 3;      // 连续多少帧接近同一音高才“锁定”
export const MAX_STABLE_CENTS = 45;  // 锁定允许的音分偏差
export const STABLE_CONF = 0.55;     // 对外报告所需的最终置信度

// ---------------------------------------------------------------------------
// 基 2 迭代 FFT（原地 Cooley–Tukey），输入长度必须是 2 的幂。
// 返回 { re, im } 两个新数组，调用方的输入不会被修改。
// ---------------------------------------------------------------------------
export function fft(input) {
  const n = input.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT length must be a power of two');
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(input);

  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const t = re[i]; re[i] = re[j]; re[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < half; k++) {
        const aR = re[i + k];
        const aI = im[i + k];
        const bR = re[i + k + half] * curR - im[i + k + half] * curI;
        const bI = re[i + k + half] * curI + im[i + k + half] * curR;
        re[i + k] = aR + bR;
        im[i + k] = aI + bI;
        re[i + k + half] = aR - bR;
        im[i + k + half] = aI - bI;
        const nextR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nextR;
      }
    }
  }
  return { re, im };
}

// Hann 窗（周期形式），按长度缓存，避免每帧重复计算。
const hannCache = new Map();
export function hannWindow(length) {
  let w = hannCache.get(length);
  if (!w) {
    w = new Float64Array(length);
    for (let i = 0; i < length; i++) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / length));
    }
    hannCache.set(length, w);
  }
  return w;
}

export function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

// 抛物线插值：利用峰值 bin 与左右邻居，把峰值位置修正到亚 bin 精度。
// 在对数幅度域做二次插值，对 Hann 窗谱峰的偏差修正比线性域更准。
// 返回小数 bin 偏移与（线性域）峰值幅度估计。
function parabolicPeak(mags, bin) {
  const left = mags[bin - 1] ?? 0;
  const center = mags[bin];
  const right = mags[bin + 1] ?? 0;
  const ll = Math.log(left + 1e-12);
  const lc = Math.log(center + 1e-12);
  const lr = Math.log(right + 1e-12);
  const denom = ll - 2 * lc + lr;
  const shift = denom === 0 ? 0 : 0.5 * (ll - lr) / denom;
  return { shift: Math.max(-1, Math.min(1, shift)), magnitude: center };
}

// 谐波证据打分：候选 f 与其各次谐波在幅度谱上的能量解释能力。
// 幅度谱由 mags（线性幅度）与 binHz（每 bin 赫兹数）描述。
// noiseFloor：全谱中位幅度，用来区分真实谐波与 Hann 旁瓣/噪底。
// globalMaxMag：全谱最强峰幅度，作为候选基频绝对强度的参照。
export function harmonicScore(f, mags, binHz, nyquist, noiseFloor, globalMaxMag) {
  let weighted = 0;       // Σ 权重 × 归一化谐波能量
  let weightSum = 0;
  const partials = [];

  for (let h = 1; h <= HARMONICS; h++) {
    const hz = f * h;
    if (hz >= nyquist * 0.98) break;
    const target = hz / binHz;
    const bin = Math.round(target);
    if (bin <= 1 || bin >= mags.length - 1) break;

    // 允许 ±1.5 bin 的失谐（吉他高次谐波普遍略偏）
    const lo = Math.max(1, bin - 1);
    const hi = Math.min(mags.length - 2, bin + 1);
    let peakMag = 0;
    let peakBin = bin;
    for (let b = lo; b <= hi; b++) {
      if (mags[b] > peakMag) {
        peakMag = mags[b];
        peakBin = b;
      }
    }
    const weight = 1 / h; // 基频权重最高，逐次递减
    weightSum += weight;
    partials.push({ h, hz: peakBin * binHz, mag: peakMag, weight, bin: peakBin });
  }
  if (weightSum === 0) return { score: 0, partials: [], presence: 0 };

  const base = Math.max(partials[0]?.mag ?? 0, 1e-9);
  // 谐波“真实存在”需要同时越过两道门限：
  //  - 绝对门限：显著高于全谱噪底（6× 中位幅度），挡住环境噪声；
  //  - 相对门限：达到本候选最强谐波的 6%，挡住 Hann 窗旁瓣（主瓣外约 1–2.5%）
  //    在无噪合成信号里冒充谐波。
  let maxPartial = 1e-9;
  for (const p of partials) maxPartial = Math.max(maxPartial, p.mag);
  const presenceGate = Math.max(noiseFloor * 6, maxPartial * 0.06, 1e-7);
  // 全局参照：候选基频相对于全谱最强峰的强度。
  // 误把高次谐波当基频的候选，其“基频”只是别人的一个泛音，
  // 绝对能量解释能力天然弱于真基频，必须在这里被压下去。
  const globalPeak = Math.max(globalMaxMag, 1e-9);
  const fundamentalStrength = Math.min(base / globalPeak, 1);
  let presentWeight = 0;
  let present = 0;
  for (const p of partials) {
    if (p.mag < presenceGate) continue;
    const norm = Math.min(p.mag / base, 1.5);
    weighted += p.weight * norm;
    presentWeight += p.weight;
    present++;
  }
  if (presentWeight === 0) return { score: 0, partials, presence: 0 };

  const presence = present / partials.length;
  const evidence = weighted / presentWeight;
  // 三个因子相乘：
  //  evidence   —— 兑现谐波彼此间的结构一致性（纯正弦 = 1.0）
  //  presence   —— 谐波席位兑现率（只有 1/8 的高次误判候选 ≤ 0.61）
  //  strength   —— 基频的全谱绝对强度（真基频 ≈ 1，寄生候选显著 < 1）
  let score = evidence * (0.55 + 0.45 * presence) * (0.6 + 0.4 * fundamentalStrength);

  // 八度上跳惩罚：若 f/2（低八度候选）位置存在“真实谱峰”，
  // 说明本候选很可能只是真实基频的二次谐波。
  // 必须要求局部峰，否则 Hann 窗在 2f0 处的旁瓣泄漏会误伤真实基频候选。
  const subBin = Math.round(f / 2 / binHz);
  if (subBin >= 2) {
    const subLo = Math.max(1, subBin - 1);
    const subHi = Math.min(mags.length - 2, subBin + 1);
    let subMag = 0;
    let subPeakBin = subBin;
    for (let b = subLo; b <= subHi; b++) {
      if (mags[b] > subMag) { subMag = mags[b]; subPeakBin = b; }
    }
    const isLocalPeak = mags[subPeakBin] > mags[subPeakBin - 1] &&
                        mags[subPeakBin] >= mags[subPeakBin + 1];
    if (isLocalPeak && subMag > presenceGate && subMag > 0.4 * base) {
      const ratio = Math.min(subMag / base, 1.5);
      score *= 1 - Math.min(0.6, 0.4 + 0.2 * ratio);
    }
  }
  return { score, partials, presence };
}

// 单帧分析：加窗 → FFT → 幅度谱 → 候选基频谐波打分 → 置信度。
// samples 长度需为 2 的幂（通常就是 FFT_SIZE）。
// 返回 null 表示静音/不可靠；否则返回 { frequency, confidence, rms, snr }。
export function analyzeFrame(samples, sampleRate) {
  const n = samples.length;
  const level = rms(samples);
  if (level < MIN_RMS) return null;

  const win = hannWindow(n);
  const windowed = new Float64Array(n);
  let windowEnergy = 0;
  for (let i = 0; i < n; i++) {
    windowed[i] = samples[i] * win[i];
    windowEnergy += win[i] * win[i];
  }

  const { re, im } = fft(windowed);
  const bins = n >> 1;
  const binHz = sampleRate / n;
  const nyquist = sampleRate / 2;
  const mags = new Float64Array(bins);
  // 补偿 Hann 窗造成的幅度衰减（相干增益 0.5）
  const gainNorm = 2 / Math.sqrt(windowEnergy / n) / Math.SQRT2;
  for (let b = 0; b < bins; b++) {
    mags[b] = Math.hypot(re[b], im[b]) * gainNorm / n;
  }

  // 谱噪底：搜索范围内幅度的中位数，作为“真实谐波 vs 旁瓣/噪声”的绝对参照
  const floorMinBin = Math.max(2, Math.floor(MIN_F0_HZ / binHz));
  const floorMaxBin = Math.min(bins - 2, Math.ceil((MAX_F0_HZ * HARMONICS) / binHz));
  const sortedSlice = Array.from(mags.subarray(floorMinBin, floorMaxBin + 1)).sort((a, b) => a - b);
  const noiseFloor = sortedSlice[sortedSlice.length >> 1] || 1e-9;
  // 全谱最强峰：谐波打分时衡量候选基频绝对强度的参照
  let globalMaxMag = 0;
  for (let b = 1; b < bins; b++) globalMaxMag = Math.max(globalMaxMag, mags[b]);

  // 全局峰：用于生成候选谱峰与兜底候选（谐波噪底在上面单独统计）
  let peakBin = -1;
  let peakMag = 0;
  const minBin = Math.max(2, Math.floor(MIN_F0_HZ / binHz));
  const maxBin = Math.min(bins - 2, Math.ceil((MAX_F0_HZ * 2) / binHz));
  for (let b = minBin; b <= maxBin; b++) {
    if (mags[b] > peakMag) {
      peakMag = mags[b];
      peakBin = b;
    }
  }
  if (peakBin < 0 || peakMag <= 0) return null;

  // 候选集：搜索范围内每个局部谱峰都是一个候选基频
  const candidates = [];
  const seen = new Set();
  for (let b = minBin; b <= maxBin; b++) {
    if (mags[b] > mags[b - 1] && mags[b] >= mags[b + 1] && mags[b] > peakMag * 0.12) {
      const { shift } = parabolicPeak(mags, b);
      const f = (b + shift) * binHz;
      const key = Math.round(f / 3); // 3Hz 量化去重
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ f, bin: b });
    }
  }
  // 兜底：没有明显局部峰时直接用全局峰
  if (candidates.length === 0) {
    const { shift } = parabolicPeak(mags, peakBin);
    candidates.push({ f: (peakBin + shift) * binHz, bin: peakBin });
  }

  let best = null;
  for (const c of candidates) {
    if (c.f < MIN_F0_HZ || c.f > MAX_F0_HZ) continue;
    const { score, partials, presence } = harmonicScore(c.f, mags, binHz, nyquist, noiseFloor, globalMaxMag);
    if (!best || score > best.score) best = { ...c, score, partials, presence };
  }
  if (!best) return null;

  // 谐波带信噪比：胜出候选各次谐波邻域的能量 vs 全谱其余能量。
  // 用整个谐波序列而不是单个峰，多谐波的低频乐音才不会被误判成噪声。
  let inBand = 0;
  const bandBins = new Set();
  for (const p of best.partials) {
    const b = p.bin;
    for (let k = b - 1; k <= b + 1; k++) {
      if (k >= 1 && k < bins && !bandBins.has(k)) {
        bandBins.add(k);
        inBand += mags[k] * mags[k];
      }
    }
  }
  let totalEnergy = 0;
  for (let b = 1; b < bins; b++) totalEnergy += mags[b] * mags[b];
  const snr = 10 * Math.log10((inBand + 1e-12) / (totalEnergy - inBand + 1e-12));
  if (snr < MIN_SNR) return null;

  // 在胜出候选自己的谱峰 bin 上做抛物线插值精修（candidates 已带亚 bin 频率）
  const { shift } = parabolicPeak(mags, best.bin);
  const frequency = (best.bin + shift) * binHz;

  // 置信度：谐波结构质量 × 谐波带纯度 × 响度余量，截断到 [0,1]
  const tonal = Math.min(1, Math.max(0, (snr + 2) / 12));
  const levelFactor = Math.min(1, level / 0.05);
  let confidence = best.score * tonal * levelFactor;
  confidence = Math.max(0, Math.min(1, confidence));
  if (confidence < MIN_FRAME_CONF) return null;

  return { frequency, confidence, rms: level, snr };
}
