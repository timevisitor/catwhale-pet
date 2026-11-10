'use strict';
/* 透明窗工作区校准（最小化恢复 / 显示拓扑变化）的回归测试。
   复现的真实症状：窗口建好以后显示拓扑、分辨率、缩放或任务栏变了，
   窗口仍保持旧 workArea 的尺寸（实测 2880×1548），而选定屏最新 workArea 是 3840×2088；
   桌宠拖到窗口边界外会被 body{overflow:hidden} 裁掉，且 resizable:false 让用户无法手动拉回。

   这里直接调用 app/main.js 里的 production helper（不启动 Electron 窗口）：
   在 require 之前把 electron 模块替换成最小桩，并按 --user-data-dir 的等价方式隔离 userData。
   运行：node --test tests/window-display-sync.test.cjs
   PET_TEST_TMP 可指定测试工作目录（本机交付时放在 H 盘证据目录，避免新建 C 盘目录）。 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const TEMP_ROOT = process.env.PET_TEST_TMP || os.tmpdir();
fs.mkdirSync(TEMP_ROOT, { recursive: true });
const temp = fs.mkdtempSync(path.join(TEMP_ROOT, 'winsync-'));
after(() => {
  const resolved = path.resolve(temp);
  assert.equal(path.dirname(resolved), path.resolve(TEMP_ROOT));
  assert.ok(path.basename(resolved).startsWith('winsync-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});

/* main.js 在模块加载期会读写 userData（boot-guard 状态、pet-state 等），
   所以必须在 require 之前把 app.getPath 指到本轮临时目录。 */
const electron = {
  app: {
    getPath: (name) => (name === 'temp' ? temp : temp),
    commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => false,      // 跳过 whenReady / 建窗
    quit() {},
    on() {},
    whenReady: () => new Promise(() => {}),
    disableHardwareAcceleration() {},
    getVersion: () => '0.0.0-test',
    getAppMetrics: () => [],
  },
  BrowserWindow: class {},
  ipcMain: { handle() {}, on() {} },
  Tray: class {},
  Menu: { buildFromTemplate: () => ({}) },
  screen: {
    getPrimaryDisplay: () => ({ id: 1, primary: true, workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
    getAllDisplays: () => [],
  },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true, resize: () => ({}), }) },
  shell: {}, clipboard: {}, globalShortcut: {}, safeStorage: {}, dialog: {}, net: {},
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return electron;
  return origLoad.apply(this, arguments);
};
const main = require('../app/main.js');
Module._load = origLoad;

/* 真实 Windows 当前状态：主屏物理 3840×2088（150% 缩放后的工作区），
   窗口恢复后仍是旧屏的 2880×1548。 */
const MAIN_3840x2088 = { id: 7, primary: true, workArea: { x: 0, y: 0, width: 3840, height: 2088 } };

function fakeWindow(bounds, opts) {
  const o = opts || {};
  const calls = [];
  return {
    calls,
    getBounds: () => Object.assign({}, bounds),
    isMinimized: () => !!o.minimized,
    isDestroyed: () => !!o.destroyed,
    setBounds: (b) => { calls.push(Object.assign({}, b)); },
  };
}

test('恢复后窗口仍是旧工作区尺寸：按选定屏最新 workArea 重设（2880×1548 → 3840×2088）', () => {
  const plan = main.planWindowDisplaySync({
    displays: [MAIN_3840x2088],
    displayId: MAIN_3840x2088.id,
    currentBounds: { x: 0, y: 0, width: 2880, height: 1548 },
    winSize: null,
    minimized: false,
  });
  assert.equal(plan.action, 'set');
  assert.equal(plan.displayId, MAIN_3840x2088.id);
  assert.deepEqual(plan.target, { x: 0, y: 0, width: 3840, height: 2088 });
});

test('窗口被 Windows 挪到主屏时，仍按保存的选定屏校准（不是按当前 bounds 猜屏）', () => {
  const displays = [
    { id: 1, primary: true, workArea: { x: 0, y: 0, width: 2560, height: 1392 } },
    { id: 2, primary: false, workArea: { x: 2560, y: 0, width: 1920, height: 1080 } },
  ];
  const plan = main.planWindowDisplaySync({
    displays,
    displayId: 2,
    currentBounds: { x: 0, y: 0, width: 1920, height: 1032 },
    winSize: null,
    minimized: false,
  });
  assert.equal(plan.action, 'set');
  assert.equal(plan.displayId, 2);
  assert.deepEqual(plan.target, { x: 2560, y: 0, width: 1920, height: 1080 });
});

