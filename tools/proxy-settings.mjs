export * from '../src/platform/proxy.mjs';
import { proxyCommand } from '../src/platform/proxy.mjs';
import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) proxyCommand();
