#!/usr/bin/env node
/* =============================================================================
 * simulate-day.js —— 把 24 小时压成几十秒跑完，验证导演层的行为
 *
 *   node tools/simulate-day.js --director <director.json> --hours 24 --out <dir>
 *   node tools/simulate-day.js --preset nightowl --cpu-trace cpu.csv --hours 24
 *
 * 它复刻的是 index.html 里那条空闲循环（IDLE_HOLD → rollLounge → 停留 → 再 roll），
 * 只是把「真实时间」换成了可以快进的虚拟时钟，把「真 CPU」换成了可注入的负载曲线。
 *
 * 产物：
 *   timeline.csv    每次切换一行（秒/时钟/动作/时长/触发原因/时段/CPU 档/倍率）
 *   summary.json    各动作时长占比、每小时切换次数、断言结果
 *   timeline.html   动作时间线图（每 10 分钟一格），用 ::preview 直接看
 * ============================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'web', 'director.js'));

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return def;
}
function flag(name) { return argv.includes('--' + name); }

const HOURS = Number(arg('hours', '24'));
const OUT = arg('out', path.join(ROOT, 'sim-out'));
const STATES_FILE = arg('states', path.join(ROOT, 'web', 'assets', 'states.json'));
const DIRECTOR_FILE = arg('director', null);
const PRESET = arg('preset', null);
const CPU_TRACE = arg('cpu-trace', null);
const SEED = Number(arg('seed', '20261028'));
const IDLE_HOLD_MS = Number(arg('idle-hold', '12000'));

/* ---------------- 可复现随机数 ---------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);

/* ---------------- 载入状态表 ---------------- */
const states = JSON.parse(fs.readFileSync(STATES_FILE, 'utf8'));
const stateIds = Object.keys(states);
const baseW = {};
for (const id of stateIds) baseW[id] = states[id].weight;
if (baseW.idle == null) baseW.idle = 25;      // 'idle' 在 states.json 里没有 weight（它原本不进池），给个中性基准

const LOUNGE = stateIds.filter(id => states[id].role === 'lounge');
const TASK = stateIds.filter(id => states[id].role === 'task');
const ACTS = stateIds.filter(id => states[id].role === 'idle_act');
const CANDIDATES = LOUNGE.concat(TASK, stateIds.filter(id => id === 'idle'));

/* ---------------- 载入 / 构造配置 ---------------- */
let rawCfg = null;
if (DIRECTOR_FILE && fs.existsSync(DIRECTOR_FILE)) rawCfg = JSON.parse(fs.readFileSync(DIRECTOR_FILE, 'utf8'));
if (PRESET) rawCfg = Object.assign({}, rawCfg || {}, { preset: PRESET });
if (flag('disabled')) rawCfg = Object.assign({}, rawCfg || {}, { enabled: false });

const director = D.create(rawCfg, { rng });
const cfg = director.cfg;

/* ---------------- CPU 曲线 ---------------- */
/* 无 --cpu-trace 时生成一条「带突发」的合成曲线：日常 15~25%，
   每隔一段时间出现 2~6 分钟 70~95% 的突发（编译/出图/游戏），用来测抖动。 */