test('runWindowDisplaySync 把新工作区真正 setBounds 到窗口', () => {
  const win = fakeWindow({ x: 0, y: 0, width: 2880, height: 1548 });
  const r = main.runWindowDisplaySync(win, {
    displays: [MAIN_3840x2088],
    displayId: MAIN_3840x2088.id,
    winSize: null,
  });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(win.calls.length, 1);
  assert.deepEqual(win.calls[0], { x: 0, y: 0, width: 3840, height: 2088 });
});

test('窗口已在目标工作区：不重复 setBounds（避免 resize 循环）', () => {
  const win = fakeWindow({ x: 0, y: 0, width: 3840, height: 2088 });
  const r = main.runWindowDisplaySync(win, {
    displays: [MAIN_3840x2088],
    displayId: MAIN_3840x2088.id,
    winSize: null,
  });
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(r.action, 'none');
  assert.equal(win.calls.length, 0);
});

test('最小化期间不 setBounds，等 restore 再校准（保留 Windows 显示桌面兼容）', () => {
  const win = fakeWindow({ x: 0, y: 0, width: 2880, height: 1548 }, { minimized: true });
  const r = main.runWindowDisplaySync(win, {
    displays: [MAIN_3840x2088],
    displayId: MAIN_3840x2088.id,
    winSize: null,
  });
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(r.action, 'defer');
  assert.equal(win.calls.length, 0);
});

test('保存的屏已不存在：回退主屏最新 workArea', () => {
  const displays = [
    { id: 3, primary: false, workArea: { x: -1920, y: 0, width: 1920, height: 1080 } },
    { id: 9, primary: true, workArea: { x: 0, y: 0, width: 3840, height: 2088 } },
  ];
  const plan = main.planWindowDisplaySync({
    displays,
    displayId: 99,
    currentBounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    winSize: null,
    minimized: false,
  });
  assert.equal(plan.action, 'set');
  assert.equal(plan.displayId, 9);
  assert.equal(plan.fallback, true);
  assert.deepEqual(plan.target, { x: 0, y: 0, width: 3840, height: 2088 });
});

test('从未保存过屏幕：直接用主屏，不标记为回退', () => {
  const plan = main.planWindowDisplaySync({
    displays: [MAIN_3840x2088],
    displayId: undefined,
    currentBounds: { x: 0, y: 0, width: 2880, height: 1548 },
    winSize: null,
    minimized: false,
  });
  assert.equal(plan.action, 'set');
  assert.equal(plan.displayId, MAIN_3840x2088.id);
  assert.equal(plan.fallback, false);
  assert.deepEqual(plan.target, MAIN_3840x2088.workArea);
});

test('任务栏/分辨率变化：x/y/宽高都跟最新 workArea，不只改尺寸', () => {
  const plan = main.planWindowDisplaySync({
    displays: [{ id: 5, primary: true, workArea: { x: 0, y: 48, width: 3840, height: 2040 } }],
    displayId: 5,
    currentBounds: { x: 0, y: 0, width: 3840, height: 2088 },
    winSize: null,
    minimized: false,
  });
  assert.equal(plan.action, 'set');
  assert.deepEqual(plan.target, { x: 0, y: 48, width: 3840, height: 2040 });
});

test('--winsize 调试尺寸保持：只跟随显示原点，不被整屏覆盖', () => {
  const plan = main.planWindowDisplaySync({
    displays: [{ id: 2, primary: true, workArea: { x: 100, y: 50, width: 2560, height: 1392 } }],
    displayId: 2,
    currentBounds: { x: 200, y: 200, width: 800, height: 600 },
    winSize: { width: 800, height: 600 },
    minimized: false,
  });
  assert.equal(plan.action, 'set');
  assert.deepEqual(plan.target, { x: 300, y: 250, width: 800, height: 600 });
});

test('--winsize 只接受 WxH；非法值退回整屏而不是 NaN 几何', () => {
  assert.deepEqual(main.parseWinSize('800x600'), { width: 800, height: 600 });
  assert.equal(main.parseWinSize('800'), null);
  assert.equal(main.parseWinSize(''), null);
});

test('窗口已销毁：同步安全返回，不抛异常', () => {
  const win = fakeWindow({}, { destroyed: true });
  const r = main.runWindowDisplaySync(win, {
    displays: [MAIN_3840x2088],
    displayId: MAIN_3840x2088.id,
    winSize: null,
  });
  assert.equal(r.ok, false);
  assert.equal(win.calls.length, 0);
});
