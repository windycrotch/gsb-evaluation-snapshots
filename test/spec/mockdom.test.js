const test = require('node:test');
const assert = require('node:assert');

require('jsdom-global')();
const {mockDOM, createCanvas, loadImage} = require('../../lib');

mockDOM(window);

// ---------- helpers ----------

async function decodePNG(buffer) {
  const img = await loadImage(buffer);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return {
    width: img.width,
    height: img.height,
    data: ctx.getImageData(0, 0, img.width, img.height).data,
  };
}

function pixelAt(data, width, x, y) {
  const idx = 4 * (y * width + x);
  return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
}

function assertPixel(actual, expected, message) {
  for(let i = 0; i < 4; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= 2,
      `${message || 'pixel'}: expected [${expected}], got [${actual}]`
    );
  }
}

function drawFullscreen(gl, r, g, b) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}');
  gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, `void main(){gl_FragColor=vec4(${r},${g},${b},1.);}`);
  gl.compileShader(fs);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.useProgram(program);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// ---------- tests ----------

test('mockDOM: setting width/height syncs the underlying canvas and GL buffer', () => {
  const el = document.createElement('canvas');
  el.width = 200;
  el.height = 120;

  const underlying = el._getCanvas();
  assert.strictEqual(underlying.width, 200);
  assert.strictEqual(underlying.height, 120);

  const gl = el.getContext('webgl');
  assert.ok(gl, 'webgl context created through the DOM mock');
  assert.strictEqual(gl.drawingBufferWidth, 200);
  assert.strictEqual(gl.drawingBufferHeight, 120);

  // resize after the GL context exists
  el.width = 160;
  el.height = 90;
  assert.strictEqual(underlying.width, 160);
  assert.strictEqual(underlying.height, 90);
  assert.strictEqual(gl.drawingBufferWidth, 160);
  assert.strictEqual(gl.drawingBufferHeight, 90);
});

test('mockDOM: exported frame matches a direct createCanvas render', async () => {
  const direct = createCanvas(120, 80);
  const glDirect = direct.getContext('webgl');
  drawFullscreen(glDirect, 0, 1, 0);

  const el = document.createElement('canvas');
  el.width = 120;
  el.height = 80;
  const glMock = el.getContext('webgl');
  drawFullscreen(glMock, 0, 1, 0);

  const directFrame = await decodePNG(direct.toBuffer());
  const mockFrame = await decodePNG(el.toBuffer());

  assert.strictEqual(mockFrame.width, directFrame.width);
  assert.strictEqual(mockFrame.height, directFrame.height);
  assert.deepStrictEqual([...mockFrame.data], [...directFrame.data]);
});

test('mockDOM: resize then export produces the new size, like the direct path', async () => {
  const el = document.createElement('canvas');
  el.width = 64;
  el.height = 64;
  const gl = el.getContext('webgl');
  drawFullscreen(gl, 1, 0, 0);

  el.width = 100;
  el.height = 50;
  drawFullscreen(gl, 0, 0, 1);

  const frame = await decodePNG(el.toBuffer());
  assert.strictEqual(frame.width, 100);
  assert.strictEqual(frame.height, 50);
  assertPixel(pixelAt(frame.data, 100, 0, 0), [0, 0, 255, 255], 'top-left');
  assertPixel(pixelAt(frame.data, 100, 99, 49), [0, 0, 255, 255], 'bottom-right');

  const dataURL = el.toDataURL();
  assert.ok(dataURL.startsWith('data:image/png'), 'toDataURL returns a PNG data URL');
  const dataURLFrame = await decodePNG(Buffer.from(dataURL.split(',')[1], 'base64'));
  assert.strictEqual(dataURLFrame.width, 100);
  assert.strictEqual(dataURLFrame.height, 50);
});

test('mockDOM: getContext type negotiation is not confused', () => {
  const el2d = document.createElement('canvas');
  const ctx2d = el2d.getContext('2d');
  assert.ok(ctx2d, '2d context created');
  assert.strictEqual(el2d.getContext('2d'), ctx2d, 'repeated 2d getContext returns the same context');
  assert.strictEqual(el2d.getContext('webgl'), null, 'webgl after 2d returns null, not the 2d context');

  const elGL = document.createElement('canvas');
  const gl = elGL.getContext('webgl');
  assert.ok(gl, 'webgl context created');
  assert.strictEqual(elGL.getContext('webgl'), gl, 'repeated webgl getContext returns the same context');
  assert.strictEqual(elGL.getContext('2d'), null, '2d after webgl returns null, not the gl context');

  // the 2d context must actually be a 2d context
  assert.strictEqual(typeof ctx2d.fillRect, 'function');
  assert.strictEqual(typeof gl.clear, 'function');
  assert.strictEqual(ctx2d.canvas, el2d);
  assert.strictEqual(gl.canvas, elGL);
});

test('mockDOM: default dimensions are 300x150', () => {
  const el = document.createElement('canvas');
  assert.strictEqual(el.width, 300);
  assert.strictEqual(el.height, 150);
  const gl = el.getContext('webgl');
  assert.strictEqual(gl.drawingBufferWidth, 300);
  assert.strictEqual(gl.drawingBufferHeight, 150);
});
