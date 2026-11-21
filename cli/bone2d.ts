/**
 * Command line for Bone 2D projects: export the Spine skeleton data without opening the editor (a build step, CI), and check a project.
 *
 *   npm run cli -- export project.bone2d [outDir] [--format json|binary] [--scale 0.5] [--pretty] [--no-nonessential] [--no-images]
 *   npm run cli -- info project.bone2d
 *   npm run cli -- check project.bone2d
 *   npm run cli -- unpack hero.atlas [outDir]            the pictures of an atlas, as PNG files
 *   npm run cli -- import hero.json out.bone2d           Spine skeleton data (+ its atlas) as a project
 *   npm run cli -- clean project.bone2d out.bone2d       a copy without the keys that change nothing
 *
 * `export` writes the skeleton (`<name>.json` or `<name>.skel`, the same bytes as the editor's export) and the pictures of the project as
 * files under `images/`; with `--atlas` it packs them instead into `<name>.atlas` and PNG pages, with the same packer, trimming and
 * quarter turns as the editor's export window. A command line has no canvas, so PNG is read and written by cli/png.ts: other picture
 * formats are left out of the atlas with a note.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composePage, packAtlas, premultiplyAlpha, writeAtlas } from '@/core/export/atlas';
import type { PackInput } from '@/core/export/atlas';
import { findAliases, makeRegion, scaledSize, usedImages } from '@/core/export/atlasBuild';
import { scaleSpineJson } from '@/core/export/scale';
import { jsonToBinary } from '@/core/export/spineBinary';
import { SPINE_VERSION, exportSpineJson } from '@/core/export/spineJson';
import { cleanUpAnimation, withCleanAnimations } from '@/core/cleanup';
import { parseAtlas } from '@/core/import/atlas';
import { binaryToJson } from '@/core/import/spineBinary';
import { importSpineJson } from '@/core/import/spineJson';
import { cutRegion, unpackAtlas, unpremultiplyAlpha } from '@/core/import/unpack';
import type { Picture } from '@/core/import/unpack';
import { migrateProject } from '@/core/model';
import type { Project } from '@/core/model';
import { countKeys } from '@/core/stats';
import { mixesToText } from '@/core/export/mixes';
import { skeletonList } from '@/core/skeletons';
import { repairProject } from '@/core/validate';
import { decodePng, encodePng, resizePixels } from './png';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const HELP = `Bone 2D command line

  export <project> [outDir]   write the Spine ${SPINE_VERSION} skeleton data and the pictures of a project
      --format json|binary    skeleton file format (default json)
      --scale <n>             scale the skeleton data (the pictures stay as they are)
      --pretty                indented JSON
      --no-nonessential       leave out names, colours and other editor-only data
      --no-images             do not write the pictures
      --clean                 leave out the keys that change nothing (the project is not changed)
      --no-mixes              do not write <name>.mixes.json (the crossfade times between animations, when the project has any)
      --skeleton <name|n>     only this skeleton of the project (default: all of them, one file each)
      --atlas                 pack the pictures into <name>.atlas and PNG pages instead of writing them one by one
      --max-size <n>          largest atlas page in pixels (default 2048)
      --padding <n>           pixels around every region (default 2)
      --no-pot                allow page sizes that are not powers of two
      --trim                  cut the empty border off pictures (not those a mesh uses)
      --rotate                turn a picture a quarter turn on the page when it fits better
      --square                pages as wide as they are tall
      --multiple-of-4         page sizes divisible by four (with --no-pot)
      --alias                 identical pictures take one place in the atlas
      --pma                   premultiplied alpha pages (the atlas says pma:true)
      --filter linear|nearest how the engine should smooth the atlas (default linear)
  unpack <atlas> [outDir]     cut the pictures out of an atlas and its pages (PNG pages only), trimmed borders restored
      --keep-pma              leave a premultiplied page as it is instead of turning it back to straight alpha
  import <skeleton> <out>     Spine .json / .skel (4.0 - 4.3) and its .atlas (same name, or --atlas <file>) as a Bone 2D project
  clean <project> <out>       write a copy with the keys that change nothing taken out
  info <project>              what the project holds
  check <project>             find and list what is damaged in it (exit code 1 when something is)
  help                        this text\n`;

interface ProjectFile {
  bone2d?: 1;
  marrow?: 1;
  project: Project;
  images?: Record<string, string>;
}

/** A project file read the way the editor does, without touching the pictures: the project (migrated, not repaired) and the picture data URLs. */
export function readProjectFile(text: string): ProjectFile {
  const file = JSON.parse(text) as ProjectFile;
  if ((file.bone2d !== 1 && file.marrow !== 1) || !file.project?.skeleton) throw new Error('Not a Bone 2D project file');
  return file;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** The bytes and the file extension of a data URL, or null when it is not a base64 picture. */
export function decodePicture(url: string): { data: Buffer; ext: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!m) return null;
  return { data: Buffer.from(m[2], 'base64'), ext: EXT[m[1]] ?? 'png' };
}

