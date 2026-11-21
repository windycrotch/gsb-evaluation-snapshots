import type { SceneObject } from '../types/editor';
import type { StoredNamedScene } from './sceneStorage';
import type { Asset } from '../types/editor';
import { isValidWebParent, newWebElement, type WebElement, type WebElementKind } from '../types/web';
import { restoreSceneObject } from './sceneObjects';
import { createSceneObjectFromModel, loadGLBModel } from './modelLoader';
import type { SceneOptions } from '../store/editorStore';
import type { SceneTimeline, TimelineTrack } from '../types/timeline';

export interface SceneEdit {
  objectId: string;
  javascript?: string;
  css?: string;
  web?: AgentWebStyle;
}

type AgentWebStyle = Partial<Pick<WebElement, 'text' | 'background' | 'backgroundMode' | 'color' | 'fontSize' |
  'padding' | 'pointerMode' | 'layoutDirection' | 'alignItems' | 'justifyContent'>>;

export interface SceneProposal {
  summary: string;
  edits: SceneEdit[];
  additions: SceneAddition[];
  removals: string[];
  timelineTracks: TimelineTrack[];
}

const primitiveTypes = ['box', 'sphere', 'cylinder', 'cone', 'ground', 'pointLight', 'spotLight', 'camera'] as const;
const webTypes = ['section', 'columns', 'container', 'card', 'slider', 'slide', 'heading', 'text', 'button', 'menu', 'image', 'video', 'audio', 'lottie'] as const;
type PrimitiveType = typeof primitiveTypes[number];
type AdditionBase = { name: string; position?: [number, number, number]; javascript?: string };
export type SceneAddition =
  | (AdditionBase & { kind: 'primitive'; type: PrimitiveType })
  | (AdditionBase & { kind: 'web'; type: WebElementKind; parentId: string | null; text?: string; css?: string; sceneId?: string })
  | (AdditionBase & { kind: 'asset'; assetId: string; usage: '3d' | 'web'; parentId: string | null; css?: string });

function withoutMedia(value: unknown): unknown {
  if (typeof value === 'string') return value.startsWith('data:') ? '[embedded media]' : value;
  if (Array.isArray(value)) return value.map(withoutMedia);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, key === 'lottieData' && item ? '[embedded Lottie JSON]' : withoutMedia(item)]));
  }
  return value;
}

export function sceneAgentContext(
  objects: SceneObject[], assets: Asset[], scenes: StoredNamedScene[],
  activeSceneId: string, sceneOptions: SceneOptions, selectedId?: string
) {
  const describeObject = (item: Pick<SceneObject, 'id' | 'name' | 'type' | 'properties'>) => ({
    id: item.id, name: item.name, type: item.type,
    gameengine_type: item.properties.web?.kind ?? item.type,
    properties: withoutMedia(item.properties)
  });
  return {
    activeSceneId, sceneName: sceneOptions.name, selectedId: selectedId ?? null,
    gameengine_actions: {
      addscenebutton: 'Add a web button with sceneId set to an existing destination scene id.'
    },
    timeline: withoutMedia(sceneOptions.timeline ?? { duration: 5, trigger: 'start', key: '', tracks: [] }),
    scenes: scenes.map(scene => ({ id: scene.id, name: scene.id === activeSceneId ? sceneOptions.name : scene.sceneOptions.name,
      ...(scene.id !== activeSceneId ? { timeline: withoutMedia(scene.sceneOptions.timeline),
        objects: scene.objects.map(describeObject) } : {}) })),
    assets: assets.map(({ id, name, type, metadata }) => ({ id, name, type, gameengine_type: `asset:${type}`, metadata })),
    objects: objects.map(item => ({
      ...describeObject(item),
      clips: item.type === 'model' ? item.object.animations.map((clip, index) => ({ index, name: clip.name, duration: clip.duration })) : undefined
    }))
  };
}

