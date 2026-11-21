import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const source = join('release', `${manifest.build.productName} Setup ${manifest.version}.exe`);
const destination = `${manifest.build.productName} Setup.exe`;
await copyFile(source, destination);
console.log(`Windows installer copied to ${destination}`);
