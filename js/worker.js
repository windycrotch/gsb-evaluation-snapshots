// ══════════════════════════════════════════════════════════════════════════════
// Audio Analyzer — DSP Worker
// All signal processing runs off the main thread
// ══════════════════════════════════════════════════════════════════════════════

// ── FFT (Cooley-Tukey radix-2 in-place) ──────────────────────────────────
function fft(re, im) {
    var n = re.length, j = 0;
    for (var i = 1; i < n; i++) {
        var bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            var t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    for (var len = 2; len <= n; len <<= 1) {
        var ang = -2 * Math.PI / len;
        var wRe = Math.cos(ang), wIm = Math.sin(ang);
        for (var i = 0; i < n; i += len) {
            var cRe = 1, cIm = 0;
            for (var k = 0; k < (len >> 1); k++) {
                var a = i + k, b = a + (len >> 1);
                var tRe = re[b] * cRe - im[b] * cIm;
                var tIm = re[b] * cIm + im[b] * cRe;
                re[b] = re[a] - tRe; im[b] = im[a] - tIm;
                re[a] += tRe; im[a] += tIm;
                var nRe = cRe * wRe - cIm * wIm;
                cIm = cRe * wIm + cIm * wRe; cRe = nRe;
            }
        }
    }
}

// ── Biquad filter ────────────────────────────────────────────────────────
function biquad(input, b0, b1, b2, a1, a2) {
    var out = new Float32Array(input.length);
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < input.length; i++) {
        var x0 = input[i];
        var y0 = b0*x0 + b1*x1 + b2*x2 - a1*y1 - a2*y2;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0;
        out[i] = y0;
    }
    return out;
}

// ── K-weighting filter (EBU R128 / ITU-R BS.1770) ────────────────────────
function kWeight(samples, fs) {
    // Stage 1: High-shelf pre-filter
    var f1 = 1681.974450955533, G = 3.999843853973347, Q1 = 0.7071752369554196;
    var A = Math.pow(10, G / 40);
    var w1 = 2 * Math.PI * f1 / fs, c1 = Math.cos(w1), s1 = Math.sin(w1);
    var alpha1 = s1 / (2 * Q1);
    var sqA = Math.sqrt(A);
    var a0 = (A+1) - (A-1)*c1 + 2*sqA*alpha1;
    var s1_b0 = A * ((A+1) + (A-1)*c1 + 2*sqA*alpha1) / a0;
    var s1_b1 = -2 * A * ((A-1) + (A+1)*c1) / a0;
    var s1_b2 = A * ((A+1) + (A-1)*c1 - 2*sqA*alpha1) / a0;
    var s1_a1 = 2 * ((A-1) - (A+1)*c1) / a0;
    var s1_a2 = ((A+1) - (A-1)*c1 - 2*sqA*alpha1) / a0;

    // Stage 2: High-pass (RLB weighting)
    var f2 = 38.13547087602444, Q2 = 0.5003270373238773;
    var w2 = 2 * Math.PI * f2 / fs, c2 = Math.cos(w2), s2 = Math.sin(w2);
    var alpha2 = s2 / (2 * Q2);
    var a0b = 1 + alpha2;
    var s2_b0 = (1 + c2) / 2 / a0b;
    var s2_b1 = -(1 + c2) / a0b;
    var s2_b2 = (1 + c2) / 2 / a0b;
    var s2_a1 = -2 * c2 / a0b;
    var s2_a2 = (1 - alpha2) / a0b;

    var filtered = biquad(samples, s1_b0, s1_b1, s1_b2, s1_a1, s1_a2);
    return biquad(filtered, s2_b0, s2_b1, s2_b2, s2_a1, s2_a2);
}

