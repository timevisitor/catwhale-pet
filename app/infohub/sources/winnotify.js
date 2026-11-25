'use strict';
/* =====================================================================
   infohub/sources/winnotify.js —— Windows 通知中心统一消息源
   ---------------------------------------------------------------------
   为什么是它：NapCat / OneBot 这类第三方协议客户端有封号风险，已弃用。
   这里走 Windows 官方「通知中心」（UserNotificationListener, WinRT）：
   只读系统已经渲染出来的 toast，不注入、不登录、不碰协议，零封号风险。

   一轮 = 起一个 PowerShell 跑 winnotify_probe.ps1（带超时），拿回通知中心
   全部条目的原始 texts[]，再按应用各自的 toast 文本结构解析成统一事件。

   各应用的文本结构（实测/上游项目结论，必须按这个顺序取，不能一律 title+body）：
   · 微信 4.x：texts[0]=应用名「微信」、texts[1]=会话名、texts[2]="发送者 : 正文"
     来源：PepsiColaya/wechat-notifier README
   · QQ / 飞书 / 钉钉 / 企业微信：texts[0]=第一行（会话名）、其余是正文；
     拿不到会话名就整体当正文
   说明：旧版 wechat_probe.ps1 把 texts[1..] 用 ' / ' 拼成 body，微信三段式会被
   拼成「群名 / 发送者 : 正文」，会话名和正文分不开，所以泛化版探针改为返回原始
   texts[] 数组，解析放在 JS 里做。

   平台限制（HaloPixelToolBox 实测）：NotificationChanged 事件订阅在未打包
   （非 MSIX）应用上注册会失败（80070490 = Element not found），所以这里
   不订阅事件，改为轮询；主流开源项目轮询间隔 500~1000ms，本模块默认 800ms。
   注意单次探针本身约 0.9~1.1s（PowerShell + WinRT 初始化），因此实际节奏是
   「上一轮跑完再排下一轮」，不会叠加进程。

   契约 §4.2 的替代实现；配置见 defaults。
   ===================================================================== */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PS1 = path.join(__dirname, 'winnotify_probe.ps1');
const NAME = 'winnotify';
const BODY_MAX = 90;                 // 正文上限（契约要求）
const PS_TIMEOUT = 15000;            // 子进程超时（契约：≤20s）
const DEFAULT_POLL_MS = 800;         // 默认轮询间隔
const DEFAULT_MERGE_MS = 10000;      // 同会话合并窗口：10 秒
const SEEN_MAX = 600;                // 去重集合上限，超了截断

/** 每个应用的默认开关（钉钉/企业微信默认关：不是所有人都用） */
const APP_ENABLED_DEFAULT = { wechat: true, qq: true, feishu: true, dingtalk: false, wecom: false };

/**
 * 应用识别表。**顺序有意义**：企业微信必须排在微信前面，
 * 否则「企业微信」会被 /微信/ 先命中，归错应用。
 * match 是对 `应用显示名 + AUMID` 同时做小写匹配的正则。
 */
const APPS = [
  { id: 'wecom', label: '企业微信', open: 'wecom', match: /企业微信|wecom|wxwork|work\s*wechat|wechat\s*work/i },
  { id: 'wechat', label: '微信', open: 'wechat', match: /微信|wechat|weixin/i },
  { id: 'dingtalk', label: '钉钉', open: 'dingtalk', match: /钉钉|dingtalk/i },
  { id: 'feishu', label: '飞书', open: 'lark', match: /飞书|feishu|bytedance[.\s]lark|\blark\b/i },
  { id: 'qq', label: 'QQ', open: 'qq', match: /^qq$|^qq[.\s]|tencent[.\s]?qq|腾讯qq|qqnt/i },
];

const APP_BY_ID = APPS.reduce((m, a) => { m[a.id] = a; return m; }, Object.create(null));

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

