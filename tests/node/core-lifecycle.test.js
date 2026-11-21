/**
 * Lifecycle tests for AdlMidiCore
 *
 * These tests exercise the init/close/generate/play lifecycle contract
 * against a mock Emscripten module, so they run without the compiled
 * WASM artifacts in dist/. The mock simulates the WASM heap, player
 * pointers, and sample generation (including short writes at end of
 * track and malloc failures) deterministically.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let AdlMidiCore;
beforeAll(async () => {
    ({ AdlMidiCore } = await import('../../src/core.js'));
});

/**
 * Build a minimal but structurally valid Standard MIDI File (format 0):
 * one track, one note-on, one note-off, end-of-track.
 */
function buildMinimalMidi() {
    const header = [
        0x4d, 0x54, 0x68, 0x64, // "MThd"
        0x00, 0x00, 0x00, 0x06, // header length
        0x00, 0x00,             // format 0
        0x00, 0x01,             // 1 track
        0x00, 0x60,             // 96 ticks per quarter
    ];
    const trackEvents = [
        0x00, 0x90, 0x3c, 0x40, // delta 0, note on, C4, vel 64
        0x83, 0x60, 0x80, 0x3c, 0x40, // delta 480, note off, C4
        0x00, 0xff, 0x2f, 0x00, // delta 0, end of track
    ];
    const trackHeader = [
        0x4d, 0x54, 0x72, 0x6b, // "MTrk"
        0x00, 0x00, 0x00, trackEvents.length,
    ];
    return new Uint8Array([...header, ...trackHeader, ...trackEvents]);
}

/**
 * Create a mock Emscripten module implementing just the surface
 * AdlMidiCore touches during lifecycle operations.
 */
function createMockModule(options = {}) {
    const heap = new ArrayBuffer(options.heapSize ?? 16 * 1024 * 1024);
    const HEAPU8 = new Uint8Array(heap);
    const HEAP16 = new Int16Array(heap);

    let nextAlloc = 8; // bump allocator, 4-byte aligned
    let nextPlayerPtr = 0x10000;
    const players = new Map();
    const freed = [];

    const module = {
        HEAPU8,
        HEAP16,

        // Test hooks
        _freed: freed,
        _players: players,
        failNextMalloc: false,
        mallocCalls: 0,

        _malloc(size) {
            module.mallocCalls++;
            if (module.failNextMalloc) {
                module.failNextMalloc = false;
                return 0; // Emscripten signals allocation failure with 0
            }
            const ptr = nextAlloc;
            nextAlloc = (nextAlloc + size + 3) & ~3;
            if (nextAlloc > heap.byteLength) {
                throw new Error('mock heap exhausted');
            }
            return ptr;
        },

        _free(ptr) {
            freed.push(ptr);
        },

        _adl_init(sampleRate) {
            const ptr = nextPlayerPtr;
            nextPlayerPtr += 0x1000;
            players.set(ptr, {
                ptr,
                sampleRate,
                closed: false,
                midiLoaded: false,
                positionSamples: 0,
                totalSamples: 0,
                genSeq: 0,
            });
            return ptr;
        },

        _adl_close(ptr) {
            const player = players.get(ptr);
            if (player) {
                player.closed = true;
            }
        },

        _adl_switchEmulator() {},

        _adl_openData(playerPtr, dataPtr, size) {
            const player = players.get(playerPtr);
            if (!player || player.closed || size <= 0) {
                return -1;
            }
            player.midiLoaded = true;
            player.positionSamples = 0;
            // Pretend the loaded song is exactly 1 second of stereo audio
            player.totalSamples = player.sampleRate * 2;
            return 0;
        },

        // Fills `count` Int16 samples with a per-call sequence value so
        // tests can tell which call produced the data they observe.
        _adl_generate(playerPtr, count, outPtr) {
            const player = players.get(playerPtr);
            if (!player || player.closed) {
                return -1;
            }
            const seq = ++player.genSeq;
            const offset = outPtr >> 1;
            for (let i = 0; i < count; i++) {
                HEAP16[offset + i] = seq * 100;
            }
            return count;
        },

        // Like _adl_generate but stops short at end of track, leaving the
        // remainder of the output buffer untouched (as the real library
        // does), and returns the number of samples actually written.
        _adl_play(playerPtr, count, outPtr) {
            const player = players.get(playerPtr);
            if (!player || player.closed) {
                return -1;
            }
            const remaining = Math.max(0, player.totalSamples - player.positionSamples);
            const written = Math.min(count, remaining);
            const seq = ++player.genSeq;
            const offset = outPtr >> 1;
            for (let i = 0; i < written; i++) {
                HEAP16[offset + i] = seq * 100;
            }
            player.positionSamples += written;
            return written;
        },

        _adl_positionTell(playerPtr) {
            const player = players.get(playerPtr);
            return player ? player.positionSamples / 2 / player.sampleRate : -1;
        },

        _adl_totalTimeLength(playerPtr) {
            const player = players.get(playerPtr);
            return player ? player.totalSamples / 2 / player.sampleRate : -1;
        },

        _adl_atEnd(playerPtr) {
            const player = players.get(playerPtr);
            return player && player.midiLoaded && player.positionSamples >= player.totalSamples ? 1 : 0;
        },

        _adl_positionRewind(playerPtr) {
            const player = players.get(playerPtr);
            if (player) {
                player.positionSamples = 0;
            }
        },
    };

    return module;
}