/** A path inside `root` for a picture name, or null for a name that would leave it. */
export function safePath(root: string, name: string): string | null {
  const full = resolve(root, name);
  return full.startsWith(resolve(root) + sep) ? full : null;
}

interface Parsed {
  command: string;
  files: string[];
  flags: Map<string, string | true>;
}

function parse(argv: string[]): Parsed {
  const flags = new Map<string, string | true>();
  const files: string[] = [];
  const valued = new Set(['format', 'scale', 'max-size', 'padding', 'filter', 'skeleton', 'atlas-file']);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      flags.set(name, valued.has(name) ? (argv[++i] ?? '') : true);
    } else files.push(a);
  }
  return { command: argv[0] ?? 'help', files, flags };
}

function load(path: string): ProjectFile {
  return readProjectFile(readFileSync(path, 'utf8'));
}

function exportCommand(p: Parsed, io: Io): number {
  const [input, outDir = '.'] = p.files;
  if (!input) {
    io.err('export: which project file?\n');
    return 2;
  }
  const format = p.flags.get('format') ?? 'json';
  if (format !== 'json' && format !== 'binary') {
    io.err('export: --format is json or binary\n');
    return 2;
  }
  const scale = p.flags.has('scale') ? Number(p.flags.get('scale')) : 1;
  if (!Number.isFinite(scale) || scale <= 0) {
    io.err('export: --scale is a number above 0\n');
    return 2;
  }
  const file = load(input);
  const repaired = repairProject(file.project);
  const project = migrateProject(file.project);
  const docs = skeletonList(project);
  let chosen = docs;
  if (p.flags.has('skeleton')) {
    const q = String(p.flags.get('skeleton'));
    const hit = docs.find((d) => d.name === q) ?? (/^\d+$/.test(q) ? docs[Number(q)] : undefined);
    if (!hit) {
      io.err(`export: no skeleton "${q}" (the project has: ${docs.map((d) => d.name).join(', ')})\n`);
      return 2;
    }
    chosen = [hit];
  }
  mkdirSync(outDir, { recursive: true });
  if (repaired.length) io.err(`repaired while reading: ${repaired.join('; ')}\n`);
  const used = new Set<string>();
  let code = 0;
  for (const doc of chosen) {
    let base = (doc.name || basename(input, extname(input))).replace(/[^\w-]+/g, '_') || 'skeleton';
    while (used.has(base)) base += '_';
    used.add(base);
    const json = scaleSpineJson(
      exportSpineJson(p.flags.has('clean') ? withCleanAnimations(doc) : doc, {
        nonessential: !p.flags.has('no-nonessential'),
        imagesPath: './images/',
      }),
      scale,
    );
    const skeletonFile = `${base}.${format === 'binary' ? 'skel' : 'json'}`;
    const bytes = format === 'binary' ? jsonToBinary(json) : Buffer.from(JSON.stringify(json, null, p.flags.has('pretty') ? 2 : 0));
    writeFileSync(join(outDir, skeletonFile), bytes);
    io.out(
      `${skeletonFile}  ${bytes.length} bytes  (Spine ${SPINE_VERSION}${format === 'binary' ? ', binary' : ''}${scale !== 1 ? `, scale ${scale}` : ''})\n`,
    );
    const mixText = p.flags.has('no-mixes')
      ? null
      : mixesToText(doc.animations, doc === project.skeleton ? project.mixes : doc.aside?.mixes);
    if (mixText) {
      writeFileSync(join(outDir, `${base}.mixes.json`), mixText);
      io.out(`${base}.mixes.json  crossfade times between animations\n`);
    }
    if (p.flags.has('atlas')) {
      const r = atlasStep(p, file, doc, base, scale, outDir, io);
      if (r === 2) return 2;
      code = Math.max(code, r);
    }
  }
  if (p.flags.has('atlas')) return code;
  let written = 0;
  if (!p.flags.has('no-images')) {
    for (const [name, url] of Object.entries(file.images ?? {})) {
      const pic = decodePicture(url);
      const target = pic && safePath(join(outDir, 'images'), `${name}.${pic.ext}`);
      if (!pic || !target) {
        io.err(`skipped the picture "${name}"\n`);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, pic.data);
      written++;
    }
    io.out(`images/  ${written} pictures\n`);
  }
  return 0;
}