function clip(text, max) {
  const s = clean(text);
  const n = max || BODY_MAX;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 一条通知属于哪个应用；认不出来返回 null（不是我们管的） */
function matchApp(item) {
  if (!item) return null;
  const hay = (clean(item.app) + ' ' + clean(item.aumid)).trim();
  if (!hay) return null;
  for (const a of APPS) if (a.match.test(hay)) return a;
  return null;
}

/** 取出原始文本数组：优先 texts[]，老格式退 title + body */
function splitTexts(item) {
  let texts = item && item.texts;
  if (typeof texts === 'string') texts = [texts];
  if (!Array.isArray(texts)) texts = [];
  texts = texts.map(clean).filter(Boolean);
  if (!texts.length) {
    const t = clean(item && item.title);
    const b = clean(item && item.body);
    if (t) texts.push(t);
    if (b) texts.push(b);
  }
  return texts;
}

/**
 * 通知条目 → 解析结果（纯函数，单测用）。
 * @returns {null|{app:object, texts:string[], chatName:string, body:string}}
 */
function parseItem(item) {
  const app = matchApp(item);
  if (!app) return null;
  const texts = splitTexts(item);
  if (!texts.length) return null;

  // 只有一段：拿不到会话名，整体当正文（契约要求）
  if (texts.length === 1) return { app, texts, chatName: app.label, body: texts[0] };

  let i = 0;
  if (app.id === 'wechat') {
    // 微信三段式：text[0] 是应用名「微信」，会话名从 text[1] 开始
    if (/^(微信|wechat|weixin)$/i.test(texts[0])) i = 1;
  } else if (new RegExp('^' + escRe(app.label) + '$', 'i').test(texts[0])) {
    // QQ 等有时把应用名也塞进第一段，去掉，别当成会话名
    i = 1;
  }
  const chatName = texts[i] || app.label;
  const rest = texts.slice(i + 1).join(' / ');
  return { app, texts, chatName, body: rest || chatName };
}

/** 通知 id（去重用）：优先 AUMID + id，AUMID 缺失退应用名 */
function idOf(item) {
  return clean(item && (item.aumid || item.app)) + ':' + clean(item && item.id);
}

/** 会话键（合并用）：应用 + 会话名 */
function chatKeyOf(parsed) {
  return parsed.app.id + '|' + parsed.chatName;
}

/**
 * 解析结果 → 归一化事件（纯函数，单测用）
 * @param {object} parsed parseItem 的返回
 * @param {object} item   原始通知条目
 */
function toEvent(parsed, item) {
  if (!parsed) return null;
  const app = parsed.app;
  const body = clip(parsed.body, BODY_MAX);
  const talk = /@我|@所有人|@全体成员/.test(parsed.body);
  return {
    source: NAME,
    kind: 'message',
    level: talk ? 'warn' : 'info',
    title: (app.label + ' · ' + parsed.chatName).slice(0, 60),
    body,
    ts: Date.parse((item && item.creation) || '') || Date.now(),
    key: 'winnotify:m:' + app.id + ':' + idOf(item),
    actions: [
      { id: 'copy', label: '复制', kind: 'copy', payload: clip(parsed.body, 200) },
      { id: 'open', label: '打开' + app.label, kind: 'app', payload: app.open },
    ],
    data: {
      app: clean(item && item.app),
      appId: app.id,
      aumid: clean(item && item.aumid),
      notificationId: clean(item && item.id),
      chatName: parsed.chatName,
      texts: parsed.texts.slice(0, 4),
      via: 'windows-notification-center',
    },
  };
}

/** 把 ps1 的 JSON 文本解析成对象；坏 JSON 不抛 */
function parseProbeJson(text) {
  const s = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!s) return { ok: false, error: '探针没有输出' };
  // 只取最后一个 JSON 对象，防止 PowerShell 在前后夹了警告文本
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) return { ok: false, error: '探针输出不是 JSON：' + s.slice(0, 120) };
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    // PS 5.1 的 ConvertTo-Json 会把「只有一个元素」的数组压成对象，这里补回来
    if (obj.items && !Array.isArray(obj.items)) obj.items = [obj.items];
    obj.items = Array.isArray(obj.items) ? obj.items : [];
    for (const it of obj.items) {
      if (typeof it.texts === 'string') it.texts = [it.texts];
      if (!Array.isArray(it.texts)) it.texts = [];
    }
    return obj;
  } catch (e) {
    return { ok: false, error: '探针 JSON 解析失败：' + e.message };
  }
}

