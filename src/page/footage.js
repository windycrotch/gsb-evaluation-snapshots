// Footage for scene pages: decodes a video file inside the page with Mediabunny (WebCodecs), one frame per renderAt.
// Served by the render server and the viewer at /__motlab/footage.js, so a scene page imports it the same way in both:
//
//   const { openFootage } = await import('/__motlab/footage.js');
//   const clip = await openFootage('clips/demo.mp4');        // path relative to the page, like an <img src>
//   const f = await clip.frame(t);                            // the frame shown at t seconds into the file
//   f.draw(ctx, 0, 0, W, H);                                  // or f.toCanvasImageSource() for a WebGL texture
//
// A frame stays valid until the next clip.frame() call. Rotation metadata (phone footage) is applied by f.draw.
// Sequential calls (render, playback) decode each frame once; a jump backwards or far ahead seeks from a keyframe.
import * as MB from './mediabunny.mjs';

export async function openFootage(path) {
  const url = new URL(path, document.baseURI);
  const input = new MB.Input({ source: new MB.UrlSource(url), formats: MB.ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error(`${path} has no video track`);
  if (!(await track.canDecode())) throw new Error(`${path}: this browser cannot decode ${track.codec}`);
  const sink = new MB.VideoSampleSink(track), first = await track.getFirstTimestamp(), duration = await track.computeDuration() - first;

  let it = null, cur = null, next = null;
  const pull = async () => { const r = await it.next(); return r.done ? null : r.value; };
  async function seek(at) {
    await it?.return(); cur?.close(); next?.close();
    it = sink.samples(at); cur = await pull(); next = cur && await pull();
  }
  return {
    width: track.displayWidth, height: track.displayHeight, duration,
    async frame(t) {
      const at = first + Math.min(Math.max(0, t), Math.max(0, duration - 1e-6));
      if (!cur || at < cur.timestamp || (next && at > next.timestamp + 1)) await seek(at);
      while (next && next.timestamp <= at + 1e-6) { cur.close(); cur = next; next = await pull(); }
      if (!cur) throw new Error(`${path}: no frame at ${t.toFixed(3)} s`);
      return cur;
    },
    close() { it?.return(); cur?.close(); next?.close(); input.dispose(); },
  };
}