// ── LUFS (EBU R128 integrated + short-term + LRA) ────────────────────────
function computeLUFS(channels, fs) {
    var kw = [];
    for (var c = 0; c < channels.length; c++) kw.push(kWeight(channels[c], fs));

    var n = kw[0].length;
    var blockSize = Math.round(0.4 * fs);   // 400ms momentary
    var hopSize = Math.round(0.1 * fs);     // 75% overlap
    var nBlocks = Math.floor((n - blockSize) / hopSize) + 1;
    if (nBlocks < 1) return { integrated: -70, stMax: -70, momentaryMax: -70, lra: 0 };

    // Compute block loudness (400ms)
    var blockLoud = new Float32Array(nBlocks);
    for (var b = 0; b < nBlocks; b++) {
        var s = b * hopSize, ms = 0;
        for (var c = 0; c < kw.length; c++) {
            var sum = 0;
            for (var i = s; i < s + blockSize && i < n; i++) sum += kw[c][i] * kw[c][i];
            ms += sum / blockSize;
        }
        blockLoud[b] = ms;
    }

    // Momentary max
    var momMax = -70;
    for (var b = 0; b < nBlocks; b++) {
        if (blockLoud[b] > 0) {
            var l = -0.691 + 10 * Math.log10(blockLoud[b]);
            if (l > momMax) momMax = l;
        }
    }

    // Absolute gate (-70 LKFS)
    var absGate = Math.pow(10, (-70 + 0.691) / 10);
    var above = [];
    for (var b = 0; b < nBlocks; b++) if (blockLoud[b] >= absGate) above.push(blockLoud[b]);
    if (!above.length) return { integrated: -70, stMax: -70, momentaryMax: momMax, lra: 0 };

    var ungatedMean = 0;
    for (var i = 0; i < above.length; i++) ungatedMean += above[i];
    ungatedMean /= above.length;

    // Relative gate (-10 LU below ungated mean)
    var relGate = ungatedMean * Math.pow(10, -10 / 10);
    var gated = [];
    for (var i = 0; i < above.length; i++) if (above[i] >= relGate) gated.push(above[i]);
    if (!gated.length) return { integrated: -70, stMax: -70, momentaryMax: momMax, lra: 0 };

    var finalMean = 0;
    for (var i = 0; i < gated.length; i++) finalMean += gated[i];
    finalMean /= gated.length;
    var integrated = -0.691 + 10 * Math.log10(finalMean);

    // Short-term (3s blocks) for max + LRA
    var stSize = Math.round(3 * fs);
    var stHop = Math.round(0.1 * fs);
    var nSt = Math.floor((n - stSize) / stHop) + 1;
    var stVals = [];
    for (var b = 0; b < nSt; b++) {
        var s = b * stHop, ms = 0;
        for (var c = 0; c < kw.length; c++) {
            var sum = 0;
            for (var i = s; i < s + stSize && i < n; i++) sum += kw[c][i] * kw[c][i];
            ms += sum / stSize;
        }
        if (ms > 0) stVals.push(-0.691 + 10 * Math.log10(ms));
    }
    var stMax = stVals.length ? Math.max.apply(null, stVals) : integrated;

    // LRA (10th/95th percentile of short-term)
    var lra = 0;
    if (stVals.length > 4) {
        var sorted = stVals.slice().sort(function(a,b){return a-b;});
        lra = Math.max(0, sorted[Math.floor(sorted.length * 0.95)] - sorted[Math.floor(sorted.length * 0.1)]);
    }

    return { integrated: integrated, stMax: stMax, momentaryMax: momMax, lra: lra };
}

// ── True Peak (4x Catmull-Rom interpolation) ─────────────────────────────
function computeTruePeak(channels) {
    var peak = 0;
    for (var c = 0; c < channels.length; c++) {
        var ch = channels[c], len = ch.length;
        for (var i = 0; i < len; i++) {
            var v = Math.abs(ch[i]);
            if (v > peak) peak = v;
        }
        // 4x oversampled interpolation
        for (var i = 1; i < len - 2; i++) {
            var p0 = ch[i-1], p1 = ch[i], p2 = ch[i+1], p3 = ch[i+2];
            for (var t = 1; t <= 3; t++) {
                var f = t / 4;
                var v = Math.abs(0.5 * ((2*p1) + (-p0+p2)*f + (2*p0-5*p1+4*p2-p3)*f*f + (-p0+3*p1-3*p2+p3)*f*f*f));
                if (v > peak) peak = v;
            }
        }
    }
    return peak > 0 ? 20 * Math.log10(peak) : -144;
}

