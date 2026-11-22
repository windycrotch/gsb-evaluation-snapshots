const test = require('node:test');
const assert = require('node:assert');
const {createCanvas, loadImage} = require('../../lib');

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

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function dataURLToBuffer(url) {
  return Buffer.from(url.split(',')[1], 'base64');
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

// Assert every pixel of the frame matches the expected color.
function assertSolidFrame({width, height, data}, color) {
  for(let y = 0; y < height; y += Math.max(1, Math.floor(height / 16))) {
    for(let x = 0; x < width; x += Math.max(1, Math.floor(width / 16))) {
      assertPixel(pixelAt(data, width, x, y), color, `pixel(${x}, ${y})`);
    }
  }
  // always check the corners explicitly
  assertPixel(pixelAt(data, width, 0, 0), color, 'top-left corner');
  assertPixel(pixelAt(data, width, width - 1, 0), color, 'top-right corner');
  assertPixel(pixelAt(data, width, 0, height - 1), color, 'bottom-left corner');
  assertPixel(pixelAt(data, width, width - 1, height - 1), color, 'bottom-right corner');
}

// Draw a fullscreen triangle through the shader pipeline — unlike gl.clear,
// this is clipped by the GL viewport, so it catches a stale viewport after
// the drawing buffer has been resized.
function drawFullscreen(gl, r, g, b) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}');
  gl.compileShader(vs);
  assert.strictEqual(gl.getShaderParameter(vs, gl.COMPILE_STATUS), true, gl.getShaderInfoLog(vs));

  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, `void main(){gl_FragColor=vec4(${r},${g},${b},1.);}`);
  gl.compileShader(fs);
  assert.strictEqual(gl.getShaderParameter(fs, gl.COMPILE_STATUS), true, gl.getShaderInfoLog(fs));

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  assert.strictEqual(gl.getProgramParameter(program, gl.LINK_STATUS), true, gl.getProgramInfoLog(program));
  gl.useProgram(program);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// Fill the top half (in image orientation) red and the bottom half blue,
