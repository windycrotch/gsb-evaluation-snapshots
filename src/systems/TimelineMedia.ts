import type * as Three from 'three';
import type { SceneObject } from '../types/editor';
import type { SceneTimeline, TimelineClip, TimelineSound } from '../types/timeline';

export function createTimelineMedia(
  timeline: SceneTimeline,
  objects: SceneObject[],
  three: typeof Three,
  reportError: (message: string) => void,
  preview: boolean
) {
  const clips = new Map<string, TimelineClip[]>();
  const mixers = new Map<string, Three.AnimationMixer>();
  const activeClips = new Map<string, string>();
  const sounds = new Map<string, {
    segment: TimelineSound;
    audio: HTMLAudioElement;
    active: boolean;
    suspended: boolean;
    lastOffset: number;
  }>();
  const clipIds = new Set<string>();
  const soundIds = new Set<string>();
  const find = (id: string) => objects.find(item => item.id === id);
  let stopped = false;
  let previousTime: number | undefined;

  if (timeline.clips !== undefined && !Array.isArray(timeline.clips)) reportError('Invalid timeline clip list.');
  else for (const segment of timeline.clips ?? []) {
    const item = segment && find(segment.targetId);
    const clip = item?.object.animations[segment.clipIndex];
    const list = clips.get(segment?.targetId) ?? [];
    if (!item || item.type !== 'model' || !clip || !segment.id || clipIds.has(segment.id) ||
        !Number.isInteger(segment.clipIndex) || !Number.isFinite(clip.duration) || clip.duration <= 0 ||
        !Number.isFinite(segment.start) || segment.start < 0 ||
        !Number.isFinite(segment.duration) || segment.duration <= 0 ||
        segment.start + segment.duration > timeline.duration + 1e-8 ||
        list.some(other => segment.start < other.start + other.duration - 1e-8 &&
          other.start < segment.start + segment.duration - 1e-8)) {
      reportError(`Invalid or overlapping timeline clip: ${segment?.id ?? '(missing)'}`);
      continue;
    }
    clipIds.add(segment.id);
    list.push(segment);
    clips.set(segment.targetId, list);
  }
  for (const list of clips.values()) list.sort((a, b) => a.start - b.start);

  if (timeline.sounds !== undefined && !Array.isArray(timeline.sounds)) reportError('Invalid timeline sound list.');
  else for (const segment of timeline.sounds ?? []) {
    const item = segment && find(segment.targetId);
    const sound = item?.properties.sounds?.find(value => value.id === segment.soundId);
    if (!sound || typeof sound.url !== 'string' || !sound.url || !Number.isFinite(sound.volume) ||
        sound.volume < 0 || sound.volume > 1 || !segment.id || soundIds.has(segment.id) ||
        !Number.isFinite(segment.start) || segment.start < 0 ||
        !Number.isFinite(segment.duration) || segment.duration <= 0 ||
        segment.start + segment.duration > timeline.duration + 1e-8) {
      reportError(`Invalid timeline sound: ${segment?.id ?? '(missing)'}`);
      continue;
    }
    soundIds.add(segment.id);
    if (!preview) {
      const audio = new Audio(sound.url);
      audio.volume = sound.volume;
      audio.loop = sound.loop;
      audio.preload = 'auto';
      const state = { segment, audio, active: false, suspended: false, lastOffset: 0 };
      // The duration of a looped sound is needed for modulo alignment. Metadata
      // may arrive after the first seek, so re-apply the pending offset then.
      audio.addEventListener('loadedmetadata', () => {
        if (audio.loop && Number.isFinite(audio.duration) && audio.duration > 0 &&
            state.lastOffset >= audio.duration) {
          audio.currentTime = state.lastOffset % audio.duration;
        }
      });
      sounds.set(segment.id, state);
    }
  }

  function seek(time: number, running: boolean) {
    for (const [id, list] of clips) {
      const item = find(id)!;
      const segment = [...list].reverse().find(value => time >= value.start);
      let mixer = mixers.get(id);
      if (!segment) {
        if (mixer && activeClips.has(id)) {
          mixer.stopAllAction();
          activeClips.delete(id);
        }
        continue;
      }
      if (!mixer) {
        mixer = new three.AnimationMixer(item.object);
        mixers.set(id, mixer);
      }
      const clip = item.object.animations[segment.clipIndex];
      if (activeClips.get(id) !== segment.id) {
        mixer.stopAllAction();
        const action = mixer.clipAction(clip);
        action.reset().play();
        action.paused = true;
        activeClips.set(id, segment.id);
      }
      const action = mixer.clipAction(clip);
      action.time = Math.min(clip.duration, segment.duration, Math.max(0, time - segment.start));
      mixer.update(0);
    }
    const jumped = previousTime !== undefined && (time < previousTime || time - previousTime > 0.3 ||
      timeline.trigger === 'scroll' && time !== previousTime);
    for (const state of sounds.values()) {
      const { segment, audio } = state;
      const shouldPlay = running && time >= segment.start && time < segment.start + segment.duration;
      const insideSegment = time >= segment.start && time < segment.start + segment.duration;
      if (!shouldPlay) {
        // Pausing while still inside the segment only suspends playback, so a
        // resume without a jump keeps its position. A jump while paused (or
        // leaving the segment) invalidates that position: relocate right away
        // so the sound stays in sync even while paused, and keep the suspended
        // marker so the following resume does not relocate a second time.
        if (state.active) {
          audio.pause();
          state.active = false;
        }
        if (!running && insideSegment) {
          if (jumped) {
            const offset = Math.max(0, time - segment.start);
            state.lastOffset = offset;
            audio.currentTime = audio.loop && Number.isFinite(audio.duration) && audio.duration > 0
              ? offset % audio.duration : offset;
          }
          state.suspended = true;
        } else {
          state.suspended = false;
        }
        continue;
      }
      const offset = Math.max(0, time - segment.start);
      if (!state.active) {
        // Fresh entry: resume-without-jump keeps the position, every other entry
        // (first entry, segment re-entry, jump while paused) re-aligns.
        if (!state.suspended || jumped) {
          state.lastOffset = offset;
          audio.currentTime = audio.loop && Number.isFinite(audio.duration) && audio.duration > 0
            ? offset % audio.duration : offset;
        }
        state.active = true;
        state.suspended = false;
        void audio.play().catch(error => {
          if (!stopped && state.active) reportError(`Timeline sound: ${error instanceof Error ? error.message : String(error)}`);
        });
      } else if (jumped) {
        // Time jumped mid-playback: relocate to the offset inside the segment.
        state.lastOffset = offset;
        audio.currentTime = audio.loop && Number.isFinite(audio.duration) && audio.duration > 0
          ? offset % audio.duration : offset;
      }
    }
    previousTime = time;
  }

  return {
    seek,
    stop() {
      stopped = true;
      for (const mixer of mixers.values()) {
        mixer.stopAllAction();
        mixer.uncacheRoot(mixer.getRoot());
      }
      for (const { audio } of sounds.values()) {
        audio.pause();
        audio.currentTime = 0;
        audio.removeAttribute('src');
        audio.load();
      }
    }
  };
}
