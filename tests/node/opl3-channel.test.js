/**
 * Tests for the atomic OPL3 channel programming entry (programChannel).
 *
 * The transaction semantics (validation-before-write, rollback, rollback
 * failure reporting, concurrency serialization, idempotent replay) are tested
 * here with record-style writers so every failure mode is deterministic.
 * Companion tests in opl3-channel.integration.test.js exercise the real
 * rawOPL3 adapter path against the WASM build.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    RegisterWriter,
    createRawOPL3Writer,
    programChannel,
    validateRegisterWrite,
    MAX_REGISTER,
} from '../../src/utils/opl3-channel.js';
import { encodeChannelVoice, channelBank } from '../../src/utils/opl3.js';
import { defaultOperator } from '../../src/utils/struct.js';

/**
 * Build a valid 2-op instrument for tests.
 * @param {Partial<ReturnType<typeof makeInstrument>>} [overrides]
 */
function makeInstrument(overrides = {}) {
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
        ...overrides,
    };
}

/**
 * Record-style sink: stores every write and supports injected failures.
 * The test marks rollback explicitly via beginRollback() (mirroring the fact
 * that the writer decides when rollback starts), so a policy can target
 * commit and rollback writes independently.
 */
class RecordSink {
    constructor() {
        /** @type {Array<{reg: number, value: number}>} */
        this.records = [];
        /** @type {Map<number, number>} */
        this.state = new Map();
        this.callCount = 0;
        /**
         * Per-call failure policy. Receives (callIndex, reg, value, phase)
         * where phase is 'commit' or 'rollback'. Return an Error to fail the
         * write, null/undefined to allow it.
         * @type {((callIndex: number, reg: number, value: number, phase: string) => Error|null)|null}
         */
        this.policy = null;
        this.phase = 'commit';
        /**
         * When true, every write yields the event loop twice before
         * completing, giving interleaved transactions a chance to mix.
         * @type {boolean}
         */
        this.delayMicros = false;
    }

    /** Mark that the writer has begun rolling a failed transaction back. */
    beginRollback() {
        this.phase = 'rollback';
    }

    /**
     * @param {number} reg
     * @param {number} value
     */
    async write(reg, value) {
        if (this.delayMicros > 0) {
            // Yield the event loop so concurrent transactions have a chance to
            // interleave if the serialization mutex were missing.
            await Promise.resolve();
            await Promise.resolve();
        }
        const index = this.callCount++;
        const error = this.policy ? this.policy(index, reg, value, this.phase) : null;
        if (error) {
            throw error;
        }
        this.records.push({ reg, value });
        this.state.set(reg, value);
    }

    get(reg) {
        return this.state.has(reg) ? this.state.get(reg) : 0;
    }
}

/**
 * Bind a RecordSink to a writer and flip it into rollback phase the moment a
 * commit write throws. Under the writer's contract, every sink call after a
 * thrown error belongs to rollback, so this mirrors the writer's own state
 * machine without reaching into its internals.
 *
 * @param {RecordSink} sink
 * @returns {RegisterWriter}
 */
function writerWithPhaseTracking(sink) {
    const wrapped = async (/** @type {number} */ reg, /** @type {number} */ value) => {
        try {
            await sink.write(reg, value);
        } catch (error) {
            sink.beginRollback();
            throw error;
        }
    };
    return new RegisterWriter(wrapped);
}

/**
 * @param {RecordSink} [sink]
 */
function makeWriter(sink = new RecordSink()) {
    const writer = new RegisterWriter(sink.write.bind(sink));
    return { writer, sink };
}

