import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractMedia } from '../web/js/workbench-media.js';
import { extractMp4Audio } from '../web/js/mp4-audio.js';

const atom = (type, ...parts) => {
  const data = Buffer.concat(parts), b = Buffer.alloc(8 + data.length);
  b.writeUInt32BE(b.length); b.write(type, 4); data.copy(b, 8); return b;
};
const words = (...values) => {
  const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32BE(v, i * 4)); return b;
};

/** Minimal ~25 s AAC-shaped track: 1024-tick samples, multi-chunk stsc, real edit list support. */
function windowFixture({ count = 1200, chunkSamples = 5, delta = 1024, edits = null,
  elstVersion = 0, mediaRate = 65536, movieScale = 1000, sampleRate = 48000, timescale = 48000 } = {}) {
  const size = 8, ftyp = atom('ftyp', Buffer.from('isom0000'));
  const audio = Buffer.alloc(count * size);
  // Each sample carries its own index so windows can be matched back to source samples.
  for (let i = 0; i < count; i++) { audio.writeUInt32BE(i, i * size); audio.writeUInt32BE((i ^ 0xffff) >>> 0, i * size + 4); }
  const mdat = atom('mdat', audio);
  const hdlr = atom('hdlr', words(0, 0), Buffer.from('soun'));
  const mdhd = atom('mdhd', words(0, 0, 0, timescale, count * delta));
  const entry = Buffer.alloc(28); entry.writeUInt16BE(1, 6); entry.writeUInt16BE(2, 16);
  entry.writeUInt16BE(16, 18); entry.writeUInt32BE(sampleRate * 65536, 24);
  const sizes = Buffer.alloc(count * 4); for (let i = 0; i < count; i++) sizes.writeUInt32BE(size, i * 4);
  const chunks = Math.ceil(count / chunkSamples), offsets = [];
  let at = ftyp.length + 8;
  for (let c = 0; c < chunks; c++) { offsets.push(at); at += Math.min(chunkSamples, count - c * chunkSamples) * size; }
  const runs = [];
  for (let c = 0; c < chunks; c++) {
    const n = Math.min(chunkSamples, count - c * chunkSamples);
    if (!runs.length || runs[runs.length - 1].n !== n) runs.push({ first: c + 1, n });
  }
  const stbl = atom('stbl', atom('stsd', words(0, 1), atom('mp4a', entry)),
    atom('stts', words(0, 1, count, delta)),
    atom('stsc', words(0, runs.length), ...runs.flatMap((r) => words(r.first, r.n, 1))),
    atom('stsz', Buffer.concat([words(0, 0, count), sizes])),
    atom('stco', words(0, chunks), words(...offsets)));
  let edts;
  if (edits) {
    const width = elstVersion === 1 ? 20 : 12, parts = [Buffer.from([elstVersion, 0, 0, 0]), words(edits.length)];
    for (const e of edits) {
      const b = Buffer.alloc(width);
      if (elstVersion === 1) { b.writeBigUInt64BE(BigInt(e.length), 0); b.writeBigInt64BE(BigInt(e.time), 8); b.writeUInt32BE(mediaRate, 16); }
      else { b.writeUInt32BE(e.length >>> 0, 0); b.writeInt32BE(e.time, 4); b.writeUInt32BE(mediaRate, 8); }
      parts.push(b);
    }
    edts = atom('edts', atom('elst', ...parts));
  }
  const track = atom('trak', atom('tkhd', Buffer.alloc(84)), ...(edts ? [edts] : []),
    atom('mdia', mdhd, hdlr, atom('minf', stbl)));
  const movie = Buffer.alloc(100); movie.writeUInt32BE(movieScale, 12);
  const bytes = Buffer.concat([ftyp, mdat, atom('moov', atom('mvhd', movie), track)]);
  return new File([bytes], 'movie.mp4', { type: 'video/mp4' });
}

