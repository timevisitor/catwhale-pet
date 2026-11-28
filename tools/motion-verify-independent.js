#!/usr/bin/env node
/**
 * motion-verify-independent.js — 用与实现**完全不同**的方法复算弹簧引擎
 *
 * 为什么要这个文件：tools/motion-selftest.js 是随引擎一起写的，断言与实现同源，
 * 它全绿只证明「实现符合它自己的预期」。这里改为拿 ODE 的数值积分（RK4，步长 1e-5 秒）
 * 当独立基准，去对 island-motion.js 的闭式解。两种方法毫无共同代码路径，
 * 两边一致才说明解析解真的对。
 *
 * 对照方程：x'' + 2ζω x' + ω²(x - target) = 0，ω = 2π/response
 *
 * 用法：node tools/motion-verify-independent.js
 * 退出码：0 全过，1 有失败。
 */
'use strict';

const path = require('node:path');
const Motion = require(path.join(__dirname, '..', 'web', 'island-motion.js'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('[PASS] ' + name + (extra !== undefined ? '   (' + extra + ')' : '')); }
  else { fail++; failures.push(name); console.log('[FAIL] ' + name + (extra !== undefined ? '   (' + extra + ')' : '')); }
}
const fmt = (x) => (typeof x === 'number' ? (Math.abs(x) < 1e-6 && x !== 0 ? x.toExponential(3) : x.toFixed(9)) : String(x));

/* ---------------- 独立基准：RK4 数值积分 ---------------- */
function rk4(x, v, target, omega, zeta, T, steps) {
  const h = T / steps;
  const k = 2 * zeta * omega;
  const w2 = omega * omega;
  const acc = (xx, vv) => -w2 * (xx - target) - k * vv;
  for (let i = 0; i < steps; i++) {
    const a1 = v, b1 = acc(x, v);
    const a2 = v + (h / 2) * b1, b2 = acc(x + (h / 2) * a1, v + (h / 2) * b1);
    const a3 = v + (h / 2) * b2, b3 = acc(x + (h / 2) * a2, v + (h / 2) * b2);
    const a4 = v + h * b3, b4 = acc(x + h * a3, v + h * b3);
    x += (h / 6) * (a1 + 2 * a2 + 2 * a3 + a4);
    v += (h / 6) * (b1 + 2 * b2 + 2 * b3 + b4);
  }
  return [x, v];
}

const RESPONSE = 0.35;
const OMEGA = (Math.PI * 2) / RESPONSE;
const STEPS_PER_SEC = 100000;   // h = 1e-5 s

/* 让引擎从 (0, 0) 走到 tMs（关掉吸附，否则尾巴会被吸到 target 掩盖误差） */
function engineAt(zeta, tMs, stepMs) {
  const m = Motion.create({ response: RESPONSE, damping: zeta, settleEps: 0 });
  m.reset(0);
  m.to(1);
  let t = 0;
  m.frame(t);                       // 建时间基准，dt=0
  while (t < tMs) {
    t = Math.min(tMs, t + stepMs);
    m.frame(t);
  }
  return m;
}

console.log('=== 独立基准：RK4(h=1e-5s) vs 解析解 ===\n');
console.log('ω = 2π/0.35 = ' + fmt(OMEGA) + ' rad/s\n');

/* ---------- 1. 三个阻尼分支的整条轨迹 ---------- */
for (const zeta of [0.6, 1.0, 2.0]) {
  const m = engineAt(zeta, 400, 4);
  const got = m.peek().value;
  const ref = rk4(0, 0, 1, OMEGA, zeta, 0.4, Math.round(0.4 * STEPS_PER_SEC))[0];
  const d = Math.abs(got - ref);
  check('ζ=' + zeta + ' t=400ms 解析解 vs RK4 数值积分（Δ<1e-6）', d < 1e-6,
    'engine=' + fmt(got) + ' rk4=' + fmt(ref) + ' Δ=' + d.toExponential(2));
}

/* ---------- 2. 多时间点逐点比对（ζ=1，含峰值与尾巴） ---------- */
{
  const m = engineAt(1.0, 600, 2);
  let worst = 0, worstAt = 0;
  for (const tMs of [20, 50, 100, 200, 350, 600]) {
    const mm = engineAt(1.0, tMs, 2);
    const ref = rk4(0, 0, 1, OMEGA, 1.0, tMs / 1000, Math.max(1, Math.round((tMs / 1000) * STEPS_PER_SEC)))[0];
    const d = Math.abs(mm.peek().value - ref);
    if (d > worst) { worst = d; worstAt = tMs; }
  }
  check('ζ=1 六个时间点最大偏差 < 1e-6', worst < 1e-6, 'maxΔ=' + worst.toExponential(2) + ' @' + worstAt + 'ms');
}

/* ---------- 3. 速度也要对（不只位置） ---------- */
{
  const m = engineAt(1.0, 120, 2);
  const ref = rk4(0, 0, 1, OMEGA, 1.0, 0.12, Math.round(0.12 * STEPS_PER_SEC));
  const dv = Math.abs(m.peek().velocity - ref[1]);
  check('ζ=1 t=120ms 速度 vs RK4（Δ<1e-5）', dv < 1e-5,
    'engine=' + fmt(m.peek().velocity) + ' rk4=' + fmt(ref[1]) + ' Δ=' + dv.toExponential(2));
}

/* ---------- 4. 步长无关：1ms / 16ms / 500ms 一步到位 ---------- */
{
  const a = engineAt(1.0, 400, 1).peek().value;
  const b = engineAt(1.0, 400, 16).peek().value;
  const c = engineAt(1.0, 400, 500).peek().value;      // 一次巨型跳帧
  const spread = Math.max(a, b, c) - Math.min(a, b, c);
  check('步长 1/16/500ms 结果一致（极差 < 1e-9）', spread < 1e-9,
    'a=' + fmt(a) + ' b=' + fmt(b) + ' c=' + fmt(c) + ' spread=' + spread.toExponential(2));
}