export function parseSceneProposal(text: string, objects: SceneObject[], assets: Asset[] = [], timeline?: SceneTimeline,
  scenes: StoredNamedScene[] = [], activeSceneId?: string): SceneProposal {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Assistant response must be a JSON object.');
  const proposal = parsed as Record<string, unknown>;
  if (Object.keys(proposal).some(key => !['summary', 'edits', 'additions', 'removals', 'timelineTracks'].includes(key)) ||
      typeof proposal.summary !== 'string' || proposal.summary.length > 2000 ||
      (proposal.edits !== undefined && !Array.isArray(proposal.edits)) ||
      (proposal.additions !== undefined && !Array.isArray(proposal.additions)) ||
      (proposal.removals !== undefined && !Array.isArray(proposal.removals)) ||
      (proposal.timelineTracks !== undefined && !Array.isArray(proposal.timelineTracks))) {
    throw new Error('Assistant response must contain a summary and valid change lists.');
  }
  const rawEdits = (proposal.edits ?? []) as unknown[];
  const rawAdditions = (proposal.additions ?? []) as unknown[];
  const rawRemovals = (proposal.removals ?? []) as unknown[];
  const rawTracks = (proposal.timelineTracks ?? []) as unknown[];
  if (!rawEdits.length && !rawAdditions.length && !rawRemovals.length && !rawTracks.length) throw new Error('Assistant proposed no changes.');
  if (rawEdits.length + rawAdditions.length + rawRemovals.length + rawTracks.length > 50) throw new Error('Assistant proposed more than 50 changes.');
  const removals = rawRemovals.map(value => {
    if (typeof value !== 'string' || !objects.some(item => item.id === value)) throw new Error('Assistant referenced an unknown object to remove.');
    return value;
  });
  if (new Set(removals).size !== removals.length) throw new Error('Duplicate object removal.');
  const seen = new Set<string>();
  const edits: SceneEdit[] = rawEdits.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid assistant edit.');
    const edit = value as Record<string, unknown>;
    if (Object.keys(edit).some(key => !['objectId', 'javascript', 'css', 'web'].includes(key)) ||
        typeof edit.objectId !== 'string' || seen.has(edit.objectId)) throw new Error('Invalid or duplicate object ID in assistant edits.');
    const object = objects.find(item => item.id === edit.objectId);
    if (!object) throw new Error(`Assistant referenced an unknown object: ${edit.objectId}`);
    if (removals.includes(edit.objectId)) throw new Error(`${object.name}: cannot edit and remove the same object.`);
    seen.add(edit.objectId);
    if (edit.javascript === undefined && edit.css === undefined && edit.web === undefined) throw new Error(`${object.name}: edit contains no changes.`);
    if (edit.javascript !== undefined && (typeof edit.javascript !== 'string' || edit.javascript.length > 20000)) throw new Error(`${object.name}: invalid JavaScript.`);
    if (edit.css !== undefined && (typeof edit.css !== 'string' || edit.css.length > 10000 || /[{}]/.test(edit.css) || !object.properties.web)) {
      throw new Error(`${object.name}: CSS must be declarations on a web component.`);
    }
    validateCode(object.name, !!object.properties.web, edit.javascript, edit.css);
    const web = edit.web === undefined ? undefined : validateWebStyle(object.name, edit.web);
    if (web && !object.properties.web) throw new Error(`${object.name}: visual settings require a web component.`);
    return { objectId: edit.objectId, ...(typeof edit.javascript === 'string' ? { javascript: edit.javascript } : {}),
      ...(typeof edit.css === 'string' ? { css: edit.css } : {}), ...(web ? { web } : {}) };
  });
  const additions: SceneAddition[] = rawAdditions.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid addition.');
    const item = value as Record<string, unknown>;
    if (!['primitive', 'web', 'asset'].includes(String(item.kind)) ||
        typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100) throw new Error('Each addition requires a valid kind and name.');
    const allowed = item.kind === 'primitive' ? ['kind', 'name', 'type', 'position', 'javascript'] :
      item.kind === 'web' ? ['kind', 'name', 'type', 'parentId', 'text', 'javascript', 'css', 'sceneId'] :
        ['kind', 'name', 'assetId', 'usage', 'parentId', 'position', 'javascript', 'css'];
    if (Object.keys(item).some(key => !allowed.includes(key))) throw new Error(`${item.name}: unsupported addition field.`);
    let position: [number, number, number] | undefined;
    if (item.position !== undefined) {
      if (!Array.isArray(item.position) || item.position.length !== 3 ||
          item.position.some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 10000)) throw new Error(`${item.name}: invalid position.`);
      position = [item.position[0], item.position[1], item.position[2]];
    }
    if (item.javascript !== undefined && (typeof item.javascript !== 'string' || item.javascript.length > 20000)) throw new Error(`${item.name}: invalid JavaScript.`);
    const javascript = typeof item.javascript === 'string' ? item.javascript : undefined;
    if (item.css !== undefined && (typeof item.css !== 'string' || item.css.length > 10000 || /[{}]/.test(item.css))) throw new Error(`${item.name}: invalid CSS declarations.`);
    const css = typeof item.css === 'string' ? item.css : undefined;
    if (item.kind === 'primitive') {
      if (!primitiveTypes.some(type => type === item.type)) throw new Error(`${item.name}: unsupported primitive type.`);
      validateCode(item.name, false, javascript);
      return { kind: 'primitive', type: item.type as PrimitiveType, name: item.name, position, javascript };
    }
    let webKind: WebElementKind;
    if (item.kind === 'web') {
      if (!webTypes.some(type => type === item.type)) throw new Error(`${item.name}: unsupported web component type.`);
      if (item.text !== undefined && (typeof item.text !== 'string' || item.text.length > 10000)) throw new Error(`${item.name}: invalid web text.`);
      if (item.sceneId !== undefined && (item.type !== 'button' || typeof item.sceneId !== 'string' ||
          item.sceneId === activeSceneId || !scenes.some(scene => scene.id === item.sceneId))) {
        throw new Error(`${item.name}: invalid destination scene for button.`);
      }
      webKind = item.type as WebElementKind;
    } else {
      const asset = assets.find(asset => asset.id === item.assetId);
      if (!asset || !['3d', 'web'].includes(String(item.usage))) throw new Error(`${item.name}: invalid asset or usage.`);
      if ((asset.type === '3d' && item.usage !== '3d') || (['audio', 'video'].includes(asset.type) && item.usage !== 'web')) {
        throw new Error(`${item.name}: asset type does not support that usage.`);
      }
      webKind = asset.type === '2d' ? 'image' : asset.type === 'audio' ? 'audio' : 'video';
    }
    const isWeb = item.kind === 'web' || item.usage === 'web';
    const parentId = item.parentId ?? null;
    if (parentId !== null && typeof parentId !== 'string') throw new Error(`${item.name}: invalid parent.`);
    if (!isWeb && (parentId !== null || css !== undefined)) throw new Error(`${item.name}: 3D assets cannot have web CSS or a web parent.`);
    if (isWeb) {
      const parent = parentId === null ? undefined : objects.find(object => object.id === parentId);
      if ((parentId !== null && (!parent?.properties.web || removals.includes(parentId))) || !isValidWebParent(webKind, parent?.properties.web?.kind)) {
        throw new Error(`${item.name}: invalid or deleted web parent.`);
      }
    }
    validateCode(item.name, isWeb, javascript, css);
    if (item.kind === 'web') return { kind: 'web', type: webKind, name: item.name, parentId, text: item.text as string | undefined,
      sceneId: item.sceneId as string | undefined, javascript, css };
    return { kind: 'asset', name: item.name, assetId: item.assetId as string, usage: item.usage as '3d' | 'web', parentId, position, javascript, css };
  });
  const properties = ['position.x', 'position.y', 'position.z', 'rotation.x', 'rotation.y', 'rotation.z',
    'scale.x', 'scale.y', 'scale.z', 'web.x', 'web.y', 'web.rotation', 'web.scale', 'web.opacity'] as const;
  const seenTracks = new Set((timeline?.tracks ?? []).map(track => `${track.targetId}:${track.property}`));
  const timelineTracks: TimelineTrack[] = rawTracks.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid timeline track.');
    const track = value as Record<string, unknown>;
    if (Object.keys(track).some(key => !['targetId', 'property', 'keyframes'].includes(key)) ||
        typeof track.targetId !== 'string' || typeof track.property !== 'string' ||
        !properties.some(property => property === track.property) || !Array.isArray(track.keyframes) ||
        track.keyframes.length < 2 || track.keyframes.length > 100) throw new Error('Invalid timeline track.');
    const object = objects.find(item => item.id === track.targetId);
    if (!object || removals.includes(track.targetId) || track.property.startsWith('web.') !== !!object.properties.web) {
      throw new Error('Timeline target or property is invalid.');
    }
    const key = `${track.targetId}:${track.property}`;
    if (seenTracks.has(key)) throw new Error('A timeline track for this target and property already exists.');
    seenTracks.add(key);
    let previous = -1;
    const keyframes = track.keyframes.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid timeline keyframe.');
      const frame = value as Record<string, unknown>;
      if (Object.keys(frame).some(key => !['time', 'value', 'easing'].includes(key)) ||
          typeof frame.time !== 'number' || !Number.isFinite(frame.time) || frame.time < 0 || frame.time <= previous ||
          frame.time > (timeline?.duration ?? 5) || typeof frame.value !== 'number' || !Number.isFinite(frame.value) ||
          Math.abs(frame.value) > 10000 || (track.property === 'web.opacity' && (frame.value < 0 || frame.value > 1)) ||
          (frame.easing !== undefined && !['linear', 'ease-in', 'ease-out', 'smooth'].includes(String(frame.easing)))) {
        throw new Error('Invalid or unordered timeline keyframe.');
      }
      previous = frame.time;
      return { id: crypto.randomUUID(), time: frame.time, value: frame.value,
        ...(frame.easing !== undefined ? { easing: frame.easing as 'linear' | 'ease-in' | 'ease-out' | 'smooth' } : {}) };
    });
    return { id: crypto.randomUUID(), targetId: track.targetId, property: track.property as TimelineTrack['property'], keyframes };
  });
  return { summary: proposal.summary, edits, additions, removals, timelineTracks };
}

