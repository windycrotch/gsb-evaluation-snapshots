import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

test('import issues keep internal diagnostics out of the public message', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());

  const { makeImportIssue } = await vite.ssrLoadModule('/src/app/helpers.ts');
  const error = Object.assign(new Error('/private/study/patient-42.dcm'), {
    code: 'E_DICOM_HEADER',
  });

  assert.deepEqual(makeImportIssue(error), {
    code: 'E_DICOM_HEADER',
    diagnostic: '/private/study/patient-42.dcm',
    messageKey: 'errors.invalidDicomSource',
  });
});
