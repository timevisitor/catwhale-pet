/**
 * gesture-selftest.js — web/island-gesture.js 的 node 自测
 *
 * 用法：node tools/gesture-selftest.js
 * 退出码：全 PASS = 0，有 FAIL = 1
 *
 * 每组都带**反例**：证明判据不是空转 ——
 *   反例① 位移超过 SLOP 但没到 SWIPE_D、速度又慢 → 必须 none（不许切换）
 *   反例② 位移只有 20px 但甩得快 → 必须 swipe-*（速度判据单独起作用）
 *   反例③ |dx| 与 |dy| 接近时轴锁定不许抖（锁定后改成另一个方向也不改轴）
 *   反例④ dt<=0 / 重复时间戳 / 乱序时间戳 → 速度必须有限，不许 Infinity/NaN
 *   反例⑤ rubberBand 的三个边界（over=0 / over>limit / coef=0,1）
 *
 * 注意一处任务书内部冲突（已在实施报告里写明处理方式）：
 *   判据 3 要「位移够但速度慢 → none」，但判据 4 要「慢拖 80px → 发生切换」，
 *   而第三节的规则是 |vx|>=0.35 **或** |dx|>=40（DotIsle A7 双判据）。
 *   dx>=40 时两条要求直接互斥，所以这里把「位移够但速度慢」严格实现为
 *   「够 SLOP（6px）但不够 SWIPE_D（40px）」→ none；同时单独断言
 *   dx>=40 时即使慢也切换（否则判据 4 的慢拖 80px 不可能成立）。
 */
'use strict';

var path = require('node:path');
var G = require(path.join(__dirname, '..', 'web', 'island-gesture.js'));

var pass = 0, fail = 0;
var failures = [];

function group(title) { console.log('\n== ' + title + ' =='); }
function check(name, ok, detail) {
  if (ok) { pass++; console.log('[PASS] ' + name + (detail !== undefined ? '   (' + detail + ')' : '')); }
  else { fail++; failures.push(name); console.log('[FAIL] ' + name + (detail !== undefined ? '   (' + detail + ')' : '')); }
}
function n(x) {
  if (typeof x !== 'number' || !isFinite(x)) return String(x);
  return String(Math.round(x * 1e4) / 1e4);
}
function near(a, b, eps) { return isFinite(a) && Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps); }

/* 一次完整手势：pts = [[x,y,t], ...]，第一点当 down，最后一点当 up */
function gesture(pts) {
  var g = G.create();
  g.down({ x: pts[0][0], y: pts[0][1], t: pts[0][2] });
  var s = 'pending';
  for (var i = 1; i < pts.length; i++) {
    s = g.move({ x: pts[i][0], y: pts[i][1], t: pts[i][2] }).state;
  }
  var L = pts[pts.length - 1];
  var up = g.up({ x: L[0], y: L[1], t: L[2] });
  up.moveState = s;
  up.axisFinal = g.axis;
  return up;
}
/* 匀速直线：从 (x0,y) 走 dx，分 steps 步，每步 dtMs */
function line(x0, y, dx, steps, dtMs, t0) {
  var pts = [], t = t0 === undefined ? 1000 : t0;
  for (var i = 0; i <= steps; i++) {
    pts.push([x0 + (dx * i) / steps, y, t + dtMs * i]);
  }
  return pts;
}

/* ============================================================
 * 0. API 形状
 * ========================================================== */
group('0. API 形状');
check('0.1 create / rubberBand 都是函数',
  typeof G.create === 'function' && typeof G.rubberBand === 'function');
var g0 = G.create();
check('0.2 实例导出 down / move / up / reset / peek',
  typeof g0.down === 'function' && typeof g0.move === 'function' &&
  typeof g0.up === 'function' && typeof g0.reset === 'function' && typeof g0.peek === 'function');
check('0.3 axis 是只读属性，初始 none', g0.axis === 'none', g0.axis);
check('0.4 常量与任务书一致（SLOP=6 / v=0.35 / d≥40 / hide≥30）',
  G.SLOP === 6 && G.SWIPE_V === 0.35 && G.SWIPE_D === 40 && G.HIDE_D === 30,
  [G.SLOP, G.SWIPE_V, G.SWIPE_D, G.HIDE_D].join('/'));

