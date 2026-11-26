'use strict';
/* 灵动岛锚点：主进程侧的采纳策略 + 重启恢复（anchor 提示）。
 *
 * app/island.js 顶部 require('electron')，所以这里用一个最小的 electron 桩把它跑起来：
 * 只用到 createIsland() 暴露的 noteAnchor / state / cfg，不建任何窗口。
 *
 * 运行：node --test tests/island-anchor-state.test.cjs */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

/* ---- electron 桩：记下 ipcMain 注册的处理器，好在测试里直接调 ---- */
const handlers = new Map();
const electronStub = {
  BrowserWindow: function () { throw new Error('本测试不该建窗口'); },
  ipcMain: {
    handle(ch, fn) { handlers.set(ch, fn); },
    on(ch, fn) { handlers.set('on:' + ch, fn); },
  },
  screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
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
  const dir = fs.mkdtempSync(path.join(TMPROOT, 'island-' + tag + '-'));
  return dir;
}

function newIsland(dir, cfgObj) {
  if (cfgObj) fs.writeFileSync(path.join(dir, 'island.json'), JSON.stringify(cfgObj));
  const island = createIsland({
    getUserData: () => dir,
    log: () => {},
    getPort: () => 0,              // 0 → ensure() 不建窗口（返回 null）
    getPetWin: () => null,
    getMediaState: () => null,
    hasHubNotify: () => true,
    getInfo: () => null,
  });
  return island;
}

const rect = { sx: 1000, sy: 600, rx: 0, ry: 0, rw: 204, rh: 340 };

test('呼吸量级的抖动不采纳（<3%）', () => {
  const island = newIsland(mkdirTmp('eps'));
  island.noteAnchor(Object.assign({ cx: 0.50, head: 0.20, pose: true }, rect));
  island.noteAnchor(Object.assign({ cx: 0.51, head: 0.21 }, rect));      // 1% 漂移
  assert.equal(island.state().anchor.head, 0.20, '呼吸不该推动锚点');
  island.noteAnchor(Object.assign({ cx: 0.50, head: 0.26 }, rect));      // 6% 真变化
  assert.equal(island.state().anchor.head, 0.26, '真实变化必须采纳');
});

test('pose=true 直接采纳（换动作后的新头顶）', () => {
  const island = newIsland(mkdirTmp('pose'));
  island.noteAnchor(Object.assign({ cx: 0.5, head: 0.20, pose: true }, rect));
  island.noteAnchor(Object.assign({ cx: 0.5, head: 0.14, pose: true }, rect));
  assert.equal(island.state().anchor.head, 0.14);
});

test('没有量到头顶（meas:false）时不采纳兜底值', () => {
  const island = newIsland(mkdirTmp('meas'));
  island.noteAnchor(Object.assign({ cx: 0.5, head: 0.20, pose: true }, rect));
  island.noteAnchor(Object.assign({ cx: 0.5, head: 0.22, meas: false }, rect));
  assert.equal(island.state().anchor.head, 0.20, '兜底值不该把已量到的头顶冲掉');
  /* 位置仍然要跟 */
  island.noteAnchor(Object.assign({ cx: 0.5, head: 0.22, meas: false }, { sx: 1400, sy: 600, rx: 0, ry: 0, rw: 204, rh: 340 }));
  assert.equal(island.state().anchorRect.sx, 1400, '位置必须照跟');
});

test('重启恢复：首帧没量到头顶时沿用松手存下的相对锚点', () => {
  const dir = mkdirTmp('hint');
  const island = newIsland(dir, { enabled: true, msg: false, music: false, video: false, holdMs: 8000,
    anchor: { cx: 0.62, head: 0.31 } });
  /* 模拟重启后的第一帧：视频还没解出首帧，页面只能给兜底 0.5/0.22 */
  island.noteAnchor(Object.assign({ cx: 0.5, head: 0.22, meas: false }, rect));
  assert.deepEqual(island.state().anchor, { cx: 0.62, head: 0.31 },
    '首帧必须先落在上次松手存下的相对位置');
  /* 量到之后就被真值接管 */
  island.noteAnchor(Object.assign({ cx: 0.55, head: 0.27, pose: true }, rect));
  assert.deepEqual(island.state().anchor, { cx: 0.55, head: 0.27 });
});

test('拖动松手才落盘：anchor-commit 写进 island.json（保留其它开关）', () => {
  const dir = mkdirTmp('commit');
  const island = newIsland(dir, { enabled: true, msg: false, music: true, video: true, holdMs: 8000 });
  island.bindIpc();       // 用桩 ipcMain 注册，不会真的挂到 Electron 上
  const h = handlers.get('island:anchor-commit');
  assert.ok(typeof h === 'function', '没注册 island:anchor-commit');
  const r = h(null, { cx: 0.6123, head: 0.2777 });
  assert.equal(r.ok, true);
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'island.json'), 'utf8'));
  assert.deepEqual(disk.anchor, { cx: 0.612, head: 0.278 }, '锚点要落盘（保留三位小数）');
  assert.equal(disk.msg, false, '写盘不能把消息开关冲掉');
  assert.equal(disk.music, true);
  assert.equal(h(null, { cx: 'x', head: 0.2 }).ok, false, '非法输入不写盘');
});
