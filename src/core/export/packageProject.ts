/**
 * Package Project (Spine 4.3's command of the same name): one ZIP with the project file, which opens again as it is, and the pictures of the
 * project as files of their own in an `images` folder, for the artist's tools.
 */
import type { ZipEntry } from './zip';

export interface PackageImage {
  name: string;
  /** The media type of the bytes ("image/png"). */
  type: string;
  bytes: Uint8Array;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** A path that is safe inside a ZIP: no drive, no leading slash, no `.` or `..` parts, no characters a file system refuses. */
export function safeZipPath(path: string): string {
  const parts = path
    .replace(/\\/g, '/')
    .split('/')
    // eslint-disable-next-line no-control-regex -- control characters are not allowed in a file name
    .map((p) => p.replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim())
    .filter((p) => p && p !== '.' && p !== '..');
  return parts.join('/') || 'image';
}

/** The entries of the package: `<name>.bone2d` and `images/<picture>.<ext>`, every path unique and safe. */
export function packageEntries(projectName: string, projectText: string, images: PackageImage[]): ZipEntry[] {
  const enc = new TextEncoder();
  const base = safeZipPath(projectName || 'untitled').replace(/\//g, '_');
  const entries: ZipEntry[] = [{ name: `${base}.bone2d`, data: enc.encode(projectText) }];
  const used = new Set<string>([entries[0].name.toLowerCase()]);
  for (const img of images) {
    const ext = EXT[img.type] ?? 'png';
    let path = safeZipPath(img.name);
    if (!path.toLowerCase().endsWith(`.${ext}`)) path += `.${ext}`;
    path = `images/${path}`;
    let unique = path;
    for (let n = 2; used.has(unique.toLowerCase()); n++) unique = path.replace(/(\.[^./]+)$/, `-${n}$1`);
    used.add(unique.toLowerCase());
    entries.push({ name: unique, data: img.bytes });
  }
  return entries;
}
