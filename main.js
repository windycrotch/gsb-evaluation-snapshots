'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  net,
  protocol,
  screen,
  shell,
} = require('electron');

// Logical pixel size of the device artwork, kept in sync with src/core/layout.js.
const ART = { w: 196, h: 166 };
const SCALES = [2, 3, 4];
const DEFAULT_SCALE_INDEX = 1;

let win = null;
let scaleIndex = DEFAULT_SCALE_INDEX;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

function windowSize(scale) {
  return { width: ART.w * scale, height: ART.h * scale };
}

function createWindow() {
  const { width, height } = windowSize(SCALES[scaleIndex]);
  const area = screen.getPrimaryDisplay().workArea;

  win = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + area.width - width - 48),
    y: Math.round(area.y + area.height - height - 48),
    useContentSize: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'DeskSynth',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  const demo = process.env.DESKSYNTH_DEMO;
  win.loadURL(`app://synth/index.html${demo ? `?demo=${encodeURIComponent(demo)}` : ''}`);

  // Dev helper: render once to a PNG and exit. Used to iterate on the artwork.
  if (process.env.DESKSYNTH_SHOT) {
    const delay = Number(process.env.DESKSYNTH_SHOT_DELAY || 1600);
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        require('node:fs').writeFileSync(process.env.DESKSYNTH_SHOT, img.toPNG());
        app.exit(0);
      }, delay);
    });
  }

  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[desksynth] load failed', code, desc, url);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[desksynth] renderer gone', details);
  });
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer] ${source}:${line} ${message}`);
  });
  win.on('closed', () => {
    win = null;
  });

  const notify = () => {
    if (win && !win.isDestroyed()) win.webContents.send('focus-change', win.isFocused());
  };
  win.on('focus', notify);
  win.on('blur', notify);
}

function applyScale(nextIndex) {
  scaleIndex = ((nextIndex % SCALES.length) + SCALES.length) % SCALES.length;
  const { width, height } = windowSize(SCALES[scaleIndex]);
  const bounds = win.getBounds();
  const content = win.getContentBounds();
  const chromeW = bounds.width - content.width;
  const chromeH = bounds.height - content.height;
  win.setBounds(
    {
      x: bounds.x,
      y: bounds.y,
      width: width + chromeW,
      height: height + chromeH,
    },
    false,
  );
  win.webContents.send('scale-change', SCALES[scaleIndex]);
}

function buildContextMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Always on top',
      type: 'checkbox',
      checked: win.isAlwaysOnTop(),
      click: (item) => win.setAlwaysOnTop(item.checked, 'floating'),
    },
    { type: 'separator' },
    ...SCALES.map((s, i) => ({
      label: `Size ${s}\u00d7`,
      type: 'radio',
      checked: i === scaleIndex,
      click: () => applyScale(i),
    })),
    { type: 'separator' },
    { label: 'Hide', click: () => win.hide() },
    { label: 'Quit DeskSynth', click: () => app.quit() },
  ]);
}

app.whenReady().then(() => {
  // No menu bar: this should feel like a desktop object, not an application.
  Menu.setApplicationMenu(null);

  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[\\/])+/, '');
    const file = path.join(__dirname, 'src', rel);
    return net.fetch(pathToFileURL(file).toString());
  });

  ipcMain.handle('scale:cycle', () => {
    applyScale(scaleIndex + 1);
    return SCALES[scaleIndex];
  });
  ipcMain.handle('scale:get', () => SCALES[scaleIndex]);
  ipcMain.handle('pin:toggle', () => {
    const next = !win.isAlwaysOnTop();
    win.setAlwaysOnTop(next, 'floating');
    return next;
  });
  ipcMain.handle('pin:get', () => win.isAlwaysOnTop());
  ipcMain.on('window:menu', () => buildContextMenu().popup({ window: win }));
  ipcMain.on('window:quit', () => app.quit());
  ipcMain.on('window:hide', () => win.hide());
  ipcMain.on('open-external', (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });

  createWindow();

  app.on('activate', () => {
    if (!win) createWindow();
    else {
      win.show();
      win.focus();
    }
  });
});

app.on('window-all-closed', () => app.quit());