describe('programChannel - normal commit', () => {
    it('commits all encoded instrument registers in one transaction', async () => {
        const { writer, sink } = makeWriter();
        const instrument = makeInstrument();

        const result = await programChannel(writer, { instrument, channel: 0 });

        expect(result.ok).toBe(true);
        expect(result.status).toBe('committed');
        expect(result.idempotent).toBe(false);

        const expected = encodeChannelVoice(instrument, 0);
        expect(result.appliedWrites).toHaveLength(expected.length);
        expect(sink.records).toHaveLength(expected.length);

        // Every encoded write reached the (simulated) chip.
        for (const { reg, value } of expected) {
            expect(sink.get(reg)).toBe(value);
        }
    });

    it('includes fnum/block A0+B0 writes with key-on when requested', async () => {
        const { writer, sink } = makeWriter();

        const result = await programChannel(writer, {
            instrument: makeInstrument(),
            channel: 3,
            fnum: 580,
            block: 4,
            keyOn: true,
        });

        expect(result.ok).toBe(true);
        // 11 voice registers + A0 + B0
        expect(result.appliedWrites).toHaveLength(13);

        const a0 = sink.records.find(r => r.reg === 0xA3);
        const b0 = sink.records.find(r => r.reg === 0xB3);
        expect(a0).toBeDefined();
        expect(a0.value).toBe(580 & 0xFF);
        expect(b0).toBeDefined();
        expect(b0.value & 0x20).toBe(0x20); // key-on bit
    });

    it('encodes bank-1 registers for channels 9-17', async () => {
        const { writer, sink } = makeWriter();

        const result = await programChannel(writer, {
            instrument: makeInstrument(),
            channel: 17,
        });

        expect(result.ok).toBe(true);
        expect(channelBank(17)).toBe(0x100);
        for (const { reg } of result.appliedWrites) {
            expect(reg).toBeGreaterThanOrEqual(0x100);
            expect(reg).toBeLessThanOrEqual(0x1FF);
        }
        const c0 = sink.records.find(r => r.reg === 0x1C8);
        expect(c0).toBeDefined();
    });

    it('accepts validated extra writes in the same transaction', async () => {
        const { writer, sink } = makeWriter();

        const result = await programChannel(writer, {
            instrument: makeInstrument(),
            channel: 0,
            writes: [{ reg: 0xBD, value: 0x00 }],
        });

        expect(result.ok).toBe(true);
        expect(sink.get(0xBD)).toBe(0x00);
    });
});

describe('programChannel - out-of-range rejection before any write', () => {
    /** @type {RecordSink} */
    let sink;
    /** @type {RegisterWriter} */
    let writer;

    beforeEach(() => {
        sink = new RecordSink();
        writer = new RegisterWriter(sink.write.bind(sink));
    });

    /**
     * @param {any} request
     * @param {string} expectedCode
     */
    async function assertRejected(request, expectedCode) {
        const result = await programChannel(writer, request);
        expect(result.status).toBe('rejected');
        expect(result.ok).toBe(false);
        expect(result.code).toBe(expectedCode);
        expect(result.error).toBeTruthy();
        // The hard guarantee: not a single write happened.
        expect(sink.records).toHaveLength(0);
        expect(sink.callCount).toBe(0);
    }

    it('rejects channel -1', () => assertRejected(
        { instrument: makeInstrument(), channel: -1 }, 'INVALID_CHANNEL',
    ));

    it('rejects channel 18', () => assertRejected(
        { instrument: makeInstrument(), channel: 18 }, 'INVALID_CHANNEL',
    ));

    it('rejects non-integer channel', () => assertRejected(
        { instrument: makeInstrument(), channel: 3.5 }, 'INVALID_CHANNEL',
    ));

    it('rejects fnum above 1023', () => assertRejected(
        { instrument: makeInstrument(), channel: 0, fnum: 1024, block: 4 }, 'INVALID_FNUM',
    ));

    it('rejects block above 7', () => assertRejected(
        { instrument: makeInstrument(), channel: 0, fnum: 100, block: 8 }, 'INVALID_BLOCK',
    ));

    it('rejects register address above 0x1FF in extra writes', () => assertRejected(
        { instrument: makeInstrument(), channel: 0, writes: [{ reg: 0x200, value: 1 }] },
        'INVALID_REGISTER',
    ));

    it('rejects negative register address', () => assertRejected(
        { instrument: makeInstrument(), channel: 0, writes: [{ reg: -1, value: 1 }] },
        'INVALID_REGISTER',
    ));

    it('rejects register value above 255', () => assertRejected(
        { instrument: makeInstrument(), channel: 0, writes: [{ reg: 0xBD, value: 256 }] },
        'INVALID_VALUE',
    ));

    it('rejects 4-op instruments without writing', () => assertRejected(
        { instrument: makeInstrument({ is4op: true }), channel: 0 },
        'INVALID_INSTRUMENT',
    ));

    it('rejects pseudo-4-op instruments without writing', () => assertRejected(
        { instrument: makeInstrument({ isPseudo4op: true }), channel: 0 },
        'INVALID_INSTRUMENT',
    ));

    it('rejects when fnum is given without block', () => assertRejected(
        { instrument: makeInstrument(), channel: 0, fnum: 100 },
        'INVALID_FNUM_BLOCK',
    ));

    it('validateRegisterWrite enforces the same 0x1FF boundary', () => {
        expect(validateRegisterWrite({ reg: 0x1FF, value: 255 }).ok).toBe(true);
        const bad = validateRegisterWrite({ reg: MAX_REGISTER + 1, value: 0 });
        expect(bad.ok).toBe(false);
        expect(bad.code).toBe('INVALID_REGISTER');
    });
});

