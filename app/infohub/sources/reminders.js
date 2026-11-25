'use strict';
/**
 * infohub 源 · 待办 / 专注 / 喝水（reminders）
 *
 * 数据文件：`ctx.dataDir/infohub-reminders.json`
 *   - 原子落盘：先写 `<file>.tmp`，再 `fs.renameSync` 覆盖（Windows 同盘 rename 是原子的）
 *   - 坏了不致命：解析失败 → 备份成 `.corrupt-<时间戳>` 后按默认值重建
 *
 * 能力：
 *   待办  {id,text,repeat:'none'|'daily'|'weekly',weekdays:[0-6],at:'HH:mm',done,doneUntil,dueAt}
 *   专注  focusStart(minutes) / focusStop() / status()
 *   喝水  {goalMl,cupMl,everyMin,from,to,today:[{ts,ml}]}，累计与撤销
 *
 * 到点一律 `ctx.emit({kind:'reminder'})`（契约 §2），并同步 `snapshot('reminders')`（§3）。
 * 额外对外 API：addTodo / removeTodo / toggleTodo / focusStart / focusStop /
 *               waterAdd / waterUndo / getState（挂实例上，宿主 app/infohub/index.js 直接调）。
 *
 * 约定（docs/infohub-contract.md §0 / §4.7）：
 *   - 只用 node:fs / node:path / node:os；零第三方依赖；
 *   - 定时器 unref()，stop() 清干净；时间统一走 clock()（可用 ctx.now 注入，便于测试）；
 *   - 任何异常都不抛到顶层，只写日志 + status()。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const NAME = 'reminders';
/** 主循环节拍：15 秒（待办最细粒度是分钟，够用且不费电） */
const TICK_MS = 15 * 1000;
/** 数据文件名 */
const FILE_NAME = 'infohub-reminders.json';
/** 单条待办文本上限 */
const MAX_TEXT = 200;
/** 喝水「今天」最多留多少条（防手抖点一天） */
const MAX_WATER_ITEMS = 60;

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/* ------------------------------------------------------------------ *
 * 时间小工具（全部本地时区，中国无夏令时但代码仍按日历运算，跨月安全）
 * ------------------------------------------------------------------ */
function pad2(n) { return (n < 10 ? '0' : '') + n; }

