/** Project persistence: new / save / open / autosave (IndexedDB). Images are embedded as data URLs. */
import { packageEntries } from '@/core/export/packageProject';
import type { PackageImage } from '@/core/export/packageProject';
import { encodeInWorker } from './encodeInWorker';
import { emptyProject, migrateProject } from '@/core/model';
import type { Project } from '@/core/model';
import { repairProject } from '@/core/validate';
import type { BackupWhy } from '@/core/backups';
import { assets, blobToDataURL, dataURLToBlob } from './assets';
import type { ImageAsset } from './assets';
import { describeProject, hasContent, maybeAutoBackup, readBackupText, saveBackup } from './backups';
import { docStore } from './doc';
import { LEGACY_DB, idbGet, idbSet } from './idb';
import { forgetRecent, recentHandle, rememberRecent } from './recent';
import type { FileHandle } from './recent';
import { settingsStore } from './settings';
import { emptySelection, toast, uiStore } from './ui';

interface ProjectFile {
  bone2d?: 1;
  /** Signature of files written before the project was renamed from "Marrow"; they still open. */
  marrow?: 1;
  project: Project;
  images: Record<string, string>;
  ui?: { camera?: { x: number; y: number; zoom: number } };
}

const dataUrlCache = new Map<string, string>();

async function assetDataURL(name: string, a: ImageAsset | undefined = assets.get(name)): Promise<string | null> {
  if (!a) return null;
  const key = `${name}@${a.version}`;
  let url = dataUrlCache.get(key);
  if (!url) {
    url = await blobToDataURL(a.blob);
    dataUrlCache.set(key, url);
  }
  return url;
}

export async function serializeProject(): Promise<string> {
  const project = docStore.get();
  // the pictures are taken now, before the first await: the caller may replace them as soon as it gets control back
  const held = project.images.map((img) => ({ name: img.name, asset: assets.get(img.name) }));
  const images: Record<string, string> = {};
  for (const img of held) {
    const url = await assetDataURL(img.name, img.asset);
    if (url) images[img.name] = url;
  }
  const file: ProjectFile = { bone2d: 1, project, images, ui: { camera: uiStore.get().camera } };
  return JSON.stringify(file);
}

/** The project a project file holds with its pictures (name -> data URL), read without opening it (nothing in the editor changes). Null when the text is not a Bone 2D project file. */
export function readProjectWithPictures(text: string): { project: Project; pictures: Record<string, string> } | null {
  try {
    const file = JSON.parse(text) as ProjectFile;
    if (
      !file ||
      typeof file !== 'object' ||
      (file.bone2d !== 1 && file.marrow !== 1) ||
      !file.project?.skeleton ||
      typeof file.project.skeleton !== 'object'
    )
      return null;
    repairProject(file.project);
    const pictures = file.images && typeof file.images === 'object' ? file.images : {};
    return { project: migrateProject(file.project), pictures };
  } catch {
    return null;
  }
}

/** The project a project file holds, read without opening it (nothing in the editor changes). Null when the text is not a Bone 2D project file. */
export function readProjectFile(text: string): Project | null {
  return readProjectWithPictures(text)?.project ?? null;
}

export interface LoadReport {
  /** Problems found in the file and fixed while opening it (dangling ids, stale deform keys, NaN ...). */
  repaired: string[];
  /** Images that could not be decoded (their attachments stay, the export lists them as missing). */
  failedImages: string[];
}

/** Takes a backup copy of the open project (the History window lists it); resolves to whether one was added. */
export function backupCurrent(why: BackupWhy): Promise<boolean> {
  if (!hasContent()) return Promise.resolve(false);
  const info = describeProject();
  return serializeProject().then(
    (text) => saveBackup(text, why, info),
    () => false,
  );
}