function synthCpu(sec) {
  const out = [];
  let burst = 0, burstLeft = 0;
  for (let t = 0; t <= sec; t += 5) {
    if (burstLeft <= 0 && rng() < 0.004) { burstLeft = 60 + Math.floor(rng() * 240); burst = 75 + rng() * 20; }
    let v;
    if (burstLeft > 0) { burstLeft -= 5; v = burst + (rng() - 0.5) * 12; }
    else v = 18 + Math.sin(t / 900) * 6 + rng() * 5;
    out.push({ t, pct: Math.max(1, Math.min(99, v)) });
  }
  return out;
}
let cpuTrace;
if (CPU_TRACE && fs.existsSync(CPU_TRACE)) {
  const lines = fs.readFileSync(CPU_TRACE, 'utf8').trim().split(/\r?\n/);
  cpuTrace = lines.map(l => { const [t, p] = l.split(/[,;\t]/); return { t: Number(t), pct: Number(p) }; })
                   .filter(x => isFinite(x.t) && isFinite(x.pct));
} else {
  cpuTrace = synthCpu(HOURS * 3600);
}
/* 每 5 秒推一次 EMA（真实桌宠是 sysinfo 1.5s 采一次、渲染端 5s 推一次） */
function feedCpu(secNow) {
  while (cpuCursor < cpuTrace.length && cpuTrace[cpuCursor].t <= secNow) {
    director.cpu.push(cpuTrace[cpuCursor].pct, cpuTrace[cpuCursor].t * 1000);
    cpuCursor++;
  }
}
let cpuCursor = 0;

/* ---------------- 主循环 ---------------- */
const events = [];          // {t, clock, id, ms, why, phase, band, tempo, mul}
let t = 0;                  // 虚拟秒，从 00:00 开始
let cur = 'idle';
let loungeUntil = 0;
let lastInteract = 0;
let mulCache = {};

function clockStr(sec) {
  const s = Math.floor(sec % 86400);
  return ('0' + Math.floor(s / 3600)).slice(-2) + ':' + ('0' + Math.floor(s % 3600 / 60)).slice(-2) +
         ':' + ('0' + (s % 60)).slice(-2);
}
function durOf(id) {
  const st = states[id];
  const rate = st && st.rate ? st.rate : 1;
  return Math.round(((st && st.duration) || 4.04) * 1000 / rate);
}
function push(id, ms, why, ctx) {
  events.push({
    t, clock: clockStr(t), id, ms, why,
    phase: ctx.phase, phaseName: ctx.phaseName, band: ctx.cpuBand, ema: Math.round(ctx.cpuEma),
    tempo: Number(ctx.tempo.toFixed(2)),
    mul: Number(director.multiplierOf(id, ctx).toFixed(3))
  });
  cur = id;
}

const STEP = 1;                         // 1 秒粒度（t 的单位是秒，毫秒一律 t*1000）
const totalSec = HOURS * 3600;
push('idle', durOf('idle'), 'start', director.ctxNow());

while (t < totalSec) {
  t += STEP;
  feedCpu(t);
  const minute = (t / 60) % 1440;
  const ctx = director.at(minute, t * 1000);

  const idleMs = t * 1000 - lastInteract;
  if (idleMs >= IDLE_HOLD_MS && t * 1000 >= loungeUntil) {
    // ① 先掷「要不要做一次性小动作」。pick 返回 null = 这个时段所有小动作倍率都是 0
    //    → 必须老实地不做，不能回落到 ACTS[0]（否则深夜照样吃米饭）。
    let acted = false;
    if (ACTS.length && rng() < director.idleActChance(ctx)) {
      const pickAct = director.pick(ACTS, ctx, baseW);
      if (pickAct) {
        push(pickAct, durOf(pickAct), 'idle_act', ctx);
        loungeUntil = t * 1000 + director.loungeDelayMs(ctx) + durOf(pickAct);
        acted = true;
      }
    }
    // ② 否则在空闲池里挑一个（'idle' 表示这一轮不动，保持待机）
    if (!acted) {
      const pickId = director.pick(CANDIDATES, ctx, baseW) || 'idle';
      if (pickId !== cur) push(pickId, durOf(pickId), 'lounge', ctx);
      loungeUntil = t * 1000 + director.loungeDelayMs(ctx);
    }
  }
}

