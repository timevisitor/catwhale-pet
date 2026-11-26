'use strict';
/* 灵动岛手动偏移：拖动落盘 / 重启还原 / 贴边只夹显示不回写 / 闲时不搬窗。
 *
 * 用 electron 桩把 app/island.js 跑起来（不建真窗口），走的是页面拖动时同一条
 * IPC 入口：island:drag-start / island:drag-move / island:drag-end。
 * 期望值按「文档里的几何」独立算，不读被测模块的内部状态。
 *
 * 运行：node --test tests/island-drag.test.cjs */
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
    this.ignore = true;
    this.destroyed = false;
    this.setBoundsCalls = 0;
    this.webContents = { on() {}, send() {}, setZoomFactor(z) { this.zoom = z; } };
  }
  getBounds() { return Object.assign({}, this.b); }
  setBounds(b) { this.setBoundsCalls++; this.b = Object.assign({}, this.b, b); }
  getPosition() { return [this.b.x, this.b.y]; }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  setAlwaysOnTop() {}
  setIgnoreMouseEvents(v) { this.ignore = !!v; }
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
function mkdirTmp(tag) {
  fs.mkdirSync(TMPROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TMPROOT, 'island-drag-' + tag + '-'));
}
function readCfg(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'island.json'), 'utf8')); } catch (e) { return null; }
}
function newIsland(dir, cfgObj) {
  if (cfgObj) fs.writeFileSync(path.join(dir, 'island.json'), JSON.stringify(cfgObj));
  const island = createIsland({
    getUserData: () => dir,
    log: () => {},
    getPort: () => 19000,                 // 真建窗口（桩）
    getPetWin: () => ({ isDestroyed: () => false, isVisible: () => true,
      getBounds: () => ({ x: 100, y: 100, width: 900, height: 700 }) }),
    getMediaState: () => null,
    hasHubNotify: () => true,
    getInfo: () => null,
  });
  island.bindIpc();
  /* 建一次窗口（tick 里的 ensure）再停掉定时器：本测试只需要窗口几何，不需要内容循环 */
  island.start();
  island.stop();
  return island;
}

/* 独立几何：角色矩形 + 锚点 → 默认落点（与文档一致） */
const W = 640, H = 150, TOP_PAD = 8, BALL = 56, CAP_H = 104, GAP = 6;
function geom(rect, a, off, caps) {
  const zoom = Math.round(Math.min(1, Math.max(0.5, rect.rh / 430)) * 50) / 50;
  const Wz = Math.round(W * zoom);
  const contentH = caps ? CAP_H : BALL;
  const cxScreen = rect.sx + (rect.rx || 0) + a.cx * rect.rw;
  const headScreen = rect.sy + (rect.ry || 0) + a.head * rect.rh;
  let x = Math.round(cxScreen - Wz / 2 + off.x);
  let y = Math.round(headScreen - GAP - (TOP_PAD + contentH) * zoom + off.y);
  if (x < WA.x) x = WA.x;
  if (x + Wz > WA.x + WA.width) x = WA.x + WA.width - Wz;
  if (y < WA.y) y = WA.y;
  return { x, y, zoom, Wz, bottom: y + (TOP_PAD + contentH) * zoom };
}

const RECT = { sx: 1000, sy: 600, rx: 0, ry: 0, rw: 204, rh: 340 };
const A = { cx: 0.5, head: 0.2 };

function prime(island) {
  island.noteAnchor(Object.assign({}, A, RECT, { pose: true }));
  island.place(true);
}

test('拖动只在松手时落盘：移动中 island.json 不出现 off', () => {
  const dir = mkdirTmp('commit');
  const island = newIsland(dir, { enabled: true, msg: false, music: false, video: false, holdMs: 8000 });
  prime(island);
  const win = island.win();
  const off0 = { x: 0, y: 0 };
  const d0 = geom(RECT, A, off0, false);
  assert.deepEqual({ x: win.getBounds().x, y: win.getBounds().y }, { x: d0.x, y: d0.y },
    '未拖动时应落在默认位置');

  assert.equal(island.state().dragging, false);
  assert.equal(handlers.get('island:drag-start')(null, { sx: 1100, sy: 620 }).ok, true);
  assert.equal(island.state().dragging, true);
  handlers.get('on:island:drag-move')(null, { sx: 1220, sy: 690 });       // +120,+70
  assert.equal(readCfg(dir) && readCfg(dir).off, undefined, '拖动过程中不许写盘');
  assert.deepEqual(island.state().off, { x: 120, y: 70 }, '内存里的偏移应立即跟随');

  const r = handlers.get('island:drag-end')(null, { sx: 1220, sy: 690 });
  assert.equal(r.ok, true);
  assert.deepEqual(readCfg(dir).off, { x: 120, y: 70 }, '松手后偏移落盘');
  assert.equal(island.state().dragging, false);
  /* 窗口 = 默认 + 偏移 */
  const d1 = geom(RECT, A, { x: 120, y: 70 }, false);
  assert.equal(win.getBounds().x, d1.x);
  assert.equal(win.getBounds().y, d1.y);
  /* 开关不被冲掉 */
  assert.equal(readCfg(dir).msg, false);
});