/** Brings a backup copy back as the open project; what was open is backed up first, so the restore can be taken back too. */
export async function restoreBackup(id: string): Promise<boolean> {
  const text = await readBackupText(id);
  if (!text) {
    toast('That backup could not be read', 'error');
    return false;
  }
  await backupCurrent('restore');
  try {
    await loadProjectText(text);
    docStore.dirty = true;
    toast('Backup restored', 'ok');
    return true;
  } catch (e) {
    toast(`Could not restore the backup: ${(e as Error).message}`, 'error');
    return false;
  }
}

export async function loadProjectText(text: string): Promise<LoadReport> {
  if (docStore.dirty) void backupCurrent('open'); // unsaved work is not lost by opening something else
  const file = JSON.parse(text) as ProjectFile;
  if ((file.bone2d !== 1 && file.marrow !== 1) || !file.project?.skeleton) throw new Error('Not a Bone 2D project file');
  // Everything that can fail happens BEFORE the open project is touched: a damaged file must never wipe the session.
  const failedImages: string[] = [];
  // all pictures at once: the browser decodes them off the main thread, so a rig of many pictures opens in the time of the slowest one
  const tried = await Promise.all(
    Object.keys(file.images ?? {}).map(async (name) => {
      try {
        return await assets.decode(name, await dataURLToBlob(file.images[name]));
      } catch (e) {
        console.warn(`image "${name}" could not be decoded`, e);
        failedImages.push(name);
        return null;
      }
    }),
  );
  const decoded = tried.filter((a): a is ImageAsset => a !== null);
  const repaired = repairProject(file.project);
  if (repaired.length) console.warn('project repaired while opening:', repaired);
  assets.replaceAll(decoded);
  docStore.replace(migrateProject(file.project));
  const doc = file.project.skeleton;
  uiStore.patch({
    mode: 'setup',
    selection: emptySelection,
    animationId: doc.animations[0]?.id ?? null,
    skinId: null,
    time: 0,
    playing: false,
    overrides: {},
    selectedKeys: [],
    ...(file.ui?.camera ? { camera: file.ui.camera } : {}),
  });
  return { repaired, failedImages };
}

export function newProject(name = 'untitled') {
  if (docStore.dirty) void backupCurrent('new');
  currentHandle = null;
  assets.clear();
  docStore.replace(emptyProject(name));
  uiStore.patch({
    mode: 'setup',
    selection: emptySelection,
    animationId: null,
    skinId: null,
    time: 0,
    playing: false,
    overrides: {},
    selectedKeys: [],
    camera: { x: 0, y: 120, zoom: 1.2 },
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 2000);
}
export { downloadBlob };

/** The file the open project belongs to, when it came from / went to a file picker that gave us a handle: Save writes to it again. */
let currentHandle: FileHandle | null = null;

type Pickers = {
  showSaveFilePicker?: (o: unknown) => Promise<FileHandle>;
  showOpenFilePicker?: (o: unknown) => Promise<FileHandle[]>;
};
const pickers = () => window as unknown as Pickers;

/** Asks for write access to a file the browser remembers from an earlier visit; true when we have it. */
async function canWrite(handle: FileHandle): Promise<boolean> {
  try {
    if (!handle.queryPermission || !handle.requestPermission) return true;
    if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

async function writeTo(handle: FileHandle, blob: Blob) {
  const w = await handle.createWritable();
  await w.write(blob);
  await w.close();
  docStore.dirty = false;
  void rememberRecent(handle);
  toast(`Saved ${handle.name}`, 'ok');
}

/** Package Project: one ZIP with the project file and the pictures as files of their own (an `images` folder). */
export async function packageProject() {
  const text = await serializeProject();
  const project = docStore.get();
  const images: PackageImage[] = [];
  for (const img of project.images) {
    const a = assets.get(img.name);
    if (a) images.push({ name: img.name, type: a.blob.type, bytes: new Uint8Array(await a.blob.arrayBuffer()) });
  }
  const name = (project.name || 'untitled').replace(/[^\w\- ]+/g, '_');
  const zip = await encodeInWorker({ kind: 'zip', files: packageEntries(name, text, images) }).result;
  downloadBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), `${name}.zip`);
  toast(`Packaged the project, pictures: ${images.length}`, 'ok');
}

/** Save writes to the file the project was opened from or saved to; the first save (or "Save as") asks where. */
export async function saveProjectFile(saveAs = false) {
  const text = await serializeProject();
  const name = (docStore.get().name || 'untitled').replace(/[^\w\- ]+/g, '_');
  const blob = new Blob([text], { type: 'application/json' });
  if (currentHandle && !saveAs && (await canWrite(currentHandle))) {
    try {
      await writeTo(currentHandle, blob);
      return;
    } catch (e) {
      console.warn('could not write to the open file, asking where to save instead', e);
      currentHandle = null;
    }
  }
  const picker = pickers().showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: `${name}.bone2d`,
        types: [{ description: 'Bone 2D project', accept: { 'application/json': ['.bone2d'] } }],
      });
      await writeTo(handle, blob);
      currentHandle = handle;
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  downloadBlob(blob, `${name}.bone2d`);
  docStore.dirty = false;
  toast('Project downloaded', 'ok');
}

