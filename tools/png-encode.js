/*
 * 零依赖 PNG（RGB, 8-bit）编码器 —— 仅用于 Node 侧生成本地样例图集。
 * 浏览器中的实际导出走原生 canvas.toBlob('image/png')。
 * 两者渲染的像素缓冲完全一致，因此同参数输出逐像素相同。
 */
'use strict';

var zlib = require('zlib');

function crcTable() {
  var table = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
}

var TABLE = crcTable();

function crc32(buf) {
  var c = 0xffffffff;
  for (var i = 0; i < buf.length; i++) {
    c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var typeBuf = Buffer.from(type, 'ascii');
  var body = Buffer.concat([typeBuf, data]);
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/* rgb: Buffer，长度 width*height*3，逐行紧密排列（无填充字节） */
function encodePNG(width, height, rgb) {
  if (rgb.length !== width * height * 3) {
    throw new Error('RGB 缓冲长度与尺寸不符');
  }

  // 每行前加一个 filter 字节（0 = None）
  var stride = width * 3;
  var raw = Buffer.alloc((stride + 1) * height);
  for (var y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  var compressed = zlib.deflateSync(raw);

  var signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type 2 = truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* 由 weave-core 的结果构造紧密 RGB 缓冲（与浏览器 canvas 的逐像素结果一致） */
function resultToRgb(result, core) {
  var width = result.columns * result.cellSize;
  var height = result.rows * result.cellSize;
  var rgb = Buffer.alloc(width * height * 3);
  var paletteRgb = result.palette.map(core.hexToRgb);
  var s = result.cellSize;
  for (var r = 0; r < result.rows; r++) {
    for (var c = 0; c < result.columns; c++) {
      var px = paletteRgb[result.cells[r * result.columns + c]];
      for (var dy = 0; dy < s; dy++) {
        for (var dx = 0; dx < s; dx++) {
          var x = c * s + dx;
          var y = r * s + dy;
          var off = (y * width + x) * 3;
          rgb[off] = px[0];
          rgb[off + 1] = px[1];
          rgb[off + 2] = px[2];
        }
      }
    }
  }
  return rgb;
}

module.exports = { encodePNG: encodePNG, resultToRgb: resultToRgb, crc32: crc32 };