/** Packs the pictures the skeleton uses into an atlas (the editor's own packer) and writes the atlas file and its PNG pages. */
function atlasStep(p: Parsed, file: ProjectFile, doc: Project['skeleton'], base: string, scale: number, outDir: string, io: Io): number {
  const number = (name: string, fallback: number, min: number): number | null => {
    if (!p.flags.has(name)) return fallback;
    const v = Number(p.flags.get(name));
    return Number.isInteger(v) && v >= min ? v : null;
  };
  const maxSize = number('max-size', 2048, 16);
  const padding = number('padding', 2, 0);
  const filter = String(p.flags.get('filter') ?? 'linear').toLowerCase();
  if (maxSize === null || padding === null || (filter !== 'linear' && filter !== 'nearest')) {
    io.err('export: --max-size is a whole number from 16, --padding a whole number from 0, --filter linear or nearest\n');
    return 2;
  }
  const trim = p.flags.has('trim');
  const inputs: PackInput[] = [];
  const pixels = new Map<string, Uint8ClampedArray>();
  const left: string[] = [];
  for (const { name, mesh } of usedImages(doc)) {
    const pic = file.images?.[name] ? decodePicture(file.images[name]) : null;
    const decoded = pic ? decodePng(pic.data) : null;
    if (!decoded) {
      left.push(name);
      continue;
    }
    const [w, h] = scaledSize(decoded.width, decoded.height, scale);
    const region = makeRegion(name, mesh, w, h, resizePixels(decoded, w, h).data, trim);
    pixels.set(name, region.pixels);
    inputs.push(region.input);
  }
  for (const name of left) io.err(`left out of the atlas: "${name}" (missing, or not a PNG this tool reads)\n`);
  if (!inputs.length) {
    io.err('export: no pictures to pack\n');
    return 1;
  }
  if (p.flags.has('alias')) {
    const aliases = findAliases(
      inputs.map((i) => ({
        name: i.name,
        width: i.width,
        height: i.height,
        data: pixels.get(i.name)!,
        extra: `${i.offsetX ?? 0},${i.offsetY ?? 0},${i.originalWidth ?? i.width},${i.originalHeight ?? i.height}`,
      })),
    );
    for (const i of inputs) if (aliases.has(i.name)) i.aliasOf = aliases.get(i.name);
  }
  const pma = p.flags.has('pma');
  const pages = packAtlas(inputs, {
    maxSize,
    padding,
    pot: !p.flags.has('no-pot'),
    rotate: p.flags.has('rotate'),
    square: p.flags.has('square'),
    multipleOf4: p.flags.has('multiple-of-4'),
  });
  const pageFile = (i: number) => (pages.length === 1 ? `${base}.png` : `${base}-${i + 1}.png`);
  const text = writeAtlas(pages, pageFile, { pma, filter: filter === 'nearest' ? 'Nearest' : 'Linear' });
  writeFileSync(join(outDir, `${base}.atlas`), text);
  for (const page of pages) {
    const data = composePage(page, (n) => (pixels.has(n) ? { data: pixels.get(n)! } : undefined), padding);
    if (pma) premultiplyAlpha(data);
    writeFileSync(join(outDir, pageFile(page.index)), encodePng(page.width, page.height, data));
  }
  io.out(`${base}.atlas  ${inputs.length} regions on ${pages.length} page${pages.length === 1 ? '' : 's'}\n`);
  return left.length ? 1 : 0;
}

function infoCommand(p: Parsed, io: Io): number {
  if (!p.files[0]) {
    io.err('info: which project file?\n');
    return 2;
  }
  const file = load(p.files[0]);
  const d = file.project.skeleton;
  const rows: [string, string | number][] = [
    ['name', d.name],
    ...(file.project.others?.length
      ? ([
          [
            'skeletons',
            skeletonList(file.project)
              .map((s) => s.name)
              .join(', '),
          ],
        ] as [string, string][])
      : []),
    ['fps', d.fps],
    ['bones', d.bones.length],
    ['slots', d.slots.length],
    ['skins', d.skins.length],
    ['constraints', d.constraints.length],
    ['events', d.events.length],
    ['animations', d.animations.length],
    ['keys', d.animations.reduce((n, a) => n + countKeys(a), 0)],
    ['images', Object.keys(file.images ?? {}).length],
  ];
  io.out(rows.map(([k, v]) => `${k.padEnd(12)}${v}`).join('\n') + '\n');
  return 0;
}

function checkCommand(p: Parsed, io: Io): number {
  if (!p.files[0]) {
    io.err('check: which project file?\n');
    return 2;
  }
  const notes = repairProject(load(p.files[0]).project);
  if (!notes.length) {
    io.out('ok: nothing to repair\n');
    return 0;
  }
  io.out(notes.map((n) => `- ${n}`).join('\n') + '\n');
  return 1;
}

