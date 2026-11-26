'use strict';
/* 灵动岛锚点上报器（web/island-anchor.js）的断言。
   这一块是纯逻辑：注入 rect/head/时钟/rAF 就能脱离 Electron 单独判定，
   所以「按帧合并 / 只在变化时发 / 逐像素头顶识别不按帧做 / 呼吸不算移动」都能钉死。

   运行：node --test tests/island-anchor.test.cjs */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const A = require('../web/island-anchor.js');

/* 假的帧循环：只在你调用 frame() 时才真的执行排队的 rAF 回调 */
function rig(opts) {
  const o = opts || {};
  let t = 1000;
  const queue = [];
  const sent = [];
  const state = { t: 0 };
  const rep = A.create({
    now: () => t,
    raf: (cb) => { queue.push(cb); return queue.length; },
    rect: () => (o.rect === null ? null : (o.rect || { x: 500, y: 300, w: 204, h: 340 })),
    head: (key) => { state.headScans = (state.headScans || 0) + 1; return o.head ? o.head(key) : { cx: 0.5, head: 0.2 }; },
    key: () => o.key || 'idle',
    send: (p) => sent.push(Object.assign({ at: t }, p)),
  });
  return {
    rep, sent, state,
    frame() { const q = queue.splice(0); q.forEach((cb) => cb(t)); },
    advance(ms) { t += ms; },
    now: () => t,
    setRect(r) { o.rect = r; },
    setHead(h) { o.head = () => h; },
    setKey(k) { o.key = k; },
  };
}

test('同一帧里多次 poke 只合成一次上报（按帧合并）', () => {
  const r = rig();
  for (let i = 0; i < 20; i++) r.rep.poke();
  assert.equal(r.sent.length, 0, 'rAF 还没跑，不应有任何上报');
  r.frame();
  assert.equal(r.sent.length, 1, '20 次 poke 合并成 1 次');
  assert.equal(r.rep.stats().flushes, 1);
});

test('静止时零上报：矩形和锚点都没变就不发', () => {
  const r = rig();
  r.rep.poke(); r.frame();                       // 首帧必须发（主进程要靠它落位）
  assert.equal(r.sent.length, 1);
  for (let i = 0; i < 10; i++) { r.advance(16); r.rep.poke(); r.frame(); }
  assert.equal(r.sent.length, 1, '10 帧静止 → 一次都不该再发');
  assert.equal(r.rep.stats().idleFlushes, 10);
});

test('亚像素抖动不发，超过 0.5 DIP 才发', () => {
  const r = rig();
  r.rep.poke(); r.frame();
  r.setRect({ x: 500.4, y: 300, w: 204, h: 340 });
  r.rep.poke(); r.frame();
  assert.equal(r.sent.length, 1, '0.4 DIP 波动应当被吞掉');
  r.setRect({ x: 500.6, y: 300, w: 204, h: 340 });
  r.rep.poke(); r.frame();
  assert.equal(r.sent.length, 2, '0.6 DIP 是真的移动了');
});

test('贵的逐像素头顶识别不按帧做：1 秒内 60 帧最多扫 1 次', () => {
  const r = rig();
  r.rep.poke({ force: true }); r.frame();
  const scans0 = r.state.headScans;
  for (let i = 1; i <= 60; i++) {
    r.advance(16);
    r.setRect({ x: 500 + i, y: 300, w: 204, h: 340 });
    r.rep.poke(); r.frame();
  }
  assert.equal(r.sent.length, 61, '每帧都有位移 → 每帧都上报');
  assert.ok(r.state.headScans - scans0 <= 1,
    '1 秒内的 60 帧最多扫一次头顶，实测 ' + (r.state.headScans - scans0));
});

test('头顶的呼吸级漂移不算移动（沿用旧值，不产生上报）', () => {
  const r = rig();
  r.setHead({ cx: 0.500, head: 0.200 });
  r.rep.poke({ force: true }); r.frame();
  const n0 = r.sent.length;
  for (let i = 0; i < 5; i++) {
    r.advance(200);
    r.setHead({ cx: 0.500 + 0.008 * (i % 2 ? 1 : -1), head: 0.200 + 0.01 * (i % 2 ? 1 : -1) }); // 1% 量级
    r.rep.poke(); r.frame();
  }
  assert.equal(r.sent.length, n0, '呼吸抖动（<2%）不该推动窗口');
});

test('动作状态换了：立刻重扫头顶，并带 pose 标志让主进程马上采纳', () => {
  const r = rig();
  r.setHead({ cx: 0.5, head: 0.2 });
  r.rep.poke({ force: true }); r.frame();
  const scans0 = r.state.headScans;
  r.advance(16);
  r.setKey('walk_right');
  r.setHead({ cx: 0.5, head: 0.12 });            // 走动姿态头顶明显更低
  r.rep.poke(); r.frame();
  const last = r.sent[r.sent.length - 1];
  assert.equal(r.state.headScans - scans0, 1, '换姿态必须重扫一次');
  assert.equal(last.pose, true);
  assert.equal(last.head, 0.12);
});

test('超过 1.2s 会到期重扫一次（兜底），未到期不扫', () => {
  const r = rig();
  r.rep.poke({ force: true }); r.frame();
  const s0 = r.state.headScans;
  r.advance(600); r.rep.poke(); r.frame();
  assert.equal(r.state.headScans, s0, '600ms 未到期');
  r.advance(700); r.rep.poke(); r.frame();
  assert.equal(r.state.headScans, s0 + 1, '1300ms 到期重扫');
});

test('角色还没出画（rect 为空）时跳过，不塞垃圾给主进程', () => {
  const r = rig();
  r.setRect(null);
  r.rep.poke({ force: true }); r.frame();
  assert.equal(r.sent.length, 0);
  assert.equal(r.rep.stats().dropped, 1);
});

test('首帧带 force 时即便数值相同也发一次（换皮肤/镜像场景）', () => {
  const r = rig();
  r.rep.poke(); r.frame();
  assert.equal(r.sent.length, 1);
  r.rep.poke({ force: true }); r.frame();
  assert.equal(r.sent.length, 2, 'force 必须穿透「没变化就不发」');
  assert.equal(r.sent[1].pose, true);
});
