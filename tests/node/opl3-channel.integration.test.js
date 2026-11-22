/**
 * Integration tests for the atomic channel programming entry against the
 * real rawOPL3 adapter path.
 *
 * Unlike opl3-channel.test.js (which drives the transaction with record-style
 * writers), these tests build a writer with createRawOPL3Writer() around a
 * real AdlMidiCore WASM instance, so every successful commit goes through
 * `AdlMidiCore.rawOPL3() -> _adl_rt_rawOPL3()` and every simulated failure
 * exercises rollback through that same production adapter.
 *
 * The WASM artifacts live in dist/ and are produced by the build pipeline
 * (see .github/workflows/ci.yml); when they are absent, e.g. a fresh checkout
 * without a build, the whole suite skips rather than fails.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
    createRawOPL3Writer,
    programChannel,
} from '../../src/utils/opl3-channel.js';
import { channelMask, encodeChannelVoice } from '../../src/utils/opl3.js';
import { defaultOperator } from '../../src/utils/struct.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_PATH = join(__dirname, '..', '..', 'dist', 'libadlmidi.nuked.core.js');
const wasmAvailable = existsSync(CORE_PATH);

const describeOrSkip = wasmAvailable ? describe : describe.skip;

function makeInstrument() {
    return {
        is4op: false,
        isPseudo4op: false,
        isBlank: false,
        noteOffset1: 0,
        connection1: 0,
        feedback1: 5,
        operators: [
            {
                am: false, vibrato: false, sustaining: false, ksr: false,
                attack: 15, decay: 4, sustain: 2, release: 5,
                totalLevel: 0, keyScaleLevel: 0, freqMult: 1, waveform: 0,
            },
            {
                am: false, vibrato: false, sustaining: false, ksr: false,
                attack: 15, decay: 4, sustain: 2, release: 5,
                totalLevel: 20, keyScaleLevel: 0, freqMult: 2, waveform: 0,
            },
            defaultOperator(),
            defaultOperator(),
        ],
    };
}

describeOrSkip('programChannel via the real rawOPL3 WASM adapter', () => {
    /** @type {import('../../src/core.js').AdlMidiCore} */
    let synth;
    /** @type {RegisterWriter} */
    let writer;

    beforeAll(async () => {
        const { AdlMidiCore } = await import('../../src/core.js');
        synth = await AdlMidiCore.create({ corePath: CORE_PATH });
        synth.init(44100);
        // Keep channels 0 and 1 away from the MIDI voice allocator.
        synth.reserveChipChannels(0, channelMask(0, 1));
        writer = createRawOPL3Writer(synth, 0);
    }, 30000);

    afterAll(() => {
        synth?.reserveChipChannels(0, 0);
        synth?.close();
    });

    it('commits a full channel voice through rawOPL3 and produces audio', async () => {
        const result = await programChannel(writer, {
            instrument: makeInstrument(),
            channel: 0,
            fnum: 512,
            block: 4,
            keyOn: true,
        });

        expect(result.ok).toBe(true);
        expect(result.status).toBe('committed');
        expect(result.appliedWrites.length).toBeGreaterThan(0);
        // Every write really went through the production adapter.
        for (const write of result.appliedWrites) {
            expect(synth.rawOPL3(0, write.reg, write.value)).toBe(true);
        }

        const samples = synth.generate(4096);
        const maxAbs = samples.reduce((max, s) => Math.max(max, Math.abs(s)), 0);
        expect(maxAbs).toBeGreaterThan(0.01);
    });

    it('rejects out-of-range requests without issuing any rawOPL3 write', async () => {
        const calls = [];
        const spy = {
            rawOPL3: (/** @type {number} */ chipId, /** @type {number} */ reg, /** @type {number} */ value) => {
                calls.push({ chipId, reg, value });
                return synth.rawOPL3(chipId, reg, value);
            },
        };
        const spyingWriter = createRawOPL3Writer(spy, 0);

        const result = await programChannel(spyingWriter, {
            instrument: makeInstrument(),
            channel: 18,
        });

        expect(result.status).toBe('rejected');
        expect(result.code).toBe('INVALID_CHANNEL');
        expect(calls).toEqual([]);
    });

    it('rejects fnum/block/register violations before touching the chip', async () => {
        const calls = [];
        const spy = {
            rawOPL3: (/** @type {number} */ chipId, /** @type {number} */ reg, /** @type {number} */ value) => {
                calls.push({ chipId, reg, value });
                return synth.rawOPL3(chipId, reg, value);
            },
        };
        const spyingWriter = createRawOPL3Writer(spy, 0);

        const badFnum = await programChannel(spyingWriter, {
            instrument: makeInstrument(), channel: 0, fnum: 2048, block: 2,
        });
        expect(badFnum.status).toBe('rejected');
        expect(badFnum.code).toBe('INVALID_FNUM');

        const badBlock = await programChannel(spyingWriter, {
            instrument: makeInstrument(), channel: 0, fnum: 100, block: 9,
        });
        expect(badBlock.status).toBe('rejected');
        expect(badBlock.code).toBe('INVALID_BLOCK');

        const badReg = await programChannel(spyingWriter, {
            instrument: makeInstrument(), channel: 0,
            writes: [{ reg: 0x200, value: 1 }],
        });
        expect(badReg.status).toBe('rejected');
        expect(badReg.code).toBe('INVALID_REGISTER');

        expect(calls).toEqual([]);
    });

    it('rolls back through the real adapter when a commit write fails', async () => {
        // Wrap the production adapter with a fault on one register, while
        // every other write still reaches the real chip.
        const targetReg = encodeChannelVoice(makeInstrument(), 1)[2].reg;
        const faulting = {
            rawOPL3: (/** @type {number} */ chipId, /** @type {number} */ reg, /** @type {number} */ value) => {
                if (reg === targetReg) {
                    throw new Error('injected rawOPL3 fault');
                }
                return synth.rawOPL3(chipId, reg, value);
            },
        };
        const faultingWriter = createRawOPL3Writer(faulting, 0);

        const result = await programChannel(faultingWriter, {
            instrument: makeInstrument(),
            channel: 1,
        });

        expect(result.status).toBe('commit_failed');
        expect(result.cause.message).toContain('injected rawOPL3 fault');
        expect(result.rollbackErrors).toEqual([]);
        expect(result.rollbackWrites.length).toBeGreaterThan(0);

        // A follow-up valid transaction on a fresh production writer still
        // works, proving the chip is usable again after rollback.
        const recoveryWriter = createRawOPL3Writer(synth, 0);
        const retry = await programChannel(recoveryWriter, {
            instrument: makeInstrument(),
            channel: 1,
        });
        expect(retry.ok).toBe(true);
    });

    it('reports rollback_failed when the adapter also fails during rollback', async () => {
        // Fail the third commit write; once a commit has failed, keep failing
        // so every rollback restore fails too.
        let commitFailures = 0;
        let successfulCalls = 0;
        const faulting = {
            rawOPL3: (/** @type {number} */ chipId, /** @type {number} */ reg, /** @type {number} */ value) => {
                if (commitFailures > 0) {
                    throw new Error('adapter bus fault');
                }
                const ok = synth.rawOPL3(chipId, reg, value);
                if (!ok) {
                    throw new Error('unexpected adapter rejection');
                }
                successfulCalls++;
                if (successfulCalls === 3) {
                    commitFailures++;
                    throw new Error('injected commit fault');
                }
                return ok;
            },
        };
        const faultingWriter = createRawOPL3Writer(faulting, 0);

        const result = await programChannel(faultingWriter, {
            instrument: makeInstrument(),
            channel: 1,
        });

        expect(result.status).toBe('rollback_failed');
        expect(result.code).toBe('ROLLBACK_FAILED');
        expect(result.cause.message).toContain('injected commit fault');
        expect(result.rollbackErrors.length).toBeGreaterThan(0);
        for (const item of result.rollbackErrors) {
            expect(item.error).toContain('adapter bus fault');
        }
    });

    it('programs two channels with complete, non-overlapping register sets', async () => {
        const [r0, r1] = await Promise.all([
            programChannel(writer, { instrument: makeInstrument(), channel: 0 }),
            programChannel(writer, { instrument: makeInstrument(), channel: 1 }),
        ]);

        expect(r0.ok).toBe(true);
        expect(r1.ok).toBe(true);
        const regs0 = new Set(r0.appliedWrites.map(w => w.reg));
        for (const reg of r1.appliedWrites.map(w => w.reg)) {
            expect(regs0.has(reg)).toBe(false);
        }
    });

    it('is idempotent when replaying the same request', async () => {
        const request = {
            instrument: makeInstrument(),
            channel: 0,
            fnum: 512,
            block: 4,
            keyOn: true,
        };

        const first = await programChannel(writer, request);
        expect(first.ok).toBe(true);

        const second = await programChannel(writer, request);
        expect(second.ok).toBe(true);
        expect(second.idempotent).toBe(true);
        expect(second.appliedWrites).toEqual([]);
    });
});