const childBoxes = (b, start, end) => {
  const out = [];
  for (let p = start; p < end;) {
    let size = b.readUInt32BE(p), header = 8;
    if (size === 1) { size = Number(b.readBigUInt64BE(p + 8)); header = 16; }
    if (!size) size = end - p;
    out.push({ type: b.toString('ascii', p + 4, p + 8), start: p, data: p + header, end: p + size });
    p += size;
  }
  return out;
};

/** Parse a yielded window and expand its sample table back to source sample indexes. */
function windowStructure(blob) {
  const b = Buffer.from(blob);
  const top = childBoxes(b, 0, b.length);
  const moov = top.find((x) => x.type === 'moov'), mdat = top.find((x) => x.type === 'mdat');
  const trak = childBoxes(b, moov.data, moov.end).find((x) => x.type === 'trak');
  const trakKids = childBoxes(b, trak.data, trak.end);
  const mdia = trakKids.find((x) => x.type === 'mdia'), mdiaKids = childBoxes(b, mdia.data, mdia.end);
  const minf = mdiaKids.find((x) => x.type === 'minf');
  const stbl = childBoxes(b, minf.data, minf.end).find((x) => x.type === 'stbl');
  const table = Object.fromEntries(childBoxes(b, stbl.data, stbl.end).map((x) => [x.type, x]));
  const mdhd = mdiaKids.find((x) => x.type === 'mdhd');
  const stsz = table.stsz, stco = table.stco, stsc = table.stsc, stts = table.stts;
  const n = b.readUInt32BE(stsz.data + 8), fixed = b.readUInt32BE(stsz.data + 4);
  const sizes = Array.from({ length: n }, (_, i) => fixed || b.readUInt32BE(stsz.data + 12 + i * 4));
  const chunkCount = b.readUInt32BE(stco.data + 4);
  const chunkOffsets = Array.from({ length: chunkCount }, (_, i) => b.readUInt32BE(stco.data + 8 + i * 4));
  const runCount = b.readUInt32BE(stsc.data + 4);
  const stscRuns = Array.from({ length: runCount }, (_, i) => ({
    first: b.readUInt32BE(stsc.data + 8 + i * 12),
    n: b.readUInt32BE(stsc.data + 12 + i * 12),
    sdi: b.readUInt32BE(stsc.data + 16 + i * 12),
  }));
  const perChunk = Array.from({ length: chunkCount }, (_, c) => {
    let r = 0; for (let k = 0; k < stscRuns.length; k++) if (stscRuns[k].first <= c + 1) r = k;
    return stscRuns[r].n;
  });
  const ids = []; let cursor = chunkOffsets[0], sample = 0;
  for (let c = 0; c < chunkCount; c++) {
    for (let k = 0; k < perChunk[c]; k++) { ids.push(b.readUInt32BE(cursor)); cursor += sizes[sample++]; }
  }
  let ticks = 0;
  for (let k = 0, c = b.readUInt32BE(stts.data + 4); k < c; k++) {
    ticks += b.readUInt32BE(stts.data + 8 + k * 8) * b.readUInt32BE(stts.data + 12 + k * 8);
  }
  return { b, n, ids, chunkOffsets, sdis: stscRuns.map((r) => r.sdi), ticks,
    end: cursor, mdatStart: mdat.data, mdatEnd: mdat.end, sampleBytes: sizes.reduce((a, c) => a + c, 0),
    totalChunkSamples: sample, mdhdScale: b.readUInt32BE(mdhd.data + 12),
    mdhdDuration: b.readUInt32BE(mdhd.data + 16), edts: !!trakKids.find((x) => x.type === 'edts') };
}

async function collect(plan) {
  const out = [];
  for await (const segment of plan.segments()) out.push(segment);
  return out;
}

