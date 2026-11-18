// Local unit tests for the agent I/O decision logic.
//
// These tests never attach to a process. They drive `readMemory` / `writeMemory`
// with a fake backend whose mappings and write targets are fully controlled, and
// assert both the reply shape and whether a real write happened.
//
// They import the TypeScript source directly; Node >= 22.18 / 23.6 strips the
// types on the fly, so no build step is needed:
//
//   node --test test/agent/io-core.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    IO_ERROR_FIELD,
    readMemory,
    writeMemory,
} from "../../src/agent/io-core.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function toRange(spec) {
    return {
        base: BigInt(spec.base),
        end: BigInt(spec.base + spec.size),
        readable: spec.protection.includes("r"),
        writable: spec.protection.includes("w"),
        executable: spec.protection.includes("x"),
    };
}

class FakeMemory {
    ranges;
    memory = new Map();
    writeCalls = [];
    patchCalls = [];
    patchApiAvailable = true;
    /** When true, reads throw even inside a readable range. */
    failReads = false;

    constructor(specs) {
        this.ranges = specs.map(toRange);
    }

    seed(base, values) {
        for (let i = 0; i < values.length; i++) {
            this.memory.set(BigInt(base + i), values[i] & 0xff);
        }
    }

    listRanges() {
        return this.ranges;
    }

    getRangeByAddress(address) {
        for (const range of this.ranges) {
            if (address >= range.base && address < range.end) {
                return range;
            }
        }
        return null;
    }

    readByteArray(address, count) {
        if (this.failReads) {
            throw new Error("simulated read fault");
        }
        // Real Frida refuses a read that leaves the readable mappings.
        const end = address + BigInt(count);
        const readable = this.ranges.filter((range) => range.readable);
        const covered = readable.some((range) =>
            address >= range.base && end <= range.end
        );
        if (count > 0 && !covered) {
            throw new Error("simulated access violation");
        }
        const buffer = new Uint8Array(count);
        for (let i = 0; i < count; i++) {
            buffer[i] = this.memory.get(address + BigInt(i)) ?? 0;
        }
        return buffer.buffer;
    }

    writeByteArray(address, data) {
        const range = this.getRangeByAddress(address);
        if (range === null || !range.writable) {
            throw new Error("simulated segfault on write");
        }
        this.writeCalls.push({ address, bytes: Array.from(new Uint8Array(data)) });
    }

    hasPatchCode() {
        return this.patchApiAvailable;
    }

    patchCode(address, data) {
        this.patchCalls.push({ address, bytes: Array.from(new Uint8Array(data)) });
    }
}

function isFailure(reply) {
    return typeof reply[0][IO_ERROR_FIELD] === "string";
}

test("read succeeds inside a readable mapping", () => {
    const backend = new FakeMemory([
        { base: 0x1000, size: 0x1000, protection: "r--" },
    ]);
    backend.seed(0x1000, [0xde, 0xad, 0xbe, 0xef]);

    for (const safe of [false, true]) {
        const reply = readMemory(0x1000n, 4, backend, safe);
        assert.equal(isFailure(reply), false);
        assert.deepEqual(reply[0], {});
        assert.ok(reply[1] instanceof ArrayBuffer);
        assert.deepEqual(Array.from(new Uint8Array(reply[1])), [
            0xde,
            0xad,
            0xbe,
            0xef,
        ]);
    }
});

test("zero-byte read succeeds and stays distinguishable from failure", () => {
    const backend = new FakeMemory([
        { base: 0x1000, size: 0x1000, protection: "r--" },
    ]);
    const reply = readMemory(0x1000n, 0, backend, true);
    assert.equal(isFailure(reply), false);
    assert.ok(reply[1] instanceof ArrayBuffer);
    assert.equal(reply[1].byteLength, 0);
});

test("read crossing the end of a readable mapping fails", () => {
    const backend = new FakeMemory([
        { base: 0x1000, size: 0x10, protection: "r--" },
    ]);
    backend.seed(0x1000, new Array(16).fill(0x41));

    for (const safe of [false, true]) {
        const reply = readMemory(0x1008n, 0x10, backend, safe);
        assert.equal(isFailure(reply), true);
        assert.deepEqual(reply[1], []);
        assert.match(reply[0][IO_ERROR_FIELD], /Cannot read 16 bytes/);
    }
});

test("read of an unmapped address fails instead of returning empty data", () => {
    const backend = new FakeMemory([
        { base: 0x1000, size: 0x1000, protection: "r--" },
    ]);
    for (const safe of [false, true]) {
        const reply = readMemory(0x9000n, 4, backend, safe);
        assert.equal(isFailure(reply), true);
        assert.deepEqual(reply[1], []);
    }
});

