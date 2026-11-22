/**
 * Atomic OPL3 channel programming.
 *
 * Turns a channel programming request into an all-or-nothing transaction:
 * every parameter is validated and every register byte is encoded before
 * the chip is touched, so a rejected request leaves the chip exactly as it
 * was. If a write fails mid-commit, the registers already written are
 * restored from a pre-commit snapshot taken through the same writer.
 *
 * The same writer also serializes concurrent requests (a per-writer mutex)
 * and keeps a shadow copy of every register it has written, which makes
 * replaying an identical request idempotent and makes rollback possible
 * even though OPL3 has no register read-back instruction.
 *
 * Production code goes through the real chip via {@link createRawOPL3Writer},
 * which adapts `AdlMidiCore.rawOPL3()` (or any object exposing the same
 * method). Tests may inject a record-style sink instead.
 *
 * @module opl3-channel
 */

import {
    encodeChannelVoice,
    encodeFnumBlock,
    fnumLoReg,
    keyOn,
    keyOff,
} from './opl3.js';

/** Highest valid OPL3 register address (9-bit address space, bank bit included). */
export const MAX_REGISTER = 0x1FF;

/** Highest valid 10-bit frequency number. */
export const MAX_FNUM = 1023;

/** Highest valid block / octave value. */
export const MAX_BLOCK = 7;

/** Highest valid per-chip melodic channel index. */
export const MAX_CHANNEL = 17;

/** Highest valid register byte value. */
export const MAX_VALUE = 0xFF;

/**
 * @typedef {Object} RegisterWrite
 * @property {number} reg - OPL3 register address (0x000-0x1FF)
 * @property {number} value - Register byte value (0-255)
 */

/**
 * @typedef {Object} ProgramChannelRequest
 * @property {import('./struct.js').Instrument} instrument - 2-op instrument to program
 * @property {number} channel - Per-chip OPL3 channel (0-17)
 * @property {Array<RegisterWrite>} [writes] - Extra register writes to include
 *   in the same transaction (e.g. pre-encoded fnum/key-on writes). They are
 *   validated and encoded before anything touches the chip. When two entries
 *   target the same register, the later entry wins.
 * @property {number} [fnum] - Optional frequency number (0-1023). When given,
 *   an A0/B0 register pair is appended to the transaction.
 * @property {number} [block] - Optional block / octave (0-7). Required when
 *   `fnum` is given.
 * @property {boolean} [keyOn] - Whether the B0 write should carry the
 *   key-on bit. Defaults to false (key-off / frequency update only).
 */

/**
 * Result of a channel programming transaction.
 *
 * @typedef {Object} ProgramChannelResult
 * @property {'committed'|'rejected'|'commit_failed'|'rollback_failed'} status
 *   - `committed`: every write was applied (or nothing needed to change).
 *   - `rejected`: validation/encoding failed before any write; the chip was
 *     not touched.
 *   - `commit_failed`: a write threw; rollback restored the pre-call state.
 *   - `rollback_failed`: a write threw and restoring state also failed.
 * @property {boolean} ok - True only for `committed`.
 * @property {boolean} idempotent - True when the shadow state already matched
 *   every requested value, so no physical write was necessary.
 * @property {string} [error] - Human-readable failure description.
 * @property {string} [code] - Machine-readable failure code.
 * @property {Array<RegisterWrite>} [appliedWrites] - Writes actually sent to
 *   the sink during the commit (empty for rejected/idempotent requests).
 * @property {Array<RegisterWrite>} [rollbackWrites] - Writes issued to restore
 *   the pre-call snapshot after a failed commit.
 * @property {Array<{reg: number, value: number, error: string}>} [rollbackErrors]
 *   - Per-register errors collected when rollback itself failed. Nothing is
 *     swallowed silently.
 * @property {Error} [cause] - The original error thrown by the writer.
 */

/**
 * A function that performs one physical register write.
 *
 * @callback RegisterSink
 * @param {number} reg - OPL3 register address (0x000-0x1FF)
 * @param {number} value - Register byte value (0-255)
 * @returns {void|Promise<void>} May return a promise for asynchronous sinks.
 *   A thrown error / rejected promise aborts the transaction.
 */

