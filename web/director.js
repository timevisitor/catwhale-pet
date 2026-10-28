/* =============================================================================
 * 猫鲸桌宠 · 作息导演层（director）
 * -----------------------------------------------------------------------------
 * 把「随机权重池」升级成「有节律 + 对环境有反应」的空闲行为决策器。
 *
 *  节律层（时钟，小时级）  → 决定它此刻在过哪一段日子，调各动作的权重倍率
 *  负载层（CPU，秒级）     → 只调 tempo 和权重倍率，**永不直接抢状态**
 *  交互层（拖拽/菜单/聊天）→ 完全不动，优先级链原样保留在 index.html
 *
 * 无 DOM、无副作用、随机数可注入 → 同一份代码既能跑在渲染进程，
 * 也能被 tools/simulate-day.js 用 require() 跑「快进一天」的离线模拟。
 *
 * 浏览器：window.CatwhaleDirector
 * Node  ：module.exports
 * ============================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CatwhaleDirector = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN_PER_DAY = 1440;
  const TRANSITION_MIN = 10;          // 时段边界前后的权重渐变半宽（分钟）

  /* ---------------- 默认配置（= %APPDATA%\桌宠\director.json 缺省内容） ----------------
     weights[phase][stateId] 是**倍率**：缺省 1，0 = 该时段完全不出。
     tempo 是节奏：>1 切得勤（停留时间 ÷ tempo），<1 更慵懒。
     cpu.bands[].weights 与时段倍率**相乘**，不是覆盖。 */
  const DEFAULT_CONFIG = {
    version: 1,
    enabled: true,
    preset: 'standard',
    clock: { mode: 'system', offsetMin: 0 },
    phasesPresets: {
      standard: [
        { id: 'dawn',      name: '清晨', from: '06:00', to: '09:00' },
        { id: 'morning',   name: '上午', from: '09:00', to: '11:30' },
        { id: 'lunch',     name: '中午', from: '11:30', to: '13:30' },
        { id: 'afternoon', name: '下午', from: '13:30', to: '17:30' },
        { id: 'evening',   name: '下班', from: '17:30', to: '19:30' },
        { id: 'night',     name: '晚上', from: '19:30', to: '23:00' },
        { id: 'late',      name: '深夜', from: '23:00', to: '06:00' }
      ],
      nightowl: [
        { id: 'dawn',      name: '清晨', from: '08:00', to: '11:00' },
        { id: 'morning',   name: '上午', from: '11:00', to: '13:00' },
        { id: 'lunch',     name: '中午', from: '13:00', to: '14:30' },
        { id: 'afternoon', name: '下午', from: '14:30', to: '19:00' },
        { id: 'evening',   name: '下班', from: '19:00', to: '21:00' },
        { id: 'night',     name: '晚上', from: '21:00', to: '02:00' },
        { id: 'late',      name: '深夜', from: '02:00', to: '08:00' }
      ],
      always_day: [
        { id: 'dawn',      name: '清晨', from: '06:00', to: '09:00' },
        { id: 'morning',   name: '上午', from: '09:00', to: '11:30' },
        { id: 'lunch',     name: '中午', from: '11:30', to: '13:30' },
        { id: 'afternoon', name: '下午', from: '13:30', to: '23:00' },
        { id: 'night',     name: '晚上', from: '23:00', to: '06:00' }
      ]
    },
    phases: null,                     // null = 用 preset 里的那套
    weights: {
      // 倍率：缺省 1（= 沿用 states.json 的 weight），0 = 该时段完全不出。
      // 食物类在深夜必须显式归零，否则「凌晨吃大盆饭」会按 base weight 正常出。
      dawn:      { tail_open: 3, run: 2.4, stretch: 2.4, read: 1, jump_high: 0.6, doze: 0.2, working: 0.2, sit_chair: 0.4, eat: 0.15, big_bowl: 0.1 },
      morning:   { working: 2.5, read: 2, run: 1.2, stretch: 0.8, sit_chair: 1.5, tail_open: 0.8, doze: 0.25, eat: 0.1, big_bowl: 0.1, jump_high: 0.6 },
      lunch:     { eat: 5, big_bowl: 4, doze: 2, idle: 1.2, sit_chair: 0.6, tail_open: 0.6, run: 0.3, jump_high: 0.4 },
      afternoon: { tail_open: 2, tail_closed: 2, sit_chair: 1.5, read: 1.2, run: 0.6, stretch: 0.8, working: 1, doze: 0.8, eat: 0.25, big_bowl: 0.15, jump_high: 0.6 },
      evening:   { jump_high: 4.5, tail_open: 3, run: 2, stretch: 2, doze: 0.2, working: 0.3, eat: 0.3, big_bowl: 0.15, sit_chair: 0.8 },
      night:     { doze: 3, tail_closed: 2, sit_chair: 1, read: 0.6, tail_open: 0.8, working: 0.4, stretch: 0.3, run: 0.15, jump_high: 0.2, eat: 0.25, big_bowl: 0.15 },
      late:      { doze: 3, tail_closed: 2.4, idle: 3, sit_chair: 0.4, tail_open: 0.2, working: 0.05, read: 0.2, stretch: 0, run: 0, jump_high: 0, eat: 0, big_bowl: 0 }
    },
    tempo: { dawn: 1.2, morning: 1.0, lunch: 0.8, afternoon: 0.9, evening: 1.4, night: 0.7, late: 0.35 },
    cpu: {
      enabled: true,
      smoothTauSec: 8,
      minHoldMs: 90000,
      hysteresis: 8,
      bands: [
        { id: 'calm', max: 25,  label: '安静', tempo: 0.9,  weights: { doze: 1.6, read: 1.4 } },
        { id: 'busy', min: 25, max: 70, label: '常态', tempo: 1.0, weights: {} },
        { id: 'hot',  min: 70, label: '热闹', tempo: 1.25, weights: { dizzy: 5, working: 1.8, doze: 0.1 } }
      ]
    },
    deepNightFreeze: true,             // 深夜且安静 → 降到 0.35 倍速（省一个核的软解）
    freezeRate: 0.35,
    loungeMinMs: 7000,
    loungeMaxMs: 14000,
    idleActChance: 0.35
  };

  /* ---------------- 时间工具 ---------------- */
  function hhmmToMin(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const h = Number(m[1]), mm = Number(m[2]);
    if (h > 23 || mm > 59) return null;
    return h * 60 + mm;
  }
  function minToHHMM(v) {
    v = ((Math.round(v) % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
    return ('0' + Math.floor(v / 60)).slice(-2) + ':' + ('0' + (v % 60)).slice(-2);
  }

  function normalizePhases(list) {
    const out = [];
    for (const p of list || []) {
      const a = hhmmToMin(p.from), b = hhmmToMin(p.to);
      if (a === null || b === null) continue;
      const dur = ((b - a) + MIN_PER_DAY) % MIN_PER_DAY || MIN_PER_DAY;
      out.push({ id: p.id, name: p.name || p.id, start: a, dur, from: minToHHMM(a), to: minToHHMM(b) });
    }
    out.sort((x, y) => x.start - y.start);
    // 渐变半宽不能超过最短时段的一半，否则相邻时段会互相吃掉
    const shortest = out.reduce((m, p) => Math.min(m, p.dur), MIN_PER_DAY);
    const T = Math.max(1, Math.min(TRANSITION_MIN, Math.floor(shortest / 4)));
    return { phases: out, transition: T };
  }

  /* 单时段在 t 时刻的隶属度（0~1）。边界 ±T 内线性过渡，
     两条时段的隶属度在边界处各为 0.5，加起来正好 1 → 不会整点硬切。 */
  function membership(t, p, T) {
    let o = ((t - p.start) % MIN_PER_DAY + MIN_PER_DAY) % MIN_PER_DAY;   // 进入该时段后的分钟数
    if (o <= T) return clamp((o + T) / (2 * T), 0, 1);                     // 刚进入：0→0.5, T→1
    if (o <= p.dur - T) return 1;                                          // 稳定区
    if (o <= p.dur + T) return clamp(1 - (o - (p.dur - T)) / (2 * T), 0, 1); // 即将离开：dur→0.5, dur+T→0
    /* 还没进入：o 接近 1440，等价于「距开始还有 before 分钟」。
       这一段必须补上，否则进入侧只有 0→0.5 的突变（实测在 05:59 出现过 50% 的跳变）。 */
    const before = MIN_PER_DAY - o;
    if (before <= T) return clamp((T - before) / (2 * T), 0, 1);           // before=T→0, before=0→0.5
    return 0;
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }

  /* ---------------- 配置规范化 ---------------- */
  function normalizeConfig(raw) {
    const cfg = Object.assign({}, DEFAULT_CONFIG, raw || {});
    cfg.clock = Object.assign({}, DEFAULT_CONFIG.clock, cfg.clock || {});
    cfg.cpu = Object.assign({}, DEFAULT_CONFIG.cpu, cfg.cpu || {});
    cfg.cpu.bands = (cfg.cpu.bands && cfg.cpu.bands.length) ? cfg.cpu.bands : DEFAULT_CONFIG.cpu.bands;
    cfg.weights = Object.assign({}, DEFAULT_CONFIG.weights, cfg.weights || {});
    cfg.tempo = Object.assign({}, DEFAULT_CONFIG.tempo, cfg.tempo || {});
    const presetList = (cfg.phasesPresets && cfg.phasesPresets[cfg.preset]) || null;
    const list = Array.isArray(cfg.phases) && cfg.phases.length ? cfg.phases : (presetList || DEFAULT_CONFIG.phasesPresets.standard);
    const norm = normalizePhases(list);
    cfg.phases = norm.phases;               // 规范化后的（带 start/dur，运行时用这份）
    cfg.transitionMin = norm.transition;
    return cfg;
  }

  /* ---------------- 导演实例 ---------------- */
  /**
   * @param {object} rawCfg  director.json 内容（可为 null → 用默认）
   * @param {object} opts    { now:()=>ms, rng:()=>0..1 }
   */
  function create(rawCfg, opts) {
    const cfg = normalizeConfig(rawCfg);
    const nowFn = (opts && opts.now) || (() => Date.now());
    const rng = (opts && opts.rng) || Math.random;

    /* --- CPU 平滑器：EMA + 三档滞回 + 最短停留 --- */
    const cpu = {
      ema: null,
      bandIdx: 1,                 // 默认 busy
      bandSince: 0,
      lastAt: 0,
      push(pct, atMs) {
        const at = num(atMs, nowFn());
        const p = clamp(num(pct, 0), 0, 100);
        const dt = cpu.lastAt ? Math.max(0, (at - cpu.lastAt) / 1000) : 1;
        cpu.lastAt = at;
        const tau = Math.max(0.5, num(cfg.cpu.smoothTauSec, 8));
        const a = 1 - Math.exp(-dt / tau);           // 时间常数正确的 EMA 系数
        cpu.ema = (cpu.ema === null) ? p : (cpu.ema + a * (p - cpu.ema));
        // 档位切换（滞回：越界要超过 hysteresis 才切；且受最短停留保护）
        const bands = cfg.cpu.bands;
        const h = num(cfg.cpu.hysteresis, 8);
        const hold = num(cfg.cpu.minHoldMs, 90000);
        if (at - cpu.bandSince < hold) return cpu;
        const cur = bands[cpu.bandIdx];
        let next = cpu.bandIdx;
        // 向上越界
        if (cpu.bandIdx < bands.length - 1) {
          const upEdge = num(cur.max, 101) + h;
          if (cpu.ema > upEdge) next = cpu.bandIdx + 1;
        }
        // 向下越界
        if (next === cpu.bandIdx && cpu.bandIdx > 0) {
          const downEdge = num(cur.min, -1) - h;
          if (cpu.ema < downEdge) next = cpu.bandIdx - 1;
        }
        if (next !== cpu.bandIdx) { cpu.bandIdx = next; cpu.bandSince = at; }
        return cpu;
      },
      band() { return cfg.cpu.bands[cpu.bandIdx] || cfg.cpu.bands[1] || { id: 'busy', tempo: 1, weights: {} }; },
      value() { return cpu.ema === null ? 0 : cpu.ema; }
    };

    /* --- 某个时刻的上下文：时段混合 + tempo + 是否冻结 --- */
    function at(minuteOfDay, atMs) {
      const t = ((minuteOfDay % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
      /* 总开关关闭：返回中性上下文 —— 所有倍率 1、tempo 1、没有 CPU 联动、不冻结。
         这就是"回到没有导演层之前的行为"：纯按 states.json 的权重随机。
         放在这里而不是各调用点，是为了让桌宠和离线模拟器走同一条判定。 */
      if (cfg.enabled === false) {
        return {
          minute: t, atMs: num(atMs, nowFn()),
          mix: [], off: true, phase: 'off', phaseName: '已关闭',
          cpuBand: 'off', cpuLabel: '已关闭', cpuEma: cpu.value(),
          tempo: 1, freeze: false
        };
      }
      const T = cfg.transitionMin;
      const mix = [];
      for (const p of cfg.phases) {
        const m = membership(t, p, T);
        if (m > 0.0001) mix.push({ id: p.id, name: p.name, m });
      }
      const sum = mix.reduce((s, x) => s + x.m, 0) || 1;
      for (const x of mix) x.w = x.m / sum;            // 归一化，权重总和恒为 1
      mix.sort((a, b) => b.w - a.w);
      const phase = mix.length ? mix[0].id : (cfg.phases[0] && cfg.phases[0].id) || 'afternoon';

      // 时段 tempo 按同一套混合系数插值
      let tempo = 0;
      for (const x of mix) tempo += num(cfg.tempo[x.id], 1) * x.w;
      if (!mix.length) tempo = 1;

      const band = cfg.cpu.enabled ? cpu.band() : { id: 'busy', tempo: 1, weights: {}, label: '常态' };
      tempo *= num(band.tempo, 1);

      const freeze = !!(cfg.deepNightFreeze && phase === 'late' && band.id === 'calm');
      if (freeze) tempo *= 0.5;

      return {
        minute: t, atMs: num(atMs, nowFn()),
        mix, phase, phaseName: (cfg.phases.find(p => p.id === phase) || {}).name || phase,
        cpuBand: band.id, cpuLabel: band.label || band.id, cpuEma: cpu.value(),
        tempo, freeze
      };
    }

    /* --- 单动作在此时刻的总倍率 --- */
    function multiplierOf(stateId, ctx) {
      if (!ctx || ctx.off) return 1;
      let mul = 0;
      for (const x of ctx.mix) {
        const t = (cfg.weights[x.id] || {})[stateId];
        mul += num(t, 1) * x.w;                     // 该时段没写 → 倍率 1（全时段可用）
      }
      if (!ctx.mix.length) mul = 1;
      const band = cfg.cpu.bands.find(b => b.id === ctx.cpuBand);
      if (band && band.weights && stateId in band.weights) mul *= num(band.weights[stateId], 1);
      return mul;
    }

    function weightOf(stateId, ctx, baseWeight) {
      return Math.max(0, num(baseWeight, 20) * multiplierOf(stateId, ctx));
    }

    /* --- 决策：给候选状态挑一个（返回 null 表示这一轮不切，继续当前状态） --- */
    function pick(candidates, ctx, baseWeights) {
      const pool = [];
      let total = 0;
      for (const id of candidates) {
        const w = weightOf(id, ctx, baseWeights ? baseWeights[id] : undefined);
        if (w > 0) { pool.push({ id, w }); total += w; }
      }
      if (!pool.length) return null;
      let r = rng() * total;
      for (const it of pool) { r -= it.w; if (r <= 0) return it.id; }
      return pool[pool.length - 1].id;
    }

    function loungeDelayMs(ctx) {
      const lo = num(cfg.loungeMinMs, 7000), hi = num(cfg.loungeMaxMs, 14000);
      return Math.round((lo + rng() * (hi - lo)) / Math.max(0.05, ctx.tempo));
    }

    function idleActChance(ctx) {
      return clamp(num(cfg.idleActChance, 0.35) * ctx.tempo, 0.1, 0.8);
    }

    /* --- 给「现在几点」用的便捷入口 --- */
    function minuteOfDayNow() {
      const off = num(cfg.clock.offsetMin, 0);
      const d = new Date(nowFn() + off * 60000);
      return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
    }

    return {
      cfg, cpu, at, multiplierOf, weightOf, pick, loungeDelayMs, idleActChance,
      minuteOfDayNow,
      ctxNow() { return at(minuteOfDayNow(), nowFn()); },
      enabled() { return cfg.enabled !== false; }
    };
  }

  return {
    DEFAULT_CONFIG, TRANSITION_MIN,
    normalizeConfig, normalizePhases, hhmmToMin, minToHHMM,
    create
  };
});