/* ============================================================
 * 1. 点击 / SLOP
 * ========================================================== */
group('1. 点击与 SLOP=6');
var r = gesture([[300, 40, 1000], [300, 40, 1010]]);
check('1.1 原地按下抬起 → tap', r.type === 'tap', r.type);
r = gesture([[300, 40, 1000], [303, 42, 1010]]);
check('1.2 抖动 3.6px → 仍 tap（不锁轴）', r.type === 'tap' && r.axisFinal === 'none', r.type + '/' + r.axisFinal);
r = gesture([[300, 40, 1000], [305.9, 40, 1010]]);
check('1.3 位移 5.9px（SLOP 边界内侧）→ tap', r.type === 'tap', r.type);
r = gesture([[300, 40, 1000], [306, 40, 1010]]);
check('1.4 位移 6.0px（SLOP 边界）→ 已锁 h、不再是 tap', r.axisFinal === 'h' && r.type !== 'tap',
  r.axisFinal + '/' + r.type);
/* pending → 页面据此不跟随手指（少于 SLOP 的抖动不该让岛动） */
var g1 = G.create();
g1.down({ x: 300, y: 40, t: 1000 });
var m1 = g1.move({ x: 304, y: 41, t: 1010 });
check('1.5 move 未超 SLOP 时 state=pending', m1.state === 'pending', m1.state);
var m2 = g1.move({ x: 320, y: 41, t: 1300 });
check('1.6 同一次手势里慢速越过 SLOP 后从 pending 转 drag', m2.state === 'drag' && m2.axis === 'h',
  m2.state + '/' + m2.axis);
/* 一旦锁轴就不再是点击了：走出去又走回来也不算 tap（轴已锁定，语义已经变成拖拽） */
r = gesture([[300, 40, 1000], [308, 40, 1010], [300, 40, 1020]]);
check('1.7 越过 SLOP 后走回按下点：已锁轴 → 绝不是 tap（轴锁定即退出点击语义）；dx=0 但甩得快，按 OR 判据仍算 swipe',
  r.type !== 'tap' && r.dx === 0 && r.axisFinal === 'h', r.type + '/dx=' + n(r.dx));

/* ============================================================
 * 2. 轴锁定（含反例③）
 * ========================================================== */
group('2. 轴锁定不抖动');
r = gesture([[300, 40, 1000], [306, 45.9, 1010]]);
check('2.1 |dx|=6 > |dy|=5.9 → 锁 h', r.axisFinal === 'h', r.axisFinal);
r = gesture([[300, 40, 1000], [305.9, 46, 1010]]);
check('2.2 |dx|=5.9 < |dy|=6 → 锁 v', r.axisFinal === 'v', r.axisFinal);
r = gesture([[300, 40, 1000], [306, 46, 1010]]);
check('2.3 对角线相等（6,6）→ 按 >= 规则锁 h', r.axisFinal === 'h', r.axisFinal);
/* 反例③：锁定后，后面的位移把另一轴拉大，轴**不许**改 */
var g2 = G.create();
g2.down({ x: 300, y: 40, t: 1000 });
g2.move({ x: 310, y: 42, t: 1010 });          // 锁 h
var mh = g2.move({ x: 311, y: 90, t: 1100 }); // 纵向一下拉到 50px
check('2.4 锁 h 后纵向猛拉 50px，轴仍是 h（不改轴）', mh.axis === 'h' && g2.axis === 'h', mh.axis);
var g3 = G.create();
g3.down({ x: 300, y: 40, t: 1000 });
g3.move({ x: 302, y: 50, t: 1010 });          // 锁 v
var mv = g3.move({ x: 360, y: 51, t: 1100 }); // 横向一下拉到 60px
check('2.5 锁 v 后横向猛拉 60px，轴仍是 v（不改轴）', mv.axis === 'v' && g3.axis === 'v', mv.axis);
/* 锁定只发生一次：来回抖 5.99/6.01 不会把轴在 h/v 之间反复切换 */
var g4 = G.create();
g4.down({ x: 300, y: 40, t: 1000 });
var axes = [];
for (var i = 1; i <= 8; i++) {
  var xx = 300 + (i % 2 ? 6.01 : 4);
  var yy = 40 + (i % 2 ? 0 : 7);
  axes.push(g4.move({ x: xx, y: yy, t: 1000 + i * 16 }).axis);
}
check('2.6 多次来回抖动后轴恒为 h（无抖动切换）', axes.every(function (a) { return a === 'h'; }), axes.join(''));