/** 'YYYY-MM-DD'（本地） */
function ymd(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 'HH:mm'（本地） */
function hhmm(ts) {
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** 解析 'HH:mm'；非法返回 null */
function parseHHmm(s) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  return { h: Number(m[1]), m: Number(m[2]) };
}

/** 当天 00:00:00 的时间戳 */
function dayStart(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 第 n 天的 00:00（按日历加，跨月/跨年正确） */
function addDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 某天某时某分的毫秒时间戳 */
function atOfDay(dayTs, h, m) {
  const d = new Date(dayTs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
}

/**
 * 计算严格晚于 afterMs 的下一个触发时刻。
 * repeat=none 只排一次（今天已过就排明天，避免创建后立刻炸一条）；
 * daily 每天；weekly 只在 weekdays 里（0=周日）。
 * @returns {number|null}
 */
function nextOccurrence(todo, afterMs) {
  const hm = parseHHmm(todo && todo.at);
  if (!hm) return null;
  const days = (todo.repeat === 'weekly' && Array.isArray(todo.weekdays) && todo.weekdays.length)
    ? todo.weekdays
    : null;
  const start = dayStart(afterMs);
  for (let i = 0; i < 8; i++) {
    const day = addDays(start, i);
    if (days) {
      const wd = new Date(day).getDay();
      if (!days.includes(wd)) continue;
    }
    const t = atOfDay(day, hm.h, hm.m);
    if (t > afterMs) return t;
  }
  return null;
}

/** 距离 dueAt 的中文提示，面板直接用 */
function dueTextOf(dueAt, now) {
  if (!dueAt) return '';
  const d = dayStart(dueAt) - dayStart(now);
  const dayWord = d === 0 ? '今天' : d === 86400000 ? '明天' : ymd(dueAt);
  return dayWord + ' ' + hhmm(dueAt);
}

/* ------------------------------------------------------------------ *
 * 工厂
 * ------------------------------------------------------------------ */
module.exports = function create(ctx) {
  const cfg = () => ctx.cfg() || {};
  const log = (m) => { try { ctx.log(m); } catch (e) {} };
  const clock = () => (typeof ctx.now === 'function' ? Number(ctx.now()) : Date.now());

  const dataDir = ctx.dataDir || path.join(os.tmpdir(), 'maojing-infohub');
  const file = path.join(dataDir, FILE_NAME);

  let timer = null;
  let started = false;
  let state = { ready: false, detail: '未启动' };
  let db = null;            // 落盘数据
  let saveCount = 0;        // 调试用

  /* ---------- 默认值 ---------- */

  function defaultWater() {
    const c = cfg();
    const w = c.water || {};
    const from = parseHHmm(w.from) ? w.from : '09:00';
    const to = parseHHmm(w.to) ? w.to : '21:00';
    return {
      goalMl: Math.max(100, Number(w.goalMl) || 2000),
      cupMl: Math.max(50, Number(w.cupMl) || 250),
      everyMin: Math.max(0, Number(w.everyMin == null ? 60 : w.everyMin)),
      from,
      to,
      today: [],
      day: '',
      nextAt: 0,          // 下一次喝水提醒时刻（0 = 还没排）
      lastAddAt: 0,
    };
  }

  function defaultDb() {
    return {
      version: 1,
      todos: [],
      focus: { active: false, minutes: 25, startedAt: 0, endsAt: 0, endedAt: 0, fired: false },
      water: defaultWater(),
      savedAt: 0,
    };
  }

  /* ---------- 落盘 ---------- */

  function ensureDir() {
    try { fs.mkdirSync(dataDir, { recursive: true }); return true; } catch (e) { log('建目录失败：' + e.message); return false; }
  }

  /** 原子写：.tmp → rename */
  function save() {
    if (!db) return false;
    db.savedAt = clock();
    const txt = JSON.stringify(db, null, 2);
    const tmp = file + '.tmp';
    try {
      ensureDir();
      fs.writeFileSync(tmp, txt, 'utf8');
      fs.renameSync(tmp, file);
      saveCount++;
      return true;
    } catch (e) {
      log('落盘失败：' + e.message);
      try { fs.unlinkSync(tmp); } catch (e2) {}
      return false;
    }
  }

  function normalizeTodo(t) {
    if (!t || typeof t !== 'object') return null;
    const at = parseHHmm(t.at) ? String(t.at) : '09:00';
    const repeat = ['none', 'daily', 'weekly'].includes(t.repeat) ? t.repeat : 'none';
    const rawWd = Array.isArray(t.weekdays) ? t.weekdays : (Array.isArray(t.weekday) ? t.weekday : []);
    const wd = [...new Set(rawWd.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
    return {
      id: String(t.id || ('td_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))),
      text: String(t.text || '').slice(0, MAX_TEXT),
      repeat,
      weekdays: repeat === 'weekly' ? (wd.length ? wd : [1, 2, 3, 4, 5]) : wd,
      at,
      done: !!t.done,
      doneUntil: Number(t.doneUntil) || 0,
      dueAt: Number(t.dueAt) || 0,
      lastFiredKey: String(t.lastFiredKey || ''),
      createdAt: Number(t.createdAt) || Date.now(),
    };
  }

  function load() {
    db = defaultDb();
    let raw = null;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') log('读数据失败：' + e.message);
      return;
    }
    try {
      const j = JSON.parse(raw);
      if (!j || typeof j !== 'object') throw new Error('不是对象');
      db.version = Number(j.version) || 1;
      db.todos = Array.isArray(j.todos) ? j.todos.map(normalizeTodo).filter(Boolean) : [];
      if (j.focus && typeof j.focus === 'object') db.focus = Object.assign(db.focus, j.focus);
      if (j.water && typeof j.water === 'object') {
        db.water = Object.assign(defaultWater(), j.water);
        db.water.today = Array.isArray(j.water.today)
          ? j.water.today.filter((x) => x && Number.isFinite(Number(x.ml))).slice(-MAX_WATER_ITEMS)
          : [];
        db.water.day = String(j.water.day || '');
      }
      db.savedAt = Number(j.savedAt) || 0;
    } catch (e) {
      log('数据文件损坏，已备份并重建：' + e.message);
      try { fs.renameSync(file, file + '.corrupt-' + Date.now()); } catch (e2) {}
      db = defaultDb();
    }
  }

  /* ---------- 视图 / 快照 ---------- */

  function totalMl() {
    return (db.water.today || []).reduce((s, x) => s + (Number(x.ml) || 0), 0);
  }

  function focusView() {
    const f = db.focus || {};
    const now = clock();
    const leftMs = f.active ? Math.max(0, Number(f.endsAt) - now) : 0;
    return {
      active: !!f.active,
      minutes: Number(f.minutes) || 25,
      startedAt: Number(f.startedAt) || 0,
      endsAt: Number(f.endsAt) || 0,
      endsAtText: f.active && f.endsAt ? hhmm(f.endsAt) : '',
      leftSec: Math.round(leftMs / 1000),
      endedAt: Number(f.endedAt) || 0,
    };
  }

  function waterView() {
    const w = db.water;
    const goal = Number(w.goalMl) || 2000;
    const t = totalMl();
    return {
      goalMl: goal,
      cupMl: Number(w.cupMl) || 250,
      everyMin: Number(w.everyMin) || 0,
      from: w.from,
      to: w.to,
      totalMl: t,
      cups: (w.today || []).length,
      percent: goal ? Math.min(100, Math.round((t / goal) * 100)) : 0,
      today: (w.today || []).map((x) => ({ ts: x.ts, ml: x.ml, time: hhmm(x.ts) })),
    };
  }

  function stateView() {
    const now = clock();
    return {
      todos: (db.todos || []).map((t) => ({
        id: t.id,
        text: t.text,
        repeat: t.repeat,
        weekdays: t.weekdays,
        at: t.at,
        done: !!t.done,
        dueAt: t.dueAt || 0,
        dueText: t.done ? '已完成' : dueTextOf(t.dueAt, now),
        repeatText: t.repeat === 'daily' ? '每天'
          : t.repeat === 'weekly' ? ('每周' + (t.weekdays || []).map((d) => WEEK_CN[d]).join('、'))
            : '单次',
      })),
      focus: focusView(),
      water: waterView(),
      updatedAt: now,
    };
  }

  function pushSnapshot() {
    try { ctx.snapshot('reminders', stateView()); } catch (e) { log('快照失败：' + e.message); }
  }

  /** 统一写盘 + 快照 */
  function commit() {
    save();
    pushSnapshot();
    return stateView();
  }

  /* ---------- 触发 ---------- */

  function emitReminder(payload) {
    try {
      ctx.emit(Object.assign({
        source: NAME,
        kind: 'reminder',
        level: 'info',
        ts: clock(),
      }, payload));
    } catch (e) {
      log('emit 失败：' + e.message);
    }
  }

  /** 待办到点：只弹一次（lastFiredKey 记住这次 occurrence），重复项滚到下一次 */
  function fireTodos(now) {
    let changed = false;
    for (const t of db.todos) {
      if (t.done) continue;
      if (!t.dueAt) {
        t.dueAt = nextOccurrence(t, now - 60000) || 0;   // 容忍同一分钟创建
        changed = true;
        continue;
      }
      if (t.dueAt > now) continue;
      const key = 'rem:todo:' + t.id + ':' + t.dueAt;
      if (t.lastFiredKey === key) {
        // 已弹过（例如重启后文件里还留着），只补滚动
        if (!t.done) t.dueAt = nextOccurrence(t, now) || 0;
        changed = true;
        continue;
      }
      t.lastFiredKey = key;
      emitReminder({
        title: '待办到点',
        body: t.text + '（' + hhmm(t.dueAt) + '）',
        key,
        actions: [{ id: 'copy', label: '复制', kind: 'copy', payload: t.text }],
        data: { type: 'todo', id: t.id, at: t.at, repeat: t.repeat },
      });
      if (t.repeat === 'none') {
        t.done = true;
        t.doneUntil = now;
        t.dueAt = 0;
      } else {
        t.dueAt = nextOccurrence(t, now) || 0;
        t.doneUntil = t.dueAt;
      }
      changed = true;
    }
    return changed;
  }

  /** 专注到点 */
  function fireFocus(now) {
    const f = db.focus;
    if (!f || !f.active) return false;
    if (!f.endsAt || f.endsAt > now) return false;
    f.active = false;
    f.endedAt = now;
    const mine = Number(f.minutes) || 25;
    emitReminder({
      title: '专注结束',
      body: '专注 ' + mine + ' 分钟完成，起来活动一下、看看远处。',
      key: 'rem:focus:' + f.endsAt,
      actions: [{ id: 'copy', label: '复制', kind: 'copy', payload: '专注 ' + mine + ' 分钟完成' }],
      data: { type: 'focus', minutes: mine },
    });
    return true;
  }

  /** 喝水时段判断（支持 from > to 的跨夜时段） */
  function inWaterWindow(now) {
    const w = db.water;
    const a = parseHHmm(w.from);
    const b = parseHHmm(w.to);
    if (!a || !b) return true;
    const d = new Date(now);
    const cur = d.getHours() * 60 + d.getMinutes();
    const s = a.h * 60 + a.m;
    const e = b.h * 60 + b.m;
    if (s === e) return true;
    return s < e ? (cur >= s && cur <= e) : (cur >= s || cur <= e);
  }

  /** 喝水：每天 0 点翻页；到间隔提醒；喝够目标就静音 */
  function fireWater(now) {
    const w = db.water;
    let changed = false;
    const today = ymd(now);
    if (w.day !== today) {
      w.day = today;
      w.today = [];
      w.nextAt = 0;
      w.lastAddAt = 0;
      changed = true;
    }
    const everyMin = Number(w.everyMin) || 0;
    if (everyMin <= 0) return changed;
    if (totalMl() >= (Number(w.goalMl) || 2000)) return changed;
    if (!inWaterWindow(now)) {
      if (w.nextAt) { w.nextAt = 0; changed = true; }
      return changed;
    }
    if (!w.nextAt) {
      // 刚启动 / 刚进时段 / 刚喝完一杯：先等一个间隔，避免开机就弹
      w.nextAt = now + everyMin * 60000;
      return true;
    }
    if (now >= w.nextAt) {
      const slot = hudSlot(now, everyMin);
      emitReminder({
        title: '喝水提醒',
        body: '该喝水啦。今日 ' + totalMl() + '/' + (Number(w.goalMl) || 2000) + ' ml。',
        key: 'rem:water:' + today + ':' + slot,
        actions: [{ id: 'copy', label: '记一杯', kind: 'copy', payload: '喝水 +' + (Number(w.cupMl) || 250) + 'ml' }],
        data: { type: 'water', totalMl: totalMl(), goalMl: Number(w.goalMl) || 2000 },
      });
      w.nextAt = now + everyMin * 60000;
      changed = true;
    }
    return changed;
  }

  /** 提醒窗口编号：每 everyMin 一个槽，避免同一间隔内重复弹 */
  function hudSlot(now, everyMin) {
    const d = new Date(now);
    return Math.floor((d.getHours() * 60 + d.getMinutes()) / Math.max(1, everyMin));
  }

  /* ---------- 主循环 ---------- */

  function tick() {
    if (!db) return;
    const now = clock();
    let changed = false;
    try {
      if (fireTodos(now)) changed = true;
      if (fireFocus(now)) changed = true;
      if (fireWater(now)) changed = true;
    } catch (e) {
      log('tick 异常：' + e.message);
    }
    if (changed) {
      save();
      pushSnapshot();
    }
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  /* ---------- 对外动作 ---------- */

  function addTodo(arg) {
    const a = arg || {};
    const text = String(a.text == null ? '' : a.text).trim();
    if (!text) return { ok: false, error: '待办内容不能为空', state: stateView() };
    const hm = parseHHmm(a.at);
    if (!hm) return { ok: false, error: '时间格式必须是 HH:mm', state: stateView() };
    const repeat = ['none', 'daily', 'weekly'].includes(a.repeat) ? a.repeat : 'none';
    // 契约里写的是 weekday?[]，实际用 weekdays；两个名字都收
    const rawWd = Array.isArray(a.weekdays) ? a.weekdays : (Array.isArray(a.weekday) ? a.weekday : []);
    let weekdays = [...new Set(rawWd.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
    if (repeat === 'weekly' && !weekdays.length) weekdays = [1, 2, 3, 4, 5];
    const now = clock();
    const todo = normalizeTodo({
      id: 'td_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      text: text.slice(0, MAX_TEXT),
      repeat,
      weekdays,
      at: pad2(hm.h) + ':' + pad2(hm.m),
      done: false,
      dueAt: 0,
      createdAt: now,
    });
    todo.dueAt = nextOccurrence(todo, now) || 0;
    db.todos.push(todo);
    log('新增待办：' + todo.at + ' ' + todo.text + '（' + todo.repeat + '）');
    return { ok: true, todo: { id: todo.id, text: todo.text, at: todo.at, dueAt: todo.dueAt }, state: commit() };
  }

  function removeTodo(id) {
    const i = db.todos.findIndex((t) => t.id === id);
    if (i < 0) return { ok: false, error: '没有这条待办', state: stateView() };
    const [gone] = db.todos.splice(i, 1);
    log('删除待办：' + gone.text);
    return { ok: true, state: commit() };
  }

  function toggleTodo(id) {
    const t = db.todos.find((x) => x.id === id);
    if (!t) return { ok: false, error: '没有这条待办', state: stateView() };
    const now = clock();
    if (t.done) {
      // 取消完成 → 重新排到下一次（今天已过就明天）
      t.done = false;
      t.doneUntil = 0;
      t.lastFiredKey = '';
      t.dueAt = nextOccurrence(t, now) || 0;
    } else {
      t.done = true;
      t.doneUntil = now;
      t.dueAt = 0;
    }
    return { ok: true, state: commit() };
  }

  function focusStart(minutes) {
    const now = clock();
    const m = Math.min(240, Math.max(1, Math.round(Number(minutes) || 25)));
    db.focus = {
      active: true,
      minutes: m,
      startedAt: now,
      endsAt: now + m * 60000,
      endedAt: 0,
      fired: false,
    };
    log('专注开始：' + m + ' 分钟');
    return { ok: true, state: commit() };
  }

  function focusStop() {
    const f = db.focus;
    const now = clock();
    const wasActive = !!f.active;
    const usedMin = wasActive && f.startedAt ? Math.round((now - f.startedAt) / 60000) : 0;
    f.active = false;
    f.endedAt = now;
    if (wasActive) log('专注中止，已进行 ' + usedMin + ' 分钟');
    return { ok: true, usedMin, state: commit() };
  }

  function waterAdd(ml) {
    const w = db.water;
    const now = clock();
    const today = ymd(now);
    if (w.day !== today) { w.day = today; w.today = []; }
    const amount = Math.min(2000, Math.max(10, Math.round(Number(ml) || Number(w.cupMl) || 250)));
    w.today.push({ ts: now, ml: amount });
    while (w.today.length > MAX_WATER_ITEMS) w.today.shift();
    w.lastAddAt = now;
    w.nextAt = now + (Number(w.everyMin) || 0) * 60000;
    log('喝水 +' + amount + 'ml，今日 ' + totalMl() + 'ml');
    return { ok: true, added: amount, state: commit() };
  }

  function waterUndo() {
    const w = db.water;
    if (!w.today.length) return { ok: false, error: '今天还没记录', state: stateView() };
    const last = w.today.pop();
    w.lastAddAt = w.today.length ? w.today[w.today.length - 1].ts : 0;
    w.nextAt = clock() + (Number(w.everyMin) || 0) * 60000;
    log('撤销喝水 -' + last.ml + 'ml，今日 ' + totalMl() + 'ml');
    return { ok: true, removed: last.ml, state: commit() };
  }

  function getState() { return stateView(); }

  /* ---------- 生命周期 ---------- */

  load();

  return {
    name: NAME,
    label: '待办 / 专注 / 喝水',
    defaults: {
      enabled: true,
      water: { goalMl: 2000, cupMl: 250, everyMin: 60, from: '09:00', to: '21:00' },
    },

    async start() {
      stopTimer();
      started = true;
      // 启动前落一次盘：把默认结构/今天日期写实，方便用户直接看文件
      if (db.water.day !== ymd(clock())) {
        db.water.day = ymd(clock());
        db.water.today = [];
      }
      save();
      pushSnapshot();
      timer = setInterval(() => tick(), TICK_MS);
      if (timer.unref) timer.unref();
      const n = db.todos.filter((t) => !t.done).length;
      state = { ready: true, detail: '运行中 · ' + n + ' 条待办 · 今日 ' + totalMl() + 'ml' };
    },

    async stop() {
      started = false;
      stopTimer();
      save();
      state = { ready: false, detail: '已停止' };
    },

    status() {
      if (!started) return { ready: false, detail: state.detail || '未启动' };
      const n = db.todos.filter((t) => !t.done).length;
      return { ready: true, detail: '运行中 · ' + n + ' 条待办 · 今日 ' + totalMl() + '/' + db.water.goalMl + 'ml' };
    },

    async refresh() {
      tick();
      return { ok: true, state: stateView() };
    },

    /* 契约要求的额外 API */
    addTodo,
    removeTodo,
    toggleTodo,
    focusStart,
    focusStop,
    waterAdd,
    waterUndo,
    getState,

    /* 测试/调试用：手动跑一拍，不必等 15 秒 */
    _tick: tick,
    _file: file,
    _raw: () => db,
    _saveCount: () => saveCount,
  };
};

module.exports.nextOccurrence = nextOccurrence;
module.exports.parseHHmm = parseHHmm;
module.exports.totalOf = (today) => (today || []).reduce((s, x) => s + (Number(x.ml) || 0), 0);
