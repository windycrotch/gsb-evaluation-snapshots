// Browser-console tests for the MP4 pipeline: the fragmented -> standard rewrite (toStandardMp4)
// and both MP4 writers (muxMp4, muxRaw), including video-only files with no audio track.
// With the page open (http://localhost:5184), run in the console:
//
//   const { runMp4Tests } = await import('./tests/mp4-tests.js');
//   await runMp4Tests();
//
// Builds its own minimal fragmented MP4s, so no media files or encoders are needed.

import { toStandardMp4 } from '../engine/recorder.js';
import { muxMp4, muxRaw } from '../engine/exporter.js';

// ---- tiny box builders (same layout as engine/exporter.js) ----
const enc = new TextEncoder();
const u8 = (...b) => new Uint8Array(b);
const u16 = (v) => u8((v >> 8) & 255, v & 255);
const u32 = (v) => u8((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const i32 = (v) => u32(v >>> 0);
const u64 = (v) => cat(u32(Math.floor(v / 2 ** 32)), u32(v >>> 0));
function cat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const box = (type, ...body) => { const b = cat(...body); return cat(u32(8 + b.length), enc.encode(type), b); };
const full = (type, version, flags, ...body) => box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...body);
const MATRIX = cat(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000));

// ---- minimal reader for assertions ----
function boxes(dv, start, end) {
  const out = [];
  let i = start;
  while (i + 8 <= end) {
    let size = dv.getUint32(i);
    const type = String.fromCharCode(dv.getUint8(i + 4), dv.getUint8(i + 5), dv.getUint8(i + 6), dv.getUint8(i + 7));
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(i + 8)); hdr = 16; } else if (size === 0) size = end - i;
    out.push({ type, start: i, body: i + hdr, end: i + size });
    i += size;
  }
  return out;
}
const findBox = (dv, s, e, type) => boxes(dv, s, e).find((b) => b.type === type);

// Parse a standard MP4 into the facts the tests assert on.
function parseStandard(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = boxes(dv, 0, bytes.length);
  const moov = findBox(dv, 0, bytes.length, 'moov');
  if (!moov) throw new Error('no moov box');
  const mvhd = findBox(dv, moov.body, moov.end, 'mvhd');
  const tracks = boxes(dv, moov.body, moov.end).filter((b) => b.type === 'trak').map((t) => {
    const tkhd = findBox(dv, t.body, t.end, 'tkhd');
    const mdia = findBox(dv, t.body, t.end, 'mdia');
    const mdhd = findBox(dv, mdia.body, mdia.end, 'mdhd');
    const hdlr = findBox(dv, mdia.body, mdia.end, 'hdlr');
    const stbl = findBox(dv, findBox(dv, mdia.body, mdia.end, 'minf').body, findBox(dv, mdia.body, mdia.end, 'minf').end, 'stbl');
    const stsz = findBox(dv, stbl.body, stbl.end, 'stsz');
    const stts = findBox(dv, stbl.body, stbl.end, 'stts');
    const stss = findBox(dv, stbl.body, stbl.end, 'stss');
    const sizes = [], sttsPairs = [], sync = [];
    for (let k = 0; k < dv.getUint32(stsz.body + 8); k++) sizes.push(dv.getUint32(stsz.body + 12 + k * 4));
    for (let k = 0; k < dv.getUint32(stts.body + 4); k++) sttsPairs.push([dv.getUint32(stts.body + 8 + k * 8), dv.getUint32(stts.body + 12 + k * 8)]);
    if (stss) for (let k = 0; k < dv.getUint32(stss.body + 4); k++) sync.push(dv.getUint32(stss.body + 8 + k * 4));
    return {
      handler: String.fromCharCode(dv.getUint8(hdlr.body + 8), dv.getUint8(hdlr.body + 9), dv.getUint8(hdlr.body + 10), dv.getUint8(hdlr.body + 11)),
      timescale: dv.getUint32(mdhd.body + 12),
      mediaDuration: dv.getUint32(mdhd.body + 16),
      trackDuration: dv.getUint32(tkhd.body + 20), // version 0 tkhd
      sizes, stts: sttsPairs, stss: stss ? sync : null,
    };
  });
  const mdat = findBox(dv, 0, bytes.length, 'mdat');
  return {
    order: top.map((b) => b.type),
    mvhdDuration: dv.getUint32(mvhd.body + 16), // version 0 mvhd
    tracks,
    mdatPayload: mdat ? bytes.slice(mdat.body, mdat.end) : null,
  };
}

