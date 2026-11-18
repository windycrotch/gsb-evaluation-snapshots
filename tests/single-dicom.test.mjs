import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

test('a single .dcm file reaches the DICOM adapter', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());

  const { fromFile } = await vite.ssrLoadModule(
    '/src/lib/import/scan-folder.ts',
  );
  const { dicomFormatAdapter } = await vite.ssrLoadModule(
    '/src/lib/import/adapters/dicom/adapter.ts',
  );
  const source = fromFile(new File([], 'volume.dcm'));

  assert.equal(source.label, 'volume.dcm');
  assert.equal(source.entries.length, 1);
  assert.equal(await dicomFormatAdapter.matches(source), true);
});

test('recognizes extensionless DICOM images and ignores the media index and unrelated files', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
  });
  t.after(() => vite.close());

  const { findImportAdapter } = await vite.ssrLoadModule(
    '/src/lib/import/adapters/index.ts',
  );
  const { findDicomEntries } = await vite.ssrLoadModule(
    '/src/lib/import/adapters/dicom/index.ts',
  );
  const preamble = [new Uint8Array(128), 'DICM'];
  const files = [
    new File(preamble, 'DICOMDIR'),
    new File(['unrelated'], '12345'),
    new File(preamble, 'IM000001'),
  ];
  const entries = files.map((file) => ({ name: file.name, relativePath: file.name, file }));
  assert.equal((await findImportAdapter({ entries }))?.id, 'dicom');
  assert.deepEqual(await findDicomEntries({ entries }), [entries[2]]);
  assert.equal(await findImportAdapter({ entries: entries.slice(0, 2) }), undefined);
});
