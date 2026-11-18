import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createServer } from 'vite';

const encoder = new TextEncoder();

function element(group, tag, valueBytes) {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint16(0, group, true);
  view.setUint16(2, tag, true);
  view.setUint32(4, valueBytes.byteLength, true);
  return [header, valueBytes];
}

function textElement(group, tag, value) {
  const text = value.length % 2 === 1 ? `${value} ` : value;
  return element(group, tag, encoder.encode(text));
}

function uint16Element(group, tag, value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return element(group, tag, bytes);
}

function concat(parts) {
  const flat = parts.flat();
  const total = flat.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of flat) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

// Minimal implicit little-endian DICOM object (no Part 10 preamble needed:
// the reader defaults to implicit LE and tests use .dcm names).
function buildDicomBytes({
  rows = 4,
  columns = 4,
  frames,
  label,
  position = '0\\0\\0',
  declaredPixelBytes,
} = {}) {
  const parts = [
    textElement(0x0008, 0x0060, 'CT'),
    uint16Element(0x0028, 0x0010, rows),
    uint16Element(0x0028, 0x0011, columns),
    uint16Element(0x0028, 0x0100, 16),
    textElement(0x0028, 0x0004, 'MONOCHROME2'),
    textElement(0x0028, 0x0030, '0.5\\0.5'),
    textElement(0x0018, 0x0088, '1'),
    textElement(0x0020, 0x0032, position),
    textElement(0x0020, 0x0037, '1\\0\\0\\0\\1\\0'),
  ];
  if (label != null) parts.unshift(textElement(0x0008, 0x103e, label));
  if (frames != null) {
    parts.splice(2, 0, textElement(0x0028, 0x0008, String(frames)));
  }
  const frameCount = frames ?? 1;
  const pixelBytes = declaredPixelBytes ?? rows * columns * frameCount * 2;
  parts.push(element(0x7fe0, 0x0010, new Uint8Array(pixelBytes)));
  return concat(parts);
}

function makeEntry(name, bytes) {
  return { name, relativePath: name, file: new File([bytes], name) };
}

function makeSource(entries, label = 'study') {
  return { kind: 'file-list', label, entries };
}

async function loadParser(t) {
  const vite = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
  });
  t.after(() => vite.close());
  return vite.ssrLoadModule('/src/lib/import/adapters/dicom/parser.ts');
}

test('mixed directory falls back to the enhanced series when the largest stack has one slice', async (t) => {
  const { parseDicomFolder } = await loadParser(t);
  const source = makeSource([
    makeEntry('slice-1.dcm', buildDicomBytes({ rows: 4, columns: 4 })),
    makeEntry(
      'enhanced.dcm',
      buildDicomBytes({ rows: 4, columns: 4, frames: 4, label: 'Axial Head' }),
    ),
    {
      name: 'DICOMDIR',
      relativePath: 'DICOMDIR',
      file: new File([new Uint8Array(132)], 'DICOMDIR'),
    },
    {
      name: 'notes.txt',
      relativePath: 'notes.txt',
      file: new File(['not dicom'], 'notes.txt'),
    },
  ]);

  const { meta } = await parseDicomFolder(source);

  assert.equal(meta.formatLabel, 'Enhanced DICOM CT volume');
  assert.deepEqual(meta.sliceFiles, ['enhanced.dcm']);
  assert.deepEqual(meta.dimensions, [4, 4, 4]);
  assert.equal(meta.sliceCount, 4);
  assert.equal(meta.bytesPerVoxel, 2);
});

