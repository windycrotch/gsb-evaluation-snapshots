const {Canvas, Image} = require('canvas');
const EventEmitter = require('events');
const createGLContext = require('gl');

const _ctx = Symbol('ctx');

function toDimension(value) {
  value = Number(value);
  if(!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

// Keep the WebGL drawing buffer in sync with the canvas size.
// Resizing a canvas in the browser also resets the GL viewport to cover
// the whole new drawing buffer; headless-gl's resize extension does not,
// so reset it here to avoid rendering only into the old viewport.
function syncDrawingBuffer(canvas) {
  const gl = canvas.__gl__;
  if(!gl) return;
  const {width, height} = canvas;
  if(gl.drawingBufferWidth === width && gl.drawingBufferHeight === height) return;
  const ext = gl.getExtension('STACKGL_resize_drawingbuffer');
  if(ext) {
    ext.resize(width, height);
    gl.viewport(0, 0, width, height);
  }
}

function putImageData(gl, canvas) {
  const {width, height} = canvas;
  let ctx = canvas[_ctx];
  if(!ctx) {
    ctx = Canvas.prototype.getContext.call(canvas, '2d');
    canvas[_ctx] = ctx;
  }
  if(width <= 0 || height <= 0) return ctx;

  // Make sure the GL drawing buffer matches the canvas before reading.
  syncDrawingBuffer(canvas);

  // Build the whole frame off to the side and only touch the 2D surface
  // once every pixel is ready, so a failed readback can never leave the
  // canvas in a half-updated state and the next export retries cleanly.
  const data = ctx.createImageData(width, height);
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  const rowBytes = width * 4;
  for(let i = 0; i < height; i++) {
    const src = i * rowBytes;
    // WebGL's origin is bottom-left, image data is top-left: flip rows.
    data.data.set(pixels.subarray(src, src + rowBytes), (height - i - 1) * rowBytes);
  }

  ctx.putImageData(data, 0, 0);
  return ctx;
}

class NodeCanvasElement extends Canvas {
  constructor(...args) {
    super(...args);
    this.__event__ = new EventEmitter();
    this.__attributes__ = {};
    this.style = {};
  }

  get width() {
    return super.width;
  }

  set width(value) {
    super.width = toDimension(value);
    syncDrawingBuffer(this);
  }

  get height() {
    return super.height;
  }

  set height(value) {
    super.height = toDimension(value);
    syncDrawingBuffer(this);
  }

  get clientWidth() {
    return super.width;
  }

  get clientHeight() {
    return super.height;
  }

  get __ctx__() {
    const gl = this.__gl__;
    if(gl) {
      putImageData(gl, this);
    }
    return this[_ctx];
  }

  getContext(type, options) {
    if(this.__contextType__ && this.__contextType__ !== type) return null;
    if(this.__gl__) return this.__gl__;
    this.__contextType__ = type;
    if(type === 'webgl' || type === 'webgl2') {
      const {width, height} = this;
      this[_ctx] = super.getContext('2d', options);
      const ctx = createGLContext(width, height, options);
      if(!ctx) return null;
      const _getUniformLocation = ctx.getUniformLocation;

      // Temporary fix https://github.com/stackgl/headless-gl/issues/170
      ctx.getUniformLocation = function (program, name) {
        if(program._uniforms && !/\[\d+\]$/.test(name)) {
          const reg = new RegExp(`${name}\\[\\d+\\]$`);
          for(let i = 0; i < program._uniforms.length; i++) {
            const _name = program._uniforms[i].name;
            if(reg.test(_name)) {
              name = _name;
            }
          }
        }
        return _getUniformLocation.call(this, program, name);
      };

      ctx.canvas = this;
      const _tetImage2D = ctx.texImage2D;
      ctx.texImage2D = function (...args) {
        let pixels = args[args.length - 1];
        if(pixels && pixels._image) pixels = pixels._image;
        if(pixels instanceof Image) {
          const canvas = new Canvas(pixels.width, pixels.height);
          canvas.getContext('2d').drawImage(pixels, 0, 0);
          args[args.length - 1] = canvas;
        }
        return _tetImage2D.apply(this, args);
      };
      this.__gl__ = ctx;
      return this.__gl__;
    }
    return super.getContext(type, options);
  }

  toBuffer(...args) {
    const gl = this.__gl__;
    if(gl) {
      putImageData(gl, this);
    }
    return super.toBuffer(...args);
  }

  toDataURL(...args) {
    const gl = this.__gl__;
    if(gl) {
      putImageData(gl, this);
    }
    return super.toDataURL(...args);
  }

  createPNGStream(...args) {
    const gl = this.__gl__;
    if(gl) {
      putImageData(gl, this);
    }
    return super.createPNGStream(...args);
  }

  createJPEGStream(...args) {
    const gl = this.__gl__;
    if(gl) {
      putImageData(gl, this);
    }
    return super.createJPEGStream(...args);
  }

  createPDFStream(...args) {
    const gl = this.__gl__;
    if(gl) {
      putImageData(gl, this);
    }
    return super.createPDFStream(...args);
  }

  addEventListener(type, listener) {
    return this.__event__.addListener(type, listener);
  }

  removeEventListener(type, listener) {
    if(listener) {
      return this.__event__.removeListener(type, listener);
    }
    return this.removeAllListeners(type);
  }

  dispatchEvent(event) {
    event.target = this;
    return this.emit(event.type, event);
  }

  setAttribute(key, value) {
    this.__attributes__[key] = value;

    if(key === 'width') {
      this.width = value;
    }

    if(key === 'height') {
      this.height = value;
    }
  }

  getAttribute(key) {
    if(key === 'width') {
      return this.width;
    }

    if(key === 'height') {
      return this.height;
    }
    return this.__attributes__[key];
  }

  removeAttribute(key) {
    delete this.__attributes__[key];
  }
}

module.exports = NodeCanvasElement;
