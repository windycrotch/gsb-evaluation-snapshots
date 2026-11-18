const {Canvas, Image} = require('canvas');
const EventEmitter = require('events');
const createGLContext = require('gl');

const _ctx = Symbol('ctx');

// Canvas dimensions are unsigned integers. Invalid (NaN, negative, infinite)
// values are treated as zero, same as browsers do for out-of-range values.
function normalizeSize(value) {
  const size = Math.floor(Number(value));
  if(!Number.isFinite(size) || size < 0) return 0;
  return size;
}

function putImageData(gl, canvas) {
  const {width, height} = canvas;
  const ctx = canvas[_ctx];

  // A zero-sized canvas has no pixels to read or write. getImageData() throws
  // on a zero-sized source, so bail out early instead of failing the export.
  if(!ctx || width <= 0 || height <= 0) return ctx;

  const data = typeof ctx.createImageData === 'function'
    ? ctx.createImageData(width, height)
    : ctx.getImageData(0, 0, width, height);

  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  // WebGL starts reading at the bottom row, image data starts at the top row.
  const rowLength = width * 4;
  for(let i = 0; i < height; i++) {
    const src = (height - i - 1) * rowLength;
    data.data.set(pixels.subarray(src, src + rowLength), i * rowLength);
  }

  ctx.putImageData(data, 0, 0);
  return ctx;
}

// Assigning canvas.width/height clears the canvas, including all WebGL
// attachments. Reproduce that for the headless-gl drawing buffer.
function clearDrawingBuffer(gl) {
  const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  const scissorTest = gl.isEnabled(gl.SCISSOR_TEST);
  const colorMask = gl.getParameter(gl.COLOR_WRITEMASK);
  const depthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
  const clearColor = gl.getParameter(gl.COLOR_CLEAR_VALUE);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if(scissorTest) gl.disable(gl.SCISSOR_TEST);
  gl.colorMask(true, true, true, true);
  gl.depthMask(true);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

  gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
  gl.colorMask(colorMask[0], colorMask[1], colorMask[2], colorMask[3]);
  gl.depthMask(depthMask);
  if(scissorTest) gl.enable(gl.SCISSOR_TEST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
}

// Keep the GL drawing buffer and the 2D backing canvas in sync. headless-gl
// rejects zero-sized drawing buffers, so a zero dimension is represented by a
// 1px buffer; such a canvas is never read back because putImageData() skips it.
function resizeDrawingBuffer(gl, width, height) {
  const ext = gl.getExtension('STACKGL_resize_drawingbuffer');
  const bufferWidth = width > 0 ? width : 1;
  const bufferHeight = height > 0 ? height : 1;
  const changed = gl.drawingBufferWidth !== bufferWidth
    || gl.drawingBufferHeight !== bufferHeight;

  if(ext && changed) {
    // Like a browser, resizing reallocates the buffer and clears it. The
    // user-managed viewport is left untouched.
    ext.resize(bufferWidth, bufferHeight);
  }

  clearDrawingBuffer(gl);
}

// DOM event objects expose target/currentTarget as readonly accessors, and
// some event implementations reject plain assignment. Fall back to defining
// an own property when assignment did not take effect.
function setEventProperty(event, key, value) {
  try {
    event[key] = value;
  } catch (e) {
    // Readonly accessor; handled below.
  }
  if(event[key] !== value) {
    try {
      Object.defineProperty(event, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    } catch (e) {
      // Frozen/non-configurable event; nothing else we can do.
    }
  }
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
    this.__resize__(normalizeSize(value), this.height);
  }

  get height() {
    return super.height;
  }

  set height(value) {
    this.__resize__(this.width, normalizeSize(value));
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

  __resize__(width, height) {
    const gl = this.__gl__;
    if(gl) {
      resizeDrawingBuffer(gl, width, height);
    }
    // Both dimensions are assigned on the backing canvas so that a change of
    // either property ends up with a bitmap matching the requested size.
    // Re-assigning also clears the previous content, like the canvas spec
    // requires for a width/height assignment.
    super.width = width;
    super.height = height;
  }

  getContext(type, options) {
    if(this.__contextType__ && this.__contextType__ !== type) return null;
    if(this.__gl__) return this.__gl__;
    this.__contextType__ = type;
    if(type === 'webgl' || type === 'webgl2') {
      const {width, height} = this;
      this[_ctx] = super.getContext('2d', options);
      const ctx = createGLContext(Math.max(1, width), Math.max(1, height), options);
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
    // Accepts callbacks as well as objects exposing handleEvent(), like the DOM.
    if(typeof listener !== 'function'
      && !(listener && typeof listener.handleEvent === 'function')) {
      return this;
    }
    // Browsers ignore duplicate registrations of the same listener.
    if(this.__event__.listeners(type).indexOf(listener) === -1) {
      this.__event__.addListener(type, listener);
    }
    return this;
  }

  removeEventListener(type, listener) {
    if(listener) {
      this.__event__.removeListener(type, listener);
    } else {
      this.__event__.removeAllListeners(type);
    }
    return this;
  }

  dispatchEvent(event) {
    if(!event || typeof event.type !== 'string') {
      throw new TypeError('dispatchEvent expects an event with a type');
    }
    setEventProperty(event, 'target', this);
    setEventProperty(event, 'currentTarget', this);
    // Invoke the registered listeners directly instead of going through
    // EventEmitter#emit: this keeps `this` bound to the canvas (as in the DOM)
    // and avoids the special-casing Node applies to the 'error' event type.
    const listeners = this.__event__.listeners(event.type);
    for(let i = 0; i < listeners.length; i++) {
      const listener = listeners[i];
      if(typeof listener === 'function') {
        listener.call(this, event);
      } else {
        listener.handleEvent(event);
      }
    }
    return !event.defaultPrevented;
  }

  setAttribute(key, value) {
    if(key === 'width' || key === 'height') {
      this[key] = value;
      return;
    }
    this.__attributes__[key] = value;
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
