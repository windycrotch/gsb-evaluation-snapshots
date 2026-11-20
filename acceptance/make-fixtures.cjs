// Generates small, self-contained test textures for local acceptance testing:
//  - equirect-16x8.png   : a tiny RGB equirectangular-ish image (8x4 block gradient)
//  - equirect-16x8.hdr   : a tiny RGBE (.hdr) equirectangular image
// No external dependencies; PNG is encoded with zlib from Node's standard library.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const W = 16;
const H = 8;

function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) {
            c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
        }
    }
    return ~c >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
}

function writePng(filename, width, height, rgba) {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // color type RGBA
    ihdr[10] = 0;  // compression
    ihdr[11] = 0;  // filter
    ihdr[12] = 0;  // interlace
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0; // filter: none
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const idat = zlib.deflateSync(raw);
    fs.writeFileSync(filename, Buffer.concat([
        sig,
        chunk('IHDR', ihdr),
        chunk('IDAT', idat),
        chunk('IEND', Buffer.alloc(0))
    ]));
}

// simple RGBE encode of one pixel row run (no run-length encoding needed at 16px wide)
function writeHdr(filename, width, height, rgbPixels) {
    const header = Buffer.from(
        '#?RGBE\n' +
        'FORMAT=32-bit_rle_rgbe\n\n' +
        `-Y ${height} +X ${width}\n`,
        'ascii'
    );
    const pixels = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const [r, g, b] = rgbPixels[i];
        const maxV = Math.max(r, g, b);
        if (maxV < 1e-32) {
            pixels[i * 4 + 3] = 0;
            continue;
        }
        // frexp: value = significand * 2^exponent, significand in [0.5, 1)
        let exponent = Math.max(-126, Math.ceil(Math.log2(maxV)));
        let significand = maxV / Math.pow(2, exponent);
        if (significand >= 1) {
            significand /= 2;
            exponent += 1;
        }
        const f = (significand * 255.9999) / maxV;
        pixels[i * 4] = Math.min(255, Math.round(r * f));
        pixels[i * 4 + 1] = Math.min(255, Math.round(g * f));
        pixels[i * 4 + 2] = Math.min(255, Math.round(b * f));
        pixels[i * 4 + 3] = exponent + 128;
    }
    fs.writeFileSync(filename, Buffer.concat([header, pixels]));
}

const outDir = path.join(__dirname, 'fixtures');
fs.mkdirSync(outDir, { recursive: true });

const rgba = Buffer.alloc(W * H * 4);
const rgb = [];
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = Math.round((x / (W - 1)) * 255);
        rgba[i + 1] = Math.round((y / (H - 1)) * 255);
        rgba[i + 2] = 128;
        rgba[i + 3] = 255;
        rgb.push([x / W + 0.25, y / H + 0.25, 0.75]);
    }
}

writePng(path.join(outDir, 'equirect-16x8.png'), W, H, rgba);
writeHdr(path.join(outDir, 'equirect-16x8.hdr'), W, H, rgb);

console.log('wrote', fs.readdirSync(outDir).join(', '));