test('segmented windows are self-consistent, independently decodable and time-contiguous', async () => {
  const plan = await extractMp4Audio(windowFixture(), { segmented: true });
  const mediaDuration = 1200 * 1024 / 48000;
  assert.equal(plan.duration, mediaDuration);
  assert.equal(plan.sampleRate, 48000);
  assert.equal(plan.channels, 2);
  const segments = await collect(plan);
  assert.ok(segments.length >= 3, 'a ~25 s track must split into several windows');
  let previousEnd = 0, previousLastSample = -Infinity;
  for (const [index, segment] of segments.entries()) {
    assert.equal(segment.silence, undefined);
    assert.equal(segment.time, previousEnd, 'windows must start exactly where the previous one ended');
    assert.ok(segment.duration > 0 && segment.duration <= 12 + 1e-9, 'window must stay near 12 s');
    const w = windowStructure(await segment.file.arrayBuffer());
    // The window's own tables must describe exactly its own mdat payload.
    assert.equal(w.sdis.every((sdi) => sdi === 1), true, 'sample description index must stay valid');
    assert.equal(w.sampleBytes, w.mdatEnd - w.mdatStart, 'stsz must match the window mdat');
    assert.equal(w.end, w.mdatEnd, 'chunk offsets must stay inside the rebuilt mdat');
    assert.equal(w.totalChunkSamples, w.n, 'stsc/stsz sample counts must agree');
    assert.equal(w.ticks, w.mdhdDuration, 'stts must describe the whole window duration');
    assert.equal(w.edts, false, 'windows drop the movie edit list they no longer honour');
    assert.equal(w.ids.every((v, i) => i === 0 || v === w.ids[i - 1] + 1), true, 'source samples stay consecutive');
    if (index > 0) {
      assert.ok(w.ids[0] < previousLastSample, 'later windows must include pre-roll samples from before their start');
      assert.ok(w.ids.at(-1) > previousLastSample, 'window must advance past the previous one');
    }
    // `skip` positions the decoder at the requested start inside the pre-roll.
    assert.ok(segment.skip >= 0 && segment.skip < segment.duration);
    assert.ok(segment.skip * w.mdhdScale <= w.ticks);
    previousLastSample = w.ids.at(-1);
    previousEnd = segment.time + segment.duration;
    if (index === 0) assert.equal(segment.skip, 0, 'first window starts on a sample boundary');
    else assert.ok(segment.skip > 0, 'later windows must skip their pre-roll');
  }
  assert.ok(Math.abs(previousEnd - plan.duration) < 1e-9, 'windows must cover the declared duration exactly');
  assert.equal(previousLastSample, 1199, 'the final window must reach the last real sample');
});

test('segments are sliced on demand and never materialize the video or the whole track', async () => {
  const source = await windowFixture().arrayBuffer();
  let largestRelease = 0, planLargestSlice = 0, planned = false;
  const file = {
    name: 'movie.mp4', size: source.byteLength,
    arrayBuffer() { throw new Error('whole file read'); },
    slice(start, end) {
      const part = new Uint8Array(source, start, end - start);
      if (planned) largestRelease = Math.max(largestRelease, part.byteLength);
      else planLargestSlice = Math.max(planLargestSlice, part.byteLength);
      const blob = new Blob([part]);
      blob.arrayBuffer = async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength);
      return blob;
    },
  };
  const plan = await extractMp4Audio(file, { segmented: true });
  // Planning only touches the moov index; no media bytes are read.
  assert.ok(planLargestSlice < source.byteLength, 'planning must not read the media payload');
  planned = true;
  const segments = await collect(plan);
  let payload = 0;
  for (const segment of segments) {
    assert.ok(segment.file.size < source.byteLength, 'each window is a slice, not the whole track');
    payload += segment.file.size;
  }
  // A window is a fraction of the track: 3 windows must not each carry the whole track.
  assert.ok(payload < source.byteLength * 2, 'window payloads stay proportional to their span');
  assert.ok(largestRelease < source.byteLength / 2, 'no single read materializes half the file');
});