/** The straight RGBA pixels of a PNG file, or null when it is missing or not a PNG this tool reads. */
function readPage(path: string): Picture | null {
  try {
    const png = decodePng(readFileSync(path));
    return png ? { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) } : null;
  } catch {
    return null;
  }
}

function unpackCommand(p: Parsed, io: Io): number {
  const [atlasPath, outDir = '.'] = p.files;
  if (!atlasPath) {
    io.err('unpack: which .atlas file?\n');
    return 2;
  }
  const dir = dirname(resolve(atlasPath));
  const { pictures, warnings } = unpackAtlas(readFileSync(atlasPath, 'utf8'), (file) => readPage(safePath(dir, file) ?? ''), {
    unpremultiply: !p.flags.has('keep-pma'),
  });
  for (const w of warnings) io.err(`${w}\n`);
  let written = 0;
  for (const { name, picture } of pictures) {
    const target = safePath(outDir, `${name}.png`);
    if (!target) {
      io.err(`skipped the picture "${name}"\n`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, encodePng(picture.width, picture.height, picture.data));
    written++;
  }
  io.out(`${outDir}  ${written} pictures\n`);
  return warnings.length || written < pictures.length ? 1 : 0;
}

function importCommand(p: Parsed, io: Io): number {
  const [input, output] = p.files;
  if (!input || !output) {
    io.err('import: import <skeleton .json|.skel> <out.bone2d> [--atlas-file <file>]\n');
    return 2;
  }
  const bytes = readFileSync(input);
  const skeleton: unknown = /\.skel$/i.test(input) ? binaryToJson(new Uint8Array(bytes)) : JSON.parse(bytes.toString('utf8'));
  const result = importSpineJson(skeleton, basename(input, extname(input)));
  const warnings = [...result.warnings];
  const atlasPath = p.flags.has('atlas-file')
    ? String(p.flags.get('atlas-file'))
    : join(dirname(input), `${basename(input, extname(input))}.atlas`);
  const images: Record<string, string> = {};
  try {
    const text = readFileSync(atlasPath, 'utf8');
    const dir = dirname(resolve(atlasPath));
    for (const page of parseAtlas(text)) {
      const pixels = readPage(safePath(dir, page.file) ?? '');
      if (!pixels) {
        warnings.push(`atlas page "${page.file}" was not found or is not a PNG`);
        continue;
      }
      if (page.pma) unpremultiplyAlpha(pixels.data);
      for (const r of page.regions) {
        const pic = cutRegion(pixels, r);
        images[r.name] = `data:image/png;base64,${encodePng(pic.width, pic.height, pic.data).toString('base64')}`;
        const ref = result.project.images.find((i) => i.name === r.name);
        if (ref) {
          ref.width = pic.width;
          ref.height = pic.height;
        }
      }
    }
  } catch {
    warnings.push(`no atlas at "${atlasPath}": the attachments have no pictures yet`);
  }
  for (const img of result.project.images) if (!images[img.name]) warnings.push(`image "${img.name}" is not in the atlas`);
  const repaired = repairProject(result.project);
  const project = migrateProject(result.project);
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, JSON.stringify({ bone2d: 1, project, images }));
  for (const w of [...warnings, ...repaired.map((r) => `repaired: ${r}`)]) io.err(`${w}\n`);
  io.out(
    `${output}  ${project.skeleton.bones.length} bones, ${project.skeleton.animations.length} animations, ${Object.keys(images).length} pictures\n`,
  );
  return 0;
}

function cleanCommand(p: Parsed, io: Io): number {
  const [input, output] = p.files;
  if (!input || !output) {
    io.err('clean: clean <project> <out>\n');
    return 2;
  }
  const file = load(input);
  repairProject(file.project);
  const project = migrateProject(file.project);
  let removed = 0;
  for (const doc of skeletonList(project)) for (const a of doc.animations) removed += cleanUpAnimation(a);
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, JSON.stringify({ ...file, project }));
  io.out(`${output}  ${removed} key${removed === 1 ? '' : 's'} removed\n`);
  return 0;
}

/** Runs one command line (without the node and script names); returns the exit code. */
export function run(argv: string[], io: Io): number {
  const p = parse(argv);
  try {
    if (p.command === 'export') return exportCommand(p, io);
    if (p.command === 'info') return infoCommand(p, io);
    if (p.command === 'check') return checkCommand(p, io);
    if (p.command === 'unpack') return unpackCommand(p, io);
    if (p.command === 'import') return importCommand(p, io);
    if (p.command === 'clean') return cleanCommand(p, io);
    if (p.command === 'help' || p.command === '--help' || p.command === '-h') {
      io.out(HELP);
      return 0;
    }
    io.err(`unknown command "${p.command}"\n\n${HELP}`);
    return 2;
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2), { out: (s) => void process.stdout.write(s), err: (s) => void process.stderr.write(s) });
}
