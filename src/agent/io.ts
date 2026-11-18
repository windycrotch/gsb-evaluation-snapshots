import r2frida from "./plugin.js";
import config from "./config.js";
import {
    ioFailure,
    readMemory,
    writeMemory,
} from "./io-core.js";
import type { MemoryBackend, MemoryRange } from "./io-core.js";

export default { read, write };

let cachedRanges: MemoryRange[] = [];

// TODO: cached ranges are never invalidated. add a command for it?
function invalidateCachedRanges() {
    Script.nextTick(() => {
        cachedRanges = [];
    });
}

function protectionFlags(protection: string): {
    readable: boolean;
    writable: boolean;
    executable: boolean;
} {
    return {
        readable: protection.indexOf("r") !== -1,
        writable: protection.indexOf("w") !== -1,
        executable: protection.indexOf("x") !== -1,
    };
}

function pointerToBigInt(value: NativePointer): bigint {
    return BigInt(value.toString());
}

function bigIntToPointer(value: bigint): NativePointer {
    return ptr("0x" + value.toString(16));
}

function toMemoryRange(map: RangeDetails): MemoryRange {
    return {
        base: pointerToBigInt(map.base),
        end: pointerToBigInt(map.base.add(map.size)),
        ...protectionFlags(map.protection),
    };
}

function getFridaRange(address: bigint): MemoryRange | null {
    try {
        const map = Process.getRangeByAddress(bigIntToPointer(address));
        return toMemoryRange(map);
    } catch (e) {
        return null;
    }
}

const fridaBackend: MemoryBackend = {
    listRanges(): MemoryRange[] {
        if (cachedRanges.length === 0) {
            cachedRanges = Process.enumerateRanges("").map(toMemoryRange);
        }
        return cachedRanges;
    },
    getRangeByAddress: getFridaRange,
    readByteArray(address: bigint, count: number): ArrayBuffer | null {
        return bigIntToPointer(address).readByteArray(count);
    },
    writeByteArray(address: bigint, data: ArrayBuffer): void {
        bigIntToPointer(address).writeByteArray(data);
    },
    hasPatchCode(): boolean {
        return typeof Memory.patchCode === "function";
    },
    patchCode(address: bigint, data: ArrayBuffer): void {
        Memory.patchCode(
            bigIntToPointer(address),
            data.byteLength,
            (p: NativePointer) => {
                p.writeByteArray(data);
            },
        );
    },
};

function volatileRead(
    offset: string,
    count: number,
    safe: boolean,
): [any, any] {
    const np = new NativePointer(offset) as any;
    try {
        const data = np.readVolatile(count);
        if (data !== null) {
            return [{}, data];
        }
        return ioFailure(
            `Cannot read ${count} bytes at ${offset}: volatile read returned no data`,
        );
    } catch (err) {
        // config.set("io.volatile", false);
    }
    return readMemory(BigInt(offset), count, fridaBackend, safe);
}

export function read(params: R2FIOReadParameters) {
    const { offset, count } = params;
    if (typeof r2frida.hookedRead === "function") {
        return r2frida.hookedRead(offset, count);
    }
    const safe = config.getBoolean("io.safe");
    if (config.getBoolean("io.volatile")) {
        return volatileRead(offset, count, safe);
    }
    return readMemory(BigInt(offset), count, fridaBackend, safe);
}

interface R2FIOWriteParameters {
    offset: string;
}
interface R2FIOReadParameters {
    offset: string;
    count: number;
    fast: boolean;
}

export function write(params: R2FIOWriteParameters, data: ArrayBuffer) {
    if (typeof r2frida.hookedWrite === "function") {
        return r2frida.hookedWrite(ptr(params.offset), data);
    }
    return writeMemory(
        BigInt(params.offset),
        data,
        fridaBackend,
        config.getBoolean("patch.code"),
    );
}