function validateWebStyle(name: string, value: unknown): AgentWebStyle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}: invalid web settings.`);
  const patch = value as Record<string, unknown>;
  const allowed = ['text', 'background', 'backgroundMode', 'color', 'fontSize', 'padding',
    'pointerMode', 'layoutDirection', 'alignItems', 'justifyContent'];
  if (!Object.keys(patch).length || Object.keys(patch).some(key => !allowed.includes(key))) throw new Error(`${name}: unsupported web setting.`);
  for (const [key, item] of Object.entries(patch)) {
    if (key === 'text' && (typeof item !== 'string' || item.length > 10000)) throw new Error(`${name}: invalid web text.`);
    if ((key === 'background' || key === 'color') &&
        (typeof item !== 'string' || item.length > 100 || !CSS.supports('color', item))) throw new Error(`${name}: invalid ${key}.`);
    if ((key === 'fontSize' || key === 'padding') &&
        (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 1000)) throw new Error(`${name}: invalid ${key}.`);
    const choices: Record<string, string[]> = { backgroundMode: ['legacy', 'transparent', 'solid', 'gradient'],
      pointerMode: ['auto', 'pass-through'], layoutDirection: ['default', 'row', 'column'],
      alignItems: ['start', 'center', 'end', 'stretch'], justifyContent: ['start', 'center', 'end', 'space-between'] };
    if (key in choices && (typeof item !== 'string' || !choices[key].includes(item))) throw new Error(`${name}: invalid ${key}.`);
  }
  return patch as AgentWebStyle;
}

function validateCode(name: string, isWeb: boolean, javascript?: unknown, css?: unknown) {
  if (typeof css === 'string' && css.trim()) {
    const style = document.createElement('span').style;
    style.cssText = css;
    if (!style.length) throw new Error(`${name}: CSS contains no valid declarations.`);
  }
  if (typeof javascript === 'string' && javascript.trim()) {
    try {
      new Function(isWeb ? 'element' : 'object', 'scene', 'camera', 'THREE', 'state', 'openScene', 'scenes', javascript);
    } catch (error) {
      throw new Error(`${name}: invalid JavaScript: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export async function prepareSceneAdditions(additions: SceneAddition[], assets: Asset[]): Promise<SceneObject[]> {
  const result: SceneObject[] = [];
  for (const addition of additions) {
    try {
      result.push(...await prepareSceneAddition(addition, assets));
    } catch (error) {
      throw new Error(`Could not prepare ${addition.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

async function prepareSceneAddition(addition: SceneAddition, assets: Asset[]): Promise<SceneObject[]> {
  const asset = addition.kind === 'asset' ? assets.find(item => item.id === addition.assetId) : undefined;
  if (addition.kind === 'asset' && !asset) throw new Error('Asset is no longer available.');
  const position: [number, number, number] = addition.kind === 'web' ? [0, 0, 0] : addition.position ?? [0, 0, 0];
  if (asset?.type === '3d') {
    const item = createSceneObjectFromModel(await loadGLBModel(asset.url), addition.name, asset.url);
    item.object.position.fromArray(position);
    item.properties.position = position;
    item.properties.script = addition.javascript;
    return [item];
  }
  const isWeb = addition.kind === 'web' || (addition.kind === 'asset' && addition.usage === 'web');
  let webKind: WebElementKind | undefined;
  if (addition.kind === 'web') webKind = addition.type;
  else if (isWeb && asset) webKind = asset.type === '2d' ? 'image' : asset.type === 'audio' ? 'audio' : 'video';
  const web = webKind && addition.kind !== 'primitive' ? newWebElement(webKind, addition.parentId) : undefined;
  if (web && addition.kind === 'web' && addition.text !== undefined) web.text = addition.text;
  if (web && addition.kind === 'web' && addition.sceneId) {
    web.action = 'scene';
    web.targetId = addition.sceneId;
  }
  if (web && asset) {
    web.text = addition.name;
    if (asset.type === '2d') web.image = asset.url;
    else if (asset.type === 'audio') web.audio = asset.url;
    else if (asset.type === 'video') web.video = asset.url;
  }
  if (web && addition.kind !== 'primitive') { web.script = addition.javascript ?? ''; web.customCss = addition.css; }
  const type = web ? 'web' : asset?.type === '2d' ? 'imagePlane' : addition.kind === 'primitive' ? addition.type : '';
  const record = {
    id: crypto.randomUUID(), name: addition.name, type,
    properties: { position, rotation: [type === 'ground' ? -90 : 0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number], ...(web ? { web } : { script: addition.javascript }),
      ...(addition.kind === 'primitive' ? {
        color: type === 'pointLight' || type === 'spotLight' ? '#ffffff' : '#808080',
        ...(type === 'ground' ? { receiveShadow: true } : {})
      } : {}),
      ...(type === 'imagePlane' && asset ? { map: asset.url } : {}) }
  };
  const result = [await restoreSceneObject(record)];
  if (web?.kind === 'slider') {
    const slide = { id: crypto.randomUUID(), name: 'Slide 1', type: 'web', properties: {
      position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number], web: newWebElement('slide', record.id)
    } };
    result.push(await restoreSceneObject(slide));
  }
  return result;
}