/* ============================================================
 * 3. 横向判据（含反例①②）
 * ========================================================== */
group('3. 横向：速度 OR 位移');
r = gesture(line(300, 40, -80, 8, 75));
check('3.1 慢拖 80px（vx≈0.133<0.35）→ swipe-left：位移判据单独起作用',
  r.type === 'swipe-left' && Math.abs(r.vx) < G.SWIPE_V && Math.abs(r.dx) >= G.SWIPE_D,
  r.type + ' vx=' + n(r.vx) + ' dx=' + n(r.dx));
r = gesture(line(300, 40, 80, 8, 75));
check('3.2 慢拖 80px 向右 → swipe-right', r.type === 'swipe-right', r.type);
r = gesture([[300, 40, 1000], [290, 40, 1010], [280, 40, 1020]]);
check('3.3 反例②·快甩 20px（vx≈-1.0，|dx|<40）→ swipe-left：速度判据单独起作用',
  r.type === 'swipe-left' && Math.abs(r.dx) === 20 && Math.abs(r.vx) >= G.SWIPE_V,
  r.type + ' vx=' + n(r.vx) + ' dx=' + n(r.dx));
r = gesture(line(300, 40, -10, 1, 300));
check('3.4 反例①·慢拖 10px（够 SLOP 不够 40、速度慢）→ none（不许切换）',
  r.type === 'none' && Math.abs(r.dx) === 10 && Math.abs(r.vx) < G.SWIPE_V,
  r.type + ' vx=' + n(r.vx));
r = gesture(line(300, 40, -25, 4, 120));
check('3.5 反例①·慢拖 25px → none（位移仍不够 40）', r.type === 'none' && Math.abs(r.dx) === 25,
  r.type + ' dx=' + n(r.dx));
r = gesture(line(300, 40, -39.9, 4, 120));
check('3.6 边界·慢拖 39.9px → none', r.type === 'none', r.type + ' dx=' + n(r.dx));
r = gesture(line(300, 40, -40, 4, 120));
check('3.7 边界·慢拖 40.0px → swipe-left（>= 判据含等号）', r.type === 'swipe-left',
  r.type + ' dx=' + n(r.dx));
r = gesture([[300, 40, 1000], [265, 40, 1100]]);
check('3.8 边界·|vx| 恰好 0.35 → swipe-left', Math.abs(Math.abs(r.vx) - 0.35) < 1e-9 && r.type === 'swipe-left',
  'vx=' + r.vx + ' ' + r.type);
r = gesture([[300, 40, 1000], [283, 40, 1050]]);
check('3.9 边界·vx=0.34（不到阈值）且 |dx|<40 → none', r.type === 'none', 'vx=' + n(r.vx) + ' ' + r.type);
/* 慢速长按拖动：抬手前停住不动 200ms，速度掉到 0，但位移够 → 仍要切换（任务书：时长不作唯一依据） */
r = gesture([[300, 40, 1000], [250, 40, 1400], [250, 40, 1600]]);
check('3.10 长按慢拖 50px 后停住再抬手 → 仍 swipe-left（时长不作唯一依据）',
  r.type === 'swipe-left' && Math.abs(r.vx) < G.SWIPE_V, r.type + ' vx=' + n(r.vx));

/* ============================================================
 * 4. 纵向判据
 * ========================================================== */