/* ---------------- 统计 ---------------- */
const byId = {};
for (const e of events) {
  const rec = byId[e.id] || (byId[e.id] = { id: e.id, name: (states[e.id] && states[e.id].name) || e.id, runs: 0, ms: 0, phases: {} });
  rec.runs++; rec.ms += (e.ms || 0);
  rec.phases[e.phase] = (rec.phases[e.phase] || 0) + 1;
}
const totalMs = events.reduce((s, e) => s + (e.ms || 0), 0) || 1;
const rows = Object.values(byId).map(r => ({ ...r, share: r.ms / totalMs })).sort((a, b) => b.ms - a.ms);

// 每小时切换次数
const perHour = {};
for (const e of events) {
  const h = Math.floor(e.t / 3600);
  perHour[h] = (perHour[h] || 0) + 1;
}

// 时段分布
const perPhase = {};
for (const e of events) {
  const p = perPhase[e.phase] || (perPhase[e.phase] = { id: e.phase, name: e.phaseName, runs: 0, ms: 0 });
  p.runs++; p.ms += (e.ms || 0);
}

// CPU 档分布
const perBand = {};
for (const e of events) perBand[e.band] = (perBand[e.band] || 0) + 1;

/* ---------------- 断言 ---------------- */
const checks = [];
function check(name, ok, detail) { checks.push({ name, ok: !!ok, detail }); }

// ① 每个时段都有动作发生（时段没被写死成空池）
for (const p of cfg.phases) {
  const n = (perPhase[p.id] || {}).runs || 0;
  check('时段有动作:' + p.id, n > 0, n + ' 次');
}

// ② 深夜必须比下午「懒」：用平均停留时长衡量，而不是事件条数
//    （事件条数会被「重复抽到同一个动作→不记事件」干扰，停顿时长才是肉眼看到的节奏）
/* 平均「到下一次换动作」的间隔（不是动作本身的时长——
   小动作只有 3.75s，用它算会让所有时段看起来一样） */
