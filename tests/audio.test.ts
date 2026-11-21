/** Event sounds (path, volume, balance): kept through export (JSON and binary) and import, as the official runtime reads them. */
import { describe, expect, it } from 'vitest';
import { jsonToBinary } from '../src/core/export/spineBinary';
import { importSpineJson } from '../src/core/import/spineJson';
import { repairProject, validateProject } from '../src/core/validate';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { buildFixture } from './fixture';
import { exportAndLoad, loadOfficialBinary } from './official';

function withAudio() {
  const { project } = buildFixture();
  const doc = project.skeleton;
  const hit = doc.events.find((e) => e.name === 'hit')!;
  hit.audio = 'sounds/hit.ogg';
  hit.volume = 0.6;
  hit.balance = -0.25;
  const walk = doc.animations.find((a) => a.name === 'walk')!;
  walk.events[0].volume = 0.9;
  walk.events[0].balance = 0.5;
  return { project, hit, walk };
}

function eventsOf(sd: any) {
  const timeline = sd.findAnimation('walk').timelines.find((t: any) => t.events);
  return timeline.events as any[];
}

describe('event sounds', () => {
  it('reach the official runtime from JSON', () => {
    const { project } = withAudio();
    const { skeletonData: sd } = exportAndLoad(project);
    const def = sd.findEvent('hit');
    expect(def.audioPath).toBe('sounds/hit.ogg');
    expect(def.setupPose.volume).toBeCloseTo(0.6, 5);
    expect(def.setupPose.balance).toBeCloseTo(-0.25, 5);
    const events = eventsOf(sd);
    expect(events[0].volume).toBeCloseTo(0.9, 5);
    expect(events[0].balance).toBeCloseTo(0.5, 5);
    expect(events[1].volume).toBeCloseTo(0.6, 5); // not overridden: the definition's
  });

  it('are the same in the binary file', () => {
    const { project } = withAudio();
    const { json, atlasText } = exportAndLoad(project);
    const sd = loadOfficialBinary(jsonToBinary(json as any), atlasText);
    const def = sd.findEvent('hit');
    expect(def.audioPath).toBe('sounds/hit.ogg');
    expect(def.setupPose.volume).toBeCloseTo(0.6, 5);
    expect(def.setupPose.balance).toBeCloseTo(-0.25, 5);
    const events = eventsOf(sd);
    expect(events[0].volume).toBeCloseTo(0.9, 5);
    expect(events[0].balance).toBeCloseTo(0.5, 5);
    expect(events[1].volume).toBeCloseTo(0.6, 5);
  });

  it('come back through our import, without a warning about audio', () => {
    const { project } = withAudio();
    const { json } = exportAndLoad(project);
    const back = importSpineJson(JSON.parse(JSON.stringify(json)));
    expect(back.warnings.some((w) => /audio/i.test(w))).toBe(false);
    const hit = back.project.skeleton.events.find((e) => e.name === 'hit')!;
    expect([hit.audio, hit.volume, hit.balance]).toEqual(['sounds/hit.ogg', 0.6, -0.25]);
    const walk = back.project.skeleton.animations.find((a) => a.name === 'walk')!;
    expect([walk.events[0].volume, walk.events[0].balance]).toEqual([0.9, 0.5]);
    expect(validateProject(back.project)).toEqual([]);
  });

  it('leave an event without sound alone', () => {
    const { project } = buildFixture();
    const { json } = exportAndLoad(project);
    expect((json as any).events.hit.audio).toBeUndefined();
    expect((json as any).animations.walk.events.some((e: any) => e.volume !== undefined)).toBe(false);
  });

  it('are repaired when damaged', () => {
    const { project, hit } = withAudio();
    (hit as any).volume = 7;
    (hit as any).balance = NaN;
    expect(repairProject(project).length).toBe(0); // clamped quietly
    expect([hit.volume, hit.balance]).toEqual([1, 0]);
    (hit as any).audio = 5;
    expect(repairProject(project).some((m) => /sound/.test(m))).toBe(true);
    expect(hit.audio).toBeUndefined();
    expect(hit.volume).toBeUndefined();
  });

  it('are edited with updateEvent, clamped, and cleared with an empty path', () => {
    const { project } = buildFixture();
    docStore.replace(project);
    const id = docStore.get().skeleton.events[0].id;
    A.updateEvent(id, { audio: ' sfx/a.wav ', volume: 3, balance: -4 });
    let e = docStore.get().skeleton.events[0];
    expect([e.audio, e.volume, e.balance]).toEqual(['sfx/a.wav', 1, -1]);
    A.updateEvent(id, { audio: '' });
    e = docStore.get().skeleton.events[0];
    expect([e.audio, e.volume, e.balance]).toEqual([undefined, undefined, undefined]);
    A.updateEvent(id, { volume: 0.5 }); // no sound: nothing to set
    expect(docStore.get().skeleton.events[0].volume).toBeUndefined();
  });
});

describe('event sounds and the official JSON loader', () => {
  it('get a volume and a balance on every key, since the loader takes the volume as the default balance', () => {
    const { project } = withAudio();
    const walk = project.skeleton.animations.find((a) => a.name === 'walk')!;
    delete walk.events[1].volume;
    delete walk.events[1].balance;
    const { json, skeletonData } = exportAndLoad(project);
    const keys = (json as any).animations.walk.events as any[];
    expect(keys.every((k) => typeof k.volume === 'number' && typeof k.balance === 'number')).toBe(true);
    // the key that overrides nothing plays with the balance of the definition (-0.25), not its volume (0.6)
    expect(eventsOf(skeletonData)[1].balance).toBeCloseTo(-0.25, 5);
  });
});