// ---- minimal fragmented MP4, shaped like Chrome's MediaRecorder output ----
// Video: 3 samples of 3000 ticks at 90000 Hz (0.1 s), first one a keyframe.
// Audio (optional): 2 samples of 1024 ticks at 48000 Hz.
function sampleFragmented({ withAudio = true } = {}) {
  const vSizes = [5, 7, 6], aSizes = [4, 4];
  const vDur = 3000, aDur = 1024, vTs = 90000, aTs = 48000;
  const vData = u8(...Array.from({ length: 18 }, (_, i) => i + 1));
  const aData = u8(201, 202, 203, 204, 205, 206, 207, 208);

  const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x10000), u16(0x100), new Uint8Array(10), MATRIX, new Uint8Array(24), u32(3));
  const trex = (id, dur) => full('trex', 0, 0, u32(id), u32(1), u32(dur), u32(0), u32(0));
  const trak = (id, ts, handler) => box('trak',
    full('tkhd', 0, 7, u32(0), u32(0), u32(id), u32(0), u32(0), u32(0), u32(0), u16(0), u16(0), u16(handler === 'soun' ? 0x100 : 0), u16(0), MATRIX, u32(0), u32(0)),
    box('mdia',
      full('mdhd', 0, 0, u32(0), u32(0), u32(ts), u32(0), u16(0x55c4), u16(0)),
      full('hdlr', 0, 0, u32(0), enc.encode(handler), u32(0), u32(0), u32(0), enc.encode('H\0')),
      box('minf',
        handler === 'vide' ? full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)) : full('smhd', 0, 0, u16(0), u16(0)),
        box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
        box('stbl', full('stsd', 0, 0, u32(1), box(handler === 'vide' ? 'avc1' : 'mp4a', new Uint8Array(16)))))));
  const traf = (id, ddur, dflags, sizes, dataOffset, firstFlags) => box('traf',
    full('tfhd', 0, 0x28, u32(id), u32(ddur), u32(dflags)), // default-sample-duration + default-sample-flags
    full('tfdt', 1, 0, u64(0)),
    full('trun', 0, firstFlags != null ? 0x205 : 0x201, u32(sizes.length), i32(dataOffset),
      ...(firstFlags != null ? [u32(firstFlags)] : []), ...sizes.map(u32)));

  const ftyp = box('ftyp', enc.encode('isom'), u32(0), enc.encode('isom'));
  const moov = box('moov', mvhd, box('mvex', trex(1, vDur), ...(withAudio ? [trex(2, aDur)] : [])),
    trak(1, vTs, 'vide'), ...(withAudio ? [trak(2, aTs, 'soun')] : []));
  // sample flags: video defaults to non-sync (0x10000), first sample overridden to sync -> stss [1]
  const makeMoof = (vOff, aOff, vN = vSizes, aN = aSizes) => box('moof', full('mfhd', 0, 0, u32(1)),
    traf(1, vDur, 0x10000, vN, vOff, 0x2000000), ...(withAudio ? [traf(2, aDur, 0, aN, aOff, null)] : []));
  let moof = makeMoof(0, 0);
  const dataStart = ftyp.length + moov.length + moof.length + 8; // mdat header is 8 bytes here
  moof = makeMoof(dataStart - (ftyp.length + moov.length), dataStart + vData.length - (ftyp.length + moov.length));
  const mdat = box('mdat', vData, ...(withAudio ? [aData] : []));
  return {
    blob: new Blob([ftyp, moov, moof, mdat]),
    parts: { ftyp, moov, moof, mdat, mvhd },
    makeMoof, traf, trak,
    vData, aData, vSizes, aSizes, vDur, aDur, vTs, aTs,
    // expected values after the rewrite
    vMediaDur: 3 * vDur, aMediaDur: 2 * aDur,
    vTrackDur: Math.round((3 * vDur * 1000) / vTs), aTrackDur: Math.round((2 * aDur * 1000) / aTs),
  };
}

// A raw track object for muxRaw, with the pre-built boxes it expects.
function rawTrack(id, handler, timescale, samples) {
  return {
    id, timescale, handler, samples,
    tkhd: full('tkhd', 0, 7, u32(0), u32(0), u32(id), u32(0), u32(0), u32(0), u32(0), u16(0), u16(0), u16(handler === 'soun' ? 0x100 : 0), u16(0), MATRIX, u32(0), u32(0)),
    hdlr: full('hdlr', 0, 0, u32(0), enc.encode(handler), u32(0), u32(0), u32(0), enc.encode('H\0')),
    stsd: full('stsd', 0, 0, u32(1), box(handler === 'vide' ? 'avc1' : 'mp4a', new Uint8Array(16))),
    mh: handler === 'vide' ? full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)) : full('smhd', 0, 0, u16(0), u16(0)),
    dinf: box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
  };
}

