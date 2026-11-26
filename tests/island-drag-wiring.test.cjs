'use strict';
/* 球/胶囊拖动在真实页面与主进程里的接线（静态检查，起 Electron 之前先挡低级错误）。
 * 运行：node --test tests/island-drag-wiring.test.cjs */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ISLAND_HTML = read('web/island.html');
const ISLAND_PRELOAD = read('app/island-preload.js');
const ISLAND = read('app/island.js');

const fnBody = (src, name) => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const end = src.indexOf('\n  }', i);
  return src.slice(i, end < 0 ? i + 3000 : end);
};

test('island.html：按下先记账，位移超 4px 才进入拖动（单击/双击不被吃）', () => {
  assert.ok(/addEventListener\('mousedown'/.test(ISLAND_HTML), '缺少 mousedown');
  assert.ok(/d < 4/.test(ISLAND_HTML), '缺少 4px 拖动阈值');
  assert.ok(/dragState\.active = true/.test(ISLAND_HTML), '阈值后没进入拖动');
});

test('island.html：拖动用屏幕坐标，且松手抑制随后的 click', () => {
  assert.ok(/islandDragStart\(dragState\.sx, dragState\.sy\)/.test(ISLAND_HTML), '拖动开始要交按下的屏幕坐标');
  assert.ok(/islandDragMove\(num\(e\.screenX\), num\(e\.screenY\)\)/.test(ISLAND_HTML), '拖动移动要交屏幕坐标');
  assert.ok(/islandDragEnd\(num\(e\.screenX\), num\(e\.screenY\)\)/.test(ISLAND_HTML), '松手要交最后坐标');
  assert.ok(/if \(suppressClick\) return;/.test(ISLAND_HTML), '拖完的 click 没被抑制 → 会误触 pin');
});

test('island.html：拖动中不改穿透（否则半路断事件）', () => {
  assert.ok(/if \(dragState\) return;\s*\/\/ 拖动中不改穿透/.test(ISLAND_HTML), 'hitAt 在拖动中仍会切穿透');
});

test('island-preload：暴露 start/move/end 三件套', () => {
  for (const m of ['islandDragStart', 'islandDragMove', 'islandDragEnd']) {
    assert.ok(new RegExp(m + ':').test(ISLAND_PRELOAD), 'preload 缺少 ' + m);
  }
  assert.ok(/ipcRenderer\.send\('island:drag-move'/.test(ISLAND_PRELOAD), 'move 应走 send（不回包）');
});

test('island.js：三类 IPC 都接了，move 走 on', () => {
  assert.ok(/'island:drag-start':/.test(ISLAND), '缺少 island:drag-start 处理器');
  assert.ok(/'island:drag-end':/.test(ISLAND), '缺少 island:drag-end 处理器');
  assert.ok(/ipcMain\.on\('island:drag-move'/.test(ISLAND), '缺少 island:drag-move');
  assert.ok(/function dragTo\(/.test(ISLAND) && /function dragEnd\(/.test(ISLAND), '缺少 dragTo/dragEnd');
});

test('island.js：移动不写盘，松手才把 off 写进 island.json', () => {
  const to = fnBody(ISLAND, 'dragTo');
  const end = fnBody(ISLAND, 'dragEnd');
  assert.ok(!/saveCfg\(/.test(to), 'dragTo 里不许 saveCfg：拖动过程中一帧都不写盘');
  assert.ok(/cfg\.off = readOff\(off\)/.test(end) && /saveCfg\(/.test(end), 'dragEnd 必须落盘 off');
  assert.ok(/place\(true\)/.test(end), 'dragEnd 应按最终偏移再落一次位');
});

test('island.js：最终落点 = 默认落点 + off，且 off 从不被夹取值覆盖', () => {
  const pos = fnBody(ISLAND, 'islandPos');
  assert.ok(/d\.x \+ off\.x/.test(pos) && /d\.y \+ off\.y/.test(pos), 'islandPos 没有加手动偏移');
  assert.ok(!/off\s*=\s*\{[^}]*area\.x/.test(pos), 'islandPos 里把夹取值写回 off 了');
  assert.ok(/off: \{ x: off\.x, y: off\.y \}/.test(ISLAND), 'state() 没暴露 off，外部没法核验');
  assert.ok(/let off = readOff\(cfg\.off\)/.test(ISLAND), '启动时没有从 island.json 还原 off');
});

test('island.js：resetPos 同时清掉 off（回到桌宠头顶）', () => {
  const i = ISLAND.indexOf('resetPos: () =>');
  const body = ISLAND.slice(i, i + 400);
  assert.ok(/off = \{ x: 0, y: 0 \}/.test(body), 'resetPos 没清 off');
  assert.ok(/delete cfg\.off/.test(body), 'resetPos 没把旧 off 从配置里删掉');
});
