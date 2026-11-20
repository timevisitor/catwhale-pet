'use strict';
/* 走动几何的断言（先写测试，再实现 web/walk-geom.js）。
   这一块是纯函数：不认 DOM / Electron，浏览器与 Node 共用同一份，
   所以「画布不越界 / 二维有界 / 朝向跟着水平分量走」可以脱离界面单独判定。

   运行：node --test tests/walk-geom.test.cjs
   PET_TEST_TMP 可指定临时目录（本机交付放在 H 盘主题目录下，不新建 C 盘目录）。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const G = require('../web/walk-geom.js');

/* 默认桌宠尺寸：高 = 340（尺寸滑块默认），宽 = 高 × 900/1500 = 204 */
const PET_W = 204, PET_H = 340;

test('反向框选（右下 → 左上）得到同一个矩形', () => {
  const a = G.rectFromDrag({ x: 900, y: 700 }, { x: 200, y: 100 });
  const b = G.rectFromDrag({ x: 200, y: 100 }, { x: 900, y: 700 });
  assert.deepEqual(a, { x: 200, y: 100, width: 700, height: 600 });
  assert.deepEqual(a, b);
});

test('零面积框选被判定为无效（单击不该被当成范围）', () => {
  const r = G.rectFromDrag({ x: 400, y: 400 }, { x: 402, y: 401 });
  assert.equal(G.rectOk(r), false);
  assert.equal(G.rectOk(G.rectFromDrag({ x: 0, y: 0 }, { x: 400, y: 300 })), true);
});

test('矩形被工作区裁掉超出部分，完全无交集时返回 null', () => {
  const area = { x: 0, y: 0, width: 1000, height: 800 };
  assert.deepEqual(G.intersectRect({ x: -100, y: -50, width: 400, height: 300 }, area),
    { x: 0, y: 0, width: 300, height: 250 });
  assert.equal(G.intersectRect({ x: 2000, y: 0, width: 100, height: 100 }, area), null);
});

test('画布包围盒：范围内能放下 → 允许在矩形内移动', () => {
  const box = G.petBox({ x: 100, y: 100, width: 700, height: 600 }, PET_W, PET_H);
  assert.deepEqual(box, { minX: 100, maxX: 596, minY: 100, maxY: 360, centeredX: false, centeredY: false });
});

test('画布包围盒：矩形比角色还小 → 以矩形为中心（不越界的唯一可能）', () => {
  const box = G.petBox({ x: 500, y: 500, width: 100, height: 100 }, PET_W, PET_H);
  assert.equal(box.centeredX, true);
  assert.equal(box.centeredY, true);
  assert.equal(box.minX, 500 + (100 - PET_W) / 2);
  assert.equal(box.minY, 500 + (100 - PET_H) / 2);
  assert.equal(box.minX, box.maxX);
});

test('clampPet 把角色拉回范围内，并如实报告是否夹过', () => {
  const box = G.petBox({ x: 100, y: 100, width: 700, height: 600 }, PET_W, PET_H);
  assert.deepEqual(G.clampPet(1000, 900, box), { x: 596, y: 360, clamped: true });
  assert.deepEqual(G.clampPet(300, 200, box), { x: 300, y: 200, clamped: false });
});

test('stepToward：一次走不完只走 maxDist，够了就精确落在目标上', () => {
  const a = G.stepToward(0, 0, 1000, 0, 120);
  assert.equal(a.arrived, false);
  assert.equal(a.x, 120);
  const b = G.stepToward(980, 0, 1000, 0, 120);
  assert.equal(b.arrived, true);
  assert.equal(b.x, 1000);
});

test('stepToward：二维斜向也按直线推进（巡游允许上下左右走）', () => {
  const s = G.stepToward(0, 0, 300, 400, 50);      // 3-4-5
  assert.equal(s.dx, 30);
  assert.equal(s.dy, 40);
  assert.equal(s.arrived, false);
});

test('stepToward：已经在目标上时不抖（arrived=true，坐标不动）', () => {
  assert.deepEqual(G.stepToward(50, 50, 50, 50, 10), { x: 50, y: 50, arrived: true, dx: 0, dy: 0, distance: 0 });
});

test('朝向只由水平分量决定；纯竖直移动沿用上一次朝向', () => {
  assert.equal(G.facingOf(-30), 'left');
  assert.equal(G.facingOf(30), 'right');
  assert.equal(G.facingOf(0), '');
  assert.equal(G.facingOf(0.0001), 'right');
});

