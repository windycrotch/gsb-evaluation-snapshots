/* A small synthetic catalog for the restore tests: no real audio assets. Each song
   declares the stem types the three layers can pick, a code, key and BPM. fetch() is
   stubbed to serve stems.json from this and decodeAudioData to hand back silent
   AudioBuffers, so the whole download -> decode -> stretch -> graph path runs locally. */

const stem = (song, type, ext) => `stems-${ext}/${song}/${type}.${ext}`;

function makeSong(code, album, key, bpm, types) {
  const stems = Object.fromEntries(types.map((t) => [t, `Stems/${code}/${t}.wav`]));
  return {
    code, album, key, bpm, stems,
    oggs: Object.fromEntries(types.map((t) => [t, stem(code, t, 'ogg')])),
    flacs: Object.fromEntries(types.map((t) => [t, stem(code, t, 'flac')])),
    lufs: Object.fromEntries(types.map((t) => [t, t === 'texture' ? -14.6 : -12.6])),
  };
}

export const MANIFEST = {
  'Alpha Song': makeSong('T1', 'ram', 'Em', 120, ['groove', 'lead', 'texture']),
  'Beta Song': makeSong('T2', 'ram', 'Gm', 124, ['groove', 'lead', 'texture']),
  // A different album, so the restored "first layer" changes the album strip too.
  'Gamma Song': makeSong('T3', 'discovery', 'Am', 128, ['groove', 'lead', 'texture']),
};

// fetch() is only ever used for stems.json and stem bytes here; stem bytes resolve to a
// tiny ArrayBuffer that the fake decoder turns into an AudioBuffer.
export function installFetch() {
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.endsWith('stems.json')) {
      return { ok: true, status: 200, json: async () => MANIFEST, headers: { get: () => null } };
    }
    return {
      ok: true, status: 200, headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(64),
      body: null,
    };
  };
}

// decodeAudioData: promise form, returns a silent 1-second stereo buffer at the stem
// rate, with no frames/marks metadata so exactDecode passes trivially.
export function installDecoder(AudioBufferCtor) {
  globalThis.AudioContext.prototype.decodeAudioData = function (bytes, ok) {
    const buf = new AudioBufferCtor({ numberOfChannels: 2, length: 44100, sampleRate: 44100 });
    if (ok) { ok(buf); return Promise.resolve(buf); }
    return Promise.resolve(buf);
  };
}