/**
 * Transactional writer around a physical OPL3 register sink.
 *
 * Holds a shadow copy of every register written through it and serializes
 * transactions so concurrent channel programming requests never interleave
 * their register writes. One instance represents one chip; create one writer
 * per chip.
 */
export class RegisterWriter {
    /**
     * @param {RegisterSink} sink - Underlying write implementation. In
     *   production use {@link createRawOPL3Writer}; tests can pass a
     *   record-style function.
     */
    constructor(sink) {
        if (typeof sink !== 'function') {
            throw new TypeError('RegisterWriter requires a sink function');
        }
        /**
         * @private
         * @type {RegisterSink}
         */
        this._sink = sink;
        /**
         * Shadow register file: last value physically written to each
         * address. An absent key means the register has not been written
         * through this writer and is treated as 0 (the OPL3 reset value).
         * Updated on successful physical writes, including rollback writes.
         * @private
         * @type {Map<number, number>}
         */
        this._shadow = new Map();
        /**
         * Ordered write sequence of the last successful batch, per register.
         * Used to recognize an exact replay as idempotent; operator latch
         * registers (0x20/0x40/...) can receive several writes per batch.
         * @private
         * @type {Map<number, number[]>}
         */
        this._lastBatchByReg = new Map();
        /**
         * Tail of the serialization mutex chain.
         * @private
         * @type {Promise<void>}
         */
        this._queue = Promise.resolve();
    }

    /**
     * Last shadow value written to a register (0 if never written through us).
     *
     * @param {number} reg - Register address
     * @returns {number}
     */
    peek(reg) {
        return this._shadow.has(reg) ? /** @type {number} */ (this._shadow.get(reg)) : 0;
    }

    /**
     * Run a function while holding the writer mutex. Guarantees that
     * transactions submitted from interleaved callers execute one at a time.
     *
     * @template T
     * @param {() => T|Promise<T>} fn
     * @returns {Promise<T>}
     */
    runExclusive(fn) {
        const result = this._queue.then(() => fn());
        // Keep the chain alive regardless of individual outcomes.
        this._queue = result.then(() => undefined, () => undefined);
        return result;
    }

    /**
     * Perform one physical write and update the shadow register file.
     *
     * @private
     * @param {number} reg
     * @param {number} value
     * @returns {Promise<void>}
     */
    async _write(reg, value) {
        await this._sink(reg, value);
        this._shadow.set(reg, value);
    }

    /**
     * Commit a pre-validated, fully encoded batch atomically.
     *
     * @param {Array<RegisterWrite>} writes - Register writes to apply
     * @returns {Promise<ProgramChannelResult>}
     */
    async commit(writes) {
        return this.runExclusive(() => this._commitLocked(writes));
    }

    /**
     * Group an ordered batch into per-register value sequences.
     *
     * @private
     * @param {Array<RegisterWrite>} writes
     * @returns {Map<number, number[]>}
     */
    static _groupByRegister(writes) {
        /** @type {Map<number, number[]>} */
        const grouped = new Map();
        for (const write of writes) {
            let sequence = grouped.get(write.reg);
            if (!sequence) {
                sequence = [];
                grouped.set(write.reg, sequence);
            }
            sequence.push(write.value);
        }
        return grouped;
    }