/** 找 PowerShell：Windows PowerShell 5.1 优先（WinRT/UIA 在它上面验过） */
function findPowerShell() {
  if (process.env.SystemRoot) {
    const p = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'powershell.exe';
}

/**
 * 真跑一次探针。永不抛异常，返回 {ok, ...}。
 * @param {object} deps { dataDir }
 * @param {object} [opts] { engine, requestAccess }
 */
function runProbe(deps, opts) {
  const o = opts || {};
  const dir = (deps && deps.dataDir) || os.tmpdir();
  const out = path.join(dir, '.infohub-winnotify-probe-' + process.pid + '.json');

  return new Promise((resolve) => {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 忽略 */ }
    try { fs.unlinkSync(out); } catch (e) { /* 不存在就算了 */ }

    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-OutFile', out];
    if (o.engine) args.push('-Engine', String(o.engine));
    if (o.requestAccess) args.push('-RequestAccess');

    let child;
    try {
      child = spawn(findPowerShell(), args, { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: '启动 PowerShell 失败：' + (err && err.message ? err.message : String(err)) });
      return;
    }

    let stderr = '';
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      resolve(res);
    };
    const killTimer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* 忽略 */ }
      finish({ ok: false, error: 'PowerShell 探针超时（' + Math.round(PS_TIMEOUT / 1000) + 's）' });
    }, PS_TIMEOUT);
    if (typeof killTimer.unref === 'function') killTimer.unref();

    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += String(d); });
    child.on('error', (err) => finish({ ok: false, error: 'PowerShell 不可用：' + (err && err.message ? err.message : String(err)) }));
    child.on('close', (code) => {
      let text = '';
      try { text = fs.readFileSync(out, 'utf8'); } catch (e) { /* 没生成文件 */ }
      try { fs.unlinkSync(out); } catch (e) { /* 忽略 */ }
      if (!text) {
        finish({ ok: false, error: '探针没产出结果（退出码 ' + code + '）' + (stderr ? '：' + clean(stderr).slice(0, 160) : '') });
        return;
      }
      const parsed = parseProbeJson(text);
      if (parsed && parsed.ok === false && parsed.error) {
        finish({ ok: false, error: parsed.error, access: parsed.access, engine: parsed.engine, count: 0, items: [] });
        return;
      }
      finish(parsed);
    });
  });
}

/* ---------------------------------------------------------------------
   工厂
   --------------------------------------------------------------------- */

/**
 * 可注入探针的工厂（测试用：把 PowerShell 换成队列化的假探针）
 * @param {object} ctx 宿主上下文（见 docs/infohub-contract.md §1）
 * @param {function} probeFn (opts) => Promise<{ok, items, access, engine, count, error}>
 * @returns {object} 源实例
 */