test('a consistent multi-slice stack still wins over an enhanced series', async (t) => {
  const { parseDicomFolder } = await loadParser(t);
  const source = makeSource([
    makeEntry(
      'slice-1.dcm',
      buildDicomBytes({ rows: 4, columns: 4, position: '0\\0\\0' }),
    ),
    makeEntry(
      'slice-2.dcm',
      buildDicomBytes({ rows: 4, columns: 4, position: '0\\0\\1' }),
    ),
    makeEntry(
      'enhanced.dcm',
      buildDicomBytes({ rows: 4, columns: 4, frames: 8, label: 'Axial Head' }),
    ),
  ]);

  const { meta } = await parseDicomFolder(source);

  assert.equal(meta.formatLabel, 'DICOM CT');
  assert.deepEqual(meta.sliceFiles, ['slice-1.dcm', 'slice-2.dcm']);
  assert.deepEqual(meta.dimensions, [4, 4, 2]);
});

test('enhanced candidates with a mismatched pixel payload are excluded and reported', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
  });
  t.after(() => vite.close());
  const { parseDicomFolder } = await vite.ssrLoadModule(
    '/src/lib/import/adapters/dicom/parser.ts',
  );
  const expected = 4 * 4 * 4 * 2;
  const source = makeSource([
    makeEntry('slice-1.dcm', buildDicomBytes({ rows: 4, columns: 4 })),
    makeEntry(
      'broken-enhanced.dcm',
      buildDicomBytes({
        rows: 4,
        columns: 4,
        frames: 4,
        label: 'Axial Head',
        declaredPixelBytes: expected - 2,
      }),
    ),
  ]);

  await assert.rejects(parseDicomFolder(source), (error) => {
    assert.equal(error.code, 'E_DICOM_PIXEL_DATA');
    assert.match(error.message, /pixel data/i);
    assert.ok(!error.message.includes('broken-enhanced.dcm'));
    assert.ok(!error.message.includes('slice-1.dcm'));
    return true;
  });

  const { IMPORT_ERROR_MESSAGE_KEYS } = await vite.ssrLoadModule(
    '/src/constants.ts',
  );
  const messageKey = IMPORT_ERROR_MESSAGE_KEYS.E_DICOM_PIXEL_DATA;
  assert.equal(typeof messageKey, 'string');
  const en = JSON.parse(
    await readFile(
      new URL('../src/i18n/locales/en.json', import.meta.url),
      'utf8',
    ),
  );
  const userMessage = messageKey
    .split('.')
    .reduce((node, key) => node?.[key], en);
  assert.match(userMessage, /pixel data/i);
  const uk = JSON.parse(
    await readFile(
      new URL('../src/i18n/locales/uk.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(
    typeof messageKey.split('.').reduce((node, key) => node?.[key], uk),
    'string',
  );
});

test('enhanced candidates prefer axial labels, then voxel count, localizers last', async (t) => {
  const { parseDicomFolder } = await loadParser(t);
  const source = makeSource([
    makeEntry(
      'localizer.dcm',
      buildDicomBytes({ rows: 8, columns: 8, frames: 8, label: 'Localizer Scout' }),
    ),
    makeEntry(
      'coronal-big.dcm',
      buildDicomBytes({ rows: 16, columns: 16, frames: 8, label: 'Coronal Recon' }),
    ),
    makeEntry(
      'axial-small.dcm',
      buildDicomBytes({ rows: 8, columns: 8, frames: 4, label: 'Axial Head' }),
    ),
    makeEntry(
      'tra-big.dcm',
      buildDicomBytes({ rows: 16, columns: 16, frames: 4, label: 'TRA Volume' }),
    ),
  ]);

  const { meta } = await parseDicomFolder(source);

  assert.deepEqual(meta.sliceFiles, ['tra-big.dcm']);
  assert.deepEqual(
    meta.seriesChoices.map((choice) => choice.id),
    ['tra-big.dcm', 'axial-small.dcm', 'coronal-big.dcm', 'localizer.dcm'],
  );
  assert.deepEqual(
    meta.seriesChoices.map((choice) => choice.selected),
    [true, false, false, false],
  );

  const preferred = await parseDicomFolder(source, {
    preferredSeriesId: 'coronal-big.dcm',
  });
  assert.deepEqual(preferred.meta.sliceFiles, ['coronal-big.dcm']);
});
