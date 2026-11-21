/**
 * What a drop brings: files, and folders that hold files. A folder becomes a folder of pictures: "hero/arm/upper.png" is the picture
 * "hero/arm/upper" (the Images window shows folders by the "/" in a name). The entries of a drop are only valid inside the drop event,
 * so `entriesOf` reads them synchronously and `readEntries` walks them afterwards.
 */

/** The part of the File System Entry API that is used (so that it can be faked in a test). */
export interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(ok: (f: File) => void, fail: (e: unknown) => void): void;
  createReader?(): { readEntries(ok: (list: FsEntry[]) => void, fail: (e: unknown) => void): void };
}

export interface PathedFile {
  file: File;
  /** Folders and file name, joined with "/". */
  path: string;
}

/** The entries of a drop, taken at once (they are gone after the first await). */
export function entriesOf(dt: DataTransfer): FsEntry[] {
  const out: FsEntry[] = [];
  for (const item of [...dt.items]) {
    const e = (item as unknown as { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.();
    if (e) out.push(e);
  }
  return out;
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Every file under the entries, folders walked, in natural order of the path (frame2 before frame10). */
export async function readEntries(entries: FsEntry[]): Promise<{ files: PathedFile[]; folders: number }> {
  const files: PathedFile[] = [];
  let folders = 0;
  const walk = async (entry: FsEntry, dir: string): Promise<void> => {
    if (entry.isFile && entry.file) {
      const file = await new Promise<File>((ok, fail) => entry.file!(ok, fail));
      files.push({ file, path: dir + entry.name });
    } else if (entry.isDirectory && entry.createReader) {
      folders++;
      const reader = entry.createReader();
      for (;;) {
        // a reader gives its entries in batches (Chrome: 100), until an empty one
        const batch = await new Promise<FsEntry[]>((ok, fail) => reader.readEntries(ok, fail));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${dir}${entry.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  files.sort((a, b) => natural(a.path, b.path));
  return { files, folders };
}

/** The files of a "choose a folder" input: the browser gives each its path from the folder down. */
export function pathedFromInput(list: File[]): PathedFile[] {
  return list
    .map((file) => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }))
    .sort((a, b) => natural(a.path, b.path));
}
