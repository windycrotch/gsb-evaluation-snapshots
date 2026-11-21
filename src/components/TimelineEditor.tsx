import { useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useEditorStore } from '../store/editorStore';
import type { SceneObject } from '../types/editor';
import type { SceneTimeline, TimelineClip, TimelineDevice, TimelineKeyframe, TimelineProperty, TimelineSound, TimelineTrack } from '../types/timeline';

const defaults: SceneTimeline = { duration: 5, trigger: 'start', key: '', tracks: [] };
const threeProperties: TimelineProperty[] = [
  'position.x', 'position.y', 'position.z', 'rotation.x', 'rotation.y', 'rotation.z',
  'scale.x', 'scale.y', 'scale.z'
];
const webProperties: TimelineProperty[] = ['web.x', 'web.y', 'web.rotation', 'web.scale', 'web.opacity'];

function initialValue(object: SceneObject, property: TimelineProperty): number {
  if (property === 'media') return 0;
  if (property === 'web.scale' || property === 'web.opacity') return 1;
  if (property.startsWith('web.')) return 0;
  const [kind, axis] = property.split('.') as ['position' | 'rotation' | 'scale', 'x' | 'y' | 'z'];
  const value = object.object[kind][axis];
  return kind === 'rotation' ? value * 180 / Math.PI : value;
}