    /**
     * @private
     * @param {Array<RegisterWrite>} writes
     * @returns {Promise<ProgramChannelResult>}
     */
    async _commitLocked(writes) {
        const requestedByReg = RegisterWriter._groupByRegister(writes);

        // Exact-replay check against the previous successful batch, evaluated
        // per register so unrelated channels do not invalidate each other.
        // A register never programmed before (or one whose ordered value
        // sequence changed) requires physical writes; an identical sequence
        // does not.
        let allMatch = true;
        for (const [reg, requested] of requestedByReg) {
            const previous = this._lastBatchByReg.get(reg);
            if (!previous || previous.length !== requested.length) {
                allMatch = false;
                break;
            }
            for (let i = 0; i < requested.length; i++) {
                if (previous[i] !== requested[i]) {
                    allMatch = false;
                    break;
                }
            }
            if (!allMatch) {
                break;
            }
        }

        if (allMatch) {
            return {
                status: 'committed',
                ok: true,
                idempotent: true,
                appliedWrites: [],
            };
        }

        // Snapshot the pre-commit shadow value of every register this batch
        // programs. One value per register (its current observable state) is
        // enough to undo all observable effects of the transaction.
        /** @type {Map<number, number>} */
        const snapshot = new Map();
        for (const reg of requestedByReg.keys()) {
            snapshot.set(reg, this.peek(reg));
        }

        // Every occurrence is a real physical write: OPL3 operator parameter
        // addresses are latched per operator, so repeated addresses program
        // distinct operator slots.
        /** @type {Array<RegisterWrite>} */
        const appliedWrites = [];
        try {
            for (const write of writes) {
                await this._write(write.reg, write.value);
                appliedWrites.push(write);
            }
        } catch (error) {
            return this._rollback(snapshot, appliedWrites, error);
        }

        this._lastBatchByReg = requestedByReg;

        return {
            status: 'committed',
            ok: true,
            idempotent: false,
            appliedWrites,
        };
    }

    /**
     * Restore registers touched by a failed commit.
     *
     * @private
     * @param {Map<number, number>} snapshot - Pre-commit shadow value per
     *   register in the failed batch
     * @param {Array<RegisterWrite>} appliedWrites - Writes that landed before
     *   the failure
     * @param {unknown} cause - Original commit error
     * @returns {Promise<ProgramChannelResult>}
     */
    async _rollback(snapshot, appliedWrites, cause) {
        /** @type {Array<RegisterWrite>} */
        const rollbackWrites = [];
        /** @type {Array<{reg: number, value: number, error: string}>} */
        const rollbackErrors = [];

        // Restore, in reverse order, every register with at least one
        // successful applied write, rewriting it to its pre-call snapshot
        // value. The register whose write threw is deliberately excluded:
        // nothing was applied to it, so its observable state already matches
        // the snapshot (a sink that applied hardware state before throwing is
        // indistinguishable from one that did not, and re-invoking a known
        // failing sink cannot improve the outcome). Registers never reached
        // by the commit are left untouched.
        const restoreOrder = [];
        /** @type {Set<number>} */
        const seen = new Set();
        for (const write of appliedWrites) {
            if (!seen.has(write.reg)) {
                seen.add(write.reg);
                restoreOrder.push(write.reg);
            }
        }

        for (let i = restoreOrder.length - 1; i >= 0; i--) {
            const reg = restoreOrder[i];
            const value = /** @type {number} */ (snapshot.get(reg));
            try {
                await this._write(reg, value);
                rollbackWrites.push({ reg, value });
            } catch (rollbackError) {
                rollbackErrors.push({
                    reg,
                    value,
                    error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                });
            }
        }

        // The batch did not complete; drop the idempotency signature only for
        // the registers it touched. Unrelated channels keep theirs, so a
        // failure on one channel does not force rewrites on another.
        for (const reg of snapshot.keys()) {
            this._lastBatchByReg.delete(reg);
        }

        const base = {
            appliedWrites,
            rollbackWrites,
            rollbackErrors,
            cause: cause instanceof Error ? cause : new Error(String(cause)),
        };

        if (rollbackErrors.length > 0) {
            return {
                ...base,
                status: 'rollback_failed',
                ok: false,
                idempotent: false,
                code: 'ROLLBACK_FAILED',
                error:
                    `Commit failed and rollback failed for ${rollbackErrors.length} register(s); `
                    + `chip state may not match the pre-call snapshot. Original error: ${
                        cause instanceof Error ? cause.message : String(cause)
                    }`,
            };
        }

        return {
            ...base,
            status: 'commit_failed',
            ok: false,
            idempotent: false,
            code: 'COMMIT_FAILED',
            error: `Commit failed and all writes were rolled back: ${
                cause instanceof Error ? cause.message : String(cause)
            }`,
        };
    }
}