test('edit list start offset shifts every window time and emits a leading silence segment', async () => {
  // 0.5 s of empty edit, then a 20 s media edit starting 1 s into the track.
  const plan = await extractMp4Audio(windowFixture({
    edits: [{ length: 500, time: -1 }, { length: 20000, time: 48000 }],
  }), { segmented: true });
  assert.equal(plan.duration, 20.5);
  const segments = await collect(plan);
  assert.deepEqual(segments.map((s) => s.time), [0, 0.5, 12.5]);
  assert.equal(segments[0].silence, 0.5);
  assert.equal(segments[0].duration, 0.5);
  assert.equal(segments[1].time, 0.5);
  // Trim selects the source samples; `skip` only trims the small pre-roll of
  // samples carried over from before the requested start.
  assert.ok(segments[1].skip > 0 && segments[1].skip < 0.25, 'skip covers only the codec pre-roll');
  assert.ok(Math.abs(segments.at(-1).time + segments.at(-1).duration - plan.duration) < 1e-9);
  const first = windowStructure(await segments[1].file.arrayBuffer());
  // 1 s trim at 1024 ticks / 48000 Hz lands between source samples 46 and 47.
  assert.ok(first.ids[0] >= 38 && first.ids[0] < 48, 'trimmed media time must select later source samples');
  // The requested start, expressed in media time, is exactly the 1 s trim.
  assert.ok(Math.abs(first.ids[0] * 1024 / 48000 + segments[1].skip - 1) < 0.03);
});

test('a rounded-up edit list never runs past the last real sample; shorter edits keep their value', async () => {
  const mediaEnd = 1200 * 1024 / 48000;
  // 25601 ms is one millisecond past the real 25.6 s sample end: exactly the
  // rounding overshoot case. 1000 ms is a shorter, fully valid edit.
  for (const [editDuration, expected] of [[25601, mediaEnd], [99999, mediaEnd], [1000, 1]]) {
    const plan = await extractMp4Audio(windowFixture({ edits: [{ length: editDuration, time: 0 }] }), { segmented: true });
    assert.equal(plan.duration, expected);
    const segments = await collect(plan);
    assert.ok(Math.abs(segments.at(-1).time + segments.at(-1).duration - expected) < 1e-9);
    const last = windowStructure(await segments.at(-1).file.arrayBuffer());
    assert.ok(last.ids.at(-1) < 1200, 'must never reference samples beyond the media data');
    // The listening master keeps the original edit list untouched.
    const master = await extractMedia(windowFixture({ edits: [{ length: editDuration, time: 0 }] }));
    const bytes = Buffer.from(await master.file.arrayBuffer());
    assert.equal(bytes.readUInt32BE(bytes.indexOf('elst') + 12), editDuration);
  }
});

test('windows rebuild correctly across chunk layouts and audio timescales', async () => {
  for (const options of [
    { chunkSamples: 1, count: 700 },              // one sample per chunk
    { chunkSamples: 50, count: 900 },             // coarse stsc runs
    { sampleRate: 44100, timescale: 44100, count: 900 }, // audio ticks == sample rate
    { delta: 2048, count: 700 },                  // 43 ms AAC frames
  ]) {
    const plan = await extractMp4Audio(windowFixture(options), { segmented: true });
    const segments = await collect(plan);
    assert.ok(segments.length >= 1);
    let previousEnd = 0, previousLast = -Infinity;
    for (const segment of segments) {
      assert.equal(segment.time, previousEnd);
      const w = windowStructure(await segment.file.arrayBuffer());
      assert.equal(w.sampleBytes, w.mdatEnd - w.mdatStart);
      assert.equal(w.end, w.mdatEnd);
      assert.equal(w.ticks, w.mdhdDuration);
      assert.equal(w.totalChunkSamples, w.n);
      assert.ok(w.ids[0] <= previousLast || previousLast === -Infinity);
      previousLast = w.ids.at(-1);
      previousEnd = segment.time + segment.duration;
    }
    assert.ok(Math.abs(previousEnd - plan.duration) < 1e-9);
    assert.equal(previousLast, options.count - 1, 'the last window must reach the final sample');
  }
});

