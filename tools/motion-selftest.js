/**
 * motion-selftest.js — web/island-motion.js 的 node 自测
 *
 * 用法：node tools/motion-selftest.js
 * 退出码：全 PASS = 0，有 FAIL = 1（可以直接挂进构建/CI）
 *
 * 覆盖 7 组契约断言 + 2 组加固（API 形状、ζ≠1 分支步长无关）。
 */
'use strict';

var path = require('node:path');
var Motion = require(path.join(__dirname, '..', 'web', 'island-motion.js'));

var pass = 0;
var fail = 0;
var failures = [];

function group(title) {
  console.log('');
  console.log('== ' + title + ' ==');
}

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('[PASS] ' + name + (detail ? '   (' + detail + ')' : ''));
  } else {
    fail++;
    failures.push(name);
    console.log('[FAIL] ' + name + (detail ? '   (' + detail + ')' : ''));
  }
}

function fmt(x) {
  if (typeof x !== 'number' || !isFinite(x)) return String(x);
  if (x !== 0 && Math.abs(x) < 1e-4) return x.toExponential(3);
  var s = x.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

var T0 = 1000;   // 任意时间基准（ms）

/* ============================================================
 * 0. API 形状
 * ========================================================== */
group('0. API 形状');
check('0.1 模块导出 channelsFromP / smoothstep / create',
  typeof Motion.channelsFromP === 'function' &&
  typeof Motion.smoothstep === 'function' &&
  typeof Motion.create === 'function',
  Object.keys(Motion).join(', '));

var mApi = Motion.create();
check('0.2 实例方法齐备',
  ['to', 'frame', 'channels', 'peek', 'reset', 'isSettled'].every(function (k) {
    return typeof mApi[k] === 'function';
  }),
  'to/frame/channels/peek/reset/isSettled');

check('0.3 默认参数（response .35 / damping 1）',
  Motion.DEFAULT_RESPONSE === 0.35 && Motion.DEFAULT_DAMPING === 1,
  'response=' + Motion.DEFAULT_RESPONSE + ' damping=' + Motion.DEFAULT_DAMPING);

/* ============================================================
 * 1. 0→1，ζ=1：不过冲 + 单调
 * ========================================================== */
group('1. 0→1（ζ=1，response=0.35）：不超调、单调');
var m1 = Motion.create({ response: 0.35, damping: 1 });
m1.to(1);
var r1 = m1.frame(T0);
check('1.0 首帧建立时间基准，dt=0，value=0',
  r1.value === 0 && r1.settled === false,
  'value=' + r1.value);

var maxV = r1.value;
var prev = r1.value;
var mono = true;
var monoAt = -1;
var settleAt = -1;
for (var i = 1; i <= 1200; i++) {
  var ri = m1.frame(T0 + i);
  if (ri.value > maxV) maxV = ri.value;
  if (ri.value < prev - 1e-6) { mono = false; if (monoAt < 0) monoAt = i; }
  prev = ri.value;
  if (settleAt < 0 && ri.settled) settleAt = i;
}
check('1.1 全程 value ≤ 1.0001（不过冲）', maxV <= 1.0001, 'max=' + fmt(maxV));
check('1.2 单调不减（容差 1e-6）', mono, mono ? '无任何回退' : ('第 ' + monoAt + 'ms 回退'));
check('1.3 结束值收敛到 1（1e-9）', Math.abs(prev - 1) < 1e-9, 'value=' + fmt(prev));
check('1.4 落定时间落在 300~900ms', settleAt >= 300 && settleAt <= 900, 'settleAt=' + settleAt + 'ms');

/* ============================================================
 * 2. 步长无关（1 / 4 / 16 / 50ms → 400ms）
 * ========================================================== */
group('2. 步长无关：1/4/16/50ms 推进到 400ms');
var OMEGA = 2 * Math.PI / 0.35;
function criticalDirect(t) {          // 独立实现：e0=-1, v0=0, ζ=1
  return 1 - (1 + OMEGA * t) * Math.exp(-OMEGA * t);
}
var expected400 = criticalDirect(0.400);
console.log('     解析直算 value(400ms) = ' + expected400.toFixed(12));

var stepCases = [1, 4, 16, 50];
var stepVals = [];
stepCases.forEach(function (dt) {
  var m = Motion.create({ response: 0.35, damping: 1 });
  m.to(1);
  m.frame(T0);
  var n = 400 / dt;
  var out = null;
  for (var k = 1; k <= n; k++) out = m.frame(T0 + k * dt);
  stepVals.push(out.value);
  check('2.' + (stepCases.indexOf(dt) + 1) + ' dt=' + dt + 'ms 与解析直算差 < 1e-3',
    Math.abs(out.value - expected400) < 1e-3,
    'value=' + out.value.toFixed(12) + ' Δ=' + Math.abs(out.value - expected400).toExponential(2));
});

var spread = Math.max.apply(null, stepVals) - Math.min.apply(null, stepVals);
check('2.5 四种步长互相之间差 < 1e-6', spread < 1e-6, 'spread=' + spread.toExponential(2));

/* ============================================================
 * 3. 中途反向：value 连续，速度掉头指向 0
 * ========================================================== */
group('3. 中途反向（p≈0.5 时 .to(0)）');
var m3 = Motion.create({ response: 0.35, damping: 1 });
m3.to(1);
m3.frame(T0);
var valBefore = null;
var velBefore = null;
var tSwitch = -1;
for (var j = 1; j <= 1200; j++) {
  var r3 = m3.frame(T0 + j);
  if (r3.value >= 0.5) {
    valBefore = r3.value;
    velBefore = m3.peek().velocity;
    tSwitch = j;
    break;
  }
}
check('3.0 切换前处于上行段（velocity > 0）',
  tSwitch > 0 && velBefore > 1,
  't=' + tSwitch + 'ms value=' + fmt(valBefore) + ' v=' + fmt(velBefore));

m3.to(0, { now: T0 + tSwitch });   // 从改目标这一刻起算（不传会让下一帧重建基准，丢一帧）
var after = m3.peek();
check('3.1 中断瞬间 value 连续（|Δ| < 1e-9）',
  Math.abs(after.value - valBefore) < 1e-9,
  'Δ=' + Math.abs(after.value - valBefore).toExponential(2));
check('3.2 velocity 原样保留（方向与大小都不改，惯性连续）',
  Math.abs(after.velocity - velBefore) < 1e-12,
  'v=' + fmt(after.velocity) + '（切换前 ' + fmt(velBefore) + '）');

/* 真实弹簧被打断时速度是连续的：物体靠惯性先越过切换点再被拉回。
   解析峰值出现在 t = v0/(ω·(v0+ω·e0)) —— 本例约 21ms，所以取 +20ms 采样峰。 */
var v20 = m3.frame(T0 + tSwitch + 20).value;
var v100 = m3.frame(T0 + tSwitch + 100).value;
check('3.3 惯性先上漂越过切换点（不是凭空反向停住）',
  v20 > valBefore + 0.01,
  'p(' + tSwitch + 'ms)=' + fmt(valBefore) + ' → +20ms ' + fmt(v20));
check('3.4 随后被弹簧拉回 0，且不越过 0',
  v100 < v20 && v100 >= 0,
  '+20ms ' + fmt(v20) + ' → +100ms ' + fmt(v100));

/* ============================================================
 * 4. 落定：settled=true 且 value 精确等于 target
 * ========================================================== */
group('4. 落定判据');
var m4 = Motion.create({ response: 0.35, damping: 1 });
m4.to(1);
m4.frame(T0);
var r4 = null;
for (var k4 = 1; k4 <= 300; k4++) r4 = m4.frame(T0 + k4 * 5);
check('4.1 收敛后 settled=true', r4.settled === true, 'settled=' + r4.settled);
check('4.2 |value - target| < 1e-9', Math.abs(r4.value - 1) < 1e-9, 'Δ=' + Math.abs(r4.value - 1).toExponential(2));
check('4.3 value 精确等于 target（===，无残差）', r4.value === 1, 'value=' + r4.value);
check('4.4 velocity 归零', m4.peek().velocity === 0, 'v=' + m4.peek().velocity);

var r4b = m4.frame(T0 + 5000);
check('4.5 落定后再推进仍精确锁在 target', r4b.value === 1 && r4b.settled === true, 'value=' + r4b.value);

/* ============================================================
 * 5. 通道边界与滞后关系
 * ========================================================== */
group('5. 派生通道');
var c0 = Motion.channelsFromP(0);
var c1 = Motion.channelsFromP(1);
var cHalf = Motion.channelsFromP(0.5);

check('5.1 p=0 → {fade:0, content:0, scale:.96, blur:6, offset:-18}',
  c0.fade === 0 && c0.content === 0 &&
  Math.abs(c0.scale - 0.96) < 1e-12 && Math.abs(c0.blur - 6) < 1e-12 && Math.abs(c0.offset + 18) < 1e-12,
  'fade=' + fmt(c0.fade) + ' content=' + fmt(c0.content) + ' scale=' + fmt(c0.scale) +
  ' blur=' + fmt(c0.blur) + ' offset=' + fmt(c0.offset));

check('5.2 p=1 → {fade:1, content:1, scale:1, blur:0, offset:0}',
  Math.abs(c1.fade - 1) < 1e-12 && Math.abs(c1.content - 1) < 1e-12 &&
  Math.abs(c1.scale - 1) < 1e-12 && Math.abs(c1.blur) < 1e-12 && Math.abs(c1.offset) < 1e-12,
  'fade=' + fmt(c1.fade) + ' content=' + fmt(c1.content) + ' scale=' + fmt(c1.scale) +
  ' blur=' + fmt(c1.blur) + ' offset=' + fmt(c1.offset));

check('5.3 p=0.5 时 content < fade（容器先于内容）',
  cHalf.content < cHalf.fade,
  'fade=' + fmt(cHalf.fade) + ' content=' + fmt(cHalf.content));

var orderOk = true;
var orderAt = 0;
for (var p5 = 0; p5 <= 1.0000001; p5 += 0.001) {
  var cc = Motion.channelsFromP(p5);
  if (cc.content > cc.fade + 1e-12) { orderOk = false; orderAt = p5; break; }
}
check('5.4 全区间 content ≤ fade', orderOk, orderOk ? '0→1 单调区域全部满足' : ('p=' + orderAt + ' 违反'));

check('5.5 smoothstep 端点/中点正确',
  Motion.smoothstep(0.18, 0.18, 0.74) === 0 &&
  Motion.smoothstep(0.74, 0.18, 0.74) === 1 &&
  Math.abs(Motion.smoothstep(0.46, 0.18, 0.74) - 0.5) < 1e-12 &&
  Motion.smoothstep(-5, 0.18, 0.74) === 0 &&
  Motion.smoothstep(5, 0.18, 0.74) === 1,
  'step(.46)=0.5 且两端夹紧');

check('5.6 每帧 frame() 返回的 channels 与 channelsFromP(value) 一致',
  (function () {
    var mm = Motion.create({ response: 0.35, damping: 1 });
    mm.to(1);
    mm.frame(T0);
    var rr = mm.frame(T0 + 60);
    var ref = Motion.channelsFromP(rr.value);
    return ['fade', 'content', 'scale', 'blur', 'offset'].every(function (k) {
      return Math.abs(rr.channels[k] - ref[k]) < 1e-12;
    });
  })(), 'keys: fade/content/scale/blur/offset');

/* ============================================================
 * 6. reduced-motion 降级路径
 * ========================================================== */
group('6. reduced-motion：位置立即就位 + 120ms 线性淡入');
var m6 = Motion.create({ reduced: true });
m6.to(1);
check('6.1 .to(1) 后位置立即等于 target',
  m6.peek().value === 1,
  'value=' + m6.peek().value);

var T6 = 5000;
var f0 = m6.frame(T6);            // 建立基准，fade 起点=此处
var f30 = m6.frame(T6 + 30);
var f60 = m6.frame(T6 + 60);
var f90 = m6.frame(T6 + 90);
var f120 = m6.frame(T6 + 120);

check('6.2 t=0 时 fade=0', Math.abs(f0.channels.fade) < 1e-12, 'fade=' + fmt(f0.channels.fade));
check('6.3 t=30ms fade=0.25（线性）', Math.abs(f30.channels.fade - 0.25) < 1e-9, 'fade=' + fmt(f30.channels.fade));
check('6.4 t=60ms fade=0.5（线性）', Math.abs(f60.channels.fade - 0.5) < 1e-9, 'fade=' + fmt(f60.channels.fade));
check('6.5 t=90ms fade=0.75（线性）', Math.abs(f90.channels.fade - 0.75) < 1e-9, 'fade=' + fmt(f90.channels.fade));
check('6.6 t=120ms fade=1 且 settled',
  Math.abs(f120.channels.fade - 1) < 1e-12 && f120.settled === true,
  'fade=' + fmt(f120.channels.fade) + ' settled=' + f120.settled);
check('6.7 120ms 内 fade 严格线性（四段增量相等）',
  Math.abs((f30.channels.fade - f0.channels.fade) - (f60.channels.fade - f30.channels.fade)) < 1e-9 &&
  Math.abs((f90.channels.fade - f60.channels.fade) - (f120.channels.fade - f90.channels.fade)) < 1e-9,
  'Δ=0.25×4');
check('6.8 全程 value 精确等于 target（不经过中间值）',
  f0.value === 1 && f30.value === 1 && f60.value === 1 && f90.value === 1 && f120.value === 1,
  'value=1 全程');
check('6.9 其余通道一开始就取终值 {content:1, scale:1, blur:0, offset:0}',
  [f0, f30, f60, f90, f120].every(function (f) {
    return Math.abs(f.channels.content - 1) < 1e-12 &&
           Math.abs(f.channels.scale - 1) < 1e-12 &&
           Math.abs(f.channels.blur) < 1e-12 &&
           Math.abs(f.channels.offset) < 1e-12;
  }), 'content/scale/blur/offset 就地终值');
check('6.10 淡入未完成时 isSettled()=false',
  (function () {
    var mm = Motion.create({ reduced: true });
    mm.to(1);
    mm.frame(T6);
    mm.frame(T6 + 60);
    return mm.isSettled() === false;
  })(), '60ms 时未落定');
check('6.11 rAF 长时间停摆后再 to()，120ms 仍从下一帧起算',
  (function () {
    var mm = Motion.create({ reduced: true });
    mm.to(1); mm.frame(T6); mm.frame(T6 + 120);      // 先跑完一次淡入
    mm.frame(T6 + 10000);                            // 模拟窗口隐藏、停摆 10s
    mm.to(0);                                        // 收起
    var s1 = mm.frame(T6 + 10010);
    var s2 = mm.frame(T6 + 10070);
    return Math.abs(s1.channels.fade - 1) < 1e-12 &&
           Math.abs(s2.channels.fade - 0.5) < 1e-9 &&
           s1.value === 0;
  })(), 'from 1→0，60ms 时 fade=0.5');

/* ============================================================
 * 7. 大跳帧：一次 frame(t0+500ms)
 * ========================================================== */
group('7. 大跳帧（一次推进 500ms）');
var m7 = Motion.create({ response: 0.35, damping: 1 });
m7.to(1);
m7.frame(T0);
var r7 = m7.frame(T0 + 500);
check('7.1 单帧 500ms 收敛（|value - 1| < 1e-6）',
  Math.abs(r7.value - 1) < 1e-6,
  'value=' + fmt(r7.value) + ' Δ=' + Math.abs(r7.value - 1).toExponential(2));
check('7.2 settled=true', r7.settled === true, 'settled=' + r7.settled);

/* ============================================================
 * 8. 加固：ζ≠1 分支（0.6 欠阻尼 / 2.0 过阻尼）
 * ========================================================== */
group('8. 加固：ζ=0.6 / ζ=2.0 分支可用且步长无关');
[0.6, 2.0].forEach(function (z, idx) {
  var a = Motion.create({ response: 0.35, damping: z });
  a.to(1);
  a.frame(T0);
  for (var q = 1; q <= 400; q++) a.frame(T0 + q);          // 1ms 逐步
  var b = Motion.create({ response: 0.35, damping: z });
  b.to(1);
  b.frame(T0);
  var bOut = b.frame(T0 + 400);                            // 一步到位
  check('8.' + (idx * 2 + 1) + ' ζ=' + z + '：1ms 步进 vs 单步 400ms 差 < 1e-6',
    Math.abs(a.peek().value - bOut.value) < 1e-6,
    'step=' + fmt(a.peek().value) + ' direct=' + fmt(bOut.value) +
    ' Δ=' + Math.abs(a.peek().value - bOut.value).toExponential(2));

  var s = Motion.create({ response: 0.35, damping: z });
  s.to(1);
  s.frame(T0);
  var last = null;
  for (var w = 1; w <= 4000; w++) { last = s.frame(T0 + w * 5); if (last.settled) break; }
  check('8.' + (idx * 2 + 2) + ' ζ=' + z + '：最终精确落定（value===target）',
    last.settled === true && last.value === 1,
    'value=' + last.value + ' v=' + fmt(s.peek().velocity));
});

check('8.5 ζ 越界被夹到 (0,3]',
  (function () {
    var hi = Motion.create({ response: 0.35, damping: 99 });
    hi.to(1); hi.frame(T0);
    var lo = Motion.create({ response: 0.35, damping: -1 });
    lo.to(1); lo.frame(T0);
    var a = hi.frame(T0 + 400).value, b = lo.frame(T0 + 400).value;
    return isFinite(a) && isFinite(b) && a > 0 && b > 0 && a < 1 && b < 1;
  })(), 'damping=99 / -1 不产生 NaN');

/* ============================================================
 * 9. 配套 API：channels() 只读、reset()、to({snap:true})
 * ========================================================== */
group('9. channels() / reset() / snap');
var m9 = Motion.create({ response: 0.35, damping: 1 });
m9.to(1);
m9.frame(T0);
m9.frame(T0 + 100);
var v9 = m9.peek().value;
var cA = m9.channels();
var cB = m9.channels();
check('9.1 channels() 不推进时间（两次读取一致、value 不变）',
  m9.peek().value === v9 && cA.fade === cB.fade && cA.content === cB.content,
  'value=' + fmt(v9) + ' fade=' + fmt(cA.fade));

m9.reset(0.3);
var p9 = m9.peek();
check('9.2 reset(v)：value=target=v 且 velocity=0、立即 settled',
  p9.value === 0.3 && p9.target === 0.3 && p9.velocity === 0 && m9.isSettled() === true,
  'value=' + p9.value + ' v=' + p9.velocity);

m9.to(1);
m9.frame(T0 + 160);
m9.to(0, { snap: true });
var p9b = m9.peek();
check('9.3 to(0,{snap:true}) 直接就位且 settled',
  p9b.value === 0 && p9b.target === 0 && p9b.velocity === 0 && p9b.settled === true,
  'value=' + p9b.value + ' settled=' + p9b.settled);

var f9 = m9.frame(T0 + 260);
check('9.4 snap 之后继续跑帧不会被弹回去',
  f9.value === 0 && f9.settled === true,
  'value=' + f9.value);

check('9.5 目标不变（重复 to 同一 target）不会抖动',
  (function () {
    var mm = Motion.create({ response: 0.35, damping: 1 });
    mm.to(1); mm.frame(T0);
    for (var q = 1; q <= 900; q++) mm.frame(T0 + q);
    var before = mm.peek().value;
    mm.to(1);
    var afterPeek = mm.peek();
    return before === 1 && afterPeek.value === 1 && afterPeek.velocity === 0 && afterPeek.settled === true;
  })(), 'value=1 保持不动');

/* ============================================================
 * 汇总
 * ========================================================== */
console.log('');
console.log('---------------------------------------------');
console.log('结果：PASS ' + pass + ' / FAIL ' + fail + '（共 ' + (pass + fail) + ' 条断言）');
if (fail) console.log('失败项：' + failures.join(' | '));
console.log('---------------------------------------------');

process.exitCode = fail ? 1 : 0;
