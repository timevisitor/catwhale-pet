'use strict';
/* 灵动岛主循环的推送节流（app/island.js 的 tick）
 *
 * 球态（idle）没有波形/歌词/进度这些随时间走的内容，内容只在 尖角位置 / 钉住 /
 * 角标 变化时才该推。v0.7.1 是不管变没变 500ms 一推；这里钉住：
 *   · 球态签名没变 → 不推（页面渲染进程零唤醒）
 *   · 签名变了（角标/尖角/钉住）→ 推一次
 *   · 非球态（音乐/消息/Agent…）→ 每拍都推（波形要靠它动）
 *   · 回到球态 → 至少推一次；页面重载后 → 至少重推一次
 *
 * 用 electron 桩把 island.js 跑起来（不建真窗口），拦下 setInterval 手动驱动 tick。
 * 运行：node --test tests/island-idle-push.test.cjs */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const WA = { x: 0, y: 0, width: 1920, height: 1040 };

class FakeWin {
  constructor(opts) {
    this.opts = opts || {};
    this.b = { x: opts.x || 0, y: opts.y || 0, width: opts.width || 640, height: opts.height || 150 };
    this.visible = false;
    this.destroyed = false;
    this.sent = [];
    this.loads = [];
    this.zoom = 1;
    const self = this;
    this.webContents = {
      on(ev, fn) { self.loads.push({ ev, fn }); },
      send(ch, payload) { self.sent.push({ ch, payload }); },
      setZoomFactor(z) { self.zoom = z; },
    };
  }
  getBounds() { return Object.assign({}, this.b); }
  setBounds(b) { this.b = Object.assign({}, this.b, b); }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  setAlwaysOnTop() {}
  setIgnoreMouseEvents() {}
  loadURL() {}
  on() {}
}

const wins = [];
const handlers = new Map();
const electronStub = {
  BrowserWindow: function (opts) { const w = new FakeWin(opts); wins.push(w); return w; },
  ipcMain: {
    handle(ch, fn) { handlers.set(ch, fn); },
    on(ch, fn) { handlers.set('on:' + ch, fn); },
  },
  screen: { getDisplayNearestPoint: () => ({ workArea: Object.assign({}, WA) }) },
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return electronStub;
  return origLoad.call(this, req, parent, isMain);
};
const { createIsland } = require('../app/island.js');

const TMPROOT = process.env.PET_TEST_TMP || process.env.TMPDIR || os.tmpdir();
function newIsland(info) {
  const dir = fs.mkdtempSync(path.join(TMPROOT, 'island-idle-push-'));
  const island = createIsland({
    getUserData: () => dir,
    log: () => {},
    getPort: () => 19001,
    getPetWin: () => ({ isDestroyed: () => false, isVisible: () => true,
      getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1040 }) }),
    getMediaState: () => null,
    hasHubNotify: () => true,                       // 不起通知源
    getInfo: () => info,
  });
  island.bindIpc();
  /* 拦下内容循环：手动驱动 tick，不依赖真实 500ms 定时器 */
  let tick = null;
  const realSetInterval = global.setInterval;
  global.setInterval = (fn) => { tick = fn; return 1; };
  try { island.start(); } finally { global.setInterval = realSetInterval; }
  return { island, dir, tick: () => tick(), win: () => wins[wins.length - 1] };
}

