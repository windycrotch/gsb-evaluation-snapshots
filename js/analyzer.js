// ══════════════════════════════════════════════════════════════════════════════
// Audio Analyzer — Main Application
// ══════════════════════════════════════════════════════════════════════════════

(function() {
'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════════════════════════ */
var audioBuffer = null;
var analysisData = null;
var audioCtx = null;
var sourceNode = null;
var analyserNode = null;
var analyserL = null, analyserR = null;
var isPlaying = false;
var startTime = 0;
var pauseOffset = 0;
var rafId = null;
var worker = null;
var essentiaInstance = null;
var essentiaLoaded = false;

/* ═══════════════════════════════════════════════════════════════════════════
   ESSENTIA.JS LOADING (async, non-blocking)
   ═══════════════════════════════════════════════════════════════════════════ */
function loadScript(src) {
    return new Promise(function(resolve, reject) {
        var s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

async function initEssentia() {
    try {
        await loadScript('https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia-wasm.web.js');
        await loadScript('https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia.js-core.min.js');
        if (typeof EssentiaWASM !== 'undefined' && typeof Essentia !== 'undefined') {
            var wasmModule = await EssentiaWASM();
            essentiaInstance = new Essentia(wasmModule);
            essentiaLoaded = true;
            console.log('essentia.js loaded');
        }
    } catch (e) {
        console.warn('essentia.js failed to load, using fallback algorithms:', e);
    }
}

function essentiaAnalyze(buffer) {
    if (!essentiaLoaded || !essentiaInstance) return null;
    try {
        var n = buffer.length;
        var sr = buffer.sampleRate;
        var mono = new Float32Array(n);
        for (var c = 0; c < buffer.numberOfChannels; c++) {
            var ch = buffer.getChannelData(c);
            for (var i = 0; i < n; i++) mono[i] += ch[i] / buffer.numberOfChannels;
        }

        var vector = essentiaInstance.arrayToVector(mono);
        var keyResult = null, bpmResult = null;
        try {
            keyResult = essentiaInstance.KeyExtractor(vector, true, 4096, 4096, 36, 5000, 100, 25, 0.2, 'bgate', sr);
        } catch (e) { console.warn('essentia KeyExtractor failed:', e); }
        try {
            bpmResult = essentiaInstance.PercivalBpmEstimator(vector, 1024, 2048, 128, 128, 210, 50, sr);
        } catch (e) {
            try { bpmResult = essentiaInstance.RhythmExtractor2013(vector); } catch (e2) {
                console.warn('essentia BPM detection failed:', e2);
            }
        }
        vector.delete();
        return { key: keyResult, bpm: bpmResult };
    } catch (e) {
        console.warn('essentia analysis failed:', e);
        return null;
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   FORMAT HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */
function fmt(v, d) { d = d || 1; return isFinite(v) ? v.toFixed(d) : '—'; }
function fmtTime(s) { return Math.floor(s/60) + ':' + String(Math.floor(s%60)).padStart(2,'0'); }

/* ═══════════════════════════════════════════════════════════════════════════
   DROP ZONE
   ═══════════════════════════════════════════════════════════════════════════ */
function initDropZone() {
    var dz = document.getElementById('azDropZone');
    var fi = document.getElementById('azFileInput');

    dz.addEventListener('click', function() { fi.click(); });
    fi.addEventListener('change', function() { if (fi.files.length) processFile(fi.files[0]); });

    dz.addEventListener('dragover', function(e) { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', function() { dz.classList.remove('drag-over'); });
    dz.addEventListener('drop', function(e) {
        e.preventDefault(); dz.classList.remove('drag-over');
        if (e.dataTransfer.files.length) processFile(e.dataTransfer.files[0]);
    });

    document.getElementById('azNewBtn').addEventListener('click', resetUI);
}

function resetUI() {
    stopPlayback();
    document.getElementById('azDropZone').classList.remove('az-hidden');
    document.getElementById('azResults').classList.add('az-hidden');
    audioBuffer = null;
    analysisData = null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   FILE PROCESSING
   ═══════════════════════════════════════════════════════════════════════════ */
async function processFile(file) {
    var sizeMB = file.size / (1024 * 1024);
    if (sizeMB > 500) {
        alert('File too large (' + sizeMB.toFixed(0) + ' MB). Maximum is 500 MB to avoid browser crashes.');
        return;
    }
    if (sizeMB > 200) {
        showLoading('Loading large file (' + sizeMB.toFixed(0) + ' MB) — this may take a moment...');
    } else {
        showLoading('Decoding audio...');
    }
    try {
        var arrayBuf = await file.arrayBuffer();
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        audioBuffer = await audioCtx.decodeAudioData(arrayBuf);
    } catch (e) {
        hideLoading();
        alert('Could not decode this file. Make sure it is a valid audio file.');
        return;
    }

    // Update file info
    document.getElementById('azFileName').textContent = file.name;
    document.getElementById('azDuration').textContent = fmtTime(audioBuffer.duration);
    document.getElementById('azSampleRate').textContent = audioBuffer.sampleRate + ' Hz';
    document.getElementById('azChannels').textContent = audioBuffer.numberOfChannels === 1 ? 'Mono' : 'Stereo';
    document.getElementById('azTotalTime').textContent = fmtTime(audioBuffer.duration);

    // Run analysis
    showLoading('Analyzing...');
    runAnalysis(audioBuffer);
}

/* ═══════════════════════════════════════════════════════════════════════════
   WORKER ANALYSIS
   ═══════════════════════════════════════════════════════════════════════════ */
function runAnalysis(buffer) {
    // Prepare channel data
    var channels = [];
    for (var c = 0; c < buffer.numberOfChannels; c++) {
        channels.push(new Float32Array(buffer.getChannelData(c)));
    }

    // Create worker from separate file (requires HTTP server, not file://)
    if (worker) worker.terminate();
    try {
        worker = new Worker('js/worker.js');
    } catch (e) {
        hideLoading();
        alert('Web Workers require an HTTP server.\n\nRun: python3 -m http.server\nThen open: http://localhost:8000');
        return;
    }

    worker.onmessage = function(e) {
        if (e.data.type === 'progress') {
            var msg = document.getElementById('azProgressMsg');
            if (msg) msg.textContent = e.data.msg;
        } else if (e.data.type === 'result') {
            analysisData = e.data.data;

            // Try essentia.js for better Key/BPM
            var essentiaResult = essentiaAnalyze(buffer);
            if (essentiaResult) {
                if (essentiaResult.key && essentiaResult.key.key) {
                    analysisData.key = {
                        key: essentiaResult.key.key,
                        scale: essentiaResult.key.scale === 'minor' ? 'Minor' : 'Major',
                        strength: Math.round((essentiaResult.key.strength || 0) * 100)
                    };
                }
                if (essentiaResult.bpm && essentiaResult.bpm.bpm > 0) {
                    var bpm = essentiaResult.bpm.bpm;
                    while (bpm < 60) bpm *= 2;
                    while (bpm > 180) bpm /= 2;
                    analysisData.bpm = Math.round(bpm * 10) / 10;
                }
            }

            // Show results container BEFORE rendering canvases (they need dimensions)
            document.getElementById('azDropZone').classList.add('az-hidden');
            document.getElementById('azResults').classList.remove('az-hidden');
            hideLoading();
            // Small delay to let layout settle before canvas rendering
            setTimeout(function() {
                displayResults(analysisData, buffer);
            }, 50);
            worker.terminate();
            worker = null;
        } else if (e.data.type === 'error') {
            hideLoading();
            alert('Analysis error: ' + e.data.msg);
            worker.terminate();
            worker = null;
        }
    };

    worker.onerror = function(e) {
        hideLoading();
        alert('Worker error: ' + (e.message || 'Unknown error'));
        worker.terminate();
        worker = null;
    };

    // Transfer channel data to worker
    var transferable = channels.map(function(ch) { return ch.buffer; });
    worker.postMessage({ channels: channels, sampleRate: buffer.sampleRate }, transferable);
}

/* ═══════════════════════════════════════════════════════════════════════════
   DISPLAY RESULTS
   ═══════════════════════════════════════════════════════════════════════════ */
function displayResults(d, buffer) {
    // LUFS
    var lufsColor = d.lufs > -9 ? 'red' : d.lufs > -14 ? 'yellow' : d.lufs > -23 ? 'green' : 'blue';
    document.getElementById('vLufs').textContent = fmt(d.lufs);
    document.getElementById('vLufs').className = 'az-metric-value c-' + lufsColor;
    document.getElementById('sLufs').textContent = fmt(d.lufs) + ' LUFS';
    var lufsFill = document.getElementById('fLufs');
    lufsFill.style.width = Math.max(0, Math.min(100, (d.lufs + 40) / 40 * 100)) + '%';
    lufsFill.className = 'az-metric-fill bg-' + lufsColor;

    // True Peak
    var tpColor = d.truePeak > -0.3 ? 'red' : d.truePeak > -1 ? 'yellow' : 'green';
    document.getElementById('vTp').textContent = fmt(d.truePeak);
    document.getElementById('vTp').className = 'az-metric-value c-' + tpColor;
    document.getElementById('sTp').textContent = fmt(d.truePeak) + ' dBTP';
    var tpFill = document.getElementById('fTp');
    tpFill.style.width = Math.max(0, Math.min(100, (d.truePeak + 20) / 20 * 100)) + '%';
    tpFill.className = 'az-metric-fill bg-' + tpColor;

    // BPM
    document.getElementById('vBpm').textContent = d.bpm > 0 ? fmt(d.bpm, 0) : '—';
    document.getElementById('sBpm').textContent = d.bpm > 0 ? d.bpm + ' BPM' : 'Could not detect';

    // Key
    if (d.key && d.key.key) {
        document.getElementById('vKey').textContent = d.key.key + ' ' + (d.key.scale === 'Minor' ? 'min' : 'Maj');
        document.getElementById('sKey').textContent = d.key.strength ? d.key.strength + '% confidence' : '';
    } else {
        document.getElementById('vKey').textContent = '—';
        document.getElementById('sKey').textContent = 'Could not detect';
    }

    // Stereo Width
    var wColor = d.width < 10 ? 'yellow' : d.width > 90 ? 'blue' : 'green';
    document.getElementById('vWidth').textContent = fmt(d.width, 0) + '%';
    document.getElementById('vWidth').className = 'az-metric-value c-' + wColor;
    document.getElementById('sWidth').textContent = d.width < 10 ? 'Mono' : d.width > 80 ? 'Wide' : 'Normal';
    var wFill = document.getElementById('fWidth');
    wFill.style.width = d.width + '%';
    wFill.className = 'az-metric-fill bg-' + wColor;

    // Secondary metrics
    document.getElementById('vStLufs').textContent = fmt(d.stLufs) + ' LUFS';
    document.getElementById('vLra').textContent = fmt(d.lra) + ' LU';
    document.getElementById('vRms').textContent = fmt(d.rms) + ' dB';
    document.getElementById('vCrest').textContent = fmt(d.crest) + ' dB';
    document.getElementById('vPhase').textContent = d.phaseCorr !== undefined ? (d.phaseCorr >= 0 ? '+' : '') + fmt(d.phaseCorr, 2) : '—';
    document.getElementById('vPeak').textContent = fmt(d.peak) + ' dB';

    // Render visualizations
    renderWaveform();
    renderSpectrum(d.spectrum);
    renderGoniometer(d.goniometer);
    buildStreamingTable(d.lufs, d.truePeak);

    // Setup playback
    pauseOffset = 0;
    isPlaying = false;
    document.getElementById('azPlayBtn').textContent = 'Play';
    document.getElementById('azCurTime').textContent = '0:00';
}

/* ═══════════════════════════════════════════════════════════════════════════
   CANVAS SETUP (DPI-aware)
   ═══════════════════════════════════════════════════════════════════════════ */
function setupCanvas(canvas) {
    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx: ctx, w: rect.width, h: rect.height };
}

/* ═══════════════════════════════════════════════════════════════════════════
   WAVEFORM RENDERER
   ═══════════════════════════════════════════════════════════════════════════ */
function renderWaveform(pos) {
    if (!analysisData) return;
    var canvas = document.getElementById('azWaveform');
    var r = setupCanvas(canvas);
    var ctx = r.ctx, w = r.w, h = r.h;
    var peaks = analysisData.waveform;
    var numPoints = peaks.length / 2;
    var mid = h / 2;
    var amp = mid * 0.92;

    ctx.fillStyle = '#0d0f14';
    ctx.fillRect(0, 0, w, h);

    // Center line
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

    // Draw waveform as filled path
    var playIdx = pos !== undefined ? Math.floor(pos * numPoints) : -1;

    // Unplayed portion (blue)
    ctx.beginPath();
    for (var i = 0; i < numPoints; i++) {
        var x = (i / numPoints) * w;
        ctx.lineTo(x, mid - peaks[i * 2 + 1] * amp);
    }
    for (var i = numPoints - 1; i >= 0; i--) {
        var x = (i / numPoints) * w;
        ctx.lineTo(x, mid - peaks[i * 2] * amp);
    }
    ctx.closePath();
    var grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(74,158,255,0.6)');
    grad.addColorStop(0.5, 'rgba(74,158,255,0.25)');
    grad.addColorStop(1, 'rgba(74,158,255,0.6)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Played portion overlay (green)
    if (playIdx > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, (playIdx / numPoints) * w, h);
        ctx.clip();

        ctx.beginPath();
        for (var i = 0; i < numPoints; i++) {
            var x = (i / numPoints) * w;
            ctx.lineTo(x, mid - peaks[i * 2 + 1] * amp);
        }
        for (var i = numPoints - 1; i >= 0; i--) {
            var x = (i / numPoints) * w;
            ctx.lineTo(x, mid - peaks[i * 2] * amp);
        }
        ctx.closePath();
        var gGrad = ctx.createLinearGradient(0, 0, 0, h);
        gGrad.addColorStop(0, 'rgba(34,197,94,0.7)');
        gGrad.addColorStop(0.5, 'rgba(34,197,94,0.3)');
        gGrad.addColorStop(1, 'rgba(34,197,94,0.7)');
        ctx.fillStyle = gGrad;
        ctx.fill();
        ctx.restore();
    }

    // Playback cursor
    if (pos !== undefined && pos > 0) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(pos * w - 1, 0, 2, h);
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SPECTRUM RENDERER
   ═══════════════════════════════════════════════════════════════════════════ */
function renderSpectrum(spectrum, realtimeData) {
    var canvas = document.getElementById('azSpectrum');
    var r = setupCanvas(canvas);
    var ctx = r.ctx, w = r.w, h = r.h;
    var n = spectrum ? spectrum.length : 0;

    ctx.fillStyle = '#0d0f14';
    ctx.fillRect(0, 0, w, h);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.15)';

    // dB grid (-90 to 0)
    for (var db = -80; db <= 0; db += 20) {
        var y = h * (1 - (db + 90) / 90);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        if (db > -90) ctx.fillText(db + ' dB', 4, y - 3);
    }

    // Frequency labels
    var freqLabels = [20,50,100,200,500,1000,2000,5000,10000,20000];
    for (var fi = 0; fi < freqLabels.length; fi++) {
        var f = freqLabels[fi];
        var x = w * Math.log(f / 20) / Math.log(1000);
        if (x > 0 && x < w - 20) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
            var label = f >= 1000 ? (f/1000) + 'k' : f;
            ctx.fillText(label, x + 2, h - 4);
        }
    }

    if (!spectrum || !n) return;

    // Draw spectrum (filled curve with gradient)
    var barW = w / n;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (var i = 0; i < n; i++) {
        var x = i * barW;
        var dbVal = spectrum[i];
        var barH = Math.max(0, (dbVal + 90) / 90) * h;
        ctx.lineTo(x, h - barH);
    }
    ctx.lineTo(w, h);
    ctx.closePath();

    var sGrad = ctx.createLinearGradient(0, h, 0, 0);
    sGrad.addColorStop(0, 'rgba(74,158,255,0.02)');
    sGrad.addColorStop(0.4, 'rgba(74,158,255,0.12)');
    sGrad.addColorStop(0.7, 'rgba(74,158,255,0.18)');
    sGrad.addColorStop(1, 'rgba(74,158,255,0.25)');
    ctx.fillStyle = sGrad;
    ctx.fill();

    // Outline
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
        var x = i * barW;
        var dbVal = spectrum[i];
        var barH = Math.max(0, (dbVal + 90) / 90) * h;
        if (i === 0) ctx.moveTo(x, h - barH);
        else ctx.lineTo(x, h - barH);
    }
    ctx.strokeStyle = 'rgba(74,158,255,0.8)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Real-time overlay (during playback)
    if (realtimeData && realtimeData.length) {
        ctx.beginPath();
        var rtBarW = w / realtimeData.length;
        for (var i = 0; i < realtimeData.length; i++) {
            var x = i * rtBarW;
            var val = realtimeData[i];
            var barH = Math.max(0, (val + 90) / 90) * h;
            if (i === 0) ctx.moveTo(x, h - barH);
            else ctx.lineTo(x, h - barH);
        }
        ctx.strokeStyle = 'rgba(74,158,255,0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   GONIOMETER RENDERER
   ═══════════════════════════════════════════════════════════════════════════ */
function renderGoniometer(points, trail) {
    var canvas = document.getElementById('azGonio');
    var r = setupCanvas(canvas);
    var ctx = r.ctx, w = r.w, h = r.h;
    var cx = w / 2, cy = h / 2;
    var radius = Math.min(cx, cy) * 0.85;

    ctx.fillStyle = trail ? 'rgba(13,15,20,0.18)' : '#0d0f14';
    ctx.fillRect(0, 0, w, h);

    // Concentric circles
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, radius * 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, radius * 0.25, 0, Math.PI * 2); ctx.stroke();

    // Cross lines (M vertical, S horizontal)
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath(); ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy); ctx.stroke();

    // Diagonal lines (L/R)
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.beginPath(); ctx.moveTo(cx - radius * 0.707, cy - radius * 0.707); ctx.lineTo(cx + radius * 0.707, cy + radius * 0.707); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + radius * 0.707, cy - radius * 0.707); ctx.lineTo(cx - radius * 0.707, cy + radius * 0.707); ctx.stroke();

    // Labels
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.textAlign = 'center';
    ctx.fillText('M', cx, cy - radius - 6);
    ctx.fillText('L', cx - radius - 8, cy - 2);
    ctx.fillText('R', cx + radius + 8, cy - 2);

    if (!points || !points.length) return;

    // Plot samples
    var numPts = points.length / 2;
    for (var i = 0; i < numPts; i++) {
        var m = points[i * 2], s = points[i * 2 + 1];
        var px = cx + s * radius * 3;
        var py = cy - m * radius * 3;
        if (px < 0 || px > w || py < 0 || py > h) continue;

        var alpha = 0.06 + (i / numPts) * 0.25;
        ctx.fillStyle = 'rgba(74,158,255,' + alpha + ')';
        ctx.fillRect(px - 0.5, py - 0.5, 1.5, 1.5);
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   STREAMING TARGETS TABLE
   ═══════════════════════════════════════════════════════════════════════════ */
function buildStreamingTable(lufs, tp) {
    var targets = [
        { name: 'Spotify',      target: -14, tp: -1 },
        { name: 'Apple Music',  target: -16, tp: -1 },
        { name: 'YouTube',      target: -14, tp: -1 },
        { name: 'Tidal',        target: -14, tp: -1 },
        { name: 'Amazon Music', target: -14, tp: -2 },
        { name: 'Deezer',       target: -15, tp: -1 },
    ];

    var RMIN = -26, RMAX = -6, RRANGE = RMAX - RMIN;

    var html = '';
    for (var i = 0; i < targets.length; i++) {
        var t = targets[i];
        var diff = lufs - t.target;
        var adiff = Math.abs(diff);
        var tpOver = tp > t.tp;
        var color, status;

        if (adiff <= 1 && !tpOver) {
            color = '#22c55e';
            status = adiff < 0.1 ? 'on target' : (diff > 0 ? '+' + fmt(diff,1) + ' dB' : fmt(adiff,1) + ' dB under');
        } else if (adiff <= 2 && !tpOver) {
            color = '#f59e0b';
            status = diff > 0 ? '+' + fmt(diff,1) + ' dB over' : fmt(adiff,1) + ' dB under';
        } else {
            color = '#ef4444';
            status = (tpOver ? 'TP! ' : '') + (diff > 0 ? '+' + fmt(diff,1) + ' dB over' : fmt(adiff,1) + ' dB under');
        }

        var targetPct = Math.max(2, Math.min(98, (t.target - RMIN) / RRANGE * 100));
        var mixPct    = Math.max(0, Math.min(100, (lufs - RMIN) / RRANGE * 100));

        html += '<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);">'
            + '<span style="width:95px;font-size:0.78rem;font-weight:500;color:var(--text-primary);flex-shrink:0;">' + t.name + '</span>'
            + '<span style="font-family:JetBrains Mono,monospace;font-size:0.65rem;color:var(--text-muted);width:52px;flex-shrink:0;">' + t.target + ' LUFS</span>'
            + '<div style="flex:1;height:8px;background:rgba(255,255,255,0.06);border-radius:4px;position:relative;">'
                + '<div style="position:absolute;top:0;left:0;height:100%;width:' + mixPct + '%;background:' + color + ';opacity:0.25;border-radius:4px;"></div>'
                + '<div style="position:absolute;top:-2px;left:calc(' + mixPct + '% - 2px);width:4px;height:12px;background:' + color + ';border-radius:2px;"></div>'
                + '<div style="position:absolute;top:-3px;left:calc(' + targetPct + '% - 1px);width:2px;height:14px;background:rgba(255,255,255,0.45);border-radius:1px;"></div>'
            + '</div>'
            + '<span style="font-family:JetBrains Mono,monospace;font-size:0.68rem;color:' + color + ';width:90px;text-align:right;flex-shrink:0;">' + status + '</span>'
            + '</div>';
    }

    document.getElementById('azStreamTable').innerHTML = html;
}

/* ═══════════════════════════════════════════════════════════════════════════
   PLAYBACK
   ═══════════════════════════════════════════════════════════════════════════ */
function initPlayback() {
    document.getElementById('azPlayBtn').addEventListener('click', togglePlay);

    document.addEventListener('keydown', function(e) {
        if (e.code === 'Space' && audioBuffer && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
            e.preventDefault();
            togglePlay();
        }
    });

    // Waveform click-to-seek
    document.getElementById('azWaveform').addEventListener('click', function(e) {
        if (!audioBuffer) return;
        var rect = e.target.getBoundingClientRect();
        var pos = (e.clientX - rect.left) / rect.width;
        seekTo(pos * audioBuffer.duration);
    });
}

var playTransition = false;

async function togglePlay() {
    if (!audioBuffer) return;
    if (playTransition) return;
    playTransition = true;
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        if (isPlaying) {
            stopPlayback();
        } else {
            startPlayback();
        }
    } finally {
        playTransition = false;
    }
}

function startPlayback() {
    if (!audioBuffer || !audioCtx) return;
    stopPlayback();

    var node = audioCtx.createBufferSource();
    node.buffer = audioBuffer;

    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserNode.smoothingTimeConstant = 0.8;

    node.connect(analyserNode);
    analyserNode.connect(audioCtx.destination);

    if (audioBuffer.numberOfChannels >= 2) {
        var splitter = audioCtx.createChannelSplitter(2);
        analyserL = audioCtx.createAnalyser(); analyserL.fftSize = 1024;
        analyserR = audioCtx.createAnalyser(); analyserR.fftSize = 1024;
        node.connect(splitter);
        splitter.connect(analyserL, 0);
        splitter.connect(analyserR, 1);
    } else {
        analyserL = analyserR = null;
    }

    sourceNode = node;
    startTime = audioCtx.currentTime;
    node.start(0, pauseOffset);
    isPlaying = true;
    document.getElementById('azPlayBtn').textContent = 'Pause';

    node.onended = function() {
        if (sourceNode !== node) return;
        isPlaying = false;
        pauseOffset = 0;
        sourceNode = null;
        document.getElementById('azPlayBtn').textContent = 'Play';
        document.getElementById('azCurTime').textContent = '0:00';
        renderWaveform(0);
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    };

    updatePlaybackUI();
}

function stopPlayback() {
    if (sourceNode) {
        var node = sourceNode;
        sourceNode = null;
        try { node.onended = null; } catch(e) {}
        try { node.stop(); } catch(e) {}
        try { node.disconnect(); } catch(e) {}
    }
    if (analyserNode) { try { analyserNode.disconnect(); } catch(e) {} analyserNode = null; }
    if (analyserL) { try { analyserL.disconnect(); } catch(e) {} analyserL = null; }
    if (analyserR) { try { analyserR.disconnect(); } catch(e) {} analyserR = null; }
    if (isPlaying) {
        pauseOffset += audioCtx.currentTime - startTime;
    }
    isPlaying = false;
    document.getElementById('azPlayBtn').textContent = 'Play';
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

function seekTo(time) {
    var wasPlaying = isPlaying;
    if (isPlaying) stopPlayback();
    pauseOffset = Math.max(0, Math.min(time, audioBuffer.duration - 0.01));
    document.getElementById('azCurTime').textContent = fmtTime(pauseOffset);
    renderWaveform(pauseOffset / audioBuffer.duration);
    if (wasPlaying) startPlayback();
}

function updatePlaybackUI() {
    if (!isPlaying) return;
    var currentTime = pauseOffset + (audioCtx.currentTime - startTime);
    var pos = currentTime / audioBuffer.duration;

    document.getElementById('azCurTime').textContent = fmtTime(currentTime);
    renderWaveform(pos);

    // Real-time goniometer from L/R AnalyserNodes
    if (analyserL && analyserR) {
        var bufSize = analyserL.fftSize;
        var lData = new Float32Array(bufSize);
        var rData = new Float32Array(bufSize);
        analyserL.getFloatTimeDomainData(lData);
        analyserR.getFloatTimeDomainData(rData);
        var flat = new Float32Array(bufSize * 2);
        for (var j = 0; j < bufSize; j++) {
            flat[j * 2]     = (lData[j] + rData[j]) * 0.707; // M
            flat[j * 2 + 1] = (lData[j] - rData[j]) * 0.707; // S
        }
        renderGoniometer(flat, true);
    }

    // Real-time spectrum from AnalyserNode
    if (analyserNode && analysisData) {
        var freqData = new Float32Array(analyserNode.frequencyBinCount);
        analyserNode.getFloatFrequencyData(freqData);
        var numBands = 256;
        var rtBands = new Float32Array(numBands);
        var fs = audioCtx.sampleRate;
        var fMin = 20, fMax = Math.min(20000, fs / 2);
        for (var band = 0; band < numBands; band++) {
            var f1 = fMin * Math.pow(fMax / fMin, band / numBands);
            var f2 = fMin * Math.pow(fMax / fMin, (band + 1) / numBands);
            var b1 = Math.max(1, Math.floor(f1 / fs * analyserNode.fftSize));
            var b2 = Math.min(freqData.length - 1, Math.ceil(f2 / fs * analyserNode.fftSize));
            var sum = 0, cnt = 0;
            for (var b = b1; b <= b2; b++) { sum += freqData[b]; cnt++; }
            rtBands[band] = cnt > 0 ? sum / cnt : -90;
        }
        renderSpectrum(analysisData.spectrum, Array.from(rtBands));
    }

    rafId = requestAnimationFrame(updatePlaybackUI);
}

/* ═══════════════════════════════════════════════════════════════════════════
   LOADING OVERLAY
   ═══════════════════════════════════════════════════════════════════════════ */
function showLoading(msg) {
    document.getElementById('azLoading').classList.remove('az-hidden');
    document.getElementById('azLoading').querySelector('p').textContent = msg || 'Loading...';
    document.getElementById('azProgressMsg').textContent = '';
}
function hideLoading() {
    document.getElementById('azLoading').classList.add('az-hidden');
}

/* ═══════════════════════════════════════════════════════════════════════════
   CANVAS RESIZE HANDLER
   ═══════════════════════════════════════════════════════════════════════════ */
function handleResize() {
    if (analysisData) {
        renderWaveform();
        renderSpectrum(analysisData.spectrum);
        renderGoniometer(analysisData.goniometer);
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function() {
    initDropZone();
    initPlayback();
    initEssentia(); // async, non-blocking

    var resizeTimer;
    window.addEventListener('resize', function() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(handleResize, 150);
    });
});

})();