test('unsupported edit lists fail loudly instead of silently truncating', async () => {
  await assert.rejects(extractMp4Audio(windowFixture({ edits: [{ length: 1000, time: 0 }], elstVersion: 2 }), { segmented: true }), /剪辑时间轴/);
  await assert.rejects(extractMp4Audio(windowFixture({ edits: [], elstVersion: 2 }), { segmented: true }), /剪辑时间轴/);
  await assert.rejects(extractMp4Audio(windowFixture({ edits: [{ length: 1000, time: 0 }], mediaRate: 0x8000 }), { segmented: true }), /剪辑时间轴/);
  await assert.rejects(extractMp4Audio(windowFixture({ edits: [{ length: 1000, time: 0 }, { length: 1000, time: 2048 }] }), { segmented: true }), /剪辑时间轴/);
  await assert.rejects(extractMp4Audio(windowFixture({ edits: [{ length: 1000, time: 0 }, { length: 500, time: -1 }] }), { segmented: true }), /剪辑时间轴/);
  await assert.rejects(extractMp4Audio(windowFixture({ edits: [{ length: 1000, time: -7 }] }), { segmented: true }), /剪辑范围无效/);
});

function fixture({ large = false, co64 = false, tail = true, fixed = false, badOffset = false, editDuration } = {}) {
  const ftyp = atom('ftyp', Buffer.from('isom0000'));
  const mdatSize = large ? 500 * 1024 * 1024 : 32;
  const mdat = words(mdatSize, 0x6d646174);
  const audio = [Buffer.from([1, 2, 3, 4]), Buffer.from([5, 6, 7, 8])];
  const makeMoov = (shift) => {
    const hdlr = atom('hdlr', words(0, 0), Buffer.from('soun'));
    const mdhd = atom('mdhd', words(0, 0, 0, 48000, 2048));
    const entry = Buffer.alloc(28); entry.writeUInt16BE(1, 6); entry.writeUInt16BE(2, 16);
    entry.writeUInt16BE(16, 18); entry.writeUInt32BE(48000 * 65536, 24);
    const positions = [ftyp.length + shift + 8, ftyp.length + shift + mdatSize - 4];
    if (badOffset) positions[1] += 100000;
    const offsets = co64 ? Buffer.concat(positions.map((p) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(p)); return b; })) : words(...positions);
    const stbl = atom('stbl', atom('stsd', words(0, 1), atom('mp4a', entry)),
      atom('stts', words(0, 1, 2, 1024)), atom('stsc', words(0, 1, 1, 1, 1)),
      atom('stsz', fixed ? words(0, 4, 2) : words(0, 0, 2, 4, 4)), atom(co64 ? 'co64' : 'stco', words(0, 2), offsets));
    const edits = editDuration === undefined ? words(0, 0) : words(0, 1, editDuration, 0, 65536);
    const track = atom('trak', atom('tkhd', Buffer.alloc(84)), atom('edts', atom('elst', edits)),
      atom('mdia', mdhd, hdlr, atom('minf', stbl)));
    const video = atom('trak', atom('mdia', atom('hdlr', words(0, 0), Buffer.from('vide'))));
    const movie = Buffer.alloc(100); movie.writeUInt32BE(1000, 12);
    return atom('moov', atom('mvhd', movie), video, track);
  };
  let moov = makeMoov(0); if (!tail) moov = makeMoov(moov.length);
  const mdatStart = ftyp.length + (tail ? 0 : moov.length), moovStart = tail ? ftyp.length + mdatSize : ftyp.length;
  const regions = [{ at: 0, data: ftyp }, { at: mdatStart, data: mdat },
    { at: mdatStart + 8, data: audio[0] }, { at: mdatStart + mdatSize - 4, data: audio[1] }, { at: moovStart, data: moov }];
  let readBytes = 0, maxRead = 0;
  // Sparse file double: its advertised 500 MiB is real in offset space, and any
  // attempt to materialize the video payload fails rather than hiding in a tiny mock.
  const file = { name: 'movie.mp4', size: ftyp.length + mdatSize + moov.length,
    arrayBuffer() { throw new Error('whole video read'); },
    slice(start, end) {
      assert.ok(end - start <= 4096, 'must not materialize video');
      const b = Buffer.alloc(end - start);
      for (const r of regions) {
        const a = Math.max(start, r.at), z = Math.min(end, r.at + r.data.length);
        if (z > a) r.data.copy(b, a - start, a - r.at, z - r.at);
      }
      const blob = new Blob([b]);
      blob.arrayBuffer = async () => { readBytes += b.length; maxRead = Math.max(maxRead, b.length); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
      return blob;
    } };
  return { file, stats: () => ({ readBytes, maxRead }) };
}

