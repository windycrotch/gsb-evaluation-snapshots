/* Deterministic local audio files for the tests.
 *
 * Flat PCM WAVs are used so each track has one loud, well-separated spectral
 * peak. Tests can then identify which song is actually feeding the analyser
 * instead of trusting the title text.
 */
'use strict';

const SAMPLE_RATE = 48000;
const FFT_SIZE = 256;

function makeWav(frequency, options) {
    const settings = Object.assign({ seconds: 4, sampleRate: SAMPLE_RATE, amplitude: 6000 }, options);
    const frames = Math.floor(settings.seconds * settings.sampleRate);
    const dataBytes = frames * 2;
    const buffer = Buffer.alloc(44 + dataBytes);

    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + dataBytes, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(1, 22); // mono
    buffer.writeUInt32LE(settings.sampleRate, 24);
    buffer.writeUInt32LE(settings.sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataBytes, 40);

    for (let i = 0; i < frames; i += 1) {
        const sample = Math.sin(2 * Math.PI * frequency * i / settings.sampleRate);
        buffer.writeInt16LE(Math.round(sample * settings.amplitude), 44 + i * 2);
    }
    return buffer;
}

// With fftSize 256 at 48 kHz each bin spans 187.5 Hz. These tones sit in
// bins 4, 16, 31 and 48, which keeps the loud bands far apart.
const TRACK_BINS = {
    'alpha-tone.wav': 4,
    'beta-tone.wav': 16,
    'gamma-tone.wav': 31,
    'delta-tone.wav': 48
};

const TRACK_TONES = {};
Object.keys(TRACK_BINS).forEach((name) => {
    TRACK_TONES[name] = TRACK_BINS[name] * SAMPLE_RATE / FFT_SIZE;
});

const TRACKS = {};
Object.keys(TRACK_TONES).forEach((name) => {
    TRACKS[name] = makeWav(TRACK_TONES[name]);
});

/** Human-readable library title the app derives from a file name. */
function trackKey(fileName) {
    return fileName.replace(/\.[^.]+$/, '');
}

module.exports = { makeWav, TRACKS, TRACK_TONES, TRACK_BINS, trackKey, SAMPLE_RATE, FFT_SIZE };