function createWithProbe(ctx, probeFn) {
  const cfg = () => (typeof ctx.cfg === 'function' ? ctx.cfg() || {} : {});
  const log = (m) => { try { ctx.log(m); } catch (e) { /* 忽略 */ } };
  const emit = (e) => { try { ctx.emit(e); } catch (err) { log('emit 失败：' + err.message); } };
  const snap = (kind, data) => { try { ctx.snapshot(kind, data); } catch (e) { /* 忽略 */ } };

  let state = { ready: false, detail: '未启动', apps: {} };
  let timer = null;
  let stopped = true;
  let busy = false;                 // 上一轮没跑完就不排下一轮（防进程叠加）
  let baselineDone = false;
  let seen = new Set();             // 已处理的通知 id
  let merge = new Map();            // 会话键 → { start, count }（合并窗口）
  let stats = emptyStats();         // 本次运行累计：emitted / merged / hits
  let last = null;                  // 最近一次探针结果
  let runs = 0;

  function emptyStats() {
    const o = {};
    for (const a of APPS) o[a.id] = { hits: 0, emitted: 0, merged: 0, lastAt: 0 };
    return o;
  }

  const pollMs = () => Math.max(300, Number(cfg().pollMs) || DEFAULT_POLL_MS);
  const mergeMs = () => {
    const v = Number(cfg().mergeMs);
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MERGE_MS;
  };

  /** 各应用开关：配置没写就按默认（微信/QQ/飞书开，钉钉/企微关） */
  function enabledMap() {
    const c = cfg().apps || {};
    const out = {};
    for (const a of APPS) out[a.id] = c[a.id] === undefined || c[a.id] === null ? !!APP_ENABLED_DEFAULT[a.id] : !!c[a.id];
    return out;
  }

  /** 处理一批通知；首轮只建基线，历史条目不弹 */
  function ingest(res) {
    const items = Array.isArray(res.items) ? res.items : [];
    const enabled = enabledMap();
    const now = Date.now();

    // 统计每应用在通知中心里的条数（面板/状态用）
    const hits = {};
    for (const a of APPS) hits[a.id] = 0;
    const parsedList = [];
    for (const it of items) {
      const p = parseItem(it);
      if (p) { hits[p.app.id] += 1; parsedList.push({ it, p }); }
    }
    for (const a of APPS) stats[a.id].hits = hits[a.id];

    if (!baselineDone) {
      for (const it of items) seen.add(idOf(it));
      baselineDone = true;
      const brief = APPS.filter((a) => hits[a.id] > 0).map((a) => a.label + ' ' + hits[a.id]).join(' / ') || '无相关应用';
      log('建立基线：通知中心 ' + items.length + ' 条（' + brief + '），历史条目不弹');
      return 0;
    }

    let emitted = 0;
    for (const { it, p } of parsedList) {
      const idKey = idOf(it);
      if (seen.has(idKey)) continue;          // 按通知 id 去重
      seen.add(idKey);
      const appId = p.app.id;
      if (!enabled[appId]) continue;          // 应用开关关着：只记住，不弹

      // 同会话 10 秒内合并：只弹第一条，后面的记数不重复打扰
      const ck = chatKeyOf(p);
      const m = merge.get(ck);
      if (m && now - m.start < mergeMs()) {
        m.count += 1;
        stats[appId].merged += 1;
        log('合并：' + p.app.label + ' 同会话窗口内第 ' + m.count + ' 条（不重复弹）');
        continue;
      }
      merge.set(ck, { start: now, count: 1 });

      const evt = toEvent(p, it);
      if (!evt) continue;
      stats[appId].emitted += 1;
      stats[appId].lastAt = now;
      emit(evt);
      emitted += 1;
    }

    // 清理：合并窗口（留 6 倍窗口）与去重集合，防长跑膨胀
    const keep = mergeMs() * 6;
    for (const [k, v] of merge) if (now - v.start > keep) merge.delete(k);
    if (seen.size > SEEN_MAX) seen = new Set(Array.from(seen).slice(-SEEN_MAX / 2));
    return emitted;
  }

  /** 组装状态：每个应用一条独立明细 */
  function buildState(res) {
    const enabled = enabledMap();
    const apps = {};
    for (const a of APPS) {
      const s = stats[a.id];
      const on = enabled[a.id];
      let detail;
      if (!on) detail = '未启用（设置里打开）';
      else if (!res || res.ok === false) detail = '通知中心不可读';
      else if (s.hits > 0) detail = '通知中心 ' + s.hits + ' 条 · 已弹 ' + s.emitted + (s.merged ? ' · 合并 ' + s.merged : '');
      else detail = '通知中心 0 条';
      apps[a.id] = { label: a.label, enabled: on, hits: s.hits, emitted: s.emitted, merged: s.merged, detail };
    }

    if (!res || res.ok === false) {
      const why = (res && res.error) || '未知原因';
      return { ready: false, detail: '通知中心读不到：' + why, apps };
    }
    if (!APPS.some((a) => enabled[a.id])) {
      return { ready: false, detail: '全部应用开关都关着（仍在读通知中心，但不弹任何卡片）', apps };
    }
    const engine = res.engine === 'uia' ? 'UIA' : 'WinRT';
    const hit = APPS.filter((a) => enabled[a.id]).map((a) => a.label + ' ' + stats[a.id].hits).join(' / ');
    const totalEmitted = APPS.reduce((n, a) => n + stats[a.id].emitted, 0);
    return {
      ready: true,
      detail: '运行中（' + engine + '）· 通知中心 ' + (res.count || 0) + ' 条 · ' + hit +
        (totalEmitted ? ' · 已弹 ' + totalEmitted + ' 条' : ''),
      apps,
    };
  }

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    runs += 1;
    let res;
    try {
      res = await Promise.resolve(probeFn({}));
    } catch (err) {
      res = { ok: false, error: '探针异常：' + (err && err.message ? err.message : String(err)) };
    } finally {
      busy = false;
    }
    last = res;
    try { state = buildState(res); } catch (e) { /* 忽略 */ }

    if (res && res.ok) {
      try {
        const n = ingest(res);
        if (n) log('新消息 ' + n + ' 条');
      } catch (e) { log('解析通知失败：' + e.message); }
      try { state = buildState(res); } catch (e) { /* 忽略 */ }
    } else if (runs === 1) {
      log('首轮探测失败：' + (res && res.error));
    }

    // 每轮写一次快照，面板能看到「通知中心里有什么」
    snap('winnotify', {
      ok: !!(res && res.ok),
      engine: res && res.engine,
      access: res && res.access,
      count: (res && res.count) || 0,
      apps: APPS.map((a) => ({
        id: a.id, label: a.label, enabled: enabledMap()[a.id], hits: stats[a.id].hits, emitted: stats[a.id].emitted,
      })),
      items: ((res && res.items) || []).slice(0, 8).map((i) => ({
        app: clean(i.app), title: clip(i.title, 40), creation: i.creation,
      })),
      updatedAt: Date.now(),
    });
  }

  function scheduleNext() {
    if (stopped) return;
    timer = setTimeout(async () => {
      timer = null;
      await tick();
      scheduleNext();
    }, pollMs());
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    name: NAME,
    label: '桌面消息（通知中心）',
    defaults: {
      enabled: false,
      pollMs: DEFAULT_POLL_MS,
      mergeMs: DEFAULT_MERGE_MS,
      apps: Object.assign({}, APP_ENABLED_DEFAULT),
    },

    async start() {
      stopped = false;
      busy = false;
      baselineDone = false;
      seen = new Set();
      merge = new Map();
      stats = emptyStats();
      runs = 0;

      if (process.platform !== 'win32') {
        state = { ready: false, detail: '仅支持 Windows（通知中心读不到，当前 ' + process.platform + '）', apps: {} };
        log(state.detail);
        return { ok: false, detail: state.detail };
      }
      if (!fs.existsSync(PS1)) {
        state = { ready: false, detail: '缺少探针脚本 winnotify_probe.ps1', apps: {} };
        log(state.detail);
        return { ok: false, detail: state.detail };
      }
      state = { ready: false, detail: '首次探测中', apps: {} };
      await tick();               // 立刻探一次，别等 pollMs
      scheduleNext();
      return { ok: state.ready, detail: state.detail };
    },

    async stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      state = Object.assign({}, state, { ready: false, detail: '已停止' });
    },

    status() { return state; },

    async refresh() {
      await tick();
      return { ok: state.ready, detail: state.detail };
    },

    /** 连通性自检：真跑一次 PowerShell，返回各应用命中数与样本 */
    async probe() {
      const res = await probeFn({});
      if (!res || !res.ok) {
        return {
          ok: false,
          detail: '通知中心读不到：' + ((res && res.error) || '未知原因'),
          access: res && res.access,
          engine: res && res.engine,
          count: 0,
          apps: {},
        };
      }
      const enabled = enabledMap();
      const apps = {};
      const unknown = { hits: 0, sample: [] };
      for (const a of APPS) apps[a.id] = { label: a.label, enabled: enabled[a.id], hits: 0, sample: [] };
      for (const it of res.items || []) {
        const p = parseItem(it);
        if (!p) {
          unknown.hits += 1;
          if (unknown.sample.length < 3) unknown.sample.push({ app: clean(it.app), aumid: clean(it.aumid), texts: splitTexts(it) });
          continue;
        }
        const slot = apps[p.app.id];
        slot.hits += 1;
        if (slot.sample.length < 3) {
          slot.sample.push({
            app: clean(it.app), aumid: clean(it.aumid), notificationId: clean(it.id),
            texts: p.texts, chatName: p.chatName, body: clip(p.body, 60), creation: it.creation,
          });
        }
      }
      const parts = APPS.map((a) => a.label + ' ' + apps[a.id].hits).join(' / ');
      return {
        ok: true,
        detail: 'WinRT 可用（access=' + res.access + '），通知中心 ' + (res.count || 0) + ' 条；' + parts +
          (unknown.hits ? '；其它应用 ' + unknown.hits + ' 条' : ''),
        access: res.access,
        engine: res.engine,
        count: res.count || 0,
        apps,
        unknown,
      };
    },
  };
}