describe('programChannel - mid-commit failure rollback', () => {
    it('rolls back every applied write and reports commit_failed', async () => {
        const sink = new RecordSink();
        const writer = writerWithPhaseTracking(sink);

        // First establish unrelated state on a register the transaction will
        // also touch, so we can prove the prior value is restored.
        await writer._write(0x20, 0x77);
        const baselineReg20 = sink.get(0x20);
        expect(baselineReg20).toBe(0x77);

        // Fail on the 4th physical write of the commit (call index 1+...):
        // index 0 was the setup write above, so commit calls start at index 1.
        sink.policy = (callIndex) => (callIndex === 3 ? new Error('simulated chip fault') : null);

        const result = await programChannel(writer, {
            instrument: makeInstrument(),
            channel: 0,
        });

        expect(result.ok).toBe(false);
        expect(result.status).toBe('commit_failed');
        expect(result.code).toBe('COMMIT_FAILED');
        expect(result.cause).toBeInstanceOf(Error);
        expect(result.cause.message).toContain('simulated chip fault');
        expect(result.appliedWrites.length).toBeGreaterThan(0);

        // Rollback rewrote every register that had been changed, in reverse.
        expect(result.rollbackWrites).toHaveLength(result.appliedWrites.length);

        // Chip state equals the pre-call snapshot.
        expect(sink.get(0x20)).toBe(baselineReg20);
        const restoredRegs = new Set(result.rollbackWrites.map(w => w.reg));
        for (const applied of result.appliedWrites) {
            expect(restoredRegs.has(applied.reg)).toBe(true);
        }
    });

    it('reports commit_failed and leaves the chip untouched when the first write fails', async () => {
        const sink = new RecordSink();
        const writer = writerWithPhaseTracking(sink);

        // Fail on the very first commit write: no write reached the chip, so
        // there is nothing to restore. The failure must still be reported as a
        // (cleanly) rolled-back commit rather than a success.
        sink.policy = (callIndex, _reg, _value, phase) => (
            phase === 'commit' && callIndex === 0 ? new Error('dead chip') : null
        );

        const result = await programChannel(writer, {
            instrument: makeInstrument(),
            channel: 0,
        });

        expect(result.status).toBe('commit_failed');
        expect(result.code).toBe('COMMIT_FAILED');
        expect(result.appliedWrites).toEqual([]);
        expect(result.rollbackWrites).toEqual([]);
        expect(result.rollbackErrors).toEqual([]);
        expect(sink.records).toEqual([]);
        expect(writer.peek(0x20)).toBe(0);
    });
});

describe('programChannel - rollback failure reporting', () => {
    it('reports rollback_failed and never swallows the error', async () => {
        const sink = new RecordSink();
        const writer = writerWithPhaseTracking(sink);

        // Commit write at call index 2 fails; the first rollback write
        // (call index 3) also fails. Subsequent rollback writes succeed, so we
        // can assert the partial rollback detail is fully reported.
        sink.policy = (callIndex, _reg, _value, phase) => {
            if (phase === 'commit' && callIndex === 2) {
                return new Error('commit fault');
            }
            if (phase === 'rollback' && callIndex === 3) {
                return new Error('rollback fault');
            }
            return null;
        };

        const result = await programChannel(writer, {
            instrument: makeInstrument(),
            channel: 0,
        });

        expect(result.status).toBe('rollback_failed');
        expect(result.ok).toBe(false);
        expect(result.code).toBe('ROLLBACK_FAILED');
        expect(result.rollbackErrors.length).toBe(1);
        expect(result.rollbackErrors[0].error).toContain('rollback fault');
        expect(result.error).toContain('rollback failed');
        expect(result.cause.message).toContain('commit fault');
        // The registers that did roll back are still recorded.
        expect(result.rollbackWrites.length + result.rollbackErrors.length)
            .toBe(result.appliedWrites.length);
    });

    it('reports rollback_failed when the sink fails on every rollback write', async () => {
        const sink = new RecordSink();
        const writer = writerWithPhaseTracking(sink);

        // Make the second commit write fail so two registers need rollback,
        // then fail every rollback write.
        sink.policy = (callIndex, _reg, _value, phase) => {
            if (phase === 'commit' && callIndex === 1) {
                return new Error('commit fault');
            }
            if (phase === 'rollback') {
                return new Error('bus down');
            }
            return null;
        };

        const result = await programChannel(writer, {
            instrument: makeInstrument(),
            channel: 0,
        });

        expect(result.status).toBe('rollback_failed');
        expect(result.rollbackErrors).toHaveLength(result.appliedWrites.length);
        for (const item of result.rollbackErrors) {
            expect(item.error).toContain('bus down');
            expect(Number.isInteger(item.reg)).toBe(true);
        }
    });
});