/* ---------- 5. ζ=1 不过冲、单调 ---------- */
{
  const m = Motion.create({ response: RESPONSE, damping: 1, settleEps: 0 });
  m.reset(0); m.to(1); m.frame(0);
  let maxV = -Infinity, mono = true, prev = 0;
  for (let t = 4; t <= 1200; t += 4) {
    const v = m.frame(t).value;
    if (v > maxV) maxV = v;
    if (v < prev - 1e-12) mono = false;
    prev = v;
  }
  check('ζ=1 全程不过冲（max ≤ 1+1e-12）', maxV <= 1 + 1e-12, 'max=' + fmt(maxV));
  check('ζ=1 全程单调不减', mono, '');
}

/* ---------- 6. 反向中断：速度必须原样保留（这是被修掉的那个 bug） ---------- */
{
  const m = Motion.create({ response: RESPONSE, damping: 1, settleEps: 0 });
  m.reset(0); m.to(1); m.frame(0);
  for (let t = 10; t <= 100; t += 10) m.frame(t);
  const before = m.peek();
  check('中断前处于上行（v>1）', before.velocity > 1, 'v=' + fmt(before.velocity) + ' p=' + fmt(before.value));

  const t0 = 100;
  m.to(0, { now: t0 });          // 从改目标这一刻起算，和真实调用方一致
  const after = m.peek();
  check('中断瞬间位置连续（Δ<1e-12）', Math.abs(after.value - before.value) < 1e-12, 'Δ=' + Math.abs(after.value - before.value).toExponential(2));
  check('中断瞬间速度原样保留（不被人为反向）',
    Math.abs(after.velocity - before.velocity) < 1e-12,
    'v before=' + fmt(before.velocity) + ' after=' + fmt(after.velocity));

  /* 后续轨迹与 RK4 从该状态积分对比 */
  m.frame(t0 + 30);
  const ref = rk4(before.value, before.velocity, 0, OMEGA, 1.0, 0.03, Math.round(0.03 * STEPS_PER_SEC));
  const d = Math.abs(m.peek().value - ref[0]);
  check('反向中断后 30ms 轨迹 vs RK4（Δ<1e-6）', d < 1e-6,
    'engine=' + fmt(m.peek().value) + ' rk4=' + fmt(ref[0]) + ' Δ=' + d.toExponential(2));

  /* 物理正确性：惯性会让它先越过切换点（不是立刻掉头） */
  const m2 = Motion.create({ response: RESPONSE, damping: 1, settleEps: 0 });
  m2.reset(0); m2.to(1); m2.frame(0);
  for (let t = 10; t <= 100; t += 10) m2.frame(t);
  const pSwitch = m2.peek().value;
  m2.to(0, { now: 100 });
  let peak = pSwitch;
  for (let t = 105; t <= 260; t += 5) peak = Math.max(peak, m2.frame(t).value);
  check('惯性先上漂越过切换点（真实弹簧手感，非强行停住）', peak > pSwitch + 0.01,
    'switch=' + fmt(pSwitch) + ' peak=' + fmt(peak) + ' 上漂=' + ((peak - pSwitch) * 100).toFixed(2) + '%');
  const end = m2.frame(4000).value;
  check('最终回到 0 且不越过 0', end >= -1e-12 && end < 0.01, 'p(4s)=' + fmt(end));
}

/* ---------- 7. 落定吸附 ---------- */
{
  const m = Motion.create({ response: RESPONSE, damping: 1 });
  m.reset(0); m.to(1); m.frame(0);
  let settledAt = null;
  for (let t = 8; t <= 2000; t += 8) {
    if (m.frame(t).settled) { settledAt = t; break; }
  }
  check('能在 2 秒内落定', settledAt !== null && settledAt < 2000, 'settleAt=' + settledAt + 'ms');
  check('落定后 value === target（精确相等，无残差）', m.peek().value === 1, 'value=' + m.peek().value);
  check('落定后 velocity 归零', m.peek().velocity === 0, 'v=' + m.peek().velocity);
}

/* ---------- 8. 通道：容器先于内容，且都由 p 推导 ---------- */
{
  const c0 = Motion.channelsFromP(0);
  const c1 = Motion.channelsFromP(1);
  check('p=0 通道终值正确', c0.fade === 0 && c0.content === 0 && Math.abs(c0.scale - 0.96) < 1e-12 && c0.blur === 6 && Math.abs(c0.offset + 18) < 1e-12,
    JSON.stringify(c0));
  check('p=1 通道终值正确', c1.fade === 1 && c1.content === 1 && c1.scale === 1 && Math.abs(c1.blur) < 1e-12 && Math.abs(c1.offset) < 1e-12,
    JSON.stringify(c1));
  let orderOK = true, worstGap = -Infinity;
  for (let p = 0; p <= 1.0001; p += 0.01) {
    const c = Motion.channelsFromP(p);
    if (c.content > c.fade + 1e-12) { orderOK = false; break; }
    worstGap = Math.max(worstGap, c.fade - c.content);
  }
  check('全区间 content ≤ fade（容器永远不晚于内容出现）', orderOK, '最大间距=' + fmt(worstGap));
}

console.log('\n---------------------------------------------');
console.log('独立复算结果：PASS ' + pass + ' / FAIL ' + fail);
console.log('---------------------------------------------');
if (fail) console.log('失败项: ' + failures.join(' | '));
process.exit(fail ? 1 : 0);
