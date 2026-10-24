// 猫鲸皮肤编辑器 —— preload（最小接口）
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('api', {
  state:        () => invoke('app:state'),
  listSkins:    () => invoke('skins:list'),
  readSkin:     (slug) => invoke('skins:read', slug),
  saveSkin:     (slug, skin) => invoke('skins:save', slug, skin),
  applySkin:    (slug) => invoke('skins:apply', slug),
  deleteSkin:   (slug) => invoke('skins:delete', slug),
  readBuiltin:  () => invoke('builtin:read'),
  importBuiltinOrCopy: (slug, id, srcAbs) => invoke('builtin:import', { slug, id, srcAbs }),
  duplicateSkin: (from, to, name) => invoke('skins:duplicate', from, to, name),
  cleanSkin:    (slug, keep) => invoke('skins:clean', slug, keep),
  probe:        (f) => invoke('video:probe', f),
  bbox:         (f) => invoke('video:bbox', f),
  pickVideo:    () => invoke('video:pick'),
  importVideo:  (p) => invoke('video:import', p),
  cornerColor:  (f) => invoke('video:corner', f),
  launchPet:    () => invoke('pet:launch'),
  petRunning:   () => invoke('pet:running'),
  openPath:     (p) => invoke('shell:open', p),
  revealPath:   (p) => invoke('shell:reveal', p),
});
