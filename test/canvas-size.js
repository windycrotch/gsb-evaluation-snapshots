/* eslint-disable no-console */
/**
 * Local, network-free tests for the NodeCanvasElement size and event paths.
 *
 * Covers:
 *   1. A 64x64 canvas cleared to a known WebGL color, exported and decoded.
 *   2. Resizing to 32x48 and re-exporting: exported size and pixels must match
 *      the new dimensions, with no content left over from the old size.
 *   3. addEventListener/removeEventListener semantics (single vs. all) and the
 *      event target.
 *
 * headless-gl renders into an offscreen buffer, so no display is required:
 *   node test/canvas-size.js
 */
const assert = require('assert');
const {createCanvas, loadImage} = require('../lib');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// Decode an exported PNG back to raw pixels. loadImage() reads from memory, so
// no external resource is involved.
async function decodePNG(buffer) {
  const image = await loadImage(buffer);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return {
    width: image.width,
    height: image.height,
    data: ctx.getImageData(0, 0, image.width, image.height).data,
  };
}

function pixelAt(image, x, y) {
  const idx = 4 * (y * image.width + x);
  return Array.from(image.data.slice(idx, idx + 4));
}

// GL converts float colors to bytes, allow a single unit of rounding.
function assertColor(actual, expected, message) {
  for(let i = 0; i < 4; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= 1,
      `${message}: expected [${expected}], got [${actual}]`
    );
  }
}

function readStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function testRenderAndResize() {
  console.log('1) 64x64 canvas cleared through WebGL');
  const canvas = createCanvas(64, 64);
  const gl = canvas.getContext('webgl');
  assert.ok(gl, 'a WebGL context should be created');

  gl.clearColor(1, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  let exported;
  await check('toBuffer exports 64x64 red pixels', async () => {
    exported = await decodePNG(canvas.toBuffer());
    assert.strictEqual(exported.width, 64);
    assert.strictEqual(exported.height, 64);
    assertColor(pixelAt(exported, 0, 0), [255, 0, 0, 255], 'top-left pixel');
    assertColor(pixelAt(exported, 63, 63), [255, 0, 0, 255], 'bottom-right pixel');
  });

  await check('toDataURL and createPNGStream carry the same frame', async () => {
    const url = canvas.toDataURL();
    assert.ok(url.startsWith('data:image/png;base64,'), 'PNG data URL');
    const fromURL = await decodePNG(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
    assert.strictEqual(fromURL.width, 64);
    assertColor(pixelAt(fromURL, 32, 32), [255, 0, 0, 255], 'data URL center pixel');

    const fromStream = await decodePNG(await readStream(canvas.createPNGStream()));
    assert.strictEqual(fromStream.width, 64);
    assert.strictEqual(fromStream.height, 64);
    assertColor(pixelAt(fromStream, 0, 63), [255, 0, 0, 255], 'streamed pixel');
  });

  console.log('2) Resize to 32x48');
  canvas.width = 32;
  canvas.height = 48;

  await check('properties, attributes and the GL buffer agree on 32x48', () => {
    assert.strictEqual(canvas.width, 32);
    assert.strictEqual(canvas.height, 48);
    assert.strictEqual(canvas.getAttribute('width'), 32);
    assert.strictEqual(canvas.getAttribute('height'), 48);
    assert.strictEqual(gl.drawingBufferWidth, 32);
    assert.strictEqual(gl.drawingBufferHeight, 48);
  });

  await check('the resize cleared the old frame', async () => {
    const cleared = await decodePNG(canvas.toBuffer());
    assert.strictEqual(cleared.width, 32);
    assert.strictEqual(cleared.height, 48);
    assert.notDeepStrictEqual(pixelAt(cleared, 0, 0), [255, 0, 0, 255]);
    assert.notDeepStrictEqual(pixelAt(cleared, 31, 47), [255, 0, 0, 255]);
  });

  gl.clearColor(0, 1, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  await check('exports after the resize are 32x48 with the new pixels', async () => {
    const resized = await decodePNG(canvas.toBuffer());
    assert.strictEqual(resized.width, 32);
    assert.strictEqual(resized.height, 48);
    assert.strictEqual(resized.data.length, 32 * 48 * 4);
    assertColor(pixelAt(resized, 0, 0), [0, 255, 0, 255], 'top-left pixel');
    assertColor(pixelAt(resized, 31, 0), [0, 255, 0, 255], 'top-right pixel');
    assertColor(pixelAt(resized, 0, 47), [0, 255, 0, 255], 'bottom-left pixel');
    assertColor(pixelAt(resized, 31, 47), [0, 255, 0, 255], 'bottom-right pixel');

    const fromURL = await decodePNG(
      Buffer.from(canvas.toDataURL().split(',')[1], 'base64')
    );
    assert.strictEqual(fromURL.width, 32);
    assert.strictEqual(fromURL.height, 48);

    const fromStream = await decodePNG(await readStream(canvas.createPNGStream()));
    assert.strictEqual(fromStream.width, 32);
    assert.strictEqual(fromStream.height, 48);
    assertColor(pixelAt(fromStream, 10, 10), [0, 255, 0, 255], 'streamed pixel after resize');
  });

  await check('setAttribute takes the same resize path', async () => {
    canvas.setAttribute('width', 20);
    canvas.setAttribute('height', 10);
    assert.strictEqual(canvas.width, 20);
    assert.strictEqual(canvas.height, 10);
    assert.strictEqual(canvas.getAttribute('width'), 20);
    assert.strictEqual(canvas.getAttribute('height'), 10);
    assert.strictEqual(gl.drawingBufferWidth, 20);
    assert.strictEqual(gl.drawingBufferHeight, 10);

    gl.clearColor(0, 0, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const exported2 = await decodePNG(canvas.toBuffer());
    assert.strictEqual(exported2.width, 20);
    assert.strictEqual(exported2.height, 10);
    assertColor(pixelAt(exported2, 19, 9), [0, 0, 255, 255], 'pixel after setAttribute');
  });

  await check('zero sizes never throw and keep the canvas empty', async () => {
    assert.doesNotThrow(() => {
      canvas.width = 0;
    });
    assert.strictEqual(canvas.width, 0);
    assert.strictEqual(canvas.getAttribute('width'), 0);
    assert.doesNotThrow(() => {
      canvas.height = 0;
    });
    assert.strictEqual(canvas.height, 0);
    assert.doesNotThrow(() => canvas.toDataURL());
    assert.doesNotThrow(() => canvas.__ctx__);

    // Growing back must not restore the previous frame.
    canvas.width = 16;
    canvas.height = 16;
    gl.clearColor(1, 1, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const revived = await decodePNG(canvas.toBuffer());
    assert.strictEqual(revived.width, 16);
    assert.strictEqual(revived.height, 16);
    assertColor(pixelAt(revived, 0, 0), [255, 255, 0, 255], 'pixel after growing back');
    assertColor(pixelAt(revived, 15, 15), [255, 255, 0, 255], 'corner after growing back');
  });
}

function testEvents() {
  console.log('3) Event listeners');
  const canvas = createCanvas(8, 8);
  const calls = [];

  const first = function first(event) {
    calls.push(['first', event, this]);
  };
  const second = event => calls.push(['second', event, this]);

  canvas.addEventListener('resize', first);
  canvas.addEventListener('resize', second);

  let event = {type: 'resize'};
  canvas.dispatchEvent(event);
  assert.strictEqual(calls.length, 2, 'both listeners invoked');
  assert.strictEqual(calls[0][0], 'first');
  assert.strictEqual(calls[1][0], 'second');
  assert.strictEqual(event.target, canvas, 'event target is the canvas');
  assert.strictEqual(calls[0][2], canvas, 'listener `this` is the canvas');

  console.log('3a) remove one listener');
  canvas.removeEventListener('resize', first);
  assert.strictEqual(canvas.__event__.listenerCount('resize'), 1, 'one listener remains');

  calls.length = 0;
  event = {type: 'resize'};
  canvas.dispatchEvent(event);
  assert.strictEqual(calls.length, 1, 'only the remaining listener is invoked');
  assert.strictEqual(calls[0][0], 'second');
  assert.strictEqual(event.target, canvas, 'event target after removal');

  console.log('3b) remove all listeners of a type');
  canvas.addEventListener('resize', first);
  assert.strictEqual(canvas.__event__.listenerCount('resize'), 2, 'two listeners again');

  canvas.removeEventListener('resize');
  assert.strictEqual(canvas.__event__.listenerCount('resize'), 0, 'all listeners removed');

  calls.length = 0;
  canvas.dispatchEvent({type: 'resize'});
  assert.strictEqual(calls.length, 0, 'removed listeners are not invoked');

  // Other event types are unaffected by removing a different type.
  const click = () => calls.push(['click']);
  canvas.addEventListener('click', click);
  canvas.removeEventListener('resize');
  assert.strictEqual(canvas.__event__.listenerCount('click'), 1, 'other types untouched');
}

async function main() {
  await testRenderAndResize();
  testEvents();
  console.log(`\nAll ${passed} checks passed.`);
}

main().catch((error) => {
  console.error('\nTest failed:');
  console.error(error);
  process.exitCode = 1;
});