// ── Levels (RMS, Peak, Crest) ────────────────────────────────────────────
function computeLevels(channels) {
    var sumSq = 0, peak = 0, count = 0;
    for (var c = 0; c < channels.length; c++) {
        for (var i = 0; i < channels[c].length; i++) {
            var v = Math.abs(channels[c][i]);
            sumSq += v * v;
            if (v > peak) peak = v;
            count++;
        }
    }
    var rms = Math.sqrt(sumSq / count);
    var rmsDB = rms > 0 ? 20 * Math.log10(rms) : -144;
    var peakDB = peak > 0 ? 20 * Math.log10(peak) : -144;
    return { rms: rmsDB, peak: peakDB, crest: peakDB - rmsDB };
}

// ── Stereo Width + Phase Correlation ─────────────────────────────────────
function computeStereo(channels) {
    if (channels.length < 2) return { width: 0, phaseCorr: 1 };
    var L = channels[0], R = channels[1], n = Math.min(L.length, R.length);
    var sumM = 0, sumS = 0, sumLL = 0, sumRR = 0, sumLR = 0;
    for (var i = 0; i < n; i++) {
        var m = (L[i] + R[i]) * 0.5, s = (L[i] - R[i]) * 0.5;
        sumM += m * m; sumS += s * s;
        sumLL += L[i] * L[i]; sumRR += R[i] * R[i]; sumLR += L[i] * R[i];
    }
    var width = (sumM + sumS) > 0 ? Math.sqrt(sumS / (sumM + sumS)) * 100 : 0;
    var denom = Math.sqrt(sumLL * sumRR);
    var phaseCorr = denom > 0 ? sumLR / denom : 1;
    return { width: Math.min(100, width), phaseCorr: Math.max(-1, Math.min(1, phaseCorr)) };
}

// ── Average Frequency Spectrum (log-spaced bands) ────────────────────────
function computeSpectrum(channels, fs, numBands) {
    var fftSize = 8192; // High resolution for accurate low-end (5.9 Hz/bin at 48kHz)
    var win = new Float32Array(fftSize);
    for (var i = 0; i < fftSize; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / fftSize));

    var n = channels[0].length;
    var mono = new Float32Array(n);
    for (var i = 0; i < n; i++) {
        for (var c = 0; c < channels.length; c++) mono[i] += channels[c][i] / channels.length;
    }

    var avgMag = new Float32Array(fftSize / 2);
    var hopSize = fftSize / 2; // 50% overlap for smoother averaging
    var frames = 0;
    for (var s = 0; s + fftSize <= n; s += hopSize) {
        var re = new Float32Array(fftSize);
        var im = new Float32Array(fftSize);
        for (var i = 0; i < fftSize; i++) re[i] = mono[s + i] * win[i];
        fft(re, im);
        for (var b = 0; b < fftSize / 2; b++) avgMag[b] += Math.sqrt(re[b]*re[b] + im[b]*im[b]);
        frames++;
    }
    if (frames > 0) for (var b = 0; b < fftSize/2; b++) avgMag[b] /= frames;

    // Map to log-spaced bands 20Hz-20kHz
    var bands = new Float32Array(numBands);
    var fMin = 20, fMax = Math.min(20000, fs / 2);
    for (var band = 0; band < numBands; band++) {
        var f1 = fMin * Math.pow(fMax / fMin, band / numBands);
        var f2 = fMin * Math.pow(fMax / fMin, (band + 1) / numBands);
        var b1 = Math.max(1, Math.floor(f1 * fftSize / fs));
        var b2 = Math.min(fftSize/2 - 1, Math.ceil(f2 * fftSize / fs));
        var sum = 0, cnt = 0;
        for (var b = b1; b <= b2; b++) { sum += avgMag[b]; cnt++; }
        bands[band] = cnt > 0 ? sum / cnt : 0;
    }
    // Convert to dB (relative to max)
    var maxB = 0;
    for (var i = 0; i < numBands; i++) if (bands[i] > maxB) maxB = bands[i];
    var dbBands = new Float32Array(numBands);
    for (var i = 0; i < numBands; i++) {
        dbBands[i] = maxB > 0 && bands[i] > 0 ? 20 * Math.log10(bands[i] / maxB) : -90;
    }
    return Array.from(dbBands);
}

