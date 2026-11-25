'use strict';
/**
 * infohub 源 · 飞书日历（calendar）
 *
 * 命令（2026-11-25 在本机真跑过，参数来自 `lark-cli calendar +agenda --help`）：
 *   lark-cli calendar +agenda --format json --start 2026-11-25 --end 2026-11-25
 * 可执行文件探测顺序：
 *   1. %LOCALAPPDATA%\hermes\node\lark-cli(.cmd)
 *   2. 环境变量 LARK_CLI
 *   3. PATH 里的 lark-cli
 *
 * 输出形态（成功）：
 *   { ok:true, identity:"user", data:{ items:[ {
 *       event_id, summary, status, free_busy_status, self_rsvp_status,
 *       start_time:{ timestamp:"1795…", date:"2026-11-25", timezone:"Asia/Shanghai" },
 *       end_time:{ … } } ] } }
 * 失败（实测本机登录态过期就是这样，原样落到 status()）：
 *   { ok:false, identity:"user",
 *     error:{ type:"authentication", subtype:"token_missing",
 *             message:"need_user_authorization (user: ou_…)" } }
 *
 * 约定（docs/infohub-contract.md §0 / §4.8）：
 *   - 只用 node:child_process / node:path / node:fs；零第三方依赖；
 *   - 子进程超时 20s（契约上限），失败静默（只写 status + 日志），不抛顶层；
 *   - 10 分钟刷新，`snapshot('calendar', { today:[{time,title}], updatedAt })`；
 *   - 定时器 unref()，stop() 清干净；日历标题里不会有密钥，但 open_id 一律脱敏后再进日志。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const NAME = 'calendar';
/** 刷新间隔：10 分钟 */
const POLL_MS = 10 * 60 * 1000;
/** 子进程超时（契约 ≤ 20s） */
const CLI_TIMEOUT_MS = 20000;
/** 面板最多显示几条 */
const MAX_ITEMS = 30;
/** 标题截断 */
const MAX_TITLE = 40;

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function ymd(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function hhmm(ts) {
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** open_id / 邮箱之类的标识脱敏：ou_abcd… → ou_ab…(32) */
function maskId(s) {
  const t = String(s || '');
  if (!t) return '';
  const m = /(ou_[0-9a-f]{4})[0-9a-f]+/i.exec(t);
  if (m) return m[1] + '…(' + t.length + ')';
  if (t.includes('@')) {
    const i = t.indexOf('@');
    return t.slice(0, Math.min(2, i)) + '…' + t.slice(i);
  }
  return t.length > 12 ? t.slice(0, 4) + '…(' + t.length + ')' : t;
}

/**
 * 从 lark-cli 的混合 stdout 里切出 JSON。
 * 实测 lark-cli 会先打印一行 `[lark-cli] uat-client: refresh_token expired …`，
 * 直接 JSON.parse 会炸，所以按第一个 { / [ 起截。
 */
function extractJson(text) {
  const s = String(text == null ? '' : text);
  // 逐个候选起点试：`[lark-cli] …` 这种前缀里的方括号会让「取第一个括号」的写法误判，
  // 所以按出现顺序试解析，第一个能 parse 的就是正文。最多试 50 个起点，避免大包空转。
  const starts = [];
  for (let i = 0; i < s.length && starts.length < 50; i++) {
    const ch = s[i];
    if (ch === '{' || ch === '[') starts.push(i);
  }
  for (const i of starts) {
    try { return JSON.parse(s.slice(i)); } catch (e) { /* 换下一个起点 */ }
  }
  throw new Error('输出里没有可用 JSON');
}

/** 把 start_time 归一成毫秒时间戳 + 是否全天 */
function startOf(item) {
  const st = (item && (item.start_time || item.start)) || null;
  if (!st) return null;
  if (typeof st === 'string') {
    if (/^\d{10}$/.test(st)) return { ms: Number(st) * 1000, allDay: false };
    const t = Date.parse(st);
    return Number.isNaN(t) ? null : { ms: t, allDay: /^\d{4}-\d{2}-\d{2}$/.test(st) };
  }
  if (typeof st === 'number') return { ms: st < 1e12 ? st * 1000 : st, allDay: false };
  if (st.timestamp && /^\d+$/.test(String(st.timestamp))) {
    return { ms: Number(st.timestamp) * 1000, allDay: false };
  }
  if (st.date) {
    const t = Date.parse(String(st.date) + 'T00:00:00');
    return Number.isNaN(t) ? null : { ms: t, allDay: true };
  }
  return null;
}

/**
 * 解析 `lark-cli calendar +agenda --format json` 的输出。
 * 纯函数，测试直接喂固定样本。
 * @param {string|object} input 原始 stdout 或已解析对象
 * @returns {{ok:boolean, items?:Array, error?:string, needAuth?:boolean}}
 */
function parseAgenda(input) {
  let j = input;
  if (typeof input === 'string') {
    try { j = extractJson(input); } catch (e) { return { ok: false, error: '不是 JSON：' + e.message }; }
  }
  if (!j || typeof j !== 'object') return { ok: false, error: '输出为空' };

  if (j.ok === false) {
    const err = j.error || {};
    const msg = String(err.message || err.type || '未知错误');
    const needAuth = err.type === 'authentication' || /need_user_authorization|token/i.test(msg);
    let human = msg;
    if (needAuth) human = '未登录飞书（登录态过期，跑 lark-cli auth login）';
    else if (err.type === 'authorization') human = '飞书应用缺权限：' + msg;
    else if (/network|timeout|ETIMEDOUT|ECONN/i.test(msg)) human = '网络不通：' + msg;
    return { ok: false, error: human, needAuth, raw: msg, subtype: err.subtype || '' };
  }

  // 兼容几种可能的包裹层
  const d = j.data != null ? j.data : j;
  let arr = null;
  if (Array.isArray(d)) arr = d;
  else if (Array.isArray(d.items)) arr = d.items;
  else if (Array.isArray(d.events)) arr = d.events;
  else if (Array.isArray(d.instances)) arr = d.instances;
  else if (Array.isArray(j.items)) arr = j.items;
  if (!arr) return { ok: false, error: '输出里没有日程列表' };

  const items = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const status = String(it.status || '').toLowerCase();
    if (status === 'cancelled' || it.is_cancelled === true) continue;
    const s = startOf(it);
    if (!s) continue;
    const title = String(it.summary || it.title || '(无标题)').slice(0, MAX_TITLE);
    items.push({
      ms: s.ms,
      allDay: s.allDay,
      time: s.allDay ? '全天' : hhmm(s.ms),
      title,
      status: status || 'confirmed',
      eventId: String(it.event_id || ''),
    });
  }
  items.sort((a, b) => (a.allDay === b.allDay ? a.ms - b.ms : (a.allDay ? -1 : 1)));
  return { ok: true, items };
}

/* ------------------------------------------------------------------ *
 * 工厂
 * ------------------------------------------------------------------ */
module.exports = function create(ctx) {
  const cfg = () => ctx.cfg() || {};
  const log = (m) => { try { ctx.log(m); } catch (e) {} };
  const clock = () => (typeof ctx.now === 'function' ? ctx.now() : Date.now());

  let timer = null;
  let started = false;
  let state = { ready: false, detail: '未启动' };
  let cliPath = '';
  let cliChecked = false;
  let lastData = null;
  let lastAt = 0;

  /* ---------- 找 lark-cli ---------- */

  function candidateDirs() {
    const out = [];
    const la = (ctx.paths && ctx.paths.localAppData) || process.env.LOCALAPPDATA || '';
    if (la) out.push(path.join(la, 'hermes', 'node'));
    if (ctx.appDir) out.push(ctx.appDir);
    return out;
  }

  function findCli() {
    if (cliChecked) return cliPath;
    cliChecked = true;
    const names = process.platform === 'win32'
      ? ['lark-cli.cmd', 'lark-cli.exe', 'lark-cli']
      : ['lark-cli'];

    // 1) 显式环境变量
    const envCli = String(process.env.LARK_CLI || '').trim();
    if (envCli && fs.existsSync(envCli)) { cliPath = envCli; log('lark-cli → ' + envCli); return cliPath; }

    // 2) 固定目录
    for (const dir of candidateDirs()) {
      for (const n of names) {
        const p = path.join(dir, n);
        try { if (fs.existsSync(p)) { cliPath = p; log('lark-cli → ' + p); return cliPath; } } catch (e) {}
      }
    }

    // 3) PATH
    const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      for (const ext of exts) {
        const p = path.join(dir, 'lark-cli' + ext);
        try { if (fs.existsSync(p)) { cliPath = p; log('lark-cli（PATH）→ ' + p); return cliPath; } } catch (e) {}
      }
    }
    cliPath = '';
    log('没找到 lark-cli');
    return cliPath;
  }

  /* ---------- 跑子进程 ---------- */

  function quote(s) {
    const t = String(s);
    if (!/[\s"&|<>^]/.test(t)) return t;
    return '"' + t.replace(/"/g, '""') + '"';
  }

  /**
   * 同步跑一次 lark-cli（20s 上限）。
   * Windows 上必须经过 cmd.exe 才能跑 .cmd 包装脚本，参数用引号包好。
   */
  function runCli(args) {
    const bin = findCli();
    if (!bin) return { ok: false, stdout: '', stderr: '没找到 lark-cli（%LOCALAPPDATA%\\hermes\\node 与 PATH 都没有）', code: -1 };
    let r;
    try {
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
        const line = [bin].concat(args).map(quote).join(' ');
        r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
          timeout: CLI_TIMEOUT_MS,
          encoding: 'utf8',
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        });
      } else {
        r = spawnSync(bin, args, {
          timeout: CLI_TIMEOUT_MS,
          encoding: 'utf8',
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        });
      }
    } catch (e) {
      return { ok: false, stdout: '', stderr: '启动失败：' + e.message, code: -1 };
    }
    if (r.error) {
      const timedOut = r.error.code === 'ETIMEDOUT' || /timed? ?out/i.test(r.error.message || '');
      return { ok: false, stdout: String(r.stdout || ''), stderr: timedOut ? 'lark-cli 超时（' + CLI_TIMEOUT_MS + 'ms）' : 'lark-cli 出错：' + r.error.message, code: -1, timedOut };
    }
    return { ok: true, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), code: r.status };
  }

  /* ---------- 主流程 ---------- */

  function refreshNow() {
    const now = clock();
    const day = ymd(now);
    const args = ['calendar', '+agenda', '--format', 'json', '--start', day, '--end', day];
    const r = runCli(args);
    let parsed;
    if (!r.ok) {
      parsed = { ok: false, error: r.stderr || '命令失败' };
    } else if (!String(r.stdout).trim()) {
      // 实测（Windows + .cmd 包装脚本）：结果 JSON 也可能整段落在 stderr，先试解析
      parsed = String(r.stderr).includes('{')
        ? parseAgenda(r.stderr)
        : { ok: false, error: (r.stderr || '').trim() ? '命令无输出：' + r.stderr.trim().slice(0, 120) : '命令无输出' };
    } else {
      parsed = parseAgenda(r.stdout);
      // lark-cli 有时把 JSON 打到 stderr（错误场景），兜一次
      if (!parsed.ok && String(r.stderr).includes('{')) {
        const alt = parseAgenda(r.stderr);
        if (alt.ok || alt.needAuth !== undefined) parsed = alt;
      }
    }

    if (!parsed.ok) {
      // 失败静默：不 emit、不清空旧快照，只在 status() 里说明原因
      state = { ready: !!lastData, detail: parsed.error || '取日程失败' };
      log('取日程失败：' + (parsed.error || '未知'));
      return { ok: false, error: parsed.error, needAuth: !!parsed.needAuth };
    }

    const today = (parsed.items || []).filter((it) => {
      if (it.allDay) return true;                      // 全天日程算今天
      return ymd(it.ms) === day;
    }).slice(0, MAX_ITEMS).map((it) => ({ time: it.time, title: it.title }));

    lastData = { today, updatedAt: clock() };
    lastAt = clock();
    state = {
      ready: true,
      detail: today.length ? '今日 ' + today.length + ' 项日程' : '今日没有日程',
    };
    try { ctx.snapshot('calendar', lastData); } catch (e) { log('快照失败：' + e.message); }
    log('刷新成功：' + state.detail);
    return { ok: true, data: lastData };
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    name: NAME,
    label: '飞书日历',
    defaults: {
      enabled: true,
      refreshMin: 10,
    },

    async start() {
      stopTimer();
      started = true;
      const c = cfg();
      if (c.enabled === false) { state = { ready: false, detail: '已关闭' }; return; }
      state = { ready: false, detail: '首次取数中' };
      // 同步子进程会阻塞主进程一点点（≤20s），放到下一拍避免卡住窗口创建
      setTimeout(() => {
        if (!started) return;                        // stop() 后不再补刷
        try { refreshNow(); } catch (e) { log('首刷异常：' + e.message); }
      }, 1500).unref();
      // 10 分钟刷新（配置 refreshMin 可覆盖）
      const mins = Math.max(1, Number(c.refreshMin) || 10);
      timer = setInterval(() => { try { refreshNow(); } catch (e) { log('刷新异常：' + e.message); } }, mins * 60 * 1000);
      if (timer.unref) timer.unref();
      state = { ready: false, detail: '已启动，等待首次取数' };
    },

    async stop() {
      started = false;
      stopTimer();
      state = { ready: false, detail: '已停止' };
    },

    status() {
      if (!started) return { ready: false, detail: state.detail || '未启动' };
      if (!cliPath) findCli();                      // 首刷还没跑过时也要能判断
      if (!cliPath) return { ready: false, detail: '没找到 lark-cli（%LOCALAPPDATA%\\hermes\\node 与 PATH 都没有）' };
      return state;
    },

    async refresh() {
      const r = refreshNow();
      return r.ok ? { ok: true, count: (r.data && r.data.today.length) || 0 } : { ok: false, error: r.error };
    },

    /** 连通性自检：只查 auth status，不拉日程（不打扰、不耗配额） */
    async probe() {
      const bin = findCli();
      if (!bin) return { ok: false, detail: '没找到 lark-cli' };
      const r = runCli(['auth', 'status']);
      if (!r.ok) return { ok: false, detail: r.stderr || 'auth status 失败' };
      const j = parseAgendaSafe(r.stdout) || {};
      const idt = j.identities || {};
      const parts = Object.keys(idt).map((k) => k + ':' + (idt[k] && idt[k].status || '?'));
      const detail = parts.length ? '身份 ' + parts.join(' / ') : 'auth status 无身份信息';
      return { ok: true, detail, auth: { identity: j.identity || '', defaultAs: j.defaultAs || '' } };
    },

    /* 测试/调试用 */
    _parseAgenda: parseAgenda,
    _extractJson: extractJson,
    _findCli: findCli,
    _mask: maskId,
    _cliPath: () => cliPath,
    _last: () => lastData,
    _lastAt: () => lastAt,
  };
};

/** auth status 之类不是 agenda 结构，容错解析，只为 probe 展示 */
function parseAgendaSafe(txt) {
  try { return extractJson(txt); } catch (e) { return null; }
}

module.exports.parseAgenda = parseAgenda;
module.exports.extractJson = extractJson;
module.exports.maskId = maskId;