/** Create an AdlMidiCore backed by a fresh mock module. */
function createMockCore(moduleOptions) {
    const core = new AdlMidiCore();
    core._module = createMockModule(moduleOptions);
    return core;
}

const expectedValue = (seq) => (seq * 100) / 32768;

describe('AdlMidiCore lifecycle (mock module)', () => {
    describe('close() / init() cycle', () => {
        it('init() after close() yields a working player with the new sample rate', () => {
            const synth = createMockCore();
            synth.init(44100);
            synth.generate(256);
            synth.close();

            synth.init(48000);
            expect(synth.sampleRate).toBe(48000);
            expect(synth.player).not.toBeNull();

            const out = synth.generate(512);
            expect(out).toBeInstanceOf(Float32Array);
            expect(out.length).toBe(512 * 2);
            synth.close();
        });

        it('close() is idempotent and safe before init()', () => {
            const synth = createMockCore();
            expect(() => synth.close()).not.toThrow();
            synth.init(44100);
            synth.close();
            expect(() => {
                synth.close();
                synth.close();
            }).not.toThrow();
        });

        it('synthesis calls after close() throw "not initialized" instead of touching freed state', () => {
            const synth = createMockCore();
            synth.init(44100);
            synth.close();

            expect(() => synth.generate(128)).toThrow(/not initialized/);
            expect(() => synth.play(128)).toThrow(/not initialized/);
            expect(() => synth.noteOn(0, 60, 100)).toThrow(/not initialized/);
            expect(() => synth.position).toThrow(/not initialized/);
            expect(() => synth.atEnd).toThrow(/not initialized/);
        });

        it('repeated init() closes the previous player instead of leaking it', () => {
            const synth = createMockCore();
            synth.init(44100);
            const firstPlayer = synth.player;
            synth.init(22050);
            const secondPlayer = synth.player;

            expect(secondPlayer).not.toBe(firstPlayer);
            expect(synth._module._players.get(firstPlayer).closed).toBe(true);
            expect(synth._module._players.get(secondPlayer).closed).toBe(false);
            expect(synth.sampleRate).toBe(22050);
            synth.close();
        });

        it('failed init() leaves the instance uninitialized and retryable', () => {
            const synth = createMockCore();
            synth._module._adl_init = () => 0; // simulate init failure

            expect(() => synth.init(44100)).toThrow(/Failed to initialize/);
            expect(synth.player).toBeNull();
            expect(() => synth.generate(64)).toThrow(/not initialized/);
            synth.close();
        });
    });

    describe('generate()/play() shared buffer', () => {
        it('returns frames*2 samples from the current call when frame counts alternate', () => {
            const synth = createMockCore();
            synth.init(44100);

            const a = synth.generate(256);
            expect(a.length).toBe(512);
            expect(a[0]).toBeCloseTo(expectedValue(1), 6);
            expect(a[511]).toBeCloseTo(expectedValue(1), 6);

            // Grow the buffer
            const b = synth.generate(1024);
            expect(b.length).toBe(2048);
            expect(b[0]).toBeCloseTo(expectedValue(2), 6);
            expect(b[2047]).toBeCloseTo(expectedValue(2), 6);

            // Shrink again: length must follow this call, content must be
            // from this call, not residue of the previous larger one.
            const c = synth.generate(128);
            expect(c.length).toBe(256);
            for (let i = 0; i < c.length; i++) {
                expect(c[i]).toBeCloseTo(expectedValue(3), 6);
            }
            synth.close();
        });

        it('generate() and play() share the buffer without leaking stale content', () => {
            const synth = createMockCore();
            synth.init(44100);
            synth.loadMidi(buildMinimalMidi());

            const g = synth.generate(512); // seq 1
            expect(g.length).toBe(1024);

            const p = synth.play(1024); // seq 2, grows buffer
            expect(p.length).toBe(2048);
            for (let i = 0; i < p.length; i++) {
                expect(p[i]).toBeCloseTo(expectedValue(2), 6);
            }

            const g2 = synth.generate(64); // seq 3, reuses larger buffer
            expect(g2.length).toBe(128);
            for (let i = 0; i < g2.length; i++) {
                expect(g2[i]).toBeCloseTo(expectedValue(3), 6);
            }
            synth.close();
        });

        it('zero-fills the unwritten tail when play() stops at end of track', () => {
            const synth = createMockCore();
            synth.init(44100);
            synth.loadMidi(buildMinimalMidi());

            // First call fills the whole buffer with a recognizable value.
            const full = synth.play(4096); // seq 1
            expect(full.every((v) => Math.abs(v - expectedValue(1)) < 1e-6)).toBe(true);

            // Second call runs past the end of the 1-second mock song:
            // 44100*2 - 8192 = 80018 samples remain of the 8192*2 requested...
            // Play most of the song first to force a short write.
            synth._module._players.get(synth.player).positionSamples =
                synth._module._players.get(synth.player).totalSamples - 100;

            const tail = synth.play(4096); // seq 2, only 100 samples written
            expect(tail.length).toBe(8192);
            for (let i = 0; i < 100; i++) {
                expect(tail[i]).toBeCloseTo(expectedValue(2), 6);
            }
            // The rest must be silence, not leftover seq-1 data.
            for (let i = 100; i < tail.length; i++) {
                expect(tail[i]).toBe(0);
            }
            expect(synth.atEnd).toBe(true);
            synth.close();
        });

        it('recovers to a retryable state when buffer growth allocation fails', () => {
            const synth = createMockCore();
            synth.init(44100);

            synth.generate(256); // allocates a small buffer
            const oldPtr = synth._audioBufferPtr;
            const freesBefore = synth._module._freed.length;

            // Fail the next allocation (the growth realloc).
            synth._module.failNextMalloc = true;
            expect(() => synth.generate(4096)).toThrow(/allocate/);

            // Old buffer was freed exactly once (no double free), and no
            // dangling pointer or stale array survives.
            expect(synth._module._freed.length).toBe(freesBefore + 1);
            expect(synth._module._freed.at(-1)).toBe(oldPtr);
            expect(synth._audioBufferPtr).toBeNull();
            expect(synth._audioBuffer).toBeNull();

            // The player is still usable and the next call reallocates.
            const out = synth.generate(4096);
            expect(out.length).toBe(8192);
            expect(out[0]).toBeCloseTo(expectedValue(2), 6);
            synth.close();
        });

        it('close() releases the buffer and clears pointer and array', () => {
            const synth = createMockCore();
            synth.init(44100);
            synth.generate(512);

            const ptr = synth._audioBufferPtr;
            expect(ptr).not.toBeNull();
            expect(synth._audioBuffer).not.toBeNull();

            synth.close();
            expect(synth._audioBufferPtr).toBeNull();
            expect(synth._audioBuffer).toBeNull();
            expect(synth._module._freed).toContain(ptr);
        });
    });

    describe('close()/init() interleaving after loadMidi()', () => {
        it('final state reflects the last init(); queries never read the old player', () => {
            const synth = createMockCore();
            synth.init(44100);
            expect(synth.loadMidi(buildMinimalMidi())).toBe(true);

            synth.play(44100); // advance to 0.5s on the first player
            synth.play(44100); // advance to 1.0s: first player is now at end
            const firstPlayer = synth.player;
            expect(synth.position).toBeGreaterThan(0);
            expect(synth.atEnd).toBe(true);

            // Same event-loop tick: close then re-init at a new rate.
            synth.close();
            synth.init(48000);
            const secondPlayer = synth.player;

            expect(secondPlayer).not.toBe(firstPlayer);
            expect(synth._module._players.get(firstPlayer).closed).toBe(true);

            // Queries must hit the fresh player: no MIDI loaded, position 0.
            expect(synth.position).toBe(0);
            expect(synth.atEnd).toBe(false);
            expect(synth.duration).toBe(0);
            expect(synth.sampleRate).toBe(48000);

            // And the new player is fully functional.
            expect(synth.loadMidi(buildMinimalMidi())).toBe(true);
            expect(synth.duration).toBe(1);
            const out = synth.play(480);
            expect(out.length).toBe(960);
            expect(synth.position).toBeGreaterThan(0);
            synth.close();
        });

        it('close() then init() then close() in one batch ends closed', () => {
            const synth = createMockCore();
            synth.init(44100);
            synth.loadMidi(buildMinimalMidi());

            synth.close();
            synth.init(44100);
            synth.close();

            expect(synth.player).toBeNull();
            expect(() => synth.position).toThrow(/not initialized/);
            expect(() => synth.atEnd).toThrow(/not initialized/);
        });
    });

    describe('real WASM profile (skipped without dist build)', () => {
        const DIST_CORE = join(__dirname, '..', '..', 'dist', 'libadlmidi.nuked.core.js');
        let wasmAvailable = true;
        try {
            readFileSync(DIST_CORE);
        } catch {
            wasmAvailable = false;
        }

        const itWasm = wasmAvailable ? it : it.skip;

        itWasm('close/init cycle works against the real WASM build', async () => {
            const synth = await AdlMidiCore.create({ corePath: DIST_CORE });
            synth.init(44100);
            synth.loadMidi(buildMinimalMidi());
            synth.play(1024);
            synth.close();
            synth.close(); // idempotent

            synth.init(48000);
            expect(synth.sampleRate).toBe(48000);
            const out = synth.generate(512);
            expect(out).toBeInstanceOf(Float32Array);
            expect(out.length).toBe(1024);
            synth.close();
        });
    });
});