group('4. 纵向：上拖隐藏');
r = gesture([[300, 100, 1000], [300, 70, 1060], [300, 60, 1120]]);
check('4.1 上拖 40px → up-hide', r.type === 'up-hide' && r.dy === -40, r.type + ' dy=' + n(r.dy));
r = gesture([[300, 100, 1000], [300, 70, 1100]]);
check('4.2 边界·上拖 30px → up-hide（>= 判据含等号）', r.type === 'up-hide', r.type + ' dy=' + n(r.dy));
r = gesture([[300, 100, 1000], [300, 71, 1100]]);
check('4.3 上拖 29px → none（不够阈值）', r.type === 'none', r.type + ' dy=' + n(r.dy));
r = gesture([[300, 100, 1000], [300, 120, 1100]]);
check('4.4 向下拖 20px → none（没有这个手势）', r.type === 'none' && r.dy === 20, r.type);
var g5 = G.create();
g5.down({ x: 300, y: 100, t: 1000 });
var m5 = g5.move({ x: 300, y: 120, t: 1100 });
check('4.5 向下拖时 move 返回 cancel（页面据此不跟随）', m5.state === 'cancel', m5.state);
r = gesture([[300, 100, 1000], [250, 60, 1100]]);
check('4.6 |dx|=50 > |dy|=40 → 锁 h，判成 swipe-left 而不是 up-hide',
  r.type === 'swipe-left' && r.axisFinal === 'h', r.type + '/' + r.axisFinal);
r = gesture([[300, 100, 1000], [320, 60, 1100]]);
check('4.7 上拖 40px 同时右偏 20px → 仍 up-hide（|dy|>|dx|）', r.type === 'up-hide', r.type);

/* ============================================================
 * 5. 时间戳鲁棒性（反例④）
 * ========================================================== */
group('5. 时间戳鲁棒性');
r = gesture([[300, 40, 1000], [280, 40, 1000], [260, 40, 1000]]);
check('5.1 全部重复时间戳（dt=0）→ 速度为 0，不产生 Infinity/NaN',
  r.vx === 0 && isFinite(r.vx) && isFinite(r.vy) && r.vy === 0, 'vx=' + r.vx);
check('5.2 重复时间戳时退回位移判据（dx=40 → swipe-left）', r.type === 'swipe-left', r.type);
r = gesture([[300, 40, 1500], [280, 40, 1000], [260, 40, 1200]]);
check('5.3 乱序时间戳 → 速度仍是有限值', isFinite(r.vx) && isFinite(r.vy), 'vx=' + n(r.vx));
r = gesture([[300, 40, 2000], [280, 40, 1500], [260, 40, 1000]]);
check('5.4 时间戳整体倒退（样本窗全为负 dt）→ 速度为 0，不是负无穷',
  r.vx === 0 && isFinite(r.vx), 'vx=' + r.vx);
r = gesture([[300, 40], [280, 40]]);
check('5.5 缺 t 字段 → 不抛错、速度 0、结果有限',
  r.vx === 0 && isFinite(r.dx) && typeof r.type === 'string', r.type + ' vx=' + r.vx);
r = gesture([[300, 40, 1000], [NaN, Infinity, 1010]]);
check('5.6 NaN / Infinity 坐标 → 退化成 0，不抛错', isFinite(r.dx) && isFinite(r.dy) && isFinite(r.vx),
  'dx=' + r.dx + ' dy=' + r.dy);
var g6 = G.create();
var upOnly = g6.up({ x: 1, y: 2, t: 3 });
check('5.7 没 down 直接 up → type=none，不抛错', upOnly.type === 'none', upOnly.type);
var g7 = G.create();
var autoStart = g7.move({ x: 10, y: 10, t: 100 });
check('5.8 没 down 直接 move → 当成按下（漏事件不至于整段手势永久 pending）',
  autoStart.state === 'pending' && g7.axis === 'none', autoStart.state);
/* 窗口内样本不足 8ms 时速度必须是 0，而不是「用 2ms 的样本外推出一个夸张的速度」 */
r = gesture([[300, 40, 1000], [280, 40, 1002]]);
check('5.9 采样窗仅 2ms（<8ms）→ 速度 0，不被外推成 10 px/ms；判据退回位移（20px→none）',
  r.vx === 0 && r.type === 'none', 'vx=' + r.vx + ' ' + r.type);

/* ============================================================
 * 6. rubberBand（反例⑤）
 * ========================================================== */
