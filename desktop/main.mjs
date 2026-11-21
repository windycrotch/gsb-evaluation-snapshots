import { app, BrowserWindow, dialog } from 'electron';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectServer } from '../server/projects.mjs';
import { createStaticHandler } from './static.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = 4319;
const origin = `http://127.0.0.1:${port}`;
app.setName('Game Engine Editor');
if (process.env.GAME_ENGINE_EDITOR_DATA_DIR) {
  app.setPath('userData', resolve(process.env.GAME_ENGINE_EDITOR_DATA_DIR));
}

let window;
let server;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.whenReady().then(async () => {
    server = createProjectServer(join(app.getPath('userData'), 'data', 'projects.jsonl'), {
      staticHandler: createStaticHandler(join(root, 'dist')),
    });
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolveListen);
    });
    server.on('error', error => {
      console.error('Desktop server error:', error);
      dialog.showErrorBox('Game Engine Editor', `The local server failed: ${error.message}`);
      app.quit();
    });
    window = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 900,
      minHeight: 600,
      title: 'Game Engine Editor',
      ...(process.platform === 'win32' ? { icon: join(root, 'desktop', 'icon.ico') } : {}),
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    window.removeMenu();
    window.webContents.session.on('will-download', (event, item) => {
      const path = dialog.showSaveDialogSync(window, {
        defaultPath: join(app.getPath('downloads'), item.getFilename()),
        filters: [{ name: 'ZIP archives', extensions: ['zip'] }],
      });
      if (!path) {
        item.cancel();
        return;
      }
      item.setSavePath(path);
      item.on('done', (_event, state) => {
        if (state !== 'completed') dialog.showErrorBox('Export failed', `The download was ${state}.`);
      });
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== origin) event.preventDefault();
    });
    await window.loadURL(origin);
  }).catch(error => {
    console.error('Desktop startup failed:', error);
    dialog.showErrorBox('Game Engine Editor', `Could not start the editor: ${error.message}\nCheck whether port ${port} is already in use.`);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    if (server) server.close();
  });
}