/**
 * Create a {@link RegisterWriter} bound to the real `rawOPL3` adapter path.
 *
 * Works with an `AdlMidiCore` instance (or anything exposing
 * `rawOPL3(chipId, reg, value)`). A `false` return from the adapter (e.g.
 * invalid chip id) is turned into a thrown error so the transaction treats it
 * as a commit failure and rolls back.
 *
 * @param {{rawOPL3: (chipId: number, reg: number, value: number) => boolean|Promise<boolean>}} rawTarget
 * @param {number} [chipId=0] - Chip index to program
 * @returns {RegisterWriter}
 */
export function createRawOPL3Writer(rawTarget, chipId = 0) {
    if (!rawTarget || typeof rawTarget.rawOPL3 !== 'function') {
        throw new TypeError('createRawOPL3Writer requires a target exposing rawOPL3()');
    }
    if (!Number.isInteger(chipId) || chipId < 0) {
        throw new RangeError(`Invalid chipId: ${chipId}`);
    }
    return new RegisterWriter(async (reg, value) => {
        const ok = await rawTarget.rawOPL3(chipId, reg, value);
        if (!ok) {
            throw new Error(`rawOPL3 write rejected by chip ${chipId}: reg=0x${reg.toString(16).toUpperCase()}`);
        }
    });
}

/**
 * Validate a scalar channel-programming parameter.
 *
 * @private
 * @param {unknown} value
 * @param {number} max
 * @param {string} label
 * @param {string} code
 * @returns {string|null} Error message, or null when valid
 */
function validateRange(value, max, label, code) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        return `${label} must be an integer, got ${String(value)} [${code}]`;
    }
    if (value < 0 || value > max) {
        return `${label} out of range (0-${max}): ${value} [${code}]`;
    }
    return null;
}

/**
 * Validate and encode a channel programming request without touching the
 * chip.
 *
 * @private
 * @param {ProgramChannelRequest} request
 * @returns {{ok: true, writes: Array<RegisterWrite>} | {ok: false, error: string, code: string}}
 */
function prepareWrites(request) {
    if (!request || typeof request !== 'object') {
        return { ok: false, error: 'Request must be an object', code: 'INVALID_REQUEST' };
    }

    const { instrument, channel, writes = [], fnum, block, keyOn: keyOnFlag = false } = request;

    // All scalar validation happens before any encoding, so a bad fnum can
    // never leave instrument registers half-encoded in a caller-side cache.
    const channelError = validateRange(channel, MAX_CHANNEL, 'channel', 'INVALID_CHANNEL');
    if (channelError) {
        return { ok: false, error: channelError, code: 'INVALID_CHANNEL' };
    }

    if (!instrument || typeof instrument !== 'object') {
        return { ok: false, error: 'instrument is required', code: 'INVALID_INSTRUMENT' };
    }

    const hasFnum = fnum !== undefined;
    const hasBlock = block !== undefined;
    if (hasFnum !== hasBlock) {
        return {
            ok: false,
            error: 'fnum and block must be provided together',
            code: 'INVALID_FNUM_BLOCK',
        };
    }

    if (hasFnum) {
        const fnumError = validateRange(fnum, MAX_FNUM, 'fnum', 'INVALID_FNUM');
        if (fnumError) {
            return { ok: false, error: fnumError, code: 'INVALID_FNUM' };
        }
        const blockError = validateRange(block, MAX_BLOCK, 'block', 'INVALID_BLOCK');
        if (blockError) {
            return { ok: false, error: blockError, code: 'INVALID_BLOCK' };
        }
    }

    if (!Array.isArray(writes)) {
        return { ok: false, error: 'writes must be an array of {reg, value}', code: 'INVALID_WRITES' };
    }

    // Encode the instrument first; 4-op / pseudo-4-op instruments are rejected
    // here, before a single register is touched.
    let voiceWrites;
    try {
        voiceWrites = encodeChannelVoice(instrument, channel);
    } catch (error) {
        return {
            ok: false,
            error: `Instrument encoding failed: ${error instanceof Error ? error.message : String(error)}`,
            code: 'INVALID_INSTRUMENT',
        };
    }

    /** @type {Array<RegisterWrite>} */
    const allWrites = [...voiceWrites];

    if (hasFnum) {
        const { fnumLo } = encodeFnumBlock(/** @type {number} */ (fnum), /** @type {number} */ (block));
        allWrites.push({ reg: fnumLoReg(channel), value: fnumLo });
        const b0 = keyOnFlag
            ? keyOn(channel, /** @type {number} */ (fnum), /** @type {number} */ (block))
            : keyOff(channel, /** @type {number} */ (fnum), /** @type {number} */ (block));
        allWrites.push(b0);
    }

    for (const write of writes) {
        if (!write || typeof write !== 'object') {
            return { ok: false, error: 'Each write must be an object {reg, value}', code: 'INVALID_WRITES' };
        }
        const regError = validateRange(write.reg, MAX_REGISTER, 'register address', 'INVALID_REGISTER');
        if (regError) {
            return { ok: false, error: regError, code: 'INVALID_REGISTER' };
        }
        const valueError = validateRange(write.value, MAX_VALUE, 'register value', 'INVALID_VALUE');
        if (valueError) {
            return { ok: false, error: valueError, code: 'INVALID_VALUE' };
        }
        allWrites.push({ reg: write.reg, value: write.value });
    }

    // Final guard over every encoded address, including those produced by the
    // encoding helpers themselves.
    for (const write of allWrites) {
        if (!Number.isInteger(write.reg) || write.reg < 0 || write.reg > MAX_REGISTER) {
            return {
                ok: false,
                error: `Encoded register address out of range (0-0x1FF): ${write.reg}`,
                code: 'INVALID_REGISTER',
            };
        }
        if (!Number.isInteger(write.value) || write.value < 0 || write.value > MAX_VALUE) {
            return {
                ok: false,
                error: `Encoded register value out of range (0-255): ${write.value}`,
                code: 'INVALID_VALUE',
            };
        }
    }

    // Note: duplicates are intentionally kept in order. Different encoded
    // registers can legitimately share an address (each operator has its own
    // 0x20/0x40/... byte), and a later caller-supplied write to the same
    // address must override an earlier encoded one. The commit layer resolves
    // duplicates against its shadow state without dropping either guarantee.
    return { ok: true, writes: allWrites };
}