// ── Waveform Peaks ───────────────────────────────────────────────────────
function computeWaveform(channels, numPoints) {
    var n = channels[0].length;
    var spp = Math.ceil(n / numPoints);
    var peaks = [];
    for (var p = 0; p < numPoints && p * spp < n; p++) {
        var s = p * spp, mn = 0, mx = 0;
        for (var c = 0; c < channels.length; c++) {
            for (var i = s; i < s + spp && i < n; i++) {
                if (channels[c][i] > mx) mx = channels[c][i];
                if (channels[c][i] < mn) mn = channels[c][i];
            }
        }
        peaks.push(mn, mx);
    }
    return peaks; // flat array [min0,max0,min1,max1,...]
}

// ── Goniometer Data ──────────────────────────────────────────────────────
function computeGoniometer(channels, numPoints) {
    if (channels.length < 2) {
        var hop = Math.ceil(channels[0].length / numPoints);
        var pts = [];
        for (var i = 0; i < channels[0].length && pts.length < numPoints * 2; i += hop) {
            pts.push(channels[0][i], 0);
        }
        return pts;
    }
    var L = channels[0], R = channels[1], n = Math.min(L.length, R.length);
    var hop = Math.ceil(n / numPoints);
    var pts = [];
    for (var i = 0; i < n && pts.length < numPoints * 2; i += hop) {
        pts.push((L[i] + R[i]) * 0.707, (L[i] - R[i]) * 0.707);
    }
    return pts; // flat [m0,s0,m1,s1,...]
}

// ── BPM Fallback (onset envelope autocorrelation) ────────────────────────
function detectBPMFallback(channels, fs) {
    var n = channels[0].length;
    var mono = new Float32Array(n);
    for (var i = 0; i < n; i++) for (var c = 0; c < channels.length; c++) mono[i] += channels[c][i] / channels.length;

    // Analyze max 90s from center
    var aLen = Math.min(n, Math.round(90 * fs));
    var start = Math.max(0, Math.round((n - aLen) / 2));
    var seg = mono.subarray(start, start + aLen);

    var winS = Math.round(0.02 * fs), hopS = Math.round(0.01 * fs);
    var envLen = Math.floor((seg.length - winS) / hopS);
    if (envLen < 100) return 0;

    var env = new Float32Array(envLen);
    for (var i = 0; i < envLen; i++) {
        var s = i * hopS, sum = 0;
        for (var j = s; j < s + winS && j < seg.length; j++) sum += seg[j] * seg[j];
        env[i] = Math.sqrt(sum / winS);
    }

    var df = new Float32Array(envLen);
    for (var i = 1; i < envLen; i++) df[i] = Math.max(0, env[i] - env[i - 1]);

    var hopDur = hopS / fs;
    var minP = Math.round(60 / 200 / hopDur);
    var maxP = Math.round(60 / 40 / hopDur);
    var corrLen = Math.min(df.length, 5000);
    var bestP = minP, bestC = 0;

    for (var period = minP; period <= maxP; period++) {
        var corr = 0;
        for (var i = 0; i < corrLen - period; i++) corr += df[i] * df[i + period];
        if (corr > bestC) { bestC = corr; bestP = period; }
    }
    var bpm = 60 / (bestP * hopDur);
    while (bpm < 60) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    return Math.round(bpm * 10) / 10;
}

