import { cropPixels, outputSize } from "./video-options.js";
import { withTimeout } from "./shared.js";

// Native capture frames drive the cropper; no rAF/setInterval drawing loop, no
// source video access, and at most one input/output frame is held at a time.
export class VideoCropper {
  constructor({ geometry, preset, onFormat = () => {}, onError = () => {} }) {
    Object.assign(this, { geometry, preset, onFormat, onError, closed: false });
  }
  async start(track) {
    if (!globalThis.MediaStreamTrackProcessor || !globalThis.VideoFrame || !globalThis.HTMLCanvasElement?.prototype.captureStream) {
      throw new Error("此 Chrome 不支持播放器裁剪，请更新 Chrome，或选择整个标签页。");
    }
    this.reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
    let resolveFirst, rejectFirst;
    const first = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
    this.cancelFirst = () => rejectFirst(new DOMException("裁剪已停止", "AbortError"));
    this.task = (async () => {
      try {
        while (!this.closed) {
          const { value: frame, done } = await this.reader.read();
          if (done) { if (!this.closed) throw new Error("视频采集帧已结束，请重新启动。"); break; }
          let cropped;
          try {
            if (this.closed) continue;
            const rect = cropPixels(frame, this.geometry);
            if (!this.size) {
              this.size = outputSize(rect, this.preset, this.geometry.sourceWidth / this.geometry.sourceHeight);
              // This canvas belongs only to the extension's Offscreen Document.
              // Canvas capture declares the selected FPS; its physical size
              // also determines actual encoded dimensions (display metadata
              // alone was ignored by Chrome's legacy generated tracks).
              this.canvas = document.createElement("canvas");
              this.canvas.width = this.size.width;
              this.canvas.height = this.size.height;
              this.context = this.canvas.getContext("2d", { alpha: false, desynchronized: true });
              if (!this.context) throw new Error("无法初始化视频缩放画布，请选择整个标签页。");
              this.context.imageSmoothingEnabled = true;
              this.context.imageSmoothingQuality = "high";
              this.track = this.canvas.captureStream(this.preset.fps).getVideoTracks()[0];
              if (!this.track?.requestFrame) throw new Error("此 Chrome 不支持画布帧采集，请更新 Chrome。");
            }
            // Physically scale our own cropped capture. Canvas timestamps use
            // capture time: processing can add a small A/V offset, so output
            // counts/settings must never be presented as sync measurements.
            // Never draw from a source-site DOM video or read JS pixel arrays.
            cropped = new VideoFrame(frame, { visibleRect: rect });
            this.context.drawImage(cropped, 0, 0, this.size.width, this.size.height);
            this.track.requestFrame();
            if (!this.closed) {
              const key = `${rect.width}x${rect.height}`;
              if (key !== this.formatKey) {
                this.formatKey = key;
                this.onFormat({ ...this.size, cropWidth: rect.width, cropHeight: rect.height,
                  captureWidth: frame.visibleRect?.width || frame.codedWidth, captureHeight: frame.visibleRect?.height || frame.codedHeight });
              }
              if (resolveFirst) { resolveFirst(); resolveFirst = null; }
            }
          } finally { cropped?.close(); frame.close(); }
        }
      } catch (error) {
        rejectFirst(error);
        if (!this.closed) this.onError(error);
      }
    })();
    await withTimeout(first, 10000);
    return this.track;
  }
  setGeometry(geometry) { this.geometry = geometry; }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.cancelFirst?.();
    this.track?.stop();
    await this.reader?.cancel().catch(() => {});
    await this.task;
    if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0; }
  }
}