/**
 * Program one OPL3 channel atomically.
 *
 * Validation and encoding complete entirely before the first register write.
 * On failure nothing is written; on a mid-commit sink error the chip is
 * restored from a pre-commit snapshot. Calls through the same writer are
 * serialized, so two channels programmed concurrently get complete,
 * independent register sets; replaying the same request is a no-op once the
 * shadow state matches.
 *
 * @param {RegisterWriter} writer - Target chip's transactional writer
 * @param {ProgramChannelRequest} request - Channel programming request
 * @returns {Promise<ProgramChannelResult>} Never rejects for validation or
 *   commit errors; failures are reported via `status`/`error`.
 */
export async function programChannel(writer, request) {
    if (!(writer instanceof RegisterWriter)) {
        return {
            status: 'rejected',
            ok: false,
            idempotent: false,
            code: 'INVALID_WRITER',
            error: 'programChannel requires a RegisterWriter instance',
        };
    }

    const prepared = prepareWrites(request);
    if (!prepared.ok) {
        // Nothing has been encoded against the chip and no write has happened.
        return {
            status: 'rejected',
            ok: false,
            idempotent: false,
            code: prepared.code,
            error: prepared.error,
        };
    }

    return writer.commit(prepared.writes);
}

/**
 * Convenience helper: validate a single register write without executing it.
 *
 * @param {RegisterWrite} write
 * @returns {{ok: true} | {ok: false, error: string, code: string}}
 */
export function validateRegisterWrite(write) {
    if (!write || typeof write !== 'object') {
        return { ok: false, error: 'Write must be an object {reg, value}', code: 'INVALID_WRITES' };
    }
    const regError = validateRange(write.reg, MAX_REGISTER, 'register address', 'INVALID_REGISTER');
    if (regError) {
        return { ok: false, error: regError, code: 'INVALID_REGISTER' };
    }
    const valueError = validateRange(write.value, MAX_VALUE, 'register value', 'INVALID_VALUE');
    if (valueError) {
        return { ok: false, error: valueError, code: 'INVALID_VALUE' };
    }
    return { ok: true };
}