export function TimelineEditor() {
  const { sceneObjects, selectedObject, sceneOptions, updateSceneOptions, timelinePreviewTime, setTimelinePreviewTime,
    timelinePreviewDevice, setTimelinePreviewDevice } = useEditorStore();
  const timeline = sceneOptions.timeline ?? defaults;
  const [property, setProperty] = useState<TimelineProperty>('position.x');
  const [drag, setDrag] = useState<{ trackId: string; keyId: string; time: number } | null>(null);
  const [segmentDrag, setSegmentDrag] = useState<{ id: string; start: number; offset: number } | null>(null);
  const [clipIndex, setClipIndex] = useState(0);
  const [soundId, setSoundId] = useState('');
  const available = selectedObject?.properties.web
    ? [...webProperties, ...(['audio', 'video'].includes(selectedObject.properties.web.kind) ? ['media' as const] : [])]
    : threeProperties;
  const selectedProperty = available.includes(property) ? property : available[0];
  const selectedClipIndex = selectedObject?.object.animations[clipIndex] ? clipIndex : 0;
  const selectedSoundId = selectedObject?.properties.sounds?.some(sound => sound.id === soundId)
    ? soundId : selectedObject?.properties.sounds?.[0]?.id ?? '';
  useEffect(() => () => { useEditorStore.getState().setTimelinePreviewTime(null); }, []);
  const update = (changes: Partial<SceneTimeline>) => updateSceneOptions({ timeline: { ...timeline, ...changes } });
  const updateTrack = (id: string, changes: Partial<TimelineTrack>) =>
    update({ tracks: timeline.tracks.map(track => track.id === id ? { ...track, ...changes } : track) });
  const setKeyValue = (track: TimelineTrack, keyId: string, value: number | undefined) => {
    updateTrack(track.id, { keyframes: track.keyframes.map(key => {
      if (key.id !== keyId) return key;
      if (timelinePreviewDevice === 'desktop') return value === undefined ? key : { ...key, value };
      return { ...key, deviceValues: { ...key.deviceValues, [timelinePreviewDevice]: value } };
    }) });
  };
  const displayedValue = (key: TimelineKeyframe) => timelinePreviewDevice === 'desktop'
    ? key.value : key.deviceValues?.[timelinePreviewDevice] ?? key.value;

  function addTrack() {
    if (!selectedObject) { toast.error('Select an object first'); return; }
    if (timeline.tracks.some(track => track.targetId === selectedObject.id && track.property === selectedProperty)) {
      toast.error('That timeline channel already exists'); return;
    }
    const value = initialValue(selectedObject, selectedProperty);
    update({ tracks: [...timeline.tracks, {
      id: crypto.randomUUID(), targetId: selectedObject.id, property: selectedProperty,
      keyframes: [
        { id: crypto.randomUUID(), time: 0, value },
        { id: crypto.randomUUID(), time: timeline.duration, value }
      ]
    }] });
  }

  function addXYZ() {
    if (!selectedObject || selectedObject.properties.web) return;
    const category = selectedProperty.split('.')[0];
    if (!['position', 'rotation', 'scale'].includes(category)) return;
    const existing = new Set(timeline.tracks.filter(track => track.targetId === selectedObject.id).map(track => track.property));
    const additions = threeProperties.filter(value => value.startsWith(`${category}.`) && !existing.has(value)).map(value => {
      const current = initialValue(selectedObject, value);
      return { id: crypto.randomUUID(), targetId: selectedObject.id, property: value, keyframes: [
        { id: crypto.randomUUID(), time: 0, value: current },
        { id: crypto.randomUUID(), time: timeline.duration, value: current }
      ] };
    });
    if (!additions.length) { toast.error('All XYZ channels already exist'); return; }
    update({ tracks: [...timeline.tracks, ...additions] });
  }

  function addClip() {
    if (!selectedObject || selectedObject.type !== 'model') return;
    const source = selectedObject.object.animations[selectedClipIndex];
    if (!source || !Number.isFinite(source.duration) || source.duration <= 0) { toast.error('Select a valid GLB clip'); return; }
    const clips = timeline.clips ?? [];
    const start = clips.filter(clip => clip.targetId === selectedObject.id)
      .reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
    if (start >= timeline.duration) { toast.error('Increase timeline duration to add another clip'); return; }
    update({ clips: [...clips, { id: crypto.randomUUID(), targetId: selectedObject.id, clipIndex: selectedClipIndex,
      start, duration: Math.min(source.duration, timeline.duration - start) }] });
  }

  function addSound() {
    const sound = selectedObject?.properties.sounds?.find(item => item.id === soundId) ?? selectedObject?.properties.sounds?.[0];
    if (!selectedObject || !sound) { toast.error('Select an attached sound'); return; }
    update({ sounds: [...(timeline.sounds ?? []), { id: crypto.randomUUID(), targetId: selectedObject.id,
      soundId: sound.id, start: 0, duration: Math.min(1, timeline.duration) }] });
  }

  function setSegment(kind: 'clip' | 'sound', id: string, changes: { start?: number; duration?: number }) {
    const segments = kind === 'clip' ? timeline.clips ?? [] : timeline.sounds ?? [];
    const current = segments.find(segment => segment.id === id);
    if (!current) return;
    const next = { ...current, ...changes };
    if (!Number.isFinite(next.start) || !Number.isFinite(next.duration) || next.start < 0 ||
        next.duration <= 0 || next.start + next.duration > timeline.duration + 1e-8) {
      toast.error('Segment must fit within the timeline and have a positive duration'); return;
    }
    if (kind === 'clip' && (timeline.clips ?? []).some(other => other.id !== id && other.targetId === next.targetId &&
      next.start < other.start + other.duration - 1e-8 && other.start < next.start + next.duration - 1e-8)) {
      toast.error('GLB clips on the same model cannot overlap'); return;
    }
    if (kind === 'clip') update({ clips: (timeline.clips ?? []).map(item => item.id === id ? { ...item, ...changes } : item) });
    else update({ sounds: (timeline.sounds ?? []).map(item => item.id === id ? { ...item, ...changes } : item) });
  }

  function setKeyTime(track: TimelineTrack, keyId: string, time: number) {
    const rounded = Math.round(Math.max(0, Math.min(timeline.duration, time)) * 100) / 100;
    if (track.keyframes.some(key => key.id !== keyId && key.time === rounded)) {
      toast.error('Keyframes on a channel must have different times'); return;
    }
    updateTrack(track.id, { keyframes: track.keyframes.map(key => key.id === keyId ? { ...key, time: rounded } : key) });
  }

  function segmentRow(kind: 'clip' | 'sound', segment: TimelineClip | TimelineSound) {
    const object = sceneObjects.find(item => item.id === segment.targetId);
    const name = kind === 'clip' && 'clipIndex' in segment
      ? object?.object.animations[segment.clipIndex]?.name || `Clip ${segment.clipIndex + 1}`
      : 'soundId' in segment ? object?.properties.sounds?.find(sound => sound.id === segment.soundId)?.name ?? 'Missing sound' : '';
    return <div key={segment.id} className="rounded bg-gray-700 p-2">
      <div className="flex items-center gap-2">
        <span className="w-36 shrink-0 truncate">{object?.name ?? 'Missing object'} — {name}</span>
        <div aria-label={`${kind} segment track`} className="relative mx-3 h-6 flex-1 rounded bg-gray-800">
          {timelinePreviewTime !== null && <span aria-hidden="true" className="pointer-events-none absolute z-10 h-full w-0.5 bg-rose-400"
            style={{ left: `${100 * Math.min(timeline.duration, timelinePreviewTime) / timeline.duration}%` }} />}
          <button aria-label={`Drag ${kind} ${name}`} title={`${name}: ${segment.start.toFixed(2)}s`}
            className={`absolute h-full overflow-hidden rounded px-1 text-left touch-none ${kind === 'clip' ? 'bg-violet-600' : 'bg-emerald-700'}`}
            style={{ left: `${100 * (segmentDrag?.id === segment.id ? segmentDrag.start : segment.start) / timeline.duration}%`,
              width: `${100 * segment.duration / timeline.duration}%` }}
            onPointerDown={event => {
              const rect = event.currentTarget.parentElement!.getBoundingClientRect();
              event.currentTarget.setPointerCapture(event.pointerId);
              setSegmentDrag({ id: segment.id, start: segment.start,
                offset: (event.clientX - rect.left) / rect.width * timeline.duration - segment.start });
            }}
            onPointerMove={event => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId) || !segmentDrag) return;
              const rect = event.currentTarget.parentElement!.getBoundingClientRect();
              setSegmentDrag({ ...segmentDrag, start: Math.max(0, Math.min(timeline.duration - segment.duration,
                (event.clientX - rect.left) / rect.width * timeline.duration - segmentDrag.offset)) });
            }}
            onPointerUp={event => {
              const rect = event.currentTarget.parentElement!.getBoundingClientRect();
              const start = Math.round(Math.max(0, Math.min(timeline.duration - segment.duration,
                (event.clientX - rect.left) / rect.width * timeline.duration - (segmentDrag?.offset ?? 0))) * 100) / 100;
              setSegment(kind, segment.id, { start });
              setSegmentDrag(null);
            }}
            onPointerCancel={() => setSegmentDrag(null)}>{name}</button>
        </div>
        <button aria-label={`Delete ${kind} ${name}`} className="w-12 shrink-0 text-red-300" onClick={() => {
          if (kind === 'clip') update({ clips: (timeline.clips ?? []).filter(item => item.id !== segment.id) });
          else update({ sounds: (timeline.sounds ?? []).filter(item => item.id !== segment.id) });
        }}>Remove</button>
      </div>
      <div className="flex gap-2">
        <label>Start
          <input aria-label={`${kind} ${name} start`} type="number" min="0" max={timeline.duration} step="0.01"
            value={segment.start} className="block w-20 rounded bg-gray-900 p-1"
            onChange={event => { if (event.target.value !== '') setSegment(kind, segment.id, { start: Number(event.target.value) }); }} />
        </label>
        <label>Duration
          <input aria-label={`${kind} ${name} duration`} type="number" min="0.01" max={timeline.duration} step="0.01"
            value={segment.duration} className="block w-20 rounded bg-gray-900 p-1"
            onChange={event => { if (event.target.value !== '') setSegment(kind, segment.id, { duration: Number(event.target.value) }); }} />
        </label>
      </div>
    </div>;
  }

  return <section aria-label="Timeline editor" className="space-y-2 text-xs">
    <div className="flex flex-wrap items-end gap-2">
      <label>Duration (seconds)
        <input aria-label="Timeline duration" type="number" min="0.1" max="600" step="0.1" value={timeline.duration}
          className="block w-24 rounded bg-gray-900 p-1"
          onChange={event => {
            const duration = Number(event.target.value);
            if (!Number.isFinite(duration) || duration < 0.1 || duration > 600) return;
            if (timeline.tracks.some(track => track.keyframes.some(key => key.time > duration))) {
              toast.error('Move or remove keyframes beyond the new duration first'); return;
            }
            if ([...(timeline.clips ?? []), ...(timeline.sounds ?? [])].some(segment => segment.start + segment.duration > duration + 1e-8)) {
              toast.error('Move or shorten segments beyond the new duration first'); return;
            }
            update({ duration });
          }} />
      </label>
      <label>Trigger
        <select aria-label="Timeline trigger" value={timeline.trigger} className="block rounded bg-gray-900 p-1"
          onChange={event => update({ trigger: event.target.value as SceneTimeline['trigger'] })}>
          <option value="start">Play on start</option><option value="key">Keyboard toggle</option><option value="scroll">Page scroll</option>
        </select>
      </label>
      {timeline.trigger === 'key' && <label>Key
        <input aria-label="Timeline key" value={timeline.key} maxLength={20} className="block w-24 rounded bg-gray-900 p-1"
          onChange={event => update({ key: event.target.value })} />
      </label>}
      <label>Device values
        <select aria-label="Timeline device" value={timelinePreviewDevice} className="block rounded bg-gray-900 p-1"
          onChange={event => setTimelinePreviewDevice(event.target.value as TimelineDevice)}>
          <option value="desktop">Desktop</option><option value="tablet">Tablet</option><option value="mobile">Mobile</option>
        </select>
      </label>
      <label>Channel for {selectedObject?.name ?? 'selected object'}
        <select aria-label="Timeline channel" value={selectedProperty} onChange={event => setProperty(event.target.value as TimelineProperty)}
          className="block rounded bg-gray-900 p-1">
          {available.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <button onClick={addTrack} disabled={!selectedObject} className="rounded bg-blue-700 px-2 py-1 disabled:opacity-50">Add channel</button>
      <button onClick={addXYZ} disabled={!selectedObject || !!selectedObject.properties.web} className="rounded bg-blue-700 px-2 py-1 disabled:opacity-50">Add XYZ</button>
      <button onClick={() => setTimelinePreviewTime(timelinePreviewTime === null ? 0 : null)}
        aria-pressed={timelinePreviewTime !== null} className="rounded bg-gray-600 px-2 py-1">
        {timelinePreviewTime === null ? 'Preview' : 'Close preview'}
      </button>
      {timelinePreviewTime !== null && <label>Preview time: {timelinePreviewTime.toFixed(2)}s
        <input aria-label="Timeline preview time" type="range" min="0" max={timeline.duration} step="0.01"
          value={Math.min(timeline.duration, timelinePreviewTime)} className="block"
          onChange={event => setTimelinePreviewTime(Number(event.target.value))} />
      </label>}
    </div>
    <div className="flex flex-wrap items-end gap-2">
      {selectedObject?.type === 'model' && selectedObject.object.animations.length > 0 && <>
        <label>GLB clip
          <select aria-label="Timeline GLB clip" value={selectedClipIndex} onChange={event => setClipIndex(Number(event.target.value))}
            className="block rounded bg-gray-900 p-1">
            {selectedObject.object.animations.map((clip, index) => <option key={index} value={index}>{clip.name || `Clip ${index + 1}`}</option>)}
          </select>
        </label>
        <button onClick={addClip} className="rounded bg-violet-700 px-2 py-1">Add GLB clip</button>
      </>}
      {!!selectedObject?.properties.sounds?.length && <>
        <label>Object sound
          <select aria-label="Timeline object sound" value={selectedSoundId} onChange={event => setSoundId(event.target.value)}
            className="block rounded bg-gray-900 p-1">
            {selectedObject.properties.sounds.map(sound => <option key={sound.id} value={sound.id}>{sound.name}</option>)}
          </select>
        </label>
        <button onClick={addSound} className="rounded bg-emerald-700 px-2 py-1">Add object sound</button>
      </>}
    </div>
    <p className="text-gray-400">Drag diamonds to change time. Easing applies until the next key. Tablet and mobile values inherit desktop until changed; times and easing are shared. Device selection previews values, not the 3D viewport aspect ratio. Media uses 0 = pause, 1 = play; preview is silent.</p>
    {timeline.trigger === 'scroll' && <p className="text-amber-300">Scroll needs web content taller than the viewport.</p>}
    {timeline.trigger === 'key' && !timeline.key && <p className="text-amber-300">Choose a key for the timeline.</p>}
    <div className="editor-scrollbar max-h-64 overflow-auto">
     <div className="min-w-[34rem] space-y-2">
      <div className="flex items-center rounded bg-slate-900 py-2">
        <span className="w-40 shrink-0 px-2 font-semibold text-slate-300">Object / Channel</span>
        <div aria-label="Timeline ruler" className="relative mx-3 h-6 flex-1 cursor-crosshair border-b border-slate-500"
          onPointerDown={event => {
            const rect = event.currentTarget.getBoundingClientRect();
            setTimelinePreviewTime(Math.max(0, Math.min(timeline.duration, (event.clientX - rect.left) / rect.width * timeline.duration)));
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const rect = event.currentTarget.getBoundingClientRect();
            setTimelinePreviewTime(Math.max(0, Math.min(timeline.duration, (event.clientX - rect.left) / rect.width * timeline.duration)));
          }}>
          {Array.from({ length: 6 }, (_, index) => <span key={index}
            style={{ left: `${index * 20}%` }} className="absolute top-0 -translate-x-1/2 text-slate-300">
            {(timeline.duration * index / 5).toFixed(1)}s
          </span>)}
          {timelinePreviewTime !== null && <span aria-hidden="true" className="absolute bottom-0 top-0 w-0.5 bg-rose-400"
            style={{ left: `${100 * Math.min(timeline.duration, timelinePreviewTime) / timeline.duration}%` }} />}
        </div>
        <span className="w-16 shrink-0" />
      </div>
      {timeline.tracks.length === 0 && !(timeline.clips?.length || timeline.sounds?.length) && <p className="text-gray-400">Select an object and add a channel.</p>}
      {timeline.tracks.map(track => {
        const object = sceneObjects.find(item => item.id === track.targetId);
        return <div key={track.id} className="rounded bg-gray-700 p-2">
          <div className="flex items-center gap-2">
            <span className="w-36 shrink-0 truncate">{object?.name ?? 'Missing object'} — {track.property}</span>
            <div className="relative mx-3 my-3 h-2 flex-1 rounded bg-gray-500" aria-label={`${track.property} keyframe track`}>
              {timelinePreviewTime !== null && <span aria-hidden="true" className="pointer-events-none absolute -top-2 h-6 w-0.5 bg-rose-400"
                style={{ left: `${100 * Math.min(timeline.duration, timelinePreviewTime) / timeline.duration}%` }} />}
              {track.keyframes.map(key => <button key={key.id} aria-label={`Drag ${track.property} keyframe at ${key.time} seconds`}
                className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-sky-400 touch-none"
                style={{ left: `${100 * (drag?.keyId === key.id ? drag.time : key.time) / timeline.duration}%` }}
                onPointerDown={event => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setDrag({ trackId: track.id, keyId: key.id, time: key.time });
                }}
                onPointerMove={event => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                  const rect = event.currentTarget.parentElement!.getBoundingClientRect();
                  setDrag({ trackId: track.id, keyId: key.id, time: Math.max(0, Math.min(timeline.duration, (event.clientX - rect.left) / rect.width * timeline.duration)) });
                }}
                onPointerUp={event => {
                  const rect = event.currentTarget.parentElement!.getBoundingClientRect();
                  setKeyTime(track, key.id, (event.clientX - rect.left) / rect.width * timeline.duration);
                  setDrag(null);
                }}
                onPointerCancel={() => setDrag(null)} />)}
            </div>
            <button aria-label={`Delete ${object?.name ?? 'missing'} ${track.property} channel`}
              onClick={() => update({ tracks: timeline.tracks.filter(item => item.id !== track.id) })} className="w-12 shrink-0 text-red-300">Remove</button>
          </div>
          <div className="flex flex-wrap gap-2">
            {[...track.keyframes].sort((a, b) => a.time - b.time).map(key => <div key={key.id} className="flex items-end gap-1">
              <label>Time
                <input aria-label={`${track.property} keyframe time`} type="number" min="0" max={timeline.duration} step="0.01"
                  value={key.time} className="block w-16 rounded bg-gray-900 p-1"
                  onChange={event => { if (event.target.value !== '' && Number.isFinite(Number(event.target.value))) setKeyTime(track, key.id, Number(event.target.value)); }} />
              </label>
              <label>Value
                <input aria-label={`${track.property} keyframe value`} type="number" step={track.property === 'media' ? 1 : 0.1}
                  min={track.property === 'media' ? 0 : undefined} max={track.property === 'media' ? 1 : undefined}
                  value={displayedValue(key)} className="block w-20 rounded bg-gray-900 p-1"
                  onChange={event => {
                    if (event.target.value === '') return;
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value) || (track.property === 'media' && value !== 0 && value !== 1)) return;
                    setKeyValue(track, key.id, value);
                  }} />
              </label>
              {timelinePreviewDevice !== 'desktop' && key.deviceValues?.[timelinePreviewDevice] !== undefined &&
                <button aria-label={`Reset ${track.property} ${timelinePreviewDevice} value at ${key.time} seconds`}
                  className="rounded bg-gray-600 px-2 py-1" onClick={() => setKeyValue(track, key.id, undefined)}>Use desktop</button>}
              {track.property !== 'media' && track.keyframes.some(next => next.time > key.time) && <label>Easing to next key
                <select aria-label={`${track.property} keyframe easing at ${key.time} seconds`} value={key.easing ?? 'linear'}
                  className="block rounded bg-gray-900 p-1"
                  onChange={event => updateTrack(track.id, { keyframes: track.keyframes.map(item =>
                    item.id === key.id ? { ...item, easing: event.target.value as 'linear' | 'ease-in' | 'ease-out' | 'smooth' } : item) })}>
                  <option value="linear">Constant speed</option><option value="ease-in">Accelerate</option>
                  <option value="ease-out">Decelerate</option><option value="smooth">Smooth start and stop</option>
                </select>
              </label>}
              {object && !object.properties.web && <button aria-label={`Capture ${track.property} at ${key.time} seconds`}
                title="Capture the object's current transform" className="rounded bg-gray-600 px-2 py-1"
                onClick={() => setKeyValue(track, key.id, initialValue(object, track.property))}>Capture</button>}
              <button aria-label={`Delete ${track.property} keyframe at ${key.time} seconds`} disabled={track.keyframes.length === 1}
                className="p-1 text-red-300 disabled:opacity-30"
                onClick={() => updateTrack(track.id, { keyframes: track.keyframes.filter(item => item.id !== key.id) })}>×</button>
            </div>)}
            <button className="self-end rounded bg-gray-600 px-2 py-1" onClick={() => {
              const time = Math.round(timeline.duration * 50) / 100;
              if (track.keyframes.some(key => key.time === time)) { toast.error('A keyframe already exists at the midpoint'); return; }
              updateTrack(track.id, { keyframes: [...track.keyframes, { id: crypto.randomUUID(), time, value: track.keyframes[0].value }] });
            }}>Add keyframe</button>
          </div>
        </div>;
      })}
      {(timeline.clips ?? []).map(segment => segmentRow('clip', segment))}
      {(timeline.sounds ?? []).map(segment => segmentRow('sound', segment))}
     </div>
    </div>
  </section>;
}