function meanDwell(phaseId) {
  const list = events.filter(e => e.phase === phaseId && e.why !== 'start');
  if (list.length < 2) return null;
  /* 取中位数，并丢掉跨大段空档的间隔：从 00:00 开始跑的模拟里 'late' 会被
     切成 00:00-06:00 和 23:00-24:00 两块，中间 17 小时的间隔会把均值撑坏。 */
  const gaps = [];
  for (let i = 0; i < list.length - 1; i++) {
    const g = list[i + 1].t - list[i].t;
    if (g > 0 && g < 3600) gaps.push(g);
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}
const lateDwell = meanDwell('late'), afterDwell = meanDwell('afternoon');
check('深夜节奏 < 下午（中位换动作间隔更长）', lateDwell === null || afterDwell === null || lateDwell > afterDwell * 1.3,
      '深夜均停 ' + (lateDwell === null ? '—' : lateDwell.toFixed(1)) + 's vs 下午 ' +
      (afterDwell === null ? '—' : afterDwell.toFixed(1)) + 's');

// ③ CPU 进入 hot 档时出现过「晕菜」（若配置里 dizzy 存在）
if (states.dizzy) {
  const hot = events.filter(e => e.band === 'hot').length;
  const dizzyHot = events.filter(e => e.id === 'dizzy' && e.band === 'hot').length;
  check('CPU 高时触发晕菜', hot === 0 || dizzyHot > 0, 'hot 事件 ' + hot + ' 次，其中晕菜 ' + dizzyHot + ' 次');
} else {
  check('CPU 高时触发晕菜', true, '素材 dizzy 尚未安装，跳过');
}

// ④ 不抽搐：任意 60 秒内切换次数 <= 8
let twitch = 0;
for (let i = 0; i < events.length; i++) {
  let n = 0;
  for (let j = i; j < events.length && events[j].t - events[i].t < 60; j++) n++;
  twitch = Math.max(twitch, n);
}
check('不抽搐（60 秒内 ≤ 8 次切换）', twitch <= 8, '最密 60 秒 ' + twitch + ' 次');

// ⑤ 每个时刻的空闲池都不为空（权重守恒，永远不会选出 null 卡死）
let emptyPool = 0;
for (let m = 0; m < 1440; m += 5) {
  const ctx = director.at(m, m * 60000);
  const ok = CANDIDATES.some(id => director.weightOf(id, ctx, baseW[id]) > 0);
  if (!ok) emptyPool++;
}
check('空闲池非空（24h 每 5 分钟采点）', emptyPool === 0, emptyPool + ' 个采样点空池');

// ⑥ 时段边界没有硬切 —— 直接查权重曲线的连续性（比数事件可靠：
//    10 分钟窗口里只有两三个事件时，采样重叠度是噪声，不是证据）
/* 判据用的是「该动作全天倍率幅度的百分比」：只要边界是渐变，
   每分钟的位移就不会超过幅度/渐变分钟数（20 分钟 → 5%）。
   用两个相邻值的相对变化会误报——在幅度低端，0.2→0.35 的相对变化有 55%，
   但绝对位移只占全天的 5%。 */
let worstPct = 0, worstId = '';
for (const id of CANDIDATES) {
  let lo = Infinity, hi = -Infinity;
  const series = [];
  for (let m = 0; m <= 1440; m++) {
    const v = director.multiplierOf(id, director.at(m, m * 60000));
    series.push(v); lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  const range = hi - lo;
  if (range < 1e-6) continue;
  for (let i = 1; i < series.length; i++) {
    const pct = Math.abs(series[i] - series[i - 1]) / range;
    if (pct > worstPct) { worstPct = pct; worstId = id + '@' + D.minToHHMM(i - 1); }
  }
}
check('时段边界无硬切（每分钟位移 < 幅度的 10%）', worstPct < 0.10,
      '最大 ' + (worstPct * 100).toFixed(1) + '% (' + worstId + ')');

// ⑦ 没有哪个动作独大（超过 30% 说明权重配歪了，看着会腻）
const topShare = rows.length ? rows[0].share : 0;
check('无单动作独大（最大占比 < 30%）', topShare < 0.30,
      '最大 ' + rows[0].name + ' ' + (topShare * 100).toFixed(1) + '%');

/* ---------------- 落盘 ---------------- */
fs.mkdirSync(OUT, { recursive: true });

const csv = ['start_sec,clock,state,name,ms,why,phase,phase_name,cpu_band,cpu_ema,tempo,mul']
  .concat(events.map(e => [e.t, e.clock, e.id, (states[e.id] && states[e.id].name) || e.id,
    e.ms, e.why, e.phase, e.phaseName, e.band, e.ema, e.tempo, e.mul].join(',')))
  .join('\n');
fs.writeFileSync(path.join(OUT, 'timeline.csv'), '\ufeff' + csv, 'utf8');

const summary = {
  generatedAt: new Date().toISOString(),
  seed: SEED, hours: HOURS, preset: cfg.preset, enabled: cfg.enabled,
  statesInstalled: stateIds, director: {
    phases: cfg.phases.map(p => ({ id: p.id, name: p.name, from: p.from, to: p.to })),
    transitionMin: cfg.transitionMin
  },
  events: events.length,
  perState: rows,
  perPhase: Object.values(perPhase).sort((a, b) => b.ms - a.ms),
  perBand,
  switchPerHour: perHour,
  checks,
  allPassed: checks.every(c => c.ok)
};
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

/* ---------------- 时间线图 ---------------- */
const COLORS = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7',
                '#9c755f', '#bab0ac', '#86bcb6', '#d37295', '#a0cbe8', '#8cd17d', '#f1ce63', '#d4a6c8'];
const legend = rows.map((r, i) => ({ id: r.id, name: r.name, color: COLORS[i % COLORS.length] }));
const colorOf = {};
for (const l of legend) colorOf[l.id] = l.color;

// 每个动作一行 × 24 小时（每格 10 分钟 = 144 格）
let svg = '';
const CELL = 3.0, ROWH = 16, PADL = 96;
for (let d = 0; d < Math.ceil(HOURS / 24); d++) {
  const y0 = d * (legend.length * ROWH + 34);
  legend.forEach((l, ri) => {
    const y = y0 + 22 + ri * ROWH;
    svg += `<text x="${PADL - 6}" y="${y + 10}" font-size="10" text-anchor="end" fill="var(--muted-foreground)">${l.name}</text>`;
    for (let c = 0; c < 144; c++) {
      const s = d * 86400 + c * 600, e = s + 600;
      const hit = events.find(ev => ev.id === l.id && ev.t < e && ev.t + ev.ms > s);
      svg += `<rect x="${PADL + c * CELL}" y="${y}" width="${CELL - 0.4}" height="${ROWH - 4}" rx="1" fill="${hit ? l.color : 'transparent'}" opacity="${hit ? 1 : 0.08}"/>`;
    }
  });
  for (let h = 0; h <= 24; h += 2) {
    const x = PADL + (h / 24) * 144 * CELL;
    svg += `<text x="${x}" y="${y0 + 14}" font-size="9" fill="var(--muted-foreground)" text-anchor="middle">${('0' + h).slice(-2)}</text>`;
    svg += `<line x1="${x}" y1="${y0 + 18}" x2="${x}" y2="${y0 + 22 + legend.length * ROWH}" stroke="var(--border)" stroke-width="0.4" opacity="0.5"/>`;
  }
}
const html = `<!doctype html><meta charset="utf-8"><title>导演层 · 24 小时动作时间线</title>
<style>body{padding:8px 0} .h{font-size:13px;margin:6px 0}.bad{color:#e15759}.ok{color:#59a14f}
table{border-collapse:collapse;font-size:11px;margin:6px 0}td,th{padding:2px 8px;border-bottom:1px solid var(--border);text-align:left}</style>
<div class="h"><b>动作时间线</b> · ${HOURS}h · seed ${SEED} · 预设 ${cfg.preset} · 每格 10 分钟</div>
<svg width="${PADL + 144 * CELL + 8}" height="${Math.ceil(HOURS / 24) * (legend.length * ROWH + 34)}">${svg}</svg>
<div class="h"><b>断言</b></div><table>${checks.map(c => `<tr><td class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'}</td><td>${c.name}</td><td>${c.detail || ''}</td></tr>`).join('')}</table>
<div class="h"><b>各动作时长占比</b></div><table><tr><th>动作</th><th>次数</th><th>时长占比</th></tr>
${rows.map(r => `<tr><td>${r.name}</td><td>${r.runs}</td><td>${(r.share * 100).toFixed(1)}%</td></tr>`).join('')}</table>`;
fs.writeFileSync(path.join(OUT, 'timeline.html'), html, 'utf8');

/* ---------------- 控制台报告 ---------------- */
console.log('=== 导演层模拟 ' + HOURS + 'h · seed ' + SEED + ' · 预设 ' + cfg.preset + ' ===');
console.log('事件数 ' + events.length + ' | 最密 60 秒 ' + twitch + ' 次切换');
console.log('\n动作                次数     占比    主要时段');
for (const r of rows) {
  const ph = Object.entries(r.phases).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => k + ':' + v).join(' ');
  console.log('  ' + r.name.padEnd(14, '　') + String(r.runs).padStart(5) + '  ' +
              (r.share * 100).toFixed(1).padStart(5) + '%   ' + ph);
}
console.log('\n每小时切换次数: ' + Object.entries(perHour).map(([h, n]) => h + ':' + n).join(' '));
console.log('\n断言:');
for (const c of checks) console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.name + (c.detail ? '  → ' + c.detail : ''));
console.log('\n' + (summary.allPassed ? '全部通过' : '有断言失败') + ' | 产物: ' + OUT);
process.exitCode = summary.allPassed ? 0 : 1;
