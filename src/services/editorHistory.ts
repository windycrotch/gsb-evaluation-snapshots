import { create } from 'zustand';
import { toast } from 'react-hot-toast';
import type { Asset } from '../types/editor';
import type { StoredScene } from './sceneStorage';
import { createProjectSnapshot, useEditorStore } from '../store/editorStore';

type Snapshot = { scene: StoredScene; assets: Asset[] };
type EncodedSnapshot = { scene: unknown; assets: unknown };
type HistoryData = { version: number; index: number; snapshots: EncodedSnapshot[] };
type Status = { ready: boolean; busy: boolean; canUndo: boolean; canRedo: boolean; error: string | null };

export const useHistoryStatus = create<Status>(() => ({
  ready: false, busy: false, canUndo: false, canRedo: false, error: null
}));

let id = '';
let history: HistoryData | null = null;
let queue: Promise<void> = Promise.resolve();
let active = false;
let group: { element: Element; time: number } | null = null;
const encodedAssets = new Map<string, Promise<string>>();
const decodedAssets = new Map<string, string>();

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/history/${path}`, init);
  if (!response.ok) {
    const body: { error?: string } = await response.json();
    throw new Error(body.error || `History request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function json(method: string, value: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

async function encode(value: unknown): Promise<unknown> {
  if (typeof value === 'string' && value.startsWith('data:')) {
    let task = encodedAssets.get(value);
    if (!task) {
      task = (async () => {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
        const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        await request(`${id}/blobs/${hash}`, json('PUT', value));
        decodedAssets.set(hash, value);
        return hash;
      })();
      encodedAssets.set(value, task);
      void task.catch(() => encodedAssets.delete(value));
    }
    return { $historyBlob: await task };
  }
  if (Array.isArray(value)) return Promise.all(value.map(encode));
  if (value && typeof value === 'object') {
    const entries = await Promise.all(Object.entries(value).filter(([, item]) => item !== undefined)
      .map(async ([key, item]) => [key, await encode(item)] as const));
    return Object.fromEntries(entries);
  }
  return value;
}

async function decode(value: unknown): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map(decode));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0][0] === '$historyBlob' &&
        typeof entries[0][1] === 'string' && /^[a-f0-9]{64}$/.test(entries[0][1])) {
      const hash = entries[0][1];
      let data = decodedAssets.get(hash);
      if (!data) {
        data = await request<string>(`${id}/blobs/${hash}`);
        if (typeof data !== 'string' || !data.startsWith('data:')) throw new Error('Invalid history asset');
        decodedAssets.set(hash, data);
        encodedAssets.set(data, Promise.resolve(hash));
      }
      return data;
    }
    return Object.fromEntries(await Promise.all(entries.map(async ([key, item]) => [key, await decode(item)] as const)));
  }
  return value;
}

function snapshot(): Snapshot {
  const state = useEditorStore.getState();
  return structuredClone({ scene: createProjectSnapshot(state.sceneObjects, state.sceneOptions), assets: state.assets });
}

function updateStatus() {
  useHistoryStatus.setState({ ready: active, canUndo: !!history && history.index > 0,
    canRedo: !!history && history.index < history.snapshots.length - 1 });
}

async function save() {
  if (!history) throw new Error('History is not initialized');
  const result = await request<{ version: number }>(id, json('PUT', {
    expectedVersion: history.version, history: { index: history.index, snapshots: history.snapshots }
  }));
  history.version = result.version;
  updateStatus();
}

function enqueue(operation: () => Promise<void>) {
  queue = queue.then(operation).catch(error => {
    if (!active && useHistoryStatus.getState().error) throw error;
    active = false;
    const message = error instanceof Error ? error.message : String(error);
    console.error('History error:', error);
    useHistoryStatus.setState({ ready: false, error: message });
    toast.error(`History could not be saved: ${message}`);
    throw error;
  });
  void queue.catch(() => {});
}