function reportOpened(name: string, r: LoadReport) {
  const notes = [
    r.repaired.length ? `${r.repaired.length} problem${r.repaired.length === 1 ? '' : 's'} repaired` : '',
    r.failedImages.length ? `${r.failedImages.length} image${r.failedImages.length === 1 ? '' : 's'} could not be read` : '',
  ].filter(Boolean);
  toast(`Opened ${name}${notes.length ? ` (${notes.join(', ')})` : ''}`, notes.length ? 'info' : 'ok');
}

/** Opens the file a handle points to (from the picker, or from the recent list) and keeps the handle for Save. */
export async function openHandle(handle: FileHandle) {
  try {
    const f = await handle.getFile();
    const r = await loadProjectText(await f.text());
    currentHandle = handle;
    void rememberRecent(handle);
    reportOpened(f.name, r);
  } catch (e) {
    toast(`Could not open the file: ${(e as Error).message}`, 'error');
  }
}

/** Opens a project from the recent list: the browser may ask once to let the editor read (and later save to) the file. */
export async function openRecentProject(id: string) {
  const handle = await recentHandle(id);
  if (!handle) {
    await forgetRecent(id);
    toast('That file is not in the list any more', 'info');
    return;
  }
  if (!(await canWrite(handle))) {
    toast('The browser did not let the editor use that file', 'info');
    return;
  }
  await openHandle(handle);
}

export async function openProjectFile() {
  const pick = pickers().showOpenFilePicker;
  if (pick) {
    try {
      const [handle] = await pick({ types: [{ description: 'Bone 2D project', accept: { 'application/json': ['.bone2d', '.marrow'] } }] });
      if (handle) await openHandle(handle);
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      // the picker is not usable here (an iframe, a policy): fall back to the plain file input below
    }
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.bone2d,.marrow,application/json';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      currentHandle = null;
      reportOpened(f.name, await loadProjectText(await f.text()));
    } catch (e) {
      toast(`Could not open the file: ${(e as Error).message}`, 'error');
    }
  };
  input.click();
}

export async function restoreAutosave(): Promise<boolean> {
  try {
    let text = await idbGet<string>('autosave');
    if (!text) text = await idbGet<string>('autosave', LEGACY_DB).catch(() => undefined);
    if (!text) return false;
    await loadProjectText(text);
    return true;
  } catch (e) {
    console.warn('autosave restore failed', e);
    return false;
  }
}

export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = async () => {
    if (!settingsStore.get().autosave) return;
    try {
      const text = await serializeProject();
      await idbSet('autosave', text);
      void maybeAutoBackup(text);
    } catch (e) {
      console.warn('autosave failed', e);
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void save(), 1200);
  };
  const unsubs = [docStore.subscribe(schedule), assets.subscribe(schedule)];
  return () => {
    if (timer) clearTimeout(timer);
    unsubs.forEach((u) => u());
  };
}