// using GL scissor coordinates (origin bottom-left).
function fillTopRedBottomBlue(gl, width, height) {
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(0, Math.floor(height / 2), width, height - Math.floor(height / 2));
  gl.clearColor(1, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.scissor(0, 0, width, Math.floor(height / 2));
  gl.clearColor(0, 0, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.disable(gl.SCISSOR_TEST);
}

// ---------- tests ----------

test('export after resize uses the new size and a complete frame', async () => {
  const canvas = createCanvas(64, 64);
  const gl = canvas.getContext('webgl');
  gl.clearColor(1, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  canvas.width = 128;
  canvas.height = 96;

  assert.strictEqual(gl.drawingBufferWidth, 128);
  assert.strictEqual(gl.drawingBufferHeight, 96);

  gl.clearColor(0, 1, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const frame = await decodePNG(canvas.toBuffer());
  assert.strictEqual(frame.width, 128);
  assert.strictEqual(frame.height, 96);
  assertSolidFrame(frame, [0, 255, 0, 255]);
});

test('viewport follows the drawing buffer after resize (no partial update)', async () => {
  // grow: old viewport would only cover a quarter of the new buffer
  const up = createCanvas(64, 64);
  const glUp = up.getContext('webgl');
  drawFullscreen(glUp, 1, 0, 0);
  up.width = 128;
  up.height = 128;
  drawFullscreen(glUp, 0, 1, 0);
  const upFrame = await decodePNG(up.toBuffer());
  assert.strictEqual(upFrame.width, 128);
  assert.strictEqual(upFrame.height, 128);
  assertSolidFrame(upFrame, [0, 255, 0, 255]);

  // shrink: old viewport would spill past the new buffer
  const down = createCanvas(128, 128);
  const glDown = down.getContext('webgl');
  drawFullscreen(glDown, 1, 0, 0);
  down.width = 64;
  down.height = 64;
  drawFullscreen(glDown, 0, 0, 1);
  const downFrame = await decodePNG(down.toBuffer());
  assert.strictEqual(downFrame.width, 64);
  assert.strictEqual(downFrame.height, 64);
  assertSolidFrame(downFrame, [0, 0, 255, 255]);
});

test('multiple resizes: only the last size matters', async () => {
  const canvas = createCanvas(64, 64);
  const gl = canvas.getContext('webgl');

  canvas.width = 100;
  canvas.height = 100;
  canvas.width = 150;
  canvas.height = 80;
  canvas.width = 200;
  canvas.height = 40;

  assert.strictEqual(canvas.width, 200);
  assert.strictEqual(canvas.height, 40);
  assert.strictEqual(gl.drawingBufferWidth, 200);
  assert.strictEqual(gl.drawingBufferHeight, 40);

  drawFullscreen(gl, 0, 1, 0);
  const frame = await decodePNG(canvas.toBuffer());
  assert.strictEqual(frame.width, 200);
  assert.strictEqual(frame.height, 40);
  assertSolidFrame(frame, [0, 255, 0, 255]);
});

test('toBuffer, toDataURL, createPNGStream and __ctx__ all agree after resize', async () => {
  const canvas = createCanvas(32, 32);
  const gl = canvas.getContext('webgl');
  canvas.width = 96;
  canvas.height = 64;
  fillTopRedBottomBlue(gl, 96, 64);

  const fromBuffer = await decodePNG(canvas.toBuffer());
  const fromDataURL = await decodePNG(dataURLToBuffer(canvas.toDataURL()));
  const fromStream = await decodePNG(await streamToBuffer(canvas.createPNGStream()));

  const ctx = canvas.__ctx__;
  const direct = ctx.getImageData(0, 0, 96, 64).data;

  [fromBuffer, fromDataURL, fromStream].forEach((frame) => {
    assert.strictEqual(frame.width, 96);
    assert.strictEqual(frame.height, 64);
    // image top must be red, image bottom must be blue (orientation correct)
    assertPixel(pixelAt(frame.data, 96, 48, 0), [255, 0, 0, 255], 'top row');
    assertPixel(pixelAt(frame.data, 96, 48, 63), [0, 0, 255, 255], 'bottom row');
  });

  assertPixel(pixelAt(direct, 96, 48, 0), [255, 0, 0, 255], '__ctx__ top row');
  assertPixel(pixelAt(direct, 96, 48, 63), [0, 0, 255, 255], '__ctx__ bottom row');
});

test('a failed readback does not leave the canvas half-updated', async () => {
  const canvas = createCanvas(64, 64);
  const gl = canvas.getContext('webgl');

  gl.clearColor(1, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const redFrame = await decodePNG(canvas.toBuffer());
  assertSolidFrame(redFrame, [255, 0, 0, 255]);

  // render a new frame, then make the next readback fail midway
  gl.clearColor(0, 1, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  canvas.width = 128;
  canvas.height = 32;
  gl.clearColor(0, 0, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const readPixels = gl.readPixels;
  gl.readPixels = function () {
    throw new Error('simulated readback failure');
  };
  assert.throws(() => canvas.toBuffer(), /simulated readback failure/);

  // the canvas must recover fully on the next export
  gl.readPixels = readPixels;
  const frame = await decodePNG(canvas.toBuffer());
  assert.strictEqual(frame.width, 128);
  assert.strictEqual(frame.height, 32);
  assertSolidFrame(frame, [0, 0, 255, 255]);

  // and every other export path agrees
  const dataURLFrame = await decodePNG(dataURLToBuffer(canvas.toDataURL()));
  assert.strictEqual(dataURLFrame.width, 128);
  assert.strictEqual(dataURLFrame.height, 32);
  assertSolidFrame(dataURLFrame, [0, 0, 255, 255]);
});

test('readPixels failure during toDataURL does not corrupt later exports', async () => {
  const canvas = createCanvas(50, 50);
  const gl = canvas.getContext('webgl');
  drawFullscreen(gl, 1, 0, 0);

  const readPixels = gl.readPixels;
  let calls = 0;
  gl.readPixels = function (...args) {
    calls++;
    if(calls === 1) throw new Error('boom');
    return readPixels.apply(this, args);
  };

  assert.throws(() => canvas.toDataURL(), /boom/);
  const frame = await decodePNG(dataURLToBuffer(canvas.toDataURL()));
  assert.strictEqual(frame.width, 50);
  assert.strictEqual(frame.height, 50);
  assertSolidFrame(frame, [255, 0, 0, 255]);
});

test('string dimensions (setAttribute path) are coerced and synced', async () => {
  const canvas = createCanvas(64, 64);
  const gl = canvas.getContext('webgl');
  canvas.setAttribute('width', '120');
  canvas.setAttribute('height', '70');
  assert.strictEqual(canvas.width, 120);
  assert.strictEqual(canvas.height, 70);
  assert.strictEqual(gl.drawingBufferWidth, 120);
  assert.strictEqual(gl.drawingBufferHeight, 70);

  drawFullscreen(gl, 0, 1, 0);
  const frame = await decodePNG(canvas.toBuffer());
  assert.strictEqual(frame.width, 120);
  assert.strictEqual(frame.height, 70);
  assertSolidFrame(frame, [0, 255, 0, 255]);
});

test('context type negotiation on a direct canvas', () => {
  const canvas = createCanvas(32, 32);
  const gl = canvas.getContext('webgl');
  assert.ok(gl, 'webgl context created');
  assert.strictEqual(canvas.getContext('webgl'), gl, 'repeated getContext returns the same context');
  assert.strictEqual(canvas.getContext('2d'), null, '2d after webgl returns null');

  const canvas2 = createCanvas(32, 32);
  const ctx2d = canvas2.getContext('2d');
  assert.ok(ctx2d, '2d context created');
  assert.strictEqual(canvas2.getContext('2d'), ctx2d);
  assert.strictEqual(canvas2.getContext('webgl'), null, 'webgl after 2d returns null');
});