for (const tail of [true, false]) for (const co64 of [true, false]) for (const fixed of [true, false]) {
  test(`MP4 remux preserves audio and rewrites offsets: tail=${tail} co64=${co64} fixed=${fixed}`, async () => {
    const { file, stats } = fixture({ large: true, tail, co64, fixed });
    const out = await extractMedia(file), b = Buffer.from(await out.file.arrayBuffer());
    assert.equal(out.file.name, 'movie.lossless.m4a'); assert.equal(out.buffer, undefined);
    assert.equal(out.sampleRate, 48000); assert.equal(out.channels, 2); assert.equal(out.duration, 2048 / 48000);
    assert.equal(b.includes(Buffer.from('vide')), false); assert.ok(b.includes(Buffer.from('edts')));
    const table = b.indexOf(co64 ? 'co64' : 'stco');
    const offsets = [0, 1].map((i) => co64 ? Number(b.readBigUInt64BE(table + 12 + i * 8)) : b.readUInt32BE(table + 12 + i * 4));
    assert.deepEqual([...b.subarray(offsets[0], offsets[0] + 4)], [1, 2, 3, 4]);
    assert.deepEqual([...b.subarray(offsets[1], offsets[1] + 4)], [5, 6, 7, 8]);
    assert.ok(out.file.size < 1024); assert.ok(stats().readBytes < 2048);
  });
}

test('invalid offsets, truncated indexes and fragmented MP4 fail without decoding', async () => {
  await assert.rejects(extractMedia(fixture({ badOffset: true }).file), /位置超出/);
  await assert.rejects(extractMedia(new File([atom('ftyp', Buffer.from('isom')), atom('moof')], 'frag.mp4')), /分片/);
  await assert.rejects(extractMedia(new File([words(100, 0x6d6f6f76)], 'bad.mp4')), /大小无效/);
});

test('abort interrupts header reads before audio assembly', async () => {
  const { file } = fixture({ large: true }), controller = new AbortController();
  const slice = file.slice;
  file.slice = (...args) => { controller.abort(); return slice(...args); };
  await assert.rejects(extractMedia(file, { signal: controller.signal }), { name: 'AbortError' });
});

test('ASR windows cap rounded-up movie duration at the real sample end, preserving shorter edits', async () => {
  for (const editDuration of [43, 42]) {
    const plan = await extractMp4Audio(fixture({ editDuration }).file, { segmented: true });
    const expected = Math.min(editDuration / 1000, 2048 / 48000);
    assert.equal(plan.duration, expected);
    const segments = [];
    for await (const segment of plan.segments()) segments.push(segment);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].duration, expected);
    assert.ok(segments[0].skip + segments[0].duration <= 2048 / 48000);
    // The listening master still preserves the original edit list unchanged.
    const master = await extractMedia(fixture({ editDuration }).file);
    const bytes = Buffer.from(await master.file.arrayBuffer());
    assert.equal(bytes.readUInt32BE(bytes.indexOf('elst') + 12), editDuration);
  }
});
