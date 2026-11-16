// Runs inside the page (injected by the renderer, the page itself is never edited). Drives the page contract
// (canvas #c, renderAt, TOTAL, ready, EVENTS) and encodes with WebCodecs, so frames never leave Chrome as images:
// only encoded video bytes are posted back to Node.
(() => {
  'use strict';
  if (window.__motlab) return;

  const BT709 = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
  // Chrome turns the canvas into limited range YUV when it draws on a GPU, but into full range when it draws in
  // software (SwiftShader, or a machine without a GPU), and the encoder's decoderConfig says which.
  const fullRange = meta => meta?.decoderConfig?.colorSpace?.fullRange === true;
  const emit = (type, data = {}) => { try { window.__motlabEmit(JSON.stringify({ type, ...data })); } catch {} };
  const post = async (url, body) => { const r = await fetch(url, { method: 'POST', body }); if (!r.ok) throw new Error(`upload failed (${r.status})`); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function canvas() {
    const c = document.getElementById('c');
    if (!(c instanceof HTMLCanvasElement)) throw new Error('page has no <canvas id="c">');
    return c;
  }

  function gpu() {   // the GPU Chrome really draws on
    try {
      const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
      if (!gl) return { renderer: null, vendor: null };
      const e = gl.getExtension('WEBGL_debug_renderer_info');
      const out = { renderer: gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER), vendor: gl.getParameter(e ? e.UNMASKED_VENDOR_WEBGL : gl.VENDOR) };
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return out;
    } catch (e) { return { renderer: null, vendor: null, error: String(e && e.message) }; }
  }

  function info() {
    const c = canvas();
    return { width: c.width, height: c.height, total: Number(window.TOTAL), events: Array.isArray(window.EVENTS) ? window.EVENTS : [], gpu: gpu() };
  }

  // rc 'quantizer' = constant QP (quality stays fixed, size follows content); otherwise variable bitrate.
  function encoderConfig(o, width, height, annexb) {
    const hevc = o.codec === 'hevc';
    return {
      codec: o.codecString, width, height, framerate: o.fps,
      hardwareAcceleration: o.hw ? 'prefer-hardware' : 'prefer-software', latencyMode: 'quality',
      ...(o.rc === 'quantizer' ? { bitrateMode: 'quantizer' } : { bitrateMode: 'variable', bitrate: o.bitrate }),
      [hevc ? 'hevc' : 'avc']: { format: annexb ? 'annexb' : (hevc ? 'hevc' : 'avc') },
    };
  }
  const frameOptions = (o, keyFrame) => o.rc === 'quantizer' ? { keyFrame, [o.codec === 'hevc' ? 'hevc' : 'avc']: { quantizer: o.qp } } : { keyFrame };

  // Wait until the encoder has room. The timeout keeps a dead encoder from hanging the loop.
  const drained = enc => Promise.race([new Promise(r => enc.addEventListener('dequeue', r, { once: true })), sleep(2000)]);

  // Where encoded chunks go. 'mediabunny' muxes the MP4 inside the page and streams it out with positional writes.
  // 'raw' appends the Annex B bitstream for ffmpeg to wrap.
  async function openSink(o) {
    if (o.mux === 'raw') {
      let parts = [], size = 0;
      const flush = async () => { if (!size) return; const blob = new Blob(parts); parts = []; size = 0; await post(`${o.base}/append?id=${o.sink}`, blob); };
      return {
        async add(chunk) { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); parts.push(b); size += b.length; if (size >= 4 << 20) await flush(); },
        finish: flush,
      };
    }
    const MB = await import(`${o.base}/mediabunny.mjs`);
    const writable = new WritableStream({ write: c => post(`${o.base}/write?id=${o.sink}&pos=${c.position}`, c.data) });
    const output = new MB.Output({
      format: new MB.Mp4OutputFormat({ fastStart: false }),   // ffmpeg writes the final fast-start file
      target: new MB.StreamTarget(writable, { chunked: true, chunkSize: 8 << 20 }),
    });
    const source = new MB.EncodedVideoPacketSource(o.codec === 'hevc' ? 'hevc' : 'avc');
    output.addVideoTrack(source, { frameRate: o.fps });
    await output.start();
    return {
      // Encoders tag colour inconsistently in the bitstream (hardware H.264 not at all), so the container tag is set
      // here: BT.709 with the range the encoder reports. ffmpeg later writes the same into the bitstream.
      add: (chunk, meta) => source.add(MB.EncodedPacket.fromEncodedChunk(chunk),
        meta && meta.decoderConfig ? { ...meta, decoderConfig: { ...meta.decoderConfig, colorSpace: { ...BT709, fullRange: fullRange(meta) } } } : meta),
      finish: () => output.finalize(),
    };
  }

  // Render frames [start, end) with renderAt(frame / fps) and encode them. Timestamps start at 0 for each range.
  async function encodeRange(o) {
    const cv = canvas(), frames = o.end - o.start;
    const cfg = encoderConfig(o, cv.width, cv.height, o.mux === 'raw');
    if (!(await VideoEncoder.isConfigSupported(cfg)).supported) throw new Error(`encoder config not supported: ${cfg.codec} ${cfg.hardwareAcceleration} ${cv.width}x${cv.height}`);
    const sink = await openSink(o);

    let chain = Promise.resolve(), queued = 0, failure = null, bytes = 0, full = false;
    const enc = new VideoEncoder({
      output(chunk, meta) {
        bytes += chunk.byteLength; queued++;
        if (meta?.decoderConfig) full = fullRange(meta);
        chain = chain.then(() => failure || sink.add(chunk, meta)).then(() => { queued--; }, e => { failure ??= e; queued--; });
      },
      error(e) { failure ??= e; },
    });
    enc.configure(cfg);

    const t0 = performance.now(), frameUs = 1e6 / o.fps; let renderMs = 0, lastEmit = t0;
    for (let i = 0; i < frames && !failure; i++) {
      const r0 = performance.now();
      await window.renderAt((o.start + i) / o.fps);
      renderMs += performance.now() - r0;
      const vf = new VideoFrame(cv, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
      enc.encode(vf, frameOptions(o, i % o.keyInterval === 0));
      vf.close();
      while (enc.encodeQueueSize > 2 && !failure) await drained(enc);
      if (queued > 32) await chain;
      const now = performance.now();
      if (now - lastEmit > 250 || i === frames - 1) { lastEmit = now; emit('progress', { done: i + 1 }); }
    }
    if (!failure) await enc.flush();
    try { enc.close(); } catch {}
    await chain;
    if (failure) throw new Error(`encode failed: ${failure.message || failure}`);
    await sink.finish();
    return { frames, bytes, ms: performance.now() - t0, renderMs, fullRange: full };
  }

  // ---- encoder probe: how fast is one encoder config at this size, with drawing kept cheap? ----
  let scene = null;
  function probeScene(width, height) {
    if (scene && scene.cv.width === width && scene.cv.height === height) return scene;
    const cv = document.createElement('canvas'); cv.width = width; cv.height = height;
    const ctx = cv.getContext('2d'), S = width / 1920;
    const g = ctx.createLinearGradient(0, 0, width, height); g.addColorStop(0, '#1b2a4a'); g.addColorStop(1, '#0c3b2e');
    ctx.fillStyle = g; ctx.fillRect(0, 0, width, height);
    for (let k = 0; k < 90; k++) {   // static detail, kept as a bitmap so per-frame drawing stays cheap
      ctx.fillStyle = `hsl(${(k * 37) % 360},65%,${45 + (k % 5) * 6}%)`;
      ctx.beginPath(); ctx.roundRect(((k * 211) % 1800) * S, ((k * 127) % 1000) * S, (60 + (k % 6) * 30) * S, (40 + (k % 4) * 24) * S, 10 * S); ctx.fill();
    }
    ctx.fillStyle = '#fff'; ctx.font = `600 ${64 * S}px system-ui, sans-serif`; ctx.fillText('motlab encoder probe', 80 * S, 120 * S);
    const bg = document.createElement('canvas'); bg.width = width; bg.height = height; bg.getContext('2d').drawImage(cv, 0, 0);
    const draw = i => {
      ctx.drawImage(bg, 0, 0);
      for (let k = 0; k < 24; k++) {
        const a = k * 0.7 + i * 0.03 * (1 + (k % 5) * 0.2);
        ctx.fillStyle = `hsl(${(k * 23 + 180) % 360},80%,62%)`;
        ctx.beginPath(); ctx.roundRect((960 + Math.cos(a) * (200 + k * 28) - 60) * S, (540 + Math.sin(a * 1.3) * (120 + k * 14) - 40) * S, 120 * S, 80 * S, 14 * S); ctx.fill();
      }
      ctx.fillStyle = '#fff'; ctx.fillText(String(i), 960 * S, 560 * S);
    };
    return (scene = { cv, draw });
  }

  async function probeEncoder(o) {
    const cfg = encoderConfig(o, o.width, o.height, true);
    try { if (!(await VideoEncoder.isConfigSupported(cfg)).supported) return { supported: false }; } catch (e) { return { supported: false, error: String(e && e.message) }; }
    const { cv, draw } = probeScene(o.width, o.height), frameUs = 1e6 / o.fps;
    // The clock starts at the WARM-th output chunk, so encoder start-up is not counted. There is no flush in the
    // middle: a hardware encoder that is flushed and then fed again stalls in headless Chrome.
    const WARM = 6; let failure = null, bytes = 0, outs = 0, t0 = 0;
    const enc = new VideoEncoder({ output(c) { if (++outs === WARM) { t0 = performance.now(); bytes = 0; } else bytes += c.byteLength; }, error(e) { failure ??= e; } });
    try {
      enc.configure(cfg);
      for (let i = 0; i < WARM + o.frames && !failure; i++) {
        draw(i);
        const vf = new VideoFrame(cv, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
        enc.encode(vf, frameOptions(o, i === 0)); vf.close();
        while (enc.encodeQueueSize > 2 && !failure) await drained(enc);
      }
      if (!failure) await enc.flush();
      const ms = performance.now() - t0, timed = outs - WARM;
      if (failure) return { supported: false, error: String(failure.message || failure) };
      if (timed < 1) return { supported: false, error: `encoder returned ${outs} of ${WARM + o.frames} frames` };
      return { supported: true, fps: timed / (ms / 1000), mbps: (bytes * 8 * o.fps) / timed / 1e6 };
    } catch (e) { return { supported: false, error: String(e && e.message) }; } finally { try { enc.close(); } catch {} }
  }

  const probeDone = () => { if (scene) { scene.cv.width = scene.cv.height = 0; scene = null; } };

  async function still(o) {
    await window.renderAt(o.t);
    const blob = await new Promise(r => canvas().toBlob(r, o.type, o.quality));
    if (!blob) throw new Error('canvas.toBlob returned nothing');
    await post(`${o.base}/append?id=${o.sink}`, blob);
    return blob.size;
  }

  window.__motlab = { info, gpu, encodeRange, probeEncoder, probeDone, still };
})();
