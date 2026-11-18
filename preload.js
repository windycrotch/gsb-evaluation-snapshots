'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  cycleScale: () => ipcRenderer.invoke('scale:cycle'),
  getScale: () => ipcRenderer.invoke('scale:get'),
  togglePin: () => ipcRenderer.invoke('pin:toggle'),
  getPin: () => ipcRenderer.invoke('pin:get'),
  menu: () => ipcRenderer.send('window:menu'),
  quit: () => ipcRenderer.send('window:quit'),
  hide: () => ipcRenderer.send('window:hide'),
  onFocusChange: (fn) => ipcRenderer.on('focus-change', (_e, focused) => fn(focused)),
  onScaleChange: (fn) => ipcRenderer.on('scale-change', (_e, scale) => fn(scale)),
});