test('窗口尺寸变了（分辨率/DPI/换屏）时矩形按比例缩放', () => {
  const r = { x: 100, y: 200, width: 800, height: 600 };
  assert.deepEqual(G.scaleRect(r, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }),
    { x: 200, y: 400, width: 1600, height: 1200 });
  assert.deepEqual(G.scaleRect(r, { width: 1920, height: 1080 }, { width: 1920, height: 1080 }), r, '同尺寸必须原样返回');
  assert.deepEqual(G.scaleRect(r, null, { width: 800, height: 600 }), r, '缺少来源尺寸时不猜，原样返回');
});

test('巡游目标永远落在包围盒内（1000 次抽样不越界）', () => {
  const box = G.petBox({ x: 100, y: 100, width: 700, height: 600 }, PET_W, PET_H);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 1000; i++) {
    const t = G.cruiseTarget(box, rnd);
    assert.ok(t.x >= box.minX - 1e-9 && t.x <= box.maxX + 1e-9, 'x 越界 ' + t.x);
    assert.ok(t.y >= box.minY - 1e-9 && t.y <= box.maxY + 1e-9, 'y 越界 ' + t.y);
  }
});

test('normalizeRect 容忍 w/h 简写与脏数据', () => {
  assert.deepEqual(G.normalizeRect({ x: 10, y: 20, w: 300, h: 400 }), { x: 10, y: 20, width: 300, height: 400 });
  assert.deepEqual(G.normalizeRect({ x: '10', y: 20, width: -5, height: 400 }), { x: 10, y: 20, width: 0, height: 400 });
  assert.equal(G.normalizeRect(null), null);
  assert.equal(G.normalizeRect({ x: NaN, y: 1, width: 10, height: 10 }), null);
});

test('几何模块不依赖 DOM（Node 里 require 就能跑）', () => {
  assert.equal(typeof path.sep, 'string');
  assert.equal(typeof G.petBox, 'function');
  assert.equal(typeof globalThis.document, 'undefined');
});

/* ---- 范围小于画布：不许走（评审挡发布项之二） ---- */
test('范围放得下画布才算可用：正好等于画布算放得下', () => {
  assert.equal(G.fitsRect({ x: 0, y: 0, width: PET_W, height: PET_H }, PET_W, PET_H).ok, true);
  assert.equal(G.fitsRect({ x: 0, y: 0, width: PET_W + 1, height: PET_H + 1 }, PET_W, PET_H).ok, true);
});

test('范围比画布小：fitsRect 判否，并给出「至少多大」的可读文案', () => {
  const r = G.fitsRect({ x: 0, y: 0, width: 120, height: 600 }, PET_W, PET_H);
  assert.equal(r.ok, false);
  assert.deepEqual(r.need, { w: PET_W, h: PET_H });
  assert.match(r.error, /120×600/);
  assert.match(r.error, /204×340/);
  const r2 = G.fitsRect({ x: 0, y: 0, width: 800, height: 100 }, PET_W, PET_H);
  assert.equal(r2.ok, false, '只有高度不够也要判否');
  assert.equal(G.fitsRect(null, PET_W, PET_H).ok, false);
});

test('范围恰好差半像素仍算放得下（浮点容差，避免 339.99 被判死）', () => {
  assert.equal(G.fitsRect({ x: 0, y: 0, width: PET_W, height: PET_H - 0.4 }, PET_W, PET_H).ok, true);
  assert.equal(G.fitsRect({ x: 0, y: 0, width: PET_W, height: PET_H - 1.5 }, PET_W, PET_H).ok, false);
});

/* ---- 目标重算：窗口/范围变了以后目标可能落到新包围盒外 ---- */
test('clampTarget 把目标夹进包围盒，并如实报告夹过', () => {
  const box = { minX: 100, maxX: 400, minY: 100, maxY: 200 };
  assert.deepEqual(G.clampTarget({ x: 900, y: 150 }, box), { x: 400, y: 150, moved: true });
  assert.deepEqual(G.clampTarget({ x: 200, y: 120 }, box), { x: 200, y: 120, moved: false });
  assert.deepEqual(G.clampTarget(null, box), { x: 100, y: 100, moved: true });
});

test('重算后一定能收敛：目标在盒外 → 夹进盒内 → stepToward 能走到（不会永远差一点）', () => {
  const box = { minX: 100, maxX: 400, minY: 100, maxY: 200 };
  const t = G.clampTarget({ x: 5000, y: 5000 }, box);
  let p = { x: 100, y: 100 };
  for (let i = 0; i < 500; i++) {
    const st = G.stepToward(p.x, p.y, t.x, t.y, 8);
    const c = G.clampPet(st.x, st.y, box);
    p = { x: c.x, y: c.y };
    if (st.arrived || Math.hypot(t.x - p.x, t.y - p.y) < 0.5) break;
  }
  assert.ok(Math.hypot(t.x - p.x, t.y - p.y) < 0.5, '应当收敛到目标，实际还差 ' + Math.hypot(t.x - p.x, t.y - p.y));
});