export function draftHistoryId() {
  let value = localStorage.getItem('editor-history-draft');
  if (!value) {
    value = crypto.randomUUID();
    localStorage.setItem('editor-history-draft', value);
  }
  return value;
}

export async function initializeHistory(projectId: string | null) {
  await flushHistory();
  active = false;
  useHistoryStatus.setState({ ready: false, error: null });
  id = projectId ?? draftHistoryId();
  history = await request<HistoryData | null>(id);
  const local = snapshot();
  if (!history) {
    history = { version: 0, index: 0, snapshots: [await encode(local) as EncodedSnapshot] };
    await save();
  } else {
    const localEncoded = await encode(local) as EncodedSnapshot;
    if (JSON.stringify(localEncoded) !== JSON.stringify(history.snapshots[history.index])) {
      history.snapshots = history.snapshots.slice(0, history.index + 1);
      history.snapshots.push(localEncoded);
      if (history.snapshots.length > 21) history.snapshots.shift();
      history.index = history.snapshots.length - 1;
      await save();
    }
  }
  group = null;
  active = true;
  updateStatus();
}

async function apply(value: Snapshot) {
  await useEditorStore.getState().loadScene(value.scene);
  useEditorStore.getState().setAssets(value.assets);
  await useEditorStore.getState().saveScene();
}

export function recordHistory(replace = false) {
  if (!active || useEditorStore.getState().isPlaying) return;
  const value = snapshot();
  const focused = document.activeElement;
  const input = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement;
  const now = Date.now();
  const merge = !replace && input && group?.element === focused && now - group.time < 750;
  group = !replace && input ? { element: focused, time: now } : null;
  enqueue(async () => {
    if (!history) throw new Error('History is not initialized');
    const encoded = await encode(value) as EncodedSnapshot;
    if (JSON.stringify(encoded) === JSON.stringify(history.snapshots[history.index])) return;
    if (replace || (merge && history.index > 0 && history.index === history.snapshots.length - 1)) {
      history.snapshots[history.index] = encoded;
    } else {
      history.snapshots = history.snapshots.slice(0, history.index + 1);
      history.snapshots.push(encoded);
      if (history.snapshots.length > 21) history.snapshots.shift();
      history.index = history.snapshots.length - 1;
    }
    await save();
  });
}

export async function flushHistory() {
  for (;;) {
    const pending = queue;
    await pending;
    if (pending === queue) return;
  }
}

export function disableHistory(error: unknown) {
  active = false;
  const message = error instanceof Error ? error.message : String(error);
  useHistoryStatus.setState({ ready: false, error: message });
}

export async function beginNewDraft() {
  await flushHistory();
  active = false;
  updateStatus();
  localStorage.setItem('editor-history-draft', crypto.randomUUID());
}

export async function transferHistory(projectId: string) {
  await flushHistory();
  if (!history || !active) throw new Error('History is unavailable');
  const pending = queue;
  const result = await request<{ version: number }>(projectId, json('PUT', {
    expectedVersion: 0, history: { index: history.index, snapshots: history.snapshots }
  }));
  if (pending !== queue) throw new Error('Project changed while transferring history; save again.');
  id = projectId;
  history.version = result.version;
  updateStatus();
}

export async function moveHistory(direction: -1 | 1) {
  if (!active || useHistoryStatus.getState().busy) return;
  useHistoryStatus.setState({ busy: true });
  try {
    await queue;
    if (!history) throw new Error('History is not initialized');
    const next = history.index + direction;
    if (next < 0 || next >= history.snapshots.length) return;
    const value = await decode(history.snapshots[next]) as Snapshot;
    await apply(value);
    history.index = next;
    await save();
    group = null;
  } catch (error) {
    active = false;
    const message = error instanceof Error ? error.message : String(error);
    useHistoryStatus.setState({ ready: false, error: message });
    console.error('History restore error:', error);
    toast.error(`Could not restore history: ${message}`);
  } finally {
    useHistoryStatus.setState({ busy: false });
  }
}
