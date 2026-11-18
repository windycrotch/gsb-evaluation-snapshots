import * as proxy from './proxy.mjs';
import * as certificates from './certificates.mjs';
import * as clientPaths from './client-paths.mjs';
import * as terminal from './terminal.mjs';
import * as browser from './browser.mjs';

export const platform = { proxy, certificates, clientPaths, terminal, browser };
