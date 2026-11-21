import { useEffect, useRef } from 'react';
import { syncPlan, videoRect, videoTimeFor } from '@/core/refVideo';
import { docStore } from '@/store/doc';
import { refVideoStore, setRefVideoMeta, useRefVideo } from '@/store/refVideo';
import { uiStore } from '@/store/ui';

/**
 * The reference video, drawn over the scene (below the bones and handles) at the opacity set in the Animation tools window, and kept in step
 * with the playhead: moved to the frame when paused, played along while the animation plays. It does not take part in the project.
 */
export function ReferenceVideo() {
  const state = useRefVideo();
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = video.current;
    const b = box.current;
    if (!v || !b || !state.url) return;
    const apply = () => {
      const ui = uiStore.get();
      const rv = refVideoStore.get();
      const vw = v.videoWidth || rv.width;
      const vh = v.videoHeight || rv.height;
      if (vw && vh) {
        const r = videoRect(ui.camera, b.clientWidth, b.clientHeight, rv.view, vw, vh);
        v.style.left = `${r.left}px`;
        v.style.top = `${r.top}px`;
        v.style.width = `${r.width}px`;
        v.style.height = `${r.height}px`;
        v.style.transform = ui.camera.flip ? 'scaleX(-1)' : '';
      }
      v.style.opacity = rv.show ? String(rv.view.opacity) : '0';
      if (!(v.duration > 0)) return;
      const plan = syncPlan(
        v.currentTime,
        videoTimeFor(ui.time, rv.view.offset, v.duration),
        ui.playing && rv.show,
        v.duration,
        docStore.get().skeleton.fps,
      );
      if (plan.seek !== null) v.currentTime = plan.seek;
      v.playbackRate = Math.min(16, Math.max(0.0625, ui.speed));
      if (plan.play && v.paused) void v.play().catch(() => {});
      else if (!plan.play && !v.paused) v.pause();
    };
    apply();
    const off = [uiStore.subscribe(apply), refVideoStore.subscribe(apply)];
    const ro = new ResizeObserver(apply);
    ro.observe(b);
    v.addEventListener('loadedmetadata', apply);
    v.addEventListener('seeked', apply);
    return () => {
      off.forEach((f) => f());
      ro.disconnect();
      v.removeEventListener('loadedmetadata', apply);
      v.removeEventListener('seeked', apply);
      v.pause();
    };
  }, [state.url]);

  if (!state.url) return null;
  return (
    <div ref={box} className="ref-video" aria-hidden="true">
      <video
        ref={video}
        src={state.url}
        muted
        playsInline
        preload="auto"
        onLoadedMetadata={(e) => setRefVideoMeta(e.currentTarget.videoWidth, e.currentTarget.videoHeight, e.currentTarget.duration)}
      />
    </div>
  );
}