test('球态：签名没变不推；变了推一次；非球态每拍都推；回球态至少推一次', async () => {
  const info = { todoOpen: 0 };
  const t = newIsland(info);
  /* 给一个角色矩形 + 头顶锚点：这样 place() 有落点、窗口会 showInactive */
  t.island.noteAnchor({ cx: 0.5, head: 0.22, sx: 600, sy: 300, rw: 204, rh: 340 });
  const w = t.win();
  const dataPushes = () => w.sent.filter((s) => s.ch === 'island:data');

  t.tick();
  assert.equal(w.isVisible(), true, '有锚点后球应显示');
  assert.equal(dataPushes().length, 1, '首拍：页面还没拿到过内容，必须推');
  assert.equal(dataPushes()[0].payload.mode, 'idle');

  for (let i = 0; i < 10; i++) t.tick();
  assert.equal(dataPushes().length, 1, '球态内容没变：连续 10 拍不应再推');

  /* 角标变了（有待办）→ 推一次 */
  info.todoOpen = 3;
  t.tick();
  assert.equal(dataPushes().length, 2);
  assert.equal(dataPushes()[1].payload.badge, 3);
  t.tick(); t.tick();
  assert.equal(dataPushes().length, 2, '角标稳定后不再推');

  /* 角色贴到屏幕左边缘：窗口被夹回、尖角位置变 → 推一次。
     走真实的 IPC 路径 queueAnchor（latest-only，下一轮事件循环里 noteAnchor + place）。 */
  t.island.queueAnchor({ cx: 0.5, head: 0.22, sx: 4, sy: 300, rw: 204, rh: 340 });
  await new Promise((r) => setImmediate(r));
  t.tick();
  const afterEdge = dataPushes().length;
  assert.equal(afterEdge, 3, '尖角位置变化应推一次');
  assert.notEqual(dataPushes()[2].payload.tailX, dataPushes()[1].payload.tailX);

  /* Agent 在干活 → 胶囊态：每拍都推 */
  t.island.noteAgent({ sessions: [{ state: 'working', agent: 'codex', title: 't', updatedAt: Date.now() }] });
  t.tick(); t.tick(); t.tick();
  assert.equal(dataPushes().length, 6, '非球态每拍都推');
  assert.equal(dataPushes()[5].payload.mode, 'agent');

  /* 回到球态：至少推一次，然后静默 */
  t.island.noteAgent({ sessions: [] });
  t.tick();
  assert.equal(dataPushes().length, 7);
  assert.equal(dataPushes()[6].payload.mode, 'idle');
  t.tick(); t.tick();
  assert.equal(dataPushes().length, 7);
});

test('页面重载后（did-finish-load）：即使球态签名没变也重推一次', () => {
  const t = newIsland({ todoOpen: 0 });
  t.island.noteAnchor({ cx: 0.5, head: 0.22, sx: 600, sy: 300, rw: 204, rh: 340 });
  const w = t.win();
  const count = () => w.sent.filter((s) => s.ch === 'island:data').length;
  t.tick(); t.tick();
  assert.equal(count(), 1);
  /* 崩溃恢复 / 手动 reload：页面从空白球重新开始，需要再拿到一份当前内容 */
  for (const l of w.loads) if (l.ev === 'did-finish-load') l.fn();
  t.tick();
  assert.equal(count(), 2, '重载后应重推');
  t.tick();
  assert.equal(count(), 2, '之后恢复静默');
});

test('球还不可见（没角色矩形）：不因为签名去重而漏掉首推', () => {
  const t = newIsland({ todoOpen: 0 });      // 不喂锚点
  const w = t.win();
  t.tick(); t.tick();
  assert.equal(w.isVisible(), false);
  const n = w.sent.filter((s) => s.ch === 'island:data').length;
  assert.ok(n >= 1, '未显示时照常推送（与旧行为一致）');
});

test('灵动岛窗口用独立 session：胶囊缩放不得泄漏到主窗口', () => {
  /* Chromium 的页面缩放按「同一 BrowserContext 内同源」共享。岛和主窗口都是
     http://127.0.0.1:<port>/…，岛为了跟随角色缩放会 setZoomFactor(0.8) ——
     不隔离的话主窗口也变成 0.8：角色画小 20%，页面坐标与屏幕 DIP 差 20%，
     岛被摆到角色旁边而不是头顶（实测 zoom={main:0.8,island:0.8}）。 */
  const t = newIsland({ todoOpen: 0 });
  t.tick();
  const prefs = t.win().opts.webPreferences || {};
  assert.equal(typeof prefs.partition, 'string');
  assert.ok(prefs.partition.length > 0, '岛必须有自己的 partition');
  assert.notEqual(prefs.partition, 'persist:session', '不能与主窗口共用默认 session');
});
