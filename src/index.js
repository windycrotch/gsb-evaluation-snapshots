// Copyright (c) 2010-2024, Lawrence Livermore National Security, LLC. Produced
// at the Lawrence Livermore National Laboratory. All Rights reserved. See files
// LICENSE and NOTICE for details. LLNL-CODE-443271.
//
// This file is part of the GLVis visualization tool and library. For more
// information and source code availability see https://glvis.org.
//
// GLVis is free software; you can redistribute it and/or modify it under the
// terms of the BSD-3 license. We welcome feedback and contributions, see file
// CONTRIBUTING.md for details.

// got this from the webpack docs
// https://webpack.js.org/configuration/output/
(function webpackUniversalModuleDefinition(root, factory) {
  // node
  if (typeof exports === "object" && typeof module === "object") {
    console.log("mod type 1");
    module.exports = factory(require("./glvis"));
  }
  // requirejs?
  else if (typeof define === "function" && define.amd) {
    console.log("mod type 2");
    define(["./glvis"], factory);
  }
  // unknown
  else if (typeof exports === "object") {
    console.warn("glvis: untested module load");
    exports["someLibName"] = factory(require("./glvis"));
  }
  // browser global
  else {
    root["glvis"] = factory(root["glvis"]);
  }
})(this, function (emglvis) {
  function rand_id() {
    const arr = new Uint8Array(10);
    window.crypto.getRandomValues(arr);
    return arr.reduce(
      (cur, next) => cur + next.toString(36).padStart(2, "0"),
      ""
    );
  }

  class State {
    constructor(div, width = 640, height = 480, canvas = undefined) {
      if (div === undefined) {
        throw "div cannot be undefined";
      }
      this.div_ = div;
      this.canvas_ = canvas;
      this.emglv_ = emglvis();
      this.emsetup_ = false;
      this.setupCanvas(width, height);
      this.new_stream_callbacks = [];
      // could also have an update_stream_callbacks
      // this.update_stream_callbacks = [];

      // Display lifecycle state. Every operation that touches the renderer
      // (display, update, setSize and the screenshot helpers) is serialized
      // through this promise chain. This makes sure that a display/update
      // switch is never interleaved with another switch or with a capture,
      // which is what used to produce mismatched sizes and stale frames.
      this._lifecycle_chain_ = Promise.resolve();
      // true after the last display completed and the renderer was resized to
      // match the canvas
      this._renderer_ready_ = false;
      // a display/update attempt failed and has not been followed by a
      // successful display
      this._display_failed_ = false;
      this._renderer_width_ = undefined;
      this._renderer_height_ = undefined;
      // exactly one animation loop may be active at any time
      this._vis_loop_active_ = false;
    }

    // Queue a lifecycle operation and return a promise for its completion.
    // A failed operation does not break the chain, so the State stays usable
    // for the next display/update/capture. New-stream callbacks are notified
    // synchronously (never awaited), so a callback that starts another
    // display just queues behind the current one instead of deadlocking.
    _runLifecycle(op) {
      const run = this._lifecycle_chain_.then(() => op());
      this._lifecycle_chain_ = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    }

    _notifyNewStream() {
      this.new_stream_callbacks.forEach((f) => f(this));
    }

    _markDisplayFailure() {
      this._renderer_ready_ = false;
      this._display_failed_ = true;
    }

    // Only callable from resolved emglvis. Resize the renderer to the given
    // (logical) size and record it, so the renderer is known to agree with
    // the canvas after the operation completes.
    _resizeRendererNow(g, width, height) {
      g.resizeWindow(width, height);
      g.sendExposeEvent();
      this._renderer_width_ = width;
      this._renderer_height_ = height;
    }

    // Resize the canvas element (logical + pixel size) and the renderer
    // together.
    _applySizeNow(g, width, height) {
      this.setCanvasSize(width, height);
      this._resizeRendererNow(g, width, height);
    }

    // Bring canvas and renderer back to the current logical size if a previous
    // operation left them out of sync (e.g. a stream changed the resolution,
    // or the canvas element was resized directly). This is a no-op when the
    // three sizes already agree, so it is cheap enough to call before an
    // update or a capture.
    _ensureSizeConsistent(g) {
      if (!this._renderer_ready_) {
        return;
      }
      const ratio = window.devicePixelRatio || 1;
      const pixel_w = Math.floor(this.logical_width_ * ratio);
      const pixel_h = Math.floor(this.logical_height_ * ratio);
      const in_sync =
        this._renderer_width_ === this.logical_width_ &&
        this._renderer_height_ === this.logical_height_ &&
        this.canvas_.width === pixel_w &&
        this.canvas_.height === pixel_h;
      if (in_sync) {
        return;
      }
      console.log("restoring canvas and renderer to the logical size");
      this._applySizeNow(g, this.logical_width_, this.logical_height_);
    }

    // Screenshots must never silently return a frame from a stream that is no
    // longer displayed. Captures are queued behind pending switches, so by the
    // time this runs any switch has completed. If nothing has been displayed
    // yet, or the last switch failed, no frame can be trusted: fail explicitly
    // instead of returning an empty or stale image.
    _assertCapturable() {
      if (!this._renderer_ready_ && !this._display_failed_) {
        throw new Error(
          "cannot take a screenshot: no visualization has been displayed yet"
        );
      }
      if (this._display_failed_ && !this._renderer_ready_) {
        throw new Error(
          "cannot take a screenshot: the last display or update failed"
        );
      }
    }

    // Expected byte size of one RGBA frame at the canvas resolution.
    _captureByteSize() {
      return this.canvas_.width * this.canvas_.height * 4;
    }

    // A renderer may hand back a larger view than requested (it reuses its
    // buffer when shrinking), but never a smaller one: too few bytes means the
    // renderer is still set up for a different size/stream.
    _captureLooksValid(data) {
      if (data === undefined || data === null) {
        return false;
      }
      if (typeof data.length !== "number") {
        return true;
      }
      return data.length >= this._captureByteSize();
    }

    // Read a frame from the renderer, repairing the size first if it drifted
    // (e.g. a stream changed the resolution behind our back, or the canvas was
    // resized directly). If the renderer still disagrees afterwards, the frame
    // cannot be trusted and this fails explicitly.
    _captureScreen(g, flipY) {
      this._ensureSizeConsistent(g);
      let data = g.getScreenBuffer(flipY);
      if (!this._captureLooksValid(data)) {
        console.log("renderer size drifted, resizing before capture");
        this._applySizeNow(g, this.logical_width_, this.logical_height_);
        data = g.getScreenBuffer(flipY);
        if (!this._captureLooksValid(data)) {
          throw new Error(
            `screenshot size mismatch: got ${data ? data.length : 0} bytes ` +
              `but the canvas is ${this.canvas_.width}x${this.canvas_.height} ` +
              `(${this._captureByteSize()} bytes)`
          );
        }
      }
      return data;
    }

    setCanvasSize(width, height) {
      this.pixel_ratio_ = window.devicePixelRatio || 1;
      this.logical_width_ = width;
      this.logical_height_ = height;
      this.canvas_.style.width = `${width}px`;
      this.canvas_.style.height = `${height}px`;
      this.canvas_.width = Math.floor(width * this.pixel_ratio_);
      this.canvas_.height = Math.floor(height * this.pixel_ratio_);
      console.log(
        `dpr=${this.pixel_ratio_} new canvas sizes: ` +
          `style.width=${this.canvas_.style.width}, ` +
          `style.height=${this.canvas_.style.height}, ` +
          `width=${this.canvas_.width}, ` +
          `height=${this.canvas_.height}`
      );
    }

    async setSize(width, height) {
      // update the canvas immediately (as before) so the page does not flash
      // the old size, then resize the renderer in the lifecycle queue
      this.setCanvasSize(width, height);
      return this._runLifecycle(async () => {
        var g = await this.emglv_;
        this._resizeRendererNow(g, width, height);
      });
    }

    setupCanvas(width, height) {
      if (this.canvas_ === undefined) {
        this.canvas_ = document.createElement("canvas");
        this.canvas_.id = `glvis-canvas-${rand_id()}`;
      }
      this.setCanvasSize(width, height);
      this.canvas_.innerHTML = "Your browser doesn't support HTML canvas";

      this.canvas_.oncontextmenu = function (e) {
        e.preventDefault();
        // prevent right-click from bubbling up to stuff like Jupyter Lab that
        // have a custom JS-based right-click menu we don't want opening when
        // someone is trying to zoom
        e.stopPropagation();
      };
      var that = this;
      this.canvas_.addEventListener("click", function () {
        that.div_.focus();
        return true;
      });

      this.div_.append(this.canvas_);
    }

    // only callable from resolved emglvis
    _setupEmGlvis(g) {
      if (this.emsetup_) {
        return;
      }
      g.setKeyboardListeningElementId(this.div_.id);
      g.setCanvasId(this.canvas_.id);
      g.canvas = this.canvas_;
    }

    // only callable from resolved emglvis
    _startVis(g) {
      // Exactly one animation loop may run: repeated display/update calls
      // (including the update fallback) must never stack additional loops.
      if (this._vis_loop_active_) {
        return;
      }
      this._vis_loop_active_ = true;
      this.emsetup_ = true;
      console.log("starting visualization loop");
      // needed again here... do we delete the SdlWindow somewhere in startVisualization?
      g.setCanvasId(this.canvas_.id);
      const iterVis = (timestamp) => {
        if (!this._vis_loop_active_) {
          return;
        }
        g.iterVisualization();
        if (!this._vis_loop_active_) {
          return;
        }
        this._vis_raf_ = window.requestAnimationFrame(iterVis);
      };
      this._vis_raf_ = window.requestAnimationFrame(iterVis);
    }

    async _display(data, is_update, ...args) {
      var g = await this.emglv_;
      if (Array.isArray(data)) {
        const f = is_update
          ? g.updateParallelStreams
          : g.displayParallelStreams;
        // TODO: this seems expensive, there must be a better way..
        var streams = new g.StringArray();
        try {
          data.forEach((s) => streams.push_back(s));
          const stat = f(streams, ...args);
          return stat;
        } finally {
          streams.delete();
        }
      } else if (typeof data == "string") {
        const f = is_update ? g.updateStream : g.displayStream;
        return f(data, ...args);
      } else {
        throw `unsupported data type ${typeof data}`;
      }
    }

    // Full display of a new stream. The operation is serialized with other
    // lifecycle operations and only touches the renderer once the previous
    // operation (switch or capture) has finished.
    async display(data) {
      return this._runLifecycle(() => this._displayNow(data));
    }

    async _displayNow(data) {
      var g = await this.emglv_;
      this._setupEmGlvis(g);

      try {
        await this._display(
          data,
          false,
          this.logical_width_,
          this.logical_height_
        );

        // make sure the renderer has the desired size even when some data
        // streams command it to change it, which is overriden here
        this._applySizeNow(g, this.logical_width_, this.logical_height_);
      } catch (e) {
        // leave the State in a clean, retryable state: no half-initialized
        // flags, no trusted renderer size, and no stale frame to capture
        this._markDisplayFailure();
        throw e;
      }

      // the stream is displayed and the renderer agrees with the canvas
      this._display_failed_ = false;
      this._renderer_ready_ = true;

      this._notifyNewStream();
      this._startVis(g);
    }

    // Incremental update of the current stream. Before the first display (or
    // after a failed one) the renderer is not usable, so fall back to a full
    // display. A nonzero return from the renderer is also handled with a
    // single full display, never with a second animation loop.
    async update(data) {
      return this._runLifecycle(() => this._updateNow(data));
    }

    async _updateNow(data) {
      if (!this._renderer_ready_ || !this.emsetup_) {
        return this._displayNow(data);
      }

      var g = await this.emglv_;
      this._setupEmGlvis(g);

      // A previous operation may have changed the canvas size (e.g. a user
      // resize that has not reached the renderer yet); bring the renderer in
      // line before applying an update so its output matches the canvas.
      this._ensureSizeConsistent(g);

      let stat;
      try {
        stat = await this._display(data, true);
      } catch (e) {
        console.log("unable to update stream, starting a new one");
        return this._displayNow(data);
      }

      if (stat != 0) {
        console.log("unable to update stream, starting a new one");
        return this._displayNow(data);
      }

      this._display_failed_ = false;
      this._renderer_ready_ = true;
      console.log("updated stream");

      // an update must leave the renderer, the canvas and the logical size in
      // agreement as well (no-op when they already are)
      this._ensureSizeConsistent(g);
    }

    async sendKey(key, ctrl = false, shift = false, alt = false) {
      var key_code = undefined;
      if (typeof key === "string") {
        key_code = key.charCodeAt(0);
        console.log(`sending key '${key[0]}' (key_code=${key_code})`);
      } else if (typeof key === "number") {
        key_code = key;
        console.log(`sending key_code=${key_code}`);
      } else {
        throw "unsupported type";
      }
      var g = await this.emglv_;
      g.processKey(key_code, ctrl, shift, alt);
    }

    async sendKeyStr(keys) {
      var g = await this.emglv_;
      g.processKeys(keys);
    }

    async loadUrl(url) {
      var resp = await fetch(url);
      if (!resp.ok) {
        alert(`${url} doesn't exist`);
        return;
      }
      var text = await resp.text();
      if (text == "") {
        alert(`${url} has no content`);
        return;
      }
      console.log(`loading ${url}`);
      await this.display(text);
    }

    async loadStream(e) {
      const file = e.target.files[0];
      const data = await new Response(file).text();
      const extension = file.name.split(".").pop();
      if (["mesh", "vtk", "msh"].includes(extension)) {
        await this.display("mesh\n" + data);
      } else {
        await this.display(data);
      }
    }

    setTouchDevice(status) {
      // TODO TMS
      //this.emglv_.then((g) => { g.setTouchDevice(status); });
    }

    async getHelpString() {
      var g = await this.emglv_;
      return g.getHelpString();
    }

    // NOTE: the resulting data is just a view and the view will be invalid
    // after subsequent aclls to `getScreenBuffer` or `getPNGURL` since they
    // all use the same underlying buffer
    async getScreenBuffer(flip_y = false) {
      return this._runLifecycle(async () => {
        // wait for any in-flight display/update (the queue guarantees this)
        // and refuse to return a frame from a failed or unrelated stream
        this._assertCapturable();
        var g = await this.emglv_;
        return this._captureScreen(g, flip_y);
      });
    }

    async getScreenBufferAsCanvas() {
      // do the capture and the canvas copy in one lifecycle slot so the
      // underlying buffer cannot be invalidated by another capture in between
      return this._runLifecycle(async () => {
        this._assertCapturable();
        var g = await this.emglv_;
        let data = this._captureScreen(g, true);
        const w = this.canvas_.width;
        const h = this.canvas_.height;
        // the renderer may reuse a larger buffer after a shrink; `ImageData`
        // needs exactly one frame, so keep only the canvas-sized prefix
        if (data.length > w * h * 4) {
          data = data.subarray(0, w * h * 4);
        }
        // idk why we need this but the `ImageData` ctor complains
        // when a Uint8Array is passed
        let clamped_data = new Uint8ClampedArray(data);
        let imdata = new ImageData(clamped_data, w, h);
        let can = document.createElement("canvas");
        can.width = w;
        can.height = h;
        let ctx = can.getContext("2d");
        ctx.putImageData(imdata, 0, 0);
        return can;
      });
    }

    async getPNGAsB64() {
      return this._runLifecycle(async () => {
        this._assertCapturable();
        var g = await this.emglv_;
        this._ensureSizeConsistent(g);
        return this._pngAsB64Now(g);
      });
    }

    _pngAsB64Now(g) {
      const data = g.getPNGByteArray();
      if (data === null) {
        throw "png data is null";
      }
      return btoa(
        data.reduce(function (data, byte) {
          return data + String.fromCharCode(byte);
        }, "")
      );
    }

    async getPNGURL() {
      return this._runLifecycle(async () => {
        this._assertCapturable();
        var g = await this.emglv_;
        this._ensureSizeConsistent(g);
        return "data:image/png;base64," + this._pngAsB64Now(g);
      });
    }

    async openScreenshotInTab() {
      const url = await this.getPNGURL();
      let tab = window.open("about:blank");
      tab.location.href = url;
    }

    async saveScreenshot(name = "glvis.png") {
      return this._runLifecycle(async () => {
        this._assertCapturable();
        var g = await this.emglv_;
        this._ensureSizeConsistent(g);
        const url = "data:image/png;base64," + this._pngAsB64Now(g);
        let link = document.createElement("a");
        link.download = name;
        link.href = url;
        link.click();
      });
    }

    // callbacks: f(State) -> void
    registerNewStreamCallback(f) {
      this.new_stream_callbacks.push(f);
    }
  }

  return {
    emglvis: emglvis,
    State: State,
    info: function () {
      console.log("hi from GLVis!");
    },
    rand_id: rand_id,
  };
});