test("read failure from the underlying API is reported as failure", () => {
    const backend = new FakeMemory([
        { base: 0x1000, size: 0x1000, protection: "r--" },
    ]);
    backend.failReads = true;
    for (const safe of [false, true]) {
        const reply = readMemory(0x1000n, 4, backend, safe);
        assert.equal(isFailure(reply), true);
        assert.match(reply[0][IO_ERROR_FIELD], /simulated read fault/);
    }
});

test("write to a non-writeable page is refused without touching memory", () => {
    const backend = new FakeMemory([
        { base: 0x1000, size: 0x1000, protection: "r--" },
    ]);
    const data = new Uint8Array([1, 2, 3, 4]).buffer;

    const reply = writeMemory(0x1000n, data, backend, false);

    assert.equal(isFailure(reply), true);
    assert.deepEqual(reply[1], []);
    assert.match(reply[0][IO_ERROR_FIELD], /not writeable/);
    assert.equal(backend.writeCalls.length, 0);
    assert.equal(backend.patchCalls.length, 0);
});

test("write to an unmapped page is refused without touching memory", () => {
    const backend = new FakeMemory([
        { base: 0x1000, size: 0x1000, protection: "rw-" },
    ]);
    const data = new Uint8Array([1, 2, 3, 4]).buffer;

    const reply = writeMemory(0x9000n, data, backend, true);

    assert.equal(isFailure(reply), true);
    assert.match(reply[0][IO_ERROR_FIELD], /not mapped/);
    assert.equal(backend.writeCalls.length, 0);
    assert.equal(backend.patchCalls.length, 0);
});

test("write to a writeable page succeeds and really writes", () => {
    const backend = new FakeMemory([
        { base: 0x1000, size: 0x1000, protection: "rw-" },
    ]);
    const data = new Uint8Array([0xaa, 0xbb]).buffer;

    const reply = writeMemory(0x1000n, data, backend, true);

    assert.equal(isFailure(reply), false);
    assert.deepEqual(reply, [{}, null]);
    assert.deepEqual(backend.writeCalls, [
        { address: 0x1000n, bytes: [0xaa, 0xbb] },
    ]);
    assert.equal(backend.patchCalls.length, 0);
});

test("patch.code writes executable pages through Memory.patchCode", () => {
    const backend = new FakeMemory([
        { base: 0x1000, size: 0x1000, protection: "r-x" },
    ]);
    const data = new Uint8Array([0x90, 0x90]).buffer;

    const reply = writeMemory(0x1000n, data, backend, true);

    assert.equal(isFailure(reply), false);
    assert.deepEqual(reply, [{}, null]);
    assert.deepEqual(backend.patchCalls, [
        { address: 0x1000n, bytes: [0x90, 0x90] },
    ]);
    assert.equal(backend.writeCalls.length, 0);
});

test("patch.code does not bypass the writeable check on data pages", () => {
    const backend = new FakeMemory([
        { base: 0x1000, size: 0x1000, protection: "r--" },
    ]);
    const data = new Uint8Array([0x90]).buffer;

    const reply = writeMemory(0x1000n, data, backend, true);

    assert.equal(isFailure(reply), true);
    assert.equal(backend.writeCalls.length, 0);
    assert.equal(backend.patchCalls.length, 0);
});

test("patch.code failures are reported instead of thrown", () => {
    const backend = new FakeMemory([
        { base: 0x1000, size: 0x1000, protection: "r-x" },
    ]);
    backend.patchCode = () => {
        throw new Error("patch denied");
    };
    const data = new Uint8Array([0x90]).buffer;

    const reply = writeMemory(0x1000n, data, backend, true);

    assert.equal(isFailure(reply), true);
    assert.match(reply[0][IO_ERROR_FIELD], /patch denied/);
});

test("host and agent agree on the failure field name", () => {
    assert.equal(IO_ERROR_FIELD, "ioError");
    const source = readFileSync(
        join(__dirname, "..", "..", "src", "io_frida.c"),
        "utf8",
    );
    const check = `json_object_has_member (result, "${IO_ERROR_FIELD}")`;
    // one occurrence in __read, one in __write
    assert.equal(source.split(check).length - 1, 2);

    // __read must bail out with -1 on the failure marker
    const readStart = source.indexOf("static int __read(");
    const writeStart = source.indexOf("static int __write(");
    assert.ok(readStart !== -1 && writeStart > readStart);
    const readBody = source.slice(readStart, writeStart);
    const failureAt = readBody.indexOf(check);
    assert.ok(failureAt !== -1);
    const failureBranch = readBody.slice(failureAt);
    assert.ok(failureBranch.indexOf("return -1;") !== -1);
    // and the old fabricated 0xff filler must be gone
    assert.equal(readBody.includes("memset (buf, 0xff, count)"), false);
});
