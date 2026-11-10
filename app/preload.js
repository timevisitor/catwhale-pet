// 只暴露桌宠需要的最小接口给页面（contextIsolation 保持打开）
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('petHost', {
  setInteractive: (on) => ipcRenderer.send('pet:interactive', on),
  cursorPosition: () => ipcRenderer.invoke('pet:cursor'),
  saveState: (s) => ipcRenderer.send('pet:save', s),

  /* ---- 文件搜索（Everything / es.exe，全部在主进程执行）---- */
  search: (query, limit) => ipcRenderer.invoke('everything:search', { query, limit }),
  openPath: (p) => ipcRenderer.invoke('everything:open', p),
  revealPath: (p) => ipcRenderer.invoke('everything:reveal', p),
  copyText: (t) => ipcRenderer.invoke('everything:copy', t),

  /* ---- 键盘输入：搜索框打开时抢焦点，关闭时还回去 ---- */
  focusWindow: (on) => ipcRenderer.send('pet:focus', !!on),

  /* ---- 全局热键唤起搜索框（主进程 → 页面）---- */
  onOpenSearch: (cb) => {
    const h = () => { try { cb(); } catch (e) {} };
    ipcRenderer.on('pet:open-search', h);
    return () => ipcRenderer.removeListener('pet:open-search', h);
  },

  /* ---- DeepSeek Harness 聊天（主进程起一次性 harness 进程）---- */
  chat: (prompt, history) => ipcRenderer.invoke('harness:chat', { prompt, history }),
  cancelChat: () => ipcRenderer.invoke('harness:cancel'),
  chatHistory: () => ipcRenderer.invoke('chat:history'),
  clearChat: () => ipcRenderer.invoke('chat:clear'),
  onOpenChat: (cb) => {
    const h = () => { try { cb(); } catch (e) {} };
    ipcRenderer.on('pet:open-chat', h);
    return () => ipcRenderer.removeListener('pet:open-chat', h);
  },

  /* ---- harness 事件流（流式文本 / 工具调用 / 状态 / 标题 / token）---- */
  onHarnessEvent: (cb) => {
    const h = (_e, evt) => { try { cb(evt); } catch (e) {} };
    ipcRenderer.on('harness:event', h);
    return () => ipcRenderer.removeListener('harness:event', h);
  },
  onHarnessStatus: (cb) => {
    const h = (_e, st) => { try { cb(st); } catch (e) {} };
    ipcRenderer.on('harness:status', h);
    return () => ipcRenderer.removeListener('harness:status', h);
  },
  harnessStatus: () => ipcRenderer.invoke('harness:status'),

  /* ---- 详情卡实时硬件数据 ---- */
  sysInfoStart: () => ipcRenderer.invoke('sysinfo:start'),
  sysInfoStartLight: () => ipcRenderer.invoke('sysinfo:startLight'),
  sysInfoStop:  () => ipcRenderer.invoke('sysinfo:stop'),
  sysInfoGet:   () => ipcRenderer.invoke('sysinfo:get'),
  onSysInfo: (cb) => {
    const h = (_e, d) => { try { cb(d); } catch (e) {} };
    ipcRenderer.on('sysinfo', h);
    return () => ipcRenderer.removeListener('sysinfo', h);
  },

  /* ---- SAO 菜单需要：工作区尺寸 / 多屏切换 / 退出 / 开机自启 ---- */
  workArea:  () => ipcRenderer.invoke('pet:workarea'),
  listDisplays: () => ipcRenderer.invoke('pet:displays'),
  setDisplay:    (id) => ipcRenderer.invoke('pet:setDisplay', id),
  quit:      () => ipcRenderer.send('pet:quit'),
  autoStart: (on) => ipcRenderer.invoke('pet:autostart', on === undefined ? null : !!on),

  /* ---- 设置（DeepSeek API key/网址、harness 路径）---- */
  getConfig:  () => ipcRenderer.invoke('config:get'),
  setConfig:  (patch) => ipcRenderer.invoke('config:set', patch),
  testConfig: () => ipcRenderer.invoke('config:test'),
  browseRepo: () => ipcRenderer.invoke('config:browseRepo'),   // 打开"选择文件夹"对话框选 harness 仓库
  detectRepo: () => ipcRenderer.invoke('config:detect'),       // 重新自动探测（不吃缓存）

  /* ---- 环境自检 + 一键部署（harness / Everything）---- */
  envCheck:   () => ipcRenderer.invoke('env:check', { quick: false }),
  envPickDir: (o) => ipcRenderer.invoke('env:pickDir', o || {}),
  envDeployHarness:   (o) => ipcRenderer.invoke('env:deployHarness', o || {}),
  envDeployEverything:(o) => ipcRenderer.invoke('env:deployEverything', o || {}),
  envLaunchEverything:(exe) => ipcRenderer.invoke('env:launchEverything', exe),
  envCancel:  (id) => ipcRenderer.invoke('env:cancel', id),
  envDismiss: (on) => ipcRenderer.invoke('env:dismiss', !!on),
  envEverythingAuto: (on) => ipcRenderer.invoke('env:everythingAuto', !!on),   // 开机自动后台拉起 Everything 的开关
  envOpenUrl: (u) => ipcRenderer.invoke('env:openUrl', u),
  onEnvLog: (cb) => {                                          // 部署日志/进度流
    const h = (_e, evt) => { try { cb(evt); } catch (e) {} };
    ipcRenderer.on('env:log', h);
    return () => ipcRenderer.removeListener('env:log', h);
  },

  /* ---- Agent 看板（虚拟按键台）：快照 / 选择 / 翻页 / 钉住 / 配置 ---- */
  dock: {
    get: () => ipcRenderer.invoke('dock:get'),
    select: (id) => ipcRenderer.invoke('dock:select', id),
    cycle: (dir) => ipcRenderer.invoke('dock:cycle', dir),
    pin: (key) => ipcRenderer.invoke('dock:pin', key),
    clearEnded: () => ipcRenderer.invoke('dock:clearEnded'),
    probe: () => ipcRenderer.invoke('dock:probe'),
    setConfig: (patch) => ipcRenderer.invoke('dock:config', patch),
    onUpdate: (cb) => {
      const h = (_e, snap) => { try { cb(snap); } catch (e) {} };
      ipcRenderer.on('dock:update', h);
      return () => ipcRenderer.removeListener('dock:update', h);
    }
  },

  /* ---- 角色卡（SillyTavern V2/V3 兼容；只含人设，不含记忆）---- */
  persona: {
    list:        () => ipcRenderer.invoke('persona:list'),
    get:         (id) => ipcRenderer.invoke('persona:get', id),
    save:        (card, id) => ipcRenderer.invoke('persona:save', { card, id }),
    remove:      (id) => ipcRenderer.invoke('persona:delete', id),
    setActive:   (id) => ipcRenderer.invoke('persona:setActive', id || ''),
    importFile:  () => ipcRenderer.invoke('persona:importFile'),
    importBytes: (bytes) => ipcRenderer.invoke('persona:importBuffer', { data: bytes }),
    exportCard:  (id, format, path) => ipcRenderer.invoke('persona:export', { id, format, path }),
    reveal:      () => ipcRenderer.invoke('persona:reveal')
  },

  /* ---- 外置皮肤包（独立皮肤编辑器生成，主进程只读）---- */
  skin: {
    get:         () => ipcRenderer.invoke('skin:get'),
    openFolder:  () => ipcRenderer.invoke('skin:openFolder')
  },

  /* ---- 作息导演层配置（皮肤目录优先，其次 %APPDATA%\桌宠\director.json）---- */
  director: {
    get: () => ipcRenderer.invoke('director:get')
  },

  /* ---- 动画片段循环（独立配置，写它不会重启 harness；主进程校验 + 原子落盘）---- */
  animationLoop: {
    get: () => ipcRenderer.invoke('animation-loop:get'),
    set: (cfg) => ipcRenderer.invoke('animation-loop:set', cfg)
  },

  /* ---- 版本检测与更新 ---- */
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  openUpdateUrl: (url) => ipcRenderer.invoke('update:openUrl', url),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  onUpdateAvailable: (cb) => {
    const h = (_e, info) => { try { cb(info); } catch (e) {} };
    ipcRenderer.on('app:update-available', h);
    return () => ipcRenderer.removeListener('app:update-available', h);
  },

  /* ---- 面板打开状态 → 主进程据此临时注册全局 Esc ---- */
  setPanelOpen: (on) => ipcRenderer.send('pet:panel', !!on),
  gameMode: () => ipcRenderer.invoke('gamemode:get'),
  onGameMode: (cb) => {
    const h = (_e, v) => { try { cb(v); } catch (e) {} };
    ipcRenderer.on('pet:gamemode', h);
    return () => ipcRenderer.removeListener('pet:gamemode', h);
  },
  onEsc: (cb) => {
    const h = () => { try { cb(); } catch (e) {} };
    ipcRenderer.on('pet:esc', h);
    return () => ipcRenderer.removeListener('pet:esc', h);
  }
});