const videoOnly = () => ({
  width: 16, height: 16, timescale: 90000, avcC: u8(1, 100, 0, 40),
  samples: [
    { data: u8(1, 2, 3), dur: 1500, key: true, cto: 0 },
    { data: u8(4, 5), dur: 1500, key: false, cto: 0 },
  ],
});
const audioTrack = () => ({ timescale: 48000, samples: [{ data: u8(9, 9, 9, 9), dur: 1024 }], asc: u8(0x11, 0x90), channels: 2, sampleRate: 48000 });

// ---- test runner ----
export async function runMp4Tests() {
  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push({ name, ok: true }); console.log('✅', name); }
    catch (e) { results.push({ name, ok: false, error: e.message }); console.error('❌', name, e); }
  };
  const eq = (got, want, what) => { if (got !== want) throw new Error(`${what}: expected ${want}, got ${got}`); };
  const eqArr = (got, want, what) => { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); };
  const throws = async (fn, match) => {
    try { await fn(); } catch (e) {
      if (match && !String(e.message).includes(match)) throw new Error(`wrong error, expected /${match}/: ${e.message}`);
      return;
    }
    throw new Error('expected an error, none was thrown');
  };
  const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
  const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  // -- rewrite: success path --
  await check('rewrite: fragmented video+audio becomes a standard MP4 with correct durations and keyframes', async () => {
    const s = sampleFragmented({ withAudio: true });
    const r = await toStandardMp4(s.blob);
    eq(r.status, 'rewritten', 'status');
    eq(r.hasAudio, true, 'hasAudio');
    const p = parseStandard(await bytesOf(r.blob));
    eqArr(p.order, ['ftyp', 'moov', 'mdat'], 'box order (index first)');
    eq(p.mvhdDuration, Math.max(s.vTrackDur, s.aTrackDur), 'mvhd duration');
    eq(p.tracks.length, 2, 'track count');
    const v = p.tracks.find((t) => t.handler === 'vide');
    eq(v.mediaDuration, s.vMediaDur, 'video mdhd duration');
    eq(v.trackDuration, s.vTrackDur, 'video tkhd duration');
    eqArr(v.sizes, s.vSizes, 'video sample sizes');
    eqArr(v.stts, [[3, s.vDur]], 'video stts');
    eqArr(v.stss, [1], 'video keyframe table');
    const a = p.tracks.find((t) => t.handler === 'soun');
    eq(a.mediaDuration, s.aMediaDur, 'audio mdhd duration');
    eq(a.trackDuration, s.aTrackDur, 'audio tkhd duration');
    eqArr(a.sizes, s.aSizes, 'audio sample sizes');
    if (!sameBytes(p.mdatPayload, cat(s.vData, s.aData))) throw new Error('mdat payload does not match the original samples');
  });

  await check('rewrite: video-only fragmented file (sound was off) becomes a single-track MP4', async () => {
    const s = sampleFragmented({ withAudio: false });
    const r = await toStandardMp4(s.blob);
    eq(r.status, 'rewritten', 'status');
    eq(r.hasAudio, false, 'hasAudio');
    const p = parseStandard(await bytesOf(r.blob));
    eq(p.tracks.length, 1, 'track count');
    eq(p.tracks[0].handler, 'vide', 'only handler');
    eq(p.mvhdDuration, s.vTrackDur, 'mvhd duration');
    if (!sameBytes(p.mdatPayload, s.vData)) throw new Error('mdat payload does not match the video samples');
  });

  // -- rewrite: no rewrite needed --
  await check('already standard: a rewritten file comes back untouched', async () => {
    const s = sampleFragmented({ withAudio: true });
    const first = await toStandardMp4(s.blob);
    const again = await toStandardMp4(first.blob);
    eq(again.status, 'already-standard', 'status');
    eq(again.hasAudio, true, 'hasAudio');
    if (!sameBytes(await bytesOf(again.blob), await bytesOf(first.blob))) throw new Error('file was modified');
  });

  await check('already standard: muxMp4 output comes back untouched', async () => {
    const { blob } = muxMp4(videoOnly(), audioTrack());
    const r = await toStandardMp4(blob);
    eq(r.status, 'already-standard', 'status');
    eq(r.hasAudio, true, 'hasAudio');
    if (!sameBytes(await bytesOf(r.blob), await bytesOf(blob))) throw new Error('file was modified');
  });

  // -- rewrite: corrupt inputs fail loudly --
  await check('corrupt: fragmented file without moov fails clearly', async () => {
    const s = sampleFragmented();
    const { ftyp, moof, mdat } = s.parts;
    await throws(() => toStandardMp4(new Blob([ftyp, moof, mdat])), 'moov');
  });

  await check('corrupt: moov without any track fails clearly', async () => {
    const s = sampleFragmented();
    const { ftyp, mvhd, moof, mdat } = s.parts;
    await throws(() => toStandardMp4(new Blob([ftyp, box('moov', mvhd), moof, mdat])), 'no tracks');
  });

  await check('corrupt: traf without tfhd fails clearly', async () => {
    const s = sampleFragmented();
    const { ftyp, moov, mdat } = s.parts;
    const brokenMoof = box('moof', full('mfhd', 0, 0, u32(1)), box('traf', full('tfdt', 1, 0, u64(0))));
    await throws(() => toStandardMp4(new Blob([ftyp, moov, brokenMoof, mdat])), 'tfhd');
  });

  await check('corrupt: fragment referencing an unknown track fails clearly', async () => {
    const s = sampleFragmented();
    const { ftyp, moov, mdat } = s.parts;
    const alienMoof = box('moof', full('mfhd', 0, 0, u32(1)), s.traf(9, 3000, 0, [4], 0, null));
    await throws(() => toStandardMp4(new Blob([ftyp, moov, alienMoof, mdat])), 'unknown track');
  });

  await check('corrupt: sample data past the end of the file fails clearly', async () => {
    const s = sampleFragmented();
    const { ftyp, moov, mdat } = s.parts;
    const badMoof = s.makeMoof(999999, 999999);
    await throws(() => toStandardMp4(new Blob([ftyp, moov, badMoof, mdat])), 'past the end');
  });

  await check('corrupt: fragments with zero samples fail clearly', async () => {
    const s = sampleFragmented();
    const { ftyp, moov, mdat } = s.parts;
    const emptyMoof = s.makeMoof(0, 0, [], []);
    await throws(() => toStandardMp4(new Blob([ftyp, moov, emptyMoof, mdat])), 'no media samples');
  });

  // -- writers: no audio track --
  await check('muxMp4 without audio writes a playable single-track MP4', async () => {
    const r = muxMp4(videoOnly(), null);
    eq(r.hasAudio, false, 'hasAudio');
    const p = parseStandard(await bytesOf(r.blob));
    eq(p.tracks.length, 1, 'track count');
    eq(p.tracks[0].handler, 'vide', 'only handler');
    eq(p.tracks[0].mediaDuration, 3000, 'video mdhd duration');
    eq(p.mvhdDuration, Math.round((3000 * 1000) / 90000), 'mvhd duration');
    eqArr(p.tracks[0].stss, [1], 'video keyframe table');
  });

  await check('muxMp4 with an empty audio track (AAC unsupported) still writes video only', async () => {
    const r = muxMp4(videoOnly(), { ...audioTrack(), samples: [] });
    eq(r.hasAudio, false, 'hasAudio');
    const p = parseStandard(await bytesOf(r.blob));
    eq(p.tracks.length, 1, 'track count');
    eq(p.tracks[0].handler, 'vide', 'only handler');
  });

  await check('muxMp4 with audio writes both tracks and reports hasAudio', async () => {
    const r = muxMp4(videoOnly(), audioTrack());
    eq(r.hasAudio, true, 'hasAudio');
    const p = parseStandard(await bytesOf(r.blob));
    eq(p.tracks.length, 2, 'track count');
    eq(p.mvhdDuration, Math.round((3000 * 1000) / 90000), 'mvhd duration is the longest track');
  });

  await check('muxRaw drops an empty audio track instead of writing it', async () => {
    const r = muxRaw([
      rawTrack(1, 'vide', 90000, [{ data: u8(1, 2, 3), dur: 1500, key: true, cto: 0 }]),
      rawTrack(2, 'soun', 48000, []),
    ]);
    eq(r.hasAudio, false, 'hasAudio');
    const p = parseStandard(await bytesOf(r.blob));
    eq(p.tracks.length, 1, 'track count');
    eq(p.tracks[0].handler, 'vide', 'only handler');
  });

  await check('muxRaw with only empty tracks throws instead of writing a broken file', async () => {
    await throws(() => Promise.resolve(muxRaw([rawTrack(2, 'soun', 48000, [])])), 'no track');
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} MP4 tests passed`);
  if (failed.length) console.error('Failed:', failed);
  return results;
}
