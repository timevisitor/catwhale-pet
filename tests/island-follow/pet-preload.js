'use strict';
/* 冒烟台桌宠页的 preload：只暴露冒烟需要的最小接口 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petHost', {
  /* 和真实 app/preload.js 同名同签名 —— 被测代码不该知道自己在冒烟台里 */
  islandAnchor: (a) => ipcRenderer.send('island:anchor-raw', a),
  islandAnchorCommit: (a) => ipcRenderer.invoke('island:anchor-commit', a).catch(() => ({})),
});

contextBridge.exposeInMainWorld('smoke', {
  truth: (t) => ipcRenderer.send('smoke:truth', t),
});

ipcRenderer.on('smoke:run', () => {
  try { window.dispatchEvent(new Event('smoke:run')); } catch (e) {}
});