test('重启还原：新实例按 island.json 的 off 落回同一相对位置', () => {
  const dir = mkdirTmp('restart');
  fs.writeFileSync(path.join(dir, 'island.json'), JSON.stringify({
    enabled: true, msg: false, music: false, video: false, holdMs: 8000, off: { x: 137.5, y: -22 },
  }));
  const island = newIsland(dir);
  prime(island);
  const win = island.win();
  const want = geom(RECT, A, { x: 137.5, y: -22 }, false);
  assert.equal(win.getBounds().x, want.x, '重启后 x 必须带上手调偏移');
  assert.equal(win.getBounds().y, want.y, '重启后 y 必须带上手调偏移');
  assert.deepEqual(island.state().off, { x: 137.5, y: -22 });
});

test('贴边只夹取显示、不回写偏移；桌宠挪回屏内后恢复 anchor+off', () => {
  const dir = mkdirTmp('clamp');
  const island = newIsland(dir);
  prime(island);
  const win = island.win();
  /* 往右拖 700 DIP：默认 846 + 700 = 1546，右缘夹到 1408 */
  handlers.get('island:drag-start')(null, { sx: 1100, sy: 620 });
  handlers.get('island:drag-end')(null, { sx: 1800, sy: 620 });
  assert.deepEqual(readCfg(dir).off, { x: 700, y: 0 }, 'off 必须是用户意图，不是被夹后的值');
  assert.equal(win.getBounds().x, WA.x + WA.width - geom(RECT, A, { x: 0, y: 0 }, false).Wz,
    '显示上要夹在右缘');
  /* 桌宠挪到左边：默认落点不再贴边，应精确回到 default+700 */
  const leftRect = Object.assign({}, RECT, { sx: 200 });
  island.noteAnchor(Object.assign({}, A, leftRect, { pose: true }));
  island.place(true, 1);
  const want = geom(leftRect, A, { x: 700, y: 0 }, false);
  assert.equal(win.getBounds().x, want.x, '换位置后必须按原偏移精确回位（夹取无残留）');
  assert.equal(readCfg(dir).off.x, 700, '回位过程不许改 off');
});

test('球↔胶囊：底边不动（胶囊向上长），偏移不变', () => {
  const dir = mkdirTmp('caps');
  fs.writeFileSync(path.join(dir, 'island.json'), JSON.stringify({
    enabled: true, msg: true, music: false, video: false, holdMs: 8000, off: { x: 40, y: -10 },
  }));
  const island = newIsland(dir);
  prime(island);
  const win = island.win();
  const ball = geom(RECT, A, { x: 40, y: -10 }, false);
  assert.equal(win.getBounds().y, ball.y);
  /* demo 一条消息 → 下一次 tick 切到胶囊态 */
  island.start();
  island.demo('msg');
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        const caps = geom(RECT, A, { x: 40, y: -10 }, true);
        assert.equal(win.getBounds().y, caps.y, '胶囊态的窗口顶应上移');
        assert.equal(Math.round(win.getBounds().y + (TOP_PAD + CAP_H) * caps.zoom),
          Math.round(ball.y + (TOP_PAD + BALL) * ball.zoom), '可见底边必须不动');
        assert.deepEqual(readCfg(dir).off, { x: 40, y: -10 }, '切换形态不许改偏移');
        island.stop();
        resolve();
      } catch (e) { island.stop(); reject(e); }
    }, 700);
  });
});

test('空闲不搬窗：同样的锚点重复落位不产生 setBounds', () => {
  const dir = mkdirTmp('idle');
  const island = newIsland(dir);
  prime(island);
  const win = island.win();
  const before = win.setBoundsCalls;
  for (let i = 0; i < 30; i++) {
    island.noteAnchor(Object.assign({}, A, RECT));       // 呼吸量级：没有变化
    island.place(false, 1);
  }
  assert.equal(win.setBoundsCalls, before, '静止时 setBounds 次数必须为 0');
});

test('非法偏移当 0：island.json 里 off 是字符串/缺字段不炸', () => {
  const dir = mkdirTmp('bad');
  fs.writeFileSync(path.join(dir, 'island.json'), JSON.stringify({
    enabled: true, msg: false, music: false, video: false, holdMs: 8000, off: { x: 'nope', y: 3 },
  }));
  const island = newIsland(dir);
  prime(island);
  assert.deepEqual(island.state().off, { x: 0, y: 0 });
});

test('「回到桌宠头顶」同时清掉手动偏移', () => {
  const dir = mkdirTmp('reset');
  fs.writeFileSync(path.join(dir, 'island.json'), JSON.stringify({
    enabled: true, msg: false, music: false, video: false, holdMs: 8000, off: { x: 200, y: 120 },
  }));
  const island = newIsland(dir);
  prime(island);
  island.resetPos();
  assert.deepEqual(island.state().off, { x: 0, y: 0 });
  assert.equal(readCfg(dir).off, undefined, '复位后 island.json 里不该再留着旧偏移');
});
