import type { SceneObject } from '../types/editor';
import type { SceneTimeline, TimelineDevice, TimelineKeyframe, TimelineTrack } from '../types/timeline';
import type { Camera } from 'three';
import type * as Three from 'three';
import type { createTimelineMedia } from './TimelineMedia';

export function createTimeline(
  timeline: SceneTimeline,
  objects: SceneObject[],
  activeCameraId: string | undefined,
  camera: Camera,
  host: HTMLElement,
  reportError: (message: string) => void,
  three: typeof Three,
  makeMedia: typeof createTimelineMedia,
  preview = false,
  previewDevice?: TimelineDevice
) {
  const abort = new AbortController();
  const byId = new Map(objects.map(item => [item.id, item]));
  const elements = new Map<string, HTMLElement>();
  host.querySelectorAll<HTMLElement>('[data-web-id]').forEach(element => {
    if (element.dataset.webId) elements.set(element.dataset.webId, element);
  });
  const initialStyles = new Map<HTMLElement, { transform: string; opacity: string; animation: string }>();
  const webValues = new Map<string, { x: number; y: number; rotation: number; scale: number; opacity: number }>();
  const mediaStates = new Map<string, number>();
  const duration = timeline.duration;
  let time = 0;
  let playing = !preview && timeline.trigger === 'start';
  let pausedByKey = timeline.trigger === 'key';
  const timelineMedia = makeMedia(timeline, objects, three, reportError, preview);
  const validProperties = ['position.x', 'position.y', 'position.z', 'rotation.x', 'rotation.y', 'rotation.z',
    'scale.x', 'scale.y', 'scale.z', 'web.x', 'web.y', 'web.rotation', 'web.scale', 'web.opacity', 'media'];
  const seen = new Set<string>();
  const tracks: TimelineTrack[] = [];

  if (!Number.isFinite(duration) || duration <= 0 || !Array.isArray(timeline.tracks)) {
    reportError('Timeline duration or tracks are invalid.');
  } else {
    for (const track of timeline.tracks) {
      if (!track || typeof track !== 'object') {
        reportError('Invalid timeline track.');
        continue;
      }
      const item = byId.get(track.targetId);
      const valid = item && validProperties.includes(track.property) && Array.isArray(track.keyframes) &&
        track.keyframes.length > 0 && track.keyframes.every(key => key &&
          Number.isFinite(key.time) && key.time >= 0 && key.time <= duration && Number.isFinite(key.value) &&
          (key.easing === undefined || ['linear', 'ease-in', 'ease-out', 'smooth'].includes(key.easing)) &&
          (key.deviceValues === undefined || (key.deviceValues && typeof key.deviceValues === 'object' &&
            (key.deviceValues.tablet === undefined || Number.isFinite(key.deviceValues.tablet)) &&
            (key.deviceValues.mobile === undefined || Number.isFinite(key.deviceValues.mobile)) &&
            (track.property !== 'media' ||
              [key.deviceValues.tablet, key.deviceValues.mobile].every(value => value === undefined || value === 0 || value === 1)))) &&
          (track.property !== 'media' || key.value === 0 || key.value === 1)) &&
        new Set(track.keyframes.map(key => key.time)).size === track.keyframes.length &&
        !seen.has(`${track.targetId}:${track.property}`) &&
        (track.property.startsWith('web.') ? !!item.properties.web :
          track.property === 'media' ? ['audio', 'video'].includes(item.properties.web?.kind ?? '') : !item.properties.web);
      if (!valid) {
        reportError(`Invalid timeline track: ${track.targetId} / ${track.property}`);
        continue;
      }
      seen.add(`${track.targetId}:${track.property}`);
      tracks.push({ ...track, keyframes: [...track.keyframes].sort((a, b) => a.time - b.time) });
    }
  }

  function valueAt(track: TimelineTrack, at: number) {
    const device = previewDevice ?? (window.innerWidth <= 767 ? 'mobile' : window.innerWidth <= 1024 ? 'tablet' : 'desktop');
    const keyValue = (key: TimelineKeyframe) => device === 'desktop' ? key.value : key.deviceValues?.[device] ?? key.value;
    const keys = track.keyframes;
    if (at <= keys[0].time) return keyValue(keys[0]);
    for (let i = 1; i < keys.length; i++) {
      if (at <= keys[i].time) {
        if (track.property === 'media') return keyValue(at === keys[i].time ? keys[i] : keys[i - 1]);
        const ratio = (at - keys[i - 1].time) / (keys[i].time - keys[i - 1].time);
        const easing = keys[i - 1].easing;
        const progress = easing === 'ease-in' ? ratio * ratio :
          easing === 'ease-out' ? ratio * (2 - ratio) :
          easing === 'smooth' ? ratio * ratio * (3 - 2 * ratio) : ratio;
        return keyValue(keys[i - 1]) + (keyValue(keys[i]) - keyValue(keys[i - 1])) * progress;
      }
    }
    return keyValue(keys[keys.length - 1]);
  }

  function render(at: number) {
    timelineMedia.seek(at, !preview && (timeline.trigger !== 'key' || !pausedByKey));
    for (const track of tracks) {
      const item = byId.get(track.targetId)!;
      const value = valueAt(track, at);
      if (track.property === 'media') {
        const desired = pausedByKey ? 0 : value;
        if (preview || mediaStates.get(track.id) === desired) continue;
        const element = elements.get(track.targetId);
        if (!(element instanceof HTMLMediaElement)) {
          reportError(`${item.name}: timeline media element is unavailable.`);
          continue;
        }
        mediaStates.set(track.id, desired);
        if (desired === 0) element.pause();
        else void element.play().catch(error => {
          if (!abort.signal.aborted && mediaStates.get(track.id) === 1) {
            reportError(`${item.name}: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      } else if (track.property.startsWith('web.')) {
        const element = elements.get(track.targetId);
        if (!element) {
          reportError(`${item.name}: timeline web element is unavailable.`);
          continue;
        }
        if (!initialStyles.has(element)) initialStyles.set(element, {
          transform: element.style.transform, opacity: element.style.opacity, animation: element.style.animation
        });
        const values = webValues.get(item.id) ?? { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 };
        const field = track.property.slice(4) as keyof typeof values;
        values[field] = value;
        webValues.set(item.id, values);
      } else {
        const [kind, axis] = track.property.split('.') as ['position' | 'rotation' | 'scale', 'x' | 'y' | 'z'];
        const converted = kind === 'rotation' ? value * Math.PI / 180 : value;
        item.object[kind][axis] = converted;
        if (item.id === activeCameraId && (kind === 'position' || kind === 'rotation')) camera[kind][axis] = converted;
      }
    }
    for (const [id, values] of webValues) {
      const element = elements.get(id)!;
      const original = initialStyles.get(element)!;
      element.style.animation = 'none';
      element.style.transform = `${original.transform} translate(${values.x}px, ${values.y}px) rotate(${values.rotation}deg) scale(${values.scale})`;
      if (seen.has(`${id}:web.opacity`)) element.style.opacity = String(Math.max(0, Math.min(1, values.opacity)));
    }
  }

  function seek(value: number) {
    time = Math.max(0, Math.min(duration, value));
    render(time);
  }

  if (!preview && timeline.trigger === 'key') {
    window.addEventListener('keydown', event => {
      if (event.repeat || event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
      if (!timeline.key || event.key.toLowerCase() !== timeline.key.toLowerCase()) return;
      if (!playing && time >= duration) time = 0;
      playing = !playing;
      pausedByKey = !playing;
    }, { signal: abort.signal });
  }
  const scroll = host.querySelector<HTMLElement>('.engine-web-scroll');
  if (!preview && timeline.trigger === 'scroll') {
    if (!scroll) reportError('Timeline scroll trigger requires web content.');
    else {
      const updateScroll = () => seek(scroll.scrollHeight > scroll.clientHeight
        ? duration * scroll.scrollTop / (scroll.scrollHeight - scroll.clientHeight) : 0);
      scroll.addEventListener('scroll', updateScroll, { passive: true, signal: abort.signal });
      updateScroll();
    }
  } else if (Number.isFinite(duration) && duration > 0) seek(0);

  return {
    seek,
    update(delta: number) {
      if (playing && timeline.trigger !== 'scroll') {
        seek(time + Math.max(0, delta));
        if (time >= duration) playing = false;
      } else render(time);
    },
    stop() {
      abort.abort();
      timelineMedia.stop();
      for (const [element, style] of initialStyles) {
        element.style.transform = style.transform;
        element.style.opacity = style.opacity;
        element.style.animation = style.animation;
      }
    }
  };
}
