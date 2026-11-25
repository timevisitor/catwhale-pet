'use strict';
/**
 * 灵动岛窗口的 preload。只暴露岛要用的四件事：
 *   islandInvoke(名字, 参数)  —— 页面里沿用 Tauri 版写法（island_cmd / island_get …）
 *   onIslandData(cb)          —— 主进程每 500ms 推一次载荷
 *   islandHit(inside)         —— 光标是否压在球/胶囊上（主进程据此切鼠标穿透）
 *   islandAnchor({cx,head})   —— 由主窗口页面喂的「桌宠头顶」锚点（这里用不到，留作对称）
 */
const { contextBridge, ipcRenderer } = require('electron');

function toChannel(name) {
  const s = String(name || '');
  if (s.indexOf('island:') === 0) return s;
  if (s.indexOf('island_') === 0) return 'island:' + s.slice(7);
  return 'island:' + s;
}

contextBridge.exposeInMainWorld('petHost', {
  islandInvoke: (name, args) => {
    const ch = toChannel(name);
    const payload = (args && typeof args === 'object') ? args : {};
    const first = payload.cmd !== undefined ? payload.cmd
      : (payload.patch !== undefined ? payload.patch
        : (payload.mode !== undefined ? payload.mode : undefined));
    return ipcRenderer.invoke(ch, first);
  },
  onIslandData: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('island:data', (_e, d) => { try { cb(d); } catch (e) {} });
  },
  islandHit: (inside) => ipcRenderer.invoke('island:hit', !!inside).catch(() => {}),
  islandAnchor: (a) => ipcRenderer.invoke('island:anchor', a).catch(() => {}),
});