group('6. rubberBand 边界');
check('6.1 over=0 → 0', G.rubberBand(0, 60, 0.35) === 0);
check('6.2 over<0（没越界）→ 0', G.rubberBand(-10, 60, 0.35) === 0);
check('6.3 coef=0（完全抑制）→ 0', G.rubberBand(40, 60, 0) === 0);
check('6.4 limit<=0 → 0（不产生除零）', G.rubberBand(40, 0, 0.35) === 0 && isFinite(G.rubberBand(40, 0, 1)));
check('6.5 coef=1 → over·limit/(limit+over)（60,60 → 30）',
  near(G.rubberBand(60, 60, 1), 30, 1e-9), n(G.rubberBand(60, 60, 1)));
check('6.6 coef=0.35, over=40, limit=60 → 11.3513（阻尼后的额外位移）',
  near(G.rubberBand(40, 60, 0.35), 840 / 74, 1e-9), n(G.rubberBand(40, 60, 0.35)));
check('6.7 over>limit（100 越 60）→ 仍小于 limit，绝不把岛拖到窗外',
  G.rubberBand(100, 60, 0.35) < 60 && G.rubberBand(100, 60, 0.35) > 0, n(G.rubberBand(100, 60, 0.35)));
check('6.8 单调：over 越大允许的位移越大',
  G.rubberBand(20, 60, 0.35) < G.rubberBand(40, 60, 0.35) &&
  G.rubberBand(40, 60, 0.35) < G.rubberBand(80, 60, 0.35),
  [20, 40, 80].map(function (o) { return n(G.rubberBand(o, 60, 0.35)); }).join(' < '));
check('6.9 极端输入（over=1e9 / coef=5）→ 有限且 < limit',
  isFinite(G.rubberBand(1e9, 60, 5)) && G.rubberBand(1e9, 60, 5) < 60, n(G.rubberBand(1e9, 60, 5)));
check('6.10 总位移上限可证：60 + rb(∞,60,1) = 120px，仍在 640 窗口内',
  60 + G.rubberBand(1e12, 60, 1) <= 120.0001, n(60 + G.rubberBand(1e12, 60, 1)));

/* ============================================================
 * 7. 状态机 / 复位
 * ========================================================== */
group('7. 状态机与复位');
var g8 = G.create();
g8.down({ x: 300, y: 40, t: 1000 });
g8.move({ x: 250, y: 40, t: 1100 });
var u8 = g8.up({ x: 250, y: 40, t: 1100 });
check('7.1 抬手后 state 回到 idle，axis 保留本次锁定值（供调用方读）',
  g8.state === 'idle' && g8.axis === 'h', g8.state + '/' + g8.axis);
g8.down({ x: 100, y: 10, t: 2000 });
var fresh = g8.move({ x: 104, y: 10, t: 2010 });
check('7.2 新一次 down 从新原点重新累计（dx 只有 4，仍 pending）',
  fresh.state === 'pending' && fresh.dx === 4, fresh.state + '/dx=' + fresh.dx);
g8.reset();
check('7.3 reset() 清空轴与状态', g8.axis === 'none' && g8.state === 'idle');
var pk = G.create().peek();
check('7.4 peek() 返回有限值（验收脚本会采样它）',
  isFinite(pk.sx) && isFinite(pk.sy) && isFinite(pk.vx) && pk.state === 'idle');
/* 一次手势里 up 之后不能因为残留样本把下一次 tap 判成 swipe */
var g9 = G.create();
g9.down({ x: 300, y: 40, t: 1000 });
g9.move({ x: 200, y: 40, t: 1020 });
g9.up({ x: 200, y: 40, t: 1020 });
g9.down({ x: 100, y: 40, t: 3000 });
var u9 = g9.up({ x: 101, y: 40, t: 3010 });
check('7.5 上一次的大位移不会污染下一次 tap', u9.type === 'tap', u9.type);

/* ============================================================ */
console.log('\n---------------------------------------------');
console.log('结果：PASS ' + pass + ' / FAIL ' + fail + '（共 ' + (pass + fail) + ' 条断言）');
console.log('---------------------------------------------');
if (fail) { console.log('失败项: ' + failures.join(' | ')); process.exit(1); }
process.exit(0);
