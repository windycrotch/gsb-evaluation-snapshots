// Pure I/O decision logic shared by the agent and the local unit tests.
//
// This module must not depend on Frida globals. `io.ts` provides a
// `MemoryBackend` implemented on top of the Frida API, and the tests provide a
// fake backend with controllable mappings.
//
// Failure replies are sent to the host as an object with the `ioError` member.
// The host (src/io_frida.c) checks for that member and reports -1 instead of
// fabricating read data. A successful read keeps the original reply shape:
// `[{}, <actual bytes>]`.

export const IO_ERROR_FIELD = "ioError";

export interface IOFailure {
    [IO_ERROR_FIELD]: string;
}

export interface MemoryRange {
    base: bigint;
    end: bigint;
    readable: boolean;
    writable: boolean;
    executable: boolean;
}

export interface MemoryBackend {
    listRanges: () => MemoryRange[];
    getRangeByAddress: (address: bigint) => MemoryRange | null;
    readByteArray: (address: bigint, count: number) => ArrayBuffer | null;
    writeByteArray: (address: bigint, data: ArrayBuffer) => void;
    hasPatchCode: () => boolean;
    patchCode: (address: bigint, data: ArrayBuffer) => void;
}

export type IOFailureReply = [IOFailure, []];
export type IOReadSuccess = [Record<string, never>, ArrayBuffer];
export type IOWriteSuccess = [Record<string, never>, null];
export type IOReadReply = IOReadSuccess | IOFailureReply;
export type IOWriteReply = IOWriteSuccess | IOFailureReply;

export function ioFailure(message: string): IOFailureReply {
    const failure: IOFailure = { [IO_ERROR_FIELD]: message };
    return [failure, []];
}

export function hexAddress(address: bigint): string {
    return "0x" + address.toString(16);
}

export function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

function requiresFullCoverage(
    ranges: MemoryRange[],
    start: bigint,
    end: bigint,
): boolean {
    let cursor = start;
    const sorted = [...ranges].sort((a, b) => {
        if (a.base < b.base) {
            return -1;
        }
        return a.base > b.base ? 1 : 0;
    });
    for (const range of sorted) {
        if (range.end <= cursor) {
            continue;
        }
        if (range.base > cursor) {
            break;
        }
        cursor = range.end;
        if (cursor >= end) {
            return true;
        }
    }
    return false;
}

function readExact(
    address: bigint,
    count: number,
    backend: MemoryBackend,
): IOReadReply {
    const bytes = backend.readByteArray(address, count);
    if (bytes === null) {
        return ioFailure(
            `Cannot read ${count} bytes at ${hexAddress(address)}: the read returned no data`,
        );
    }
    return [{}, bytes];
}

export function readMemory(
    address: bigint,
    count: number,
    backend: MemoryBackend,
    safe: boolean,
): IOReadReply {
    if (count <= 0) {
        return [{}, new ArrayBuffer(0)];
    }
    if (address < 2n) {
        return ioFailure(`Cannot read at invalid address ${hexAddress(address)}`);
    }
    const end = address + BigInt(count);
    if (safe) {
        const readable = backend.listRanges().filter((range) => range.readable);
        if (!requiresFullCoverage(readable, address, end)) {
            return ioFailure(
                `Cannot read ${count} bytes at ${hexAddress(address)}: ` +
                    "the requested range is not fully covered by readable mappings",
            );
        }
        try {
            return readExact(address, count, backend);
        } catch (e) {
            return ioFailure(
                `Cannot read ${count} bytes at ${hexAddress(address)}: ${describeError(e)}`,
            );
        }
    }
    try {
        return readExact(address, count, backend);
    } catch (e) {
        return ioFailure(
            `Cannot read ${count} bytes at ${hexAddress(address)}: ${describeError(e)}`,
        );
    }
}

export function writeMemory(
    address: bigint,
    data: ArrayBuffer,
    backend: MemoryBackend,
    patchCode: boolean,
): IOWriteReply {
    const size = BigInt(data.byteLength);
    const range = backend.getRangeByAddress(address);

    if (patchCode && range !== null && range.executable) {
        if (backend.hasPatchCode()) {
            try {
                backend.patchCode(address, data);
                return [{}, null];
            } catch (e) {
                return ioFailure(
                    `Cannot patch code at ${hexAddress(address)}: ${describeError(e)}`,
                );
            }
        }
        try {
            backend.writeByteArray(address, data);
            return [{}, null];
        } catch (e) {
            return ioFailure(
                `Cannot write ${size} bytes at ${hexAddress(address)}: ${describeError(e)}`,
            );
        }
    }

    if (range === null) {
        return ioFailure(
            `Cannot write ${size} bytes at ${hexAddress(address)}: the address is not mapped`,
        );
    }
    if (!range.writable) {
        return ioFailure(
            `The page at ${hexAddress(address)} is not writeable. ` +
                `Run ':dmp ${hexAddress(address)} 4096 rwx' to fix that error.`,
        );
    }
    try {
        backend.writeByteArray(address, data);
        return [{}, null];
    } catch (e) {
        return ioFailure(
            `Cannot write ${size} bytes at ${hexAddress(address)}: ${describeError(e)}`,
        );
    }
}
