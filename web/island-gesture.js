/**
 * island-gesture.js — 灵动岛手势判定层（纯逻辑，**不碰 DOM**）
 *
 * 为什么单独成文件：判定要在 node 里被单测逐条证伪（tools/gesture-selftest.js），
 * 和 DOM/pointer 事件绑在一起就只能靠肉眼和截图验收。页面只负责「把 pointer 采样喂进来、
 * 按结果做视觉反馈」，语义判断全在这里。
 *
 * 用法（浏览器）：
 *   <script src="island-gesture.js"></script>
 *   var g = IslandGesture.create();
 *   g.down({x:100,y:40,t:performance.now()});
 *   g.move({x:60,y:41,t:performance.now()});   // → {state:'drag'|'swipe'|'pending'|'cancel'}
 *   g.up({x:40,y:41,t:performance.now()});     // → {type:'swipe-left',dx,dy,vx,vy}
 *
 * 用法（node / CommonJS）：
 *   var G = require('./island-gesture.js');
 *
 * 判定规则（每条都能被单测证伪）：
 *   SLOP=6   按下后总位移不足 6 → 还是 pending，抬手出 tap
 *   轴锁定   首次超过 SLOP 时按 |dx| >= |dy| 锁 h，否则锁 v；锁定后不再改轴
 *   h 轴     |vx| >= 0.35 px/ms **或** |dx| >= 40 → swipe-left/right，否则 none
 *            （DotIsle 记下的教训：旧版只看位移，快速一甩会弹回原位；
 *              反过来只看速度也不行 —— 慢慢拖 80px 必须能换卡，所以是双判据 OR）
 *   v 轴     dy <= -30 且 |dy| > |dx| → up-hide；其它方向 none
 *   速度     用「最近一个跨度 ≥8ms 的样本」算；窗口内样本不足（同毫秒重复事件）
 *            一律给 0 —— 宁可退回位移判据，也不让 0 除产生 Infinity/NaN
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.IslandGesture = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var SLOP = 6;            // DIP：小于它一律算「还没开始拖」
  var SWIPE_V = 0.35;      // px/ms：轻扫速度阈值
  var SWIPE_D = 40;        // px：轻扫位移阈值（与速度是 OR 关系）
  var HIDE_D = 30;         // px：上拖隐藏的位移阈值
  var VEL_WIN = 8;         // ms：速度采样窗下界
  var MAX_SAMPLES = 96;    // 采样上限（一次拖拽几十个 move 足够）

  function fin(v, fb) {
    return (typeof v === 'number' && isFinite(v)) ? v : fb;
  }
  /* 输入一律过这道闸：缺字段/NaN 都退化成有限值，判定器永远不抛错 */
  function pt(p) {
    p = (p && typeof p === 'object') ? p : {};
    return { x: fin(p.x, 0), y: fin(p.y, 0), t: fin(p.t, 0) };
  }

  /**
   * 越界阻尼：手指越过边界 limit 后，允许的**额外**位移。
   *   over=0      → 0（没越界，不加）
   *   coef=0      → 0（完全抑制，等于硬边界）
   *   coef=1      → over·limit/(limit+over)（仍有阻尼，但最接近线性）
   *   单调递增、永远 < limit —— 所以拖再远也不会把岛拖出屏幕。
   * 为什么不用硬钳：手指还在动时位移突然停住，读作「卡死」。
   */
  function rubberBand(over, limit, coef) {
    var o = fin(over, 0), lim = fin(limit, 0), c = fin(coef, 0);
    if (!(o > 0) || !(lim > 0) || !(c > 0)) return 0;
    if (c > 1) c = 1;
    return (o * lim * c) / (lim + c * o);
  }

  function create() {
    var samples = [];        // 本次按下的采样序列
    var sx = 0, sy = 0;      // 按下点
    var axis = 'none';       // 'none' | 'h' | 'v'
    var state = 'idle';      // 'idle' | 'pending' | 'drag' | 'swipe' | 'cancel'
    var last = { x: 0, y: 0, t: 0 };

    function push(s) {
      samples.push(s);
      if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
    }

    /**
     * 速度：找最近一个「比最后一个样本早至少 8ms」的样本当基准。
     * 乱序 / 重复时间戳（dt<=0）的样本自然被跳过；一个都找不到就返回 0。
     */
    function velocity(key) {
      var n = samples.length;
      if (n < 2) return 0;
      var L = samples[n - 1];
      for (var i = n - 2; i >= 0; i--) {
        var S = samples[i];
        var dt = L.t - S.t;
        if (!(dt >= VEL_WIN)) continue;
        var d = key === 'y' ? (L.y - S.y) : (L.x - S.x);
        var v = d / dt;
        return isFinite(v) ? v : 0;     // 双保险：dt 已经 >=8，这里只防脏数据
      }
      return 0;
    }

    function delta(s) {
      return { dx: s.x - sx, dy: s.y - sy, adx: Math.abs(s.x - sx), ady: Math.abs(s.y - sy) };
    }

    var api = {
      down: function (p) {
        var s = pt(p);
        samples.length = 0;
        push(s);
        sx = s.x; sy = s.y;
        axis = 'none';
        state = 'pending';
        last = s;
        return { state: 'pending', axis: 'none', dx: 0, dy: 0, vx: 0, vy: 0 };
      },

      move: function (p) {
        var s = pt(p);
        /* 漏了 down（上层事件被吞）时把这次 move 当按下 —— 否则整段手势永久 pending，
           表现为「拖了没反应」这种最难查的故障。 */
        if (state === 'idle') return api.down(s);
        push(s);
        last = s;
        var d = delta(s);

        if (axis === 'none') {
          if (d.adx < SLOP && d.ady < SLOP) {
            state = 'pending';
            return { state: state, axis: axis, dx: d.dx, dy: d.dy, vx: 0, vy: 0 };
          }
          /* 轴锁定只看这一次的瞬时位移：|dx| >= |dy| 就锁横。之后不再改轴 ——
             改轴会让同一段拖拽在两种语义间反复跳，读作「卡顿」。 */
          axis = d.adx >= d.ady ? 'h' : 'v';
        }

        var vx = velocity('x'), vy = velocity('y');
        if (axis === 'h') {
          state = Math.abs(vx) >= SWIPE_V ? 'swipe' : 'drag';
        } else {
          /* 向下拖没有对应手势：标 cancel，让页面别跟着手指往下跑 */
          state = d.dy > 0 ? 'cancel' : 'drag';
        }
        return { state: state, axis: axis, dx: d.dx, dy: d.dy, vx: vx, vy: vy };
      },

      up: function (p) {
        if (state === 'idle') {
          return { type: 'none', axis: 'none', dx: 0, dy: 0, vx: 0, vy: 0 };
        }
        var s = (p && typeof p === 'object' && p.x !== undefined) ? pt(p) : last;
        push(s);
        last = s;
        var d = delta(s);
        var vx = velocity('x'), vy = velocity('y');
        var out = { type: 'none', axis: axis, dx: d.dx, dy: d.dy, vx: vx, vy: vy };

        if (axis === 'none') {
          /* 没锁轴 = 从没超过 SLOP → 这是点击，不是手势 */
          if (d.adx < SLOP && d.ady < SLOP) out.type = 'tap';
        } else if (axis === 'h') {
          if (Math.abs(vx) >= SWIPE_V) out.type = vx < 0 ? 'swipe-left' : 'swipe-right';
          else if (d.adx >= SWIPE_D) out.type = d.dx < 0 ? 'swipe-left' : 'swipe-right';
        } else if (d.dy <= -HIDE_D && d.ady > d.adx) {
          out.type = 'up-hide';
        }
        state = 'idle';       // 本次手势结束；axis 留着给调用方读
        return out;
      },

      /* 复位：blur / pointercancel 之后必须能干净地开始下一次手势 */
      reset: function () {
        samples.length = 0;
        axis = 'none';
        state = 'idle';
        sx = sy = 0;
        last = { x: 0, y: 0, t: 0 };
        return api;
      },

      /* 调试快照：页面把它塞进 __islandState() 里，验收脚本采样用 */
      peek: function () {
        return {
          state: state, axis: axis, sx: sx, sy: sy, last: last,
          samples: samples.length, vx: velocity('x'), vy: velocity('y'),
        };
      }
    };

    Object.defineProperty(api, 'axis', { get: function () { return axis; }, enumerable: true });
    Object.defineProperty(api, 'state', { get: function () { return state; }, enumerable: true });
    return api;
  }

  return {
    create: create,
    rubberBand: rubberBand,
    SLOP: SLOP,
    SWIPE_V: SWIPE_V,
    SWIPE_D: SWIPE_D,
    HIDE_D: HIDE_D,
    VEL_WIN: VEL_WIN
  };
});