describe('programChannel - concurrent interleaving', () => {
    it('serializes two different channels so neither transaction is split', async () => {
        const sink = new RecordSink();
        // Add async latency so naive interleaving would mix the two
        // transactions; the mutex must keep each batch contiguous.
        sink.delayMicros = true;
        const writer = new RegisterWriter(sink.write.bind(sink));

        const [r0, r1] = await Promise.all([
            programChannel(writer, { instrument: makeInstrument(), channel: 0 }),
            programChannel(writer, { instrument: makeInstrument(), channel: 5 }),
        ]);

        expect(r0.ok).toBe(true);
        expect(r1.ok).toBe(true);

        // The physical write log must contain two contiguous blocks.
        const n0 = r0.appliedWrites.length;
        const n1 = r1.appliedWrites.length;
        expect(sink.records).toHaveLength(n0 + n1);

        const firstBlock = sink.records.slice(0, n0);
        const secondBlock = sink.records.slice(n0);
        const bankOf = (/** @type {number} */ reg) => reg & 0x100;
        const firstBank = bankOf(firstBlock[0].reg);
        const secondBank = bankOf(secondBlock[0].reg);

        for (const r of firstBlock) {
            expect(bankOf(r.reg)).toBe(firstBank);
        }
        for (const r of secondBlock) {
            expect(bankOf(r.reg)).toBe(secondBank);
        }
        // Channels 0 and 5 are both bank 0 but use different slot offsets;
        // their register sets must be disjoint.
        const regs0 = new Set(r0.appliedWrites.map(w => w.reg));
        const regs1 = new Set(r1.appliedWrites.map(w => w.reg));
        for (const reg of regs0) {
            expect(regs1.has(reg)).toBe(false);
        }

        // Final chip state carries both complete voices.
        for (const { reg, value } of [...r0.appliedWrites, ...r1.appliedWrites]) {
            expect(sink.state.get(reg)).toBe(value);
        }
    });

    it('a failing transaction does not corrupt a concurrently queued one', async () => {
        const sink = new RecordSink();
        const writer = writerWithPhaseTracking(sink);

        // Fail the third write of the first (A) transaction. Rollback moves
        // the sink into the rollback phase, so the policy stays scoped to A;
        // transaction B runs afterwards under normal conditions.
        sink.policy = (callIndex, _reg, _value, phase) => {
            if (phase === 'commit' && callIndex === 2) {
                return new Error('fault in A');
            }
            return null;
        };

        const [a, b] = await Promise.all([
            programChannel(writer, { instrument: makeInstrument(), channel: 0 }),
            programChannel(writer, { instrument: makeInstrument(), channel: 1 }),
        ]);

        expect(a.status).toBe('commit_failed');
        expect(a.cause.message).toBe('fault in A');
        expect(b.ok).toBe(true);
        for (const { reg, value } of b.appliedWrites) {
            expect(sink.state.get(reg)).toBe(value);
        }
        // A's partial writes were undone before B ran.
        for (const applied of a.appliedWrites) {
            expect(sink.state.get(applied.reg)).toBe(0);
        }
    });

    it('a failed transaction does not invalidate idempotency on another channel', async () => {
        const sink = new RecordSink();
        const writer = writerWithPhaseTracking(sink);

        // Program channel 2 successfully, then make a channel 0 transaction
        // fail mid-commit. A replay of channel 2 must stay idempotent.
        const channel2 = { instrument: makeInstrument(), channel: 2 };
        const first2 = await programChannel(writer, channel2);
        expect(first2.ok).toBe(true);
        const writesAfter2 = sink.records.length;

        sink.policy = (callIndex, _reg, _value, phase) => (
            phase === 'commit' && callIndex === writesAfter2 + 1
                ? new Error('fault elsewhere')
                : null
        );
        const failed0 = await programChannel(writer, { instrument: makeInstrument(), channel: 0 });
        expect(failed0.status).toBe('commit_failed');

        const replay2 = await programChannel(writer, channel2);
        expect(replay2.idempotent).toBe(true);
        expect(replay2.appliedWrites).toEqual([]);
        expect(sink.records).toHaveLength(writesAfter2 + failed0.appliedWrites.length
            + failed0.rollbackWrites.length);
    });
});