// ── Key Fallback (chromagram + Krumhansl-Kessler) ────────────────────────
function detectKeyFallback(channels, fs) {
    var n = channels[0].length;
    var mono = new Float32Array(n);
    for (var i = 0; i < n; i++) for (var c = 0; c < channels.length; c++) mono[i] += channels[c][i] / channels.length;

    var fftSize = 4096;
    var win = new Float32Array(fftSize);
    for (var i = 0; i < fftSize; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / fftSize));

    var chroma = new Float32Array(12);
    var frames = 0;
    for (var s = 0; s + fftSize <= n; s += fftSize) {
        var re = new Float32Array(fftSize), im = new Float32Array(fftSize);
        for (var i = 0; i < fftSize; i++) re[i] = mono[s + i] * win[i];
        fft(re, im);
        for (var bin = 1; bin < fftSize / 2; bin++) {
            var freq = bin * fs / fftSize;
            if (freq < 65 || freq > 5000) continue;
            var midi = 12 * Math.log2(freq / 440) + 69;
            var pc = ((Math.round(midi) % 12) + 12) % 12;
            chroma[pc] += Math.sqrt(re[bin]*re[bin] + im[bin]*im[bin]);
        }
        frames++;
    }
    if (!frames) return { key: 'C', scale: 'Major', strength: 0 };

    var cMax = 0;
    for (var i = 0; i < 12; i++) if (chroma[i] > cMax) cMax = chroma[i];
    if (cMax > 0) for (var i = 0; i < 12; i++) chroma[i] /= cMax;

    var MAJOR = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
    var MINOR = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
    var NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

    function pearson(a, b) {
        var n = a.length, ma = 0, mb = 0;
        for (var i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
        ma /= n; mb /= n;
        var num = 0, da = 0, db = 0;
        for (var i = 0; i < n; i++) { num += (a[i]-ma)*(b[i]-mb); da += (a[i]-ma)*(a[i]-ma); db += (b[i]-mb)*(b[i]-mb); }
        return (da * db) > 0 ? num / Math.sqrt(da * db) : 0;
    }

    var bestKey = 'C', bestMode = 'Major', bestCorr = -2;
    for (var root = 0; root < 12; root++) {
        var profiles = [['Major', MAJOR], ['Minor', MINOR]];
        for (var p = 0; p < 2; p++) {
            var mode = profiles[p][0], prof = profiles[p][1];
            var rotated = new Array(12);
            for (var i = 0; i < 12; i++) rotated[i] = prof[(i - root + 12) % 12];
            var corr = pearson(Array.from(chroma), rotated);
            if (corr > bestCorr) { bestCorr = corr; bestKey = NOTES[root]; bestMode = mode; }
        }
    }
    return { key: bestKey, scale: bestMode, strength: Math.round((bestCorr + 1) / 2 * 100) };
}

// ── Worker message handler ───────────────────────────────────────────────
self.onmessage = function(e) {
    var channels = e.data.channels;
    var fs = e.data.sampleRate;

    try {
        self.postMessage({ type: 'progress', msg: 'Computing loudness (EBU R128)...' });
        var lufs = computeLUFS(channels, fs);

        self.postMessage({ type: 'progress', msg: 'Measuring True Peak...' });
        var tp = computeTruePeak(channels);

        self.postMessage({ type: 'progress', msg: 'Analyzing levels...' });
        var levels = computeLevels(channels);

        self.postMessage({ type: 'progress', msg: 'Analyzing stereo field...' });
        var stereo = computeStereo(channels);

        self.postMessage({ type: 'progress', msg: 'Computing frequency spectrum...' });
        var spectrum = computeSpectrum(channels, fs, 256);

        self.postMessage({ type: 'progress', msg: 'Preparing waveform...' });
        var waveform = computeWaveform(channels, 1200);

        self.postMessage({ type: 'progress', msg: 'Computing stereo field data...' });
        var goniometer = computeGoniometer(channels, 8000);

        self.postMessage({ type: 'progress', msg: 'Detecting BPM...' });
        var bpm = detectBPMFallback(channels, fs);

        self.postMessage({ type: 'progress', msg: 'Detecting key...' });
        var key = detectKeyFallback(channels, fs);

        self.postMessage({
            type: 'result',
            data: {
                lufs: lufs.integrated, stLufs: lufs.stMax, momLufs: lufs.momentaryMax, lra: lufs.lra,
                truePeak: tp, rms: levels.rms, peak: levels.peak, crest: levels.crest,
                width: stereo.width, phaseCorr: stereo.phaseCorr,
                bpm: bpm, key: key,
                spectrum: spectrum, waveform: waveform, goniometer: goniometer
            }
        });
    } catch (err) {
        self.postMessage({ type: 'error', msg: err.message || String(err) });
    }
};
