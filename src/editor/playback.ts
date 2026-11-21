import { uiStore } from '@/store/ui';
import { docStore } from '@/store/doc';
import { eventsBetween } from '@/core/animate';
import { findAnimation } from '@/core/edit';
import { playEventSound, soundCount } from '@/store/sounds';
import { DEFAULT_PLAY, advancePlayback, playOf, samePlay } from '@/core/playback';

/** `ui.loop`, `ui.pingPong` and `ui.range` mirror the play settings of the current animation (they live on the animation, see `setPlay`). */
function syncPlaySettings() {
  const ui = uiStore.get();
  const anim = findAnimation(docStore.get().skeleton, ui.animationId);
  const play = anim ? playOf(anim) : DEFAULT_PLAY;
  if (!samePlay(play, { loop: ui.loop, pingPong: ui.pingPong, range: ui.range }))
    uiStore.patch({ loop: play.loop, pingPong: play.pingPong, range: play.range });
}

/** Keeps the mirror in line with the document and the chosen animation; returns the stop function. */
export function startPlaySync(): () => void {
  syncPlaySettings();
  const offDoc = docStore.subscribe(syncPlaySettings);
  const offUi = uiStore.subscribe(syncPlaySettings);
  return () => {
    offDoc();
    offUi();
  };
}

/** Drives `ui.time` while playing. Runs for the whole app lifetime. */
export function startPlaybackLoop(): () => void {
  const stopSync = startPlaySync();
  let raf = 0;
  let last = performance.now();
  let dir: 1 | -1 = 1;
  let wasPlaying = false;
  const tick = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const ui = uiStore.get();
    if (ui.playing) {
      if (!wasPlaying) dir = 1; // every play starts forward
      const anim = findAnimation(docStore.get().skeleton, ui.animationId);
      if (!anim) uiStore.patch({ playing: false });
      else {
        const next = advancePlayback({ time: ui.time, dir }, dt * ui.speed, anim.duration, {
          loop: ui.loop,
          pingPong: ui.pingPong,
          range: ui.range,
        });
        // the events the playhead passes make their sound (when the person has loaded sound files)
        if (dir === 1 && next.dir === 1 && soundCount() > 0 && anim.events.length) {
          const passed =
            next.time >= ui.time
              ? eventsBetween(anim, ui.time, next.time)
              : [...eventsBetween(anim, ui.time, anim.duration), ...eventsBetween(anim, -1, next.time)];
          for (const k of passed) playEventSound(docStore.get().skeleton.events, k);
        }
        dir = next.dir;
        uiStore.patch(next.stopped ? { time: next.time, playing: false } : { time: next.time });
      }
    }
    wasPlaying = uiStore.get().playing;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    stopSync();
  };
}
