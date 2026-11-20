// Generates the tiny PNG fixtures used by the browser export tests.
//
// Usage: node test/make-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');

const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; ++n) {
        let c = n;
        for (let k = 0; k < 8; ++k) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; ++i) {
        c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
    const typeBytes = Buffer.from(type, 'ascii');
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    typeBytes.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
    return out;
};

// css color strings map to [r, g, b, a]
const COLORS = {
    red: [255, 0, 0, 255],
    green: [0, 255, 0, 255],
    blue: [0, 0, 255, 255],
    white: [255, 255, 255, 255],
    black: [0, 0, 0, 255],
    yellow: [255, 255, 0, 255],
    cyan: [0, 255, 255, 255],
    magenta: [255, 0, 255, 255]
};

const makePng = (width, height, rows) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace

    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; ++y) {
        const rowOffset = y * (width * 4 + 1);
        raw[rowOffset] = 0; // no filter
        for (let x = 0; x < width; ++x) {
            const color = COLORS[rows[y][x]];
            raw.set(color, rowOffset + 1 + x * 4);
        }
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
};

fs.mkdirSync(fixtures, { recursive: true });

// 2x2 texture: each quadrant a distinct color
fs.writeFileSync(
    path.join(fixtures, 'avatar.png'),
    makePng(2, 2, [
        ['red', 'green'],
        ['blue', 'white']
    ])
);

// second 2x2 texture with different colors, used to verify that switching the
// selection mid-export does not retarget an in-flight export
fs.writeFileSync(
    path.join(fixtures, 'stripes.png'),
    makePng(2, 2, [
        ['yellow', 'black'],
        ['cyan', 'magenta']
    ])
);

// extra copies used by the removal / unload tests
for (const name of ['doomed.png', 'unloaded.png']) {
    fs.writeFileSync(
        path.join(fixtures, name),
        makePng(2, 2, [
            ['red', 'green'],
            ['blue', 'white']
        ])
    );
}

console.log(`fixtures written to ${fixtures}`);
