/**
 * island-motion.js — 灵动岛形变弹簧引擎（引擎层，不碰 DOM）
 *
 * 为什么不用 CSS transition：
 *   CSS 的 width/height/border-radius 各走各的缓动曲线，而且中途改目标值时
 *   浏览器会「重新起算」缓动（速度瞬间归零），所以快速展开又收起时视觉上顿一下。
 *   这里用二阶阻尼弹簧的**解析解**按真实经过时间采样：状态只有 (value, velocity)，
 *   改目标时 value/velocity 连续交接，任意 dt（包括 500ms 大跳帧）结果一致。
 *
 * 用法（浏览器）：
 *   <script src="island-motion.js"></script>
 *   var m = IslandMotion.create({response:0.35, damping:1});
 *   m.to(1);
 *   // 由调用方自己的 requestAnimationFrame 驱动：
 *   var r = m.frame(performance.now());  // {value, channels, settled}
 *
 * 用法（node / CommonJS）：
 *   var Motion = require('./island-motion.js');
 *
 * 数学契约：
 *   ω = 2π / response，e = value - target
 *   ζ = 1 临界：e(t) = (e0 + (v0 + ω·e0)t)·e^(-ωt)
 *              e'(t) = [v0 - ω(v0 + ω·e0)t]·e^(-ωt)
 *   0<ζ<1 欠阻尼：ωd = ω√(1-ζ²)
 *              e(t) = e^(-ζωt)[e0·cos(ωd t) + ((v0+ζωe0)/ωd)·sin(ωd t)]
 *              e'(t)= e^(-ζωt)[v0·cos(ωd t) - ((ω²e0+ζωv0)/ωd)·sin(ωd t)]
 *   ζ>1 过阻尼：r1,2 = -ω(ζ ∓ √(ζ²-1))
 *              e(t) = C1·e^(r1 t) + C2·e^(r2 t)，C1=(v0-r2 e0)/(r1-r2)，C2=e0-C1
 *              e'(t)= r1·C1·e^(r1 t) + r2·C2·e^(r2 t)
 *   三个分支都是闭式解，没有固定步长积分，所以「分多步推进」和「一步到位」等价。
 *
 * 2026-11 新增：只被 island.html 集成时引用，不依赖任何第三方库。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.IslandMotion = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var TAU = Math.PI * 2;
  var DEFAULT_RESPONSE = 0.35;   // 秒
  var DEFAULT_DAMPING = 1.0;     // ζ = 1 临界阻尼（不过冲）
  var DEFAULT_SETTLE_EPS = 0.002;
  var REDUCED_FADE_MS = 120;     // 降级路径：120ms 线性淡入
  var ZETA_MIN = 0.05;
  var ZETA_MAX = 3.0;            // 契约：支持 0 < ζ ≤ 3

  /* ---------------- 小工具 ---------------- */
  function clamp01(x) {
    return x < 0 ? 0 : (x > 1 ? 1 : x);
  }
  function numOr(v, fb) {
    return (typeof v === 'number' && isFinite(v)) ? v : fb;
  }
  function clampNum(v, lo, hi, fb) {
    var n = numOr(v, fb);
    if (!(n >= lo)) n = lo;
    if (n > hi) n = hi;
    return n;
  }

  /* smoothstep：0 以下夹 0、1 以上夹 1，中间是 3t²-2t³（一阶导在两端为 0，衔接不硬） */
  function smoothstep(x, a, b) {
    var t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }

  /**
   * 派生通道：全部从主弹簧值 p 推导，禁止各自计时（各自计时就会「不同步」，
   * 这正是 CSS 方案的病根）。fade 比 content 早，容器先出现、内容后浮现。
   */
  function channelsFromP(p) {
    var v = numOr(p, 0);
    return {
      fade: smoothstep(v, 0.18, 0.74),                       // 卡片层不透明度
      content: smoothstep(v, 0.44, 0.97),                    // 内容不透明度（滞后于 fade）
      scale: 0.96 + 0.04 * clamp01(v / 0.62),                 // p∈[0,0.62] 内完成
      blur: 6 * (1 - clamp01((v - 0.06) / (0.70 - 0.06))),    // 6 → 0
      offset: -18 * (1 - v)                                   // 线性跟随
    };
  }

  /**
   * 弹簧解析解：给定 t=0 时的偏移 e0 与速度 v0，求 t 秒后的偏移与速度。
   * 返回 [e, v]（e 相对 target，v = d(value)/dt，因为 target 恒定）。
   */
  function springSolve(e0, v0, omega, zeta, t) {
    if (!(t > 0)) return [e0, v0];

    /* ζ = 1（临界） */
    if (Math.abs(zeta - 1) <= 1e-6) {
      var a = v0 + omega * e0;
      var decay = Math.exp(-omega * t);
      return [
        (e0 + a * t) * decay,
        (v0 - omega * a * t) * decay
      ];
    }

    /* 0 < ζ < 1（欠阻尼） */
    if (zeta < 1) {
      var wd = omega * Math.sqrt(1 - zeta * zeta);
      var d = Math.exp(-zeta * omega * t);
      var c = Math.cos(wd * t);
      var s = Math.sin(wd * t);
      var B = (v0 + zeta * omega * e0) / wd;
      var K = (omega * omega * e0 + zeta * omega * v0) / wd;
      return [
        d * (e0 * c + B * s),
        d * (v0 * c - K * s)
      ];
    }

    /* ζ > 1（过阻尼，双指数） */
    var sq = Math.sqrt(zeta * zeta - 1);
    var r1 = -omega * (zeta - sq);
    var r2 = -omega * (zeta + sq);
    var C1 = (v0 - r2 * e0) / (r1 - r2);
    var C2 = e0 - C1;
    var e1 = Math.exp(r1 * t);
    var e2 = Math.exp(r2 * t);
    return [
      C1 * e1 + C2 * e2,
      r1 * C1 * e1 + r2 * C2 * e2
    ];
  }

  /* ---------------- 实例 ---------------- */
  function create(opts) {
    opts = (opts && typeof opts === 'object') ? opts : {};

    var response = clampNum(opts.response, 0.01, 10, DEFAULT_RESPONSE);
    var zeta = clampNum(opts.damping, ZETA_MIN, ZETA_MAX, DEFAULT_DAMPING);
    var settleEps = clampNum(opts.settleEps, 0, 1, DEFAULT_SETTLE_EPS);
    var reduced = !!opts.reduced;

    var omega = TAU / response;
    /* 速度阈值跟着 ω 走：|e|<eps 且 |v|<eps·ω 时，再走一个弧度也挪不到 eps，
       此时直接吸附到 target，避免尾巴上留 1e-4 级残差被上层当成「还在动」。 */
    var velEps = settleEps * omega;

    var value = 0;       // 主弹簧当前值（0 = 球态，1 = 完全展开）
    var velocity = 0;    // d(value)/dt，单位 1/秒
    var target = 0;
    var settled = true;

    /* reduced-motion 专用：位置立刻到位，只留一条线性淡入 */
    var redFrom = channelsFromP(0).fade;
    var redTo = redFrom;
    var redT0 = null;    // 淡入起点（ms），null = 等首帧定基准
    var redDone = true;

    var lastMs = null;   // 时间基准，首次 frame() 初始化

    function currentFade(nowMs) {
      if (!reduced) return channelsFromP(value).fade;
      if (redDone) return redTo;
      if (redT0 === null || nowMs === null || nowMs === undefined) return redFrom;
      var pr = clamp01((nowMs - redT0) / REDUCED_FADE_MS);
      return redFrom + (redTo - redFrom) * pr;
    }

    function channelsNow(nowMs) {
      var ch = channelsFromP(value);
      if (reduced) ch.fade = currentFade(nowMs);
      return ch;
    }

    var api = {
      /**
       * 设新目标。
       *   opts.snap === true —— 直接就位（收起/初始化用）。
       *   opts.now —— 改目标那一刻的时间戳（与 frame() 同一时间轴）。
       *     给了就从这一刻起算，不给则作废时间基准、由下一帧重建。
       *   value 与 velocity 一律原样保留（不改写方向）。
       */
      to: function (t, o) {
        var nt = numOr(t, target);
        var snap = !!(o && o.snap);
        var nowHint = (o && typeof o.now === 'number' && isFinite(o.now)) ? o.now : null;
        var oldFade = currentFade(lastMs);

        target = nt;

        /* 时间基准必须跟着改目标的时刻走。改目标发生在「上一次 frame」之后、下一帧之前，
           那段空档不能算进新目标的积分里 —— 否则 rAF 停过一会儿（窗口隐藏、系统降频、
           刚点完一次静置）再切目标，弹簧会把整段静止时间一次吃进去，表现为瞬移到位。
           调用方给了 now 就从那刻起算；没给就让下一帧重建基准（代价是丢一帧）。 */
        lastMs = nowHint;

        if (snap) {
          value = nt;
          velocity = 0;
          settled = true;
        } else if (reduced) {
          /* 降级：位置/尺寸立即就位 */
          value = nt;
          velocity = 0;
          settled = true;
        } else {
          /* 速度交接：value 与 velocity 一律原样保留，交给弹簧继续算。
             这里绝不能改写 velocity 的方向 —— 真实弹簧被打断时速度是连续的，
             物体靠惯性会先朝原方向再漂一小段才被拉回。强行掉头等于凭空加了一个
             冲量，视觉上会「啪」地停在原地，反而比 CSS 更假。
             （0→1 上行途中改成 0 时，会先上漂约 5% 再回落，这是正确手感。） */
          settled = (Math.abs(value - nt) === 0 && velocity === 0);
        }

        if (reduced) {
          /* 淡入起点一律等下一帧再定：避免 rAF 停摆（窗口隐藏）后回填，
             把 120ms 淡入直接算成「已经结束」 */
          redFrom = snap ? channelsFromP(nt).fade : oldFade;
          redTo = channelsFromP(nt).fade;
          redT0 = null;
          redDone = !!(snap || (redFrom === redTo));
        }
        return api;
      },

      /** 按真实经过时间推进（调用方驱动 rAF，引擎自己不排帧） */
      frame: function (nowMs) {
        var now = numOr(nowMs, lastMs === null ? 0 : lastMs);
        if (lastMs === null) {
          lastMs = now;
          if (reduced && redT0 === null && !redDone) redT0 = now;
        }

        if (reduced) {
          if (redT0 === null && !redDone) redT0 = now;
          if (!redDone && redT0 !== null && (now - redT0) >= REDUCED_FADE_MS) {
            redFrom = redTo;
            redDone = true;
          }
          lastMs = now;
          return {
            value: value,
            channels: channelsNow(now),
            settled: settled && redDone
          };
        }

        var dt = (now - lastMs) / 1000;
        lastMs = now;

        if (!settled && dt > 0) {
          var e0 = value - target;
          var v0 = velocity;
          var r = springSolve(e0, v0, omega, zeta, dt);
          value = target + r[0];
          velocity = r[1];
          if (Math.abs(value - target) < settleEps && Math.abs(velocity) < velEps) {
            value = target;      // 吸附：settled 后 value 精确等于 target
            velocity = 0;
            settled = true;
          }
        }

        return { value: value, channels: channelsFromP(value), settled: settled };
      },

      /** 不推进时间，只读当前通道 */
      channels: function () {
        return channelsNow(lastMs);
      },

      /** 内部状态快照（调试用） */
      peek: function () {
        return { value: value, velocity: velocity, target: target, settled: settled && (reduced ? redDone : true) };
      },

      reset: function (v) {
        var nv = numOr(v, 0);
        value = nv;
        target = nv;
        velocity = 0;
        settled = true;
        if (reduced) {
          redFrom = channelsFromP(nv).fade;
          redTo = redFrom;
          redT0 = lastMs;
          redDone = true;
        }
        return api;
      },

      isSettled: function () {
        return settled && (reduced ? redDone : true);
      }
    };

    return api;
  }

  return {
    channelsFromP: channelsFromP,
    smoothstep: smoothstep,
    create: create,
    REDUCED_FADE_MS: REDUCED_FADE_MS,
    DEFAULT_RESPONSE: DEFAULT_RESPONSE,
    DEFAULT_DAMPING: DEFAULT_DAMPING
  };
});