module.exports = function create(ctx) {
  return createWithProbe(ctx, (opts) => runProbe({ dataDir: (ctx && ctx.dataDir) || os.tmpdir() }, opts));
};

module.exports._internals = {
  toEvent, parseItem, matchApp, splitTexts, parseProbeJson, clip, clean, idOf, chatKeyOf,
  APPS, APP_ENABLED_DEFAULT,
};
module.exports._createWithProbe = createWithProbe;

/* ---------------------------------------------------------------------
   命令行自检：node app/infohub/sources/winnotify.js --probe
   输出 JSON（真跑 PowerShell 的结果，不做任何美化/伪造）
   --------------------------------------------------------------------- */
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (!argv.includes('--probe')) {
    console.log('用法：node app/infohub/sources/winnotify.js --probe [--engine winrt|uia] [--request-access]');
    process.exitCode = 2;
  } else {
    const engIdx = argv.indexOf('--engine');
    const engine = engIdx >= 0 ? argv[engIdx + 1] : '';
    const ctx = {
      cfg: () => ({ enabled: true }),
      setCfg: () => {},
      emit: (e) => { if (argv.includes('--verbose')) console.log('[emit] ' + JSON.stringify(e).slice(0, 400)); },
      snapshot: () => {},
      log: (m) => { if (argv.includes('--verbose')) console.error('[log] ' + m); },
      dataDir: path.join(os.tmpdir(), 'infohub-winnotify'),
      appDir: path.join(__dirname, '..', '..'),
      paths: { localAppData: process.env.LOCALAPPDATA, home: os.homedir() },
    };
    const inst = createWithProbe(ctx, (opts) => runProbe({ dataDir: ctx.dataDir },
      Object.assign({}, opts, engine ? { engine } : {}, argv.includes('--request-access') ? { requestAccess: true } : {})));
    const t0 = Date.now();
    Promise.resolve()
      .then(() => inst.probe())
      .then((r) => {
        r.elapsedMs = Date.now() - t0;
        r.ps1 = PS1;
        console.log(JSON.stringify(r, null, 2));
        process.exitCode = r.ok ? 0 : 1;
      })
      .catch((e) => {
        console.log(JSON.stringify({ ok: false, detail: '未捕获异常：' + e.message }, null, 2));
        process.exitCode = 1;
      });
  }
}