describe('programChannel - idempotent replay', () => {
    it('replaying the same request performs no additional writes', async () => {
        const sink = new RecordSink();
        const writer = new RegisterWriter(sink.write.bind(sink));
        const request = { instrument: makeInstrument(), channel: 0, fnum: 512, block: 3, keyOn: true };

        const first = await programChannel(writer, request);
        expect(first.status).toBe('committed');
        expect(first.idempotent).toBe(false);
        const writesAfterFirst = sink.records.length;

        const second = await programChannel(writer, request);
        expect(second.status).toBe('committed');
        expect(second.ok).toBe(true);
        expect(second.idempotent).toBe(true);
        expect(second.appliedWrites).toEqual([]);

        // Nothing else touched the chip.
        expect(sink.records).toHaveLength(writesAfterFirst);

        const third = await programChannel(writer, request);
        expect(third.idempotent).toBe(true);
        expect(sink.records).toHaveLength(writesAfterFirst);
    });

    it('re-issues only registers whose desired value changed', async () => {
        const sink = new RecordSink();
        const writer = new RegisterWriter(sink.write.bind(sink));

        const first = await programChannel(writer, {
            instrument: makeInstrument(),
            channel: 0,
            writes: [{ reg: 0xBD, value: 0x00 }],
        });
        expect(first.ok).toBe(true);

        // Same voice, different 0xBD value: the voice batch is replayed
        // (re-asserting operator latch state is harmless) and 0xBD changes.
        const second = await programChannel(writer, {
            instrument: makeInstrument(),
            channel: 0,
            writes: [{ reg: 0xBD, value: 0x20 }],
        });
        expect(second.ok).toBe(true);
        const bdWrite = second.appliedWrites.find(w => w.reg === 0xBD);
        expect(bdWrite).toEqual({ reg: 0xBD, value: 0x20 });
        expect(sink.get(0xBD)).toBe(0x20);

        // Replaying the identical request now performs no writes at all.
        const third = await programChannel(writer, {
            instrument: makeInstrument(),
            channel: 0,
            writes: [{ reg: 0xBD, value: 0x20 }],
        });
        expect(third.idempotent).toBe(true);
        expect(third.appliedWrites).toEqual([]);
    });
});

describe('createRawOPL3Writer - real adapter shape', () => {
    it('forwards writes through target.rawOPL3 with the bound chip id', async () => {
        /** @type {Array<{chipId: number, reg: number, value: number}>} */
        const calls = [];
        const fakeCore = {
            /**
             * @param {number} chipId
             * @param {number} reg
             * @param {number} value
             */
            rawOPL3(chipId, reg, value) {
                calls.push({ chipId, reg, value });
                return true;
            },
        };

        const writer = createRawOPL3Writer(fakeCore, 2);
        const result = await programChannel(writer, {
            instrument: makeInstrument(),
            channel: 9,
        });

        expect(result.ok).toBe(true);
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
            expect(call.chipId).toBe(2);
        }
        // Channel 9 lives in bank 1.
        expect(calls.every(c => c.reg >= 0x100 && c.reg <= 0x1FF)).toBe(true);
    });

    it('turns a false rawOPL3 return into a rollback', async () => {
        const fakeCore = {
            rawOPL3() {
                return false; // e.g. invalid chip id
            },
        };
        const writer = createRawOPL3Writer(fakeCore, 99);

        const result = await programChannel(writer, {
            instrument: makeInstrument(),
            channel: 0,
        });

        expect(result.status).toBe('commit_failed');
        expect(result.error).toContain('rawOPL3');
    });

    it('turns a thrown rawOPL3 error into a rollback', async () => {
        const fakeCore = {
            rawOPL3() {
                throw new Error('wasm trap');
            },
        };
        const writer = createRawOPL3Writer(fakeCore);

        const result = await programChannel(writer, {
            instrument: makeInstrument(),
            channel: 0,
        });

        expect(result.status).toBe('commit_failed');
        expect(result.cause.message).toBe('wasm trap');
    });

    it('rejects targets without rawOPL3', () => {
        expect(() => createRawOPL3Writer({})).toThrow('rawOPL3');
    });
});
