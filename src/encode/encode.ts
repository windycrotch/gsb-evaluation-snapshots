import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_MEDIUM,
  canEncodeVideo,
} from 'mediabunny';
import { renderFrame, type RenderOptions } from '../render/renderFrame';
import type { Timeline } from '../timeline';
import { UnsupportedError } from './errors';

export { UnsupportedError };


export interface EncodeOptions extends RenderOptions {
  fps: number;
  onProgress?: (fraction: number) => void;
  /** Cancels rendering (the Cancel button): releases the encoder and throws AbortError. */
  signal?: AbortSignal;
}

/** Whether the device has a WebCodecs H.264 encoder for this size. */
export async function canEncodeMp4(width: number, height: number): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false;
  return canEncodeVideo('avc', { width, height, quality: QUALITY_MEDIUM });
}

/**
 * Deterministic frame-by-frame render → H.264 → MP4.
 * Frames are streamed into the encoder and never accumulated in memory (important on iOS Safari).
 * TODO: captureStream + MediaRecorder fallback for devices without WebCodecs.
 */
export async function encodeMp4(timeline: Timeline, opts: EncodeOptions): Promise<Blob> {
  const { width, height, fps, onProgress, signal } = opts;
  if (!(await canEncodeMp4(width, height))) {
    throw new UnsupportedError('H.264 encoding is not supported');
  }

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new UnsupportedError('Canvas 2D is not available');

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec: 'avc', bitrate: QUALITY_MEDIUM, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  const frameCount = Math.ceil(timeline.duration * fps);
  const dt = 1 / fps;
  for (let i = 0; i < frameCount; i++) {
    if (signal?.aborted) {
      await output.cancel();
      throw new DOMException('Render cancelled', 'AbortError');
    }
    const t = i * dt;
    renderFrame(ctx, timeline, t, opts);
    await source.add(t, dt); // awaiting respects encoder backpressure
    onProgress?.((i + 1) / frameCount);
  }

  await output.finalize();
  const buffer = output.target.buffer;
  if (!buffer) throw new Error('Encoding produced an empty result');
  return new Blob([buffer], { type: 'video/mp4' });
}

function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}
