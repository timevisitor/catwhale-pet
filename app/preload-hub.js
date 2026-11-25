/**
 * preload-hub.js — 「信息中枢」面板窗口的桥
 *
 * 只开一扇门：所有能力都走 infohub:* 的 IPC，面板自己不认识 fs / net / electron。
 * 与主窗的 preload.js 分开写，是为了让面板出问题时不影响桌宠本体。
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, cb) => {
  const h = (_e, v) => { try { cb(v); } catch (e) {} };
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('hub', {
  state: () => ipcRenderer.invoke('infohub:state'),
  snapshots: () => ipcRenderer.invoke('infohub:snapshots'),
  do: (action, arg) => ipcRenderer.invoke('infohub:do', action, arg),
  noteAction: (id, actionId) => ipcRenderer.invoke('infohub:noteAction', id, actionId),
  close: () => ipcRenderer.invoke('infohub:closeWindow'),
  onNote: (cb) => listen('infohub:note', cb),
  onSnapshot: (cb) => listen('infohub:snapshot', cb),
  onTab: (cb) => listen('infohub:tab', cb),
});
