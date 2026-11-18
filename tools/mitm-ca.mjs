export * from '../src/platform/certificates.mjs';
import { certificateCommand } from '../src/platform/certificates.mjs';
import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) certificateCommand().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
