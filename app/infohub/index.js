/**
 * app/infohub/index.js — 桌宠「信息中枢」宿主
 *
 * 设计（与 agent-dock.js 同一套哲学）：
 *   收 → 各 source 把外部世界压成"归一化事件"；
 *   归一 → 这里统一去重、排队、限流，只保留最近 N 条；
 *   发 → 主窗弹小卡片（WeFlow 风格），面板窗口读快照。
 *
 * 刻意的边界：
 *   - 所有 source 都可单独失败：require 不到、start 抛错，只影响它自己。
 *   - 默认全部关闭，用户在面板「设置」里逐个打开（加功能不该改变桌宠原有行为）。
 *   - 密钥只在这里（主进程内存）过一遍，不写日志、不进快照、不推给渲染层。
 *
 * @module infohub
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

/* 内置源清单：name → 模块相对路径。缺文件不算错误（子模块可分批到位）。
   注意：QQ/微信的消息只走 winnotify（读 Windows 通知中心，非侵入）。
   早期版本用 NapCat（第三方协议客户端，有账号风险）与单独的 wechat.js，
   两份实现已挪到 sources/optional/ 留档，不再装载。 */
const SOURCE_LIST = [
  ['winnotify', './sources/winnotify.js'],
  ['lark',      './sources/lark.js'],
  ['mail',      './sources/mail.js'],
  ['balance',   './sources/balance.js'],
  ['weather',   './sources/weather.js'],
  ['reminders', './sources/reminders.js'],
  ['calendar',  './sources/calendar.js'],
  ['music',     './music.js'],
  ['clip',      './clipboard.js'],
];

const MAX_NOTES = 50;          // 面板里保留的历史条数
const DEDUPE_MS = 60 * 1000;   // 同 key 60 秒内只弹一次
const MIN_GAP_MS = 900;        // 弹窗最小间隔，防炸屏

const DEFAULTS = {
  enabled: true,
  note: { durationSec: 7, position: 'auto', previewBody: true },
  sources: {},                  // 各源自己的默认值由源自己给
};

function nowMs() { return Date.now(); }

function atomicWrite(file, text) {
  try {
    const tmp = file + '.tmp';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { return false; }
}

function createHub(opts) {
  const o = opts || {};
  const dataDir = o.dataDir;
  const appDir = o.appDir || __dirname;
  const cfgFile = path.join(dataDir, 'infohub.json');
  const log = (m) => { try { console.log('[infohub] ' + m); } catch (e) {} };

  let cfg = JSON.parse(JSON.stringify(DEFAULTS));
  let instances = new Map();     // name → 实例
  let meta = new Map();          // name → { label, defaults }
  const snapshots = Object.create(null);
  const notes = [];              // 最近事件（新的在后）
  const seen = new Map();        // key → ts
  let lastPush = 0;
  let started = false;
  const emitToUi = o.emitToUi || (() => {});       // (channel, payload) → 主窗
  const emitToHub = o.emitToHub || (() => {});     // (channel, payload) → 面板窗

  /* ---------- 配置 ---------- */
  /* 密钥不落明文：pass / *Key / token / cookie / secret 这类字段单独存进 cfg.secrets，
     用 Electron safeStorage（DPAPI）加密；source 拿到的仍是明文（内存里用）。
     加密不可用时退化为明文存储，但日志与 UI 永远看不到值。 */
  const SECRET_FIELD_RE = /^(pass|password|.*key|.*token|cookie|secret)$/i;

  function encSecret(s) {
    try {
      const ss = require('electron').safeStorage;
      if (ss && ss.isEncryptionAvailable()) return { enc: ss.encryptString(String(s)).toString('base64') };
    } catch (e) {}
    return { plain: String(s) };
  }
  function decSecret(o) {
    if (!o) return '';
    if (o.enc) {
      try { return require('electron').safeStorage.decryptString(Buffer.from(String(o.enc), 'base64')); } catch (e) { return ''; }
    }
    return o.plain == null ? '' : String(o.plain);
  }

  function loadCfg() {
    try {
      const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      cfg = Object.assign({}, DEFAULTS, raw || {});
      cfg.note = Object.assign({}, DEFAULTS.note, (raw && raw.note) || {});
      cfg.sources = (raw && raw.sources) || {};
      cfg.secrets = (raw && raw.secrets) || {};
      // 迁移：老配置里可能把密钥明文写在 sources 里，搬到 secrets 并加密
      let migrated = false;
      for (const [name, sc] of Object.entries(cfg.sources)) {
        if (!sc || typeof sc !== 'object') continue;
        for (const k of Object.keys(sc)) {
          if (SECRET_FIELD_RE.test(k) && sc[k]) {
            cfg.secrets[name] = cfg.secrets[name] || {};
            cfg.secrets[name][k] = encSecret(sc[k]);
            delete sc[k];
            migrated = true;
          }
        }
      }
      if (migrated) saveCfg();
    } catch (e) { cfg = JSON.parse(JSON.stringify(DEFAULTS)); cfg.secrets = {}; }
    return cfg;
  }
  function saveCfg() { atomicWrite(cfgFile, JSON.stringify(cfg, null, 2)); }
  function srcCfg(name) {
    const base = Object.assign({}, (meta.get(name) || {}).defaults || {});
    const plain = Object.assign(base, cfg.sources[name] || {});
    const sec = (cfg.secrets && cfg.secrets[name]) || {};
    for (const k of Object.keys(sec)) plain[k] = decSecret(sec[k]);
    return plain;
  }
  function setSrcCfg(name, patch) {
    cfg.sources[name] = cfg.sources[name] || {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (SECRET_FIELD_RE.test(k)) {
        if (v === '' || v == null) continue;                 // 留空 = 不改
        cfg.secrets = cfg.secrets || {};
        cfg.secrets[name] = cfg.secrets[name] || {};
        cfg.secrets[name][k] = encSecret(v);
      } else {
        cfg.sources[name][k] = v;
      }
    }
    saveCfg();
    const inst = instances.get(name);
    if (inst && typeof inst.onCfg === 'function') {
      try { inst.onCfg(srcCfg(name)); } catch (e) { log(name + ' onCfg 失败: ' + e.message); }
    }
  }

  /* ---------- 事件归一 ---------- */
  function normalize(evt) {
    if (!evt || typeof evt !== 'object') return null;
    const v = {
      source: String(evt.source || 'unknown'),
      kind: String(evt.kind || 'info'),
      level: ['info', 'warn', 'alert'].includes(evt.level) ? evt.level : 'info',
      title: String(evt.title == null ? '' : evt.title).slice(0, 80),
      body: String(evt.body == null ? '' : evt.body).slice(0, 200),
      ts: Number(evt.ts) || nowMs(),
      key: String(evt.key || ''),
      actions: Array.isArray(evt.actions) ? evt.actions.slice(0, 2).map((a) => ({
        id: String(a && a.id || ''),
        label: String(a && a.label || ''),
        kind: String(a && a.kind || 'copy'),
        payload: a && a.payload != null ? String(a.payload).slice(0, 500) : '',
      })) : [],
      data: (evt.data && typeof evt.data === 'object') ? evt.data : {},
    };
    if (!v.title && !v.body) return null;
    return v;
  }

  function pushNote(v) {
    if (cfg.enabled === false) return;                // 总开关关掉：不弹、不记录
    const t = nowMs();
    const key = v.key || (v.source + ':' + v.kind + ':' + v.title + ':' + v.body);
    const last = seen.get(key);
    if (last && t - last < DEDUPE_MS) return;          // 去重
    seen.set(key, t);
    if (seen.size > 400) {                              // 清理过期 key
      for (const [k, ts] of seen) if (t - ts > DEDUPE_MS * 4) seen.delete(k);
    }
    const gap = t - lastPush;
    if (gap < MIN_GAP_MS) {
      // 太密就排队：延后到间隔后再给界面，避免一串卡片同时飞出
      setTimeout(() => pushNote(v), MIN_GAP_MS - gap + 30);
      return;
    }
    lastPush = t;
    v.id = v.key = key + ':' + t;
    notes.push(v);
    while (notes.length > MAX_NOTES) notes.shift();
    emitToUi('infohub:note', v);
    emitToHub('infohub:note', v);
  }

  function setSnapshot(kind, data) {
    snapshots[kind] = { data, ts: nowMs() };
    emitToHub('infohub:snapshot', { kind, data, ts: snapshots[kind].ts });
    emitToUi('infohub:snapshot', { kind, data, ts: snapshots[kind].ts });
  }

  function makeCtx(name) {
    return {
      cfg: () => srcCfg(name),
      setCfg: (patch) => setSrcCfg(name, patch),
      emit: (evt) => { const v = normalize(Object.assign({ source: name }, evt || {})); if (v) pushNote(v); },
      snapshot: (kind, data) => setSnapshot(kind || name, data),
      log: (m) => log(name + ' ' + m),
      dataDir,
      appDir,
      paths: {
        localAppData: process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
        home: process.env.USERPROFILE || '',
        hermesHome: path.join(process.env.LOCALAPPDATA || '', 'hermes'),
      },
    };
  }

  /* ---------- 源装载 ---------- */
  function loadSources() {
    for (const [name, rel] of SOURCE_LIST) {
      let factory = null;
      try {
        factory = require(path.join(__dirname, rel));
      } catch (e) {
        log(name + ' 模块未就绪: ' + e.message);
        continue;
      }
      try {
        const inst = factory(makeCtx(name));
        if (!inst || !inst.name) throw new Error('工厂没有返回实例');
        meta.set(name, { label: inst.label || name, defaults: inst.defaults || {} });
        instances.set(name, inst);
      } catch (e) {
        log(name + ' 初始化失败: ' + e.message);
      }
    }
    log('已装载源: ' + [...instances.keys()].join(', '));
  }

  async function startOne(name) {
    const inst = instances.get(name);
    if (!inst) return;
    const c = srcCfg(name);
    if (c.enabled === false) { try { await inst.stop(); } catch (e) {} return; }
    try { await inst.start(); } catch (e) { log(name + ' start 失败: ' + e.message); }
  }

  async function start() {
    if (started) return;
    started = true;
    loadCfg();
    loadSources();
    if (cfg.enabled === false) {                        // 总开关关着：装载但不启动
      log('信息中枢处于关闭状态（%APPDATA%\\桌宠\\infohub.json 里 enabled=false）');
      return;
    }
    for (const name of instances.keys()) await startOne(name);
  }

  async function stop() {
    for (const inst of instances.values()) { try { await inst.stop(); } catch (e) {} }
    started = false;
  }

  /** 总开关：关掉时停掉所有源（不再占用 PowerShell / 网络 / 剪贴板轮询），
      打开时把用户逐个开过的源重新起起来。弹窗与面板都由这里决定生不生效。 */
  async function setEnabled(on) {
    const want = !!on;
    if (cfg.enabled === want && started) return { ok: true, enabled: want };
    cfg.enabled = want;
    saveCfg();
    if (!want) {
      await stop();
      log('信息中枢已关闭：所有来源停止，弹窗不再出现');
    } else {
      if (!instances.size) { loadSources(); }
      started = true;
      for (const name of instances.keys()) await startOne(name);
      log('信息中枢已开启：' + instances.size + ' 个源就绪');
    }
    emitToUi('infohub:enabled', { enabled: want, state: getState() });
    emitToHub('infohub:enabled', { enabled: want, state: getState() });
    return { ok: true, enabled: want, state: getState() };
  }

  /* ---------- 对外状态 ---------- */
  const SECRET_KEY_RE = /(pass(word)?|secret|token|cookie|apikey|api_key|^key$|key$)/i;
  function sanitize(v) {
    if (Array.isArray(v)) return v.map(sanitize);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (SECRET_KEY_RE.test(k) && (typeof val === 'string' || typeof val === 'number')) {
          out['has' + k.charAt(0).toUpperCase() + k.slice(1)] = !!val;
        } else out[k] = sanitize(val);
      }
      return out;
    }
    return v;
  }

  function getState() {
    const sources = [];
    for (const [name, inst] of instances) {
      let st = { ready: false, detail: '未启动' };
      try { st = inst.status() || st; } catch (e) { st = { ready: false, detail: '状态异常' }; }
      // 只给渲染层"非密钥配置 + hasXxx 标志"，明文永远不出主进程
      const shown = sanitize(Object.assign({}, (meta.get(name) || {}).defaults || {}, cfg.sources[name] || {}));
      const sec = (cfg.secrets && cfg.secrets[name]) || {};
      for (const k of Object.keys(sec)) shown['has' + k.charAt(0).toUpperCase() + k.slice(1)] = !!decSecret(sec[k]);
      sources.push({
        name,
        label: (meta.get(name) || {}).label || name,
        enabled: srcCfg(name).enabled !== false,
        ready: !!st.ready,
        detail: String(st.detail || ''),
        cfg: shown,
      });
    }
    return { enabled: cfg.enabled !== false, note: cfg.note, sources, notes: notes.slice(-MAX_NOTES) };
  }

  function getSnapshots() { return snapshots; }

  /* ---------- 面板动作 ---------- */
  async function doAction(action, arg) {
    const a = String(action || '');
    const inst = (name) => instances.get(name);
    try {
      if (a === 'refresh') {
        const list = arg && arg.name ? [arg.name] : [...instances.keys()];
        for (const n of list) {
          const i = instances.get(n);
          if (i && typeof i.refresh === 'function') await i.refresh();
        }
        return { ok: true };
      }
      if (a === 'setSource') { setSrcCfg(arg.name, arg.patch || {}); await startOne(arg.name); return { ok: true, state: getState() }; }
      if (a === 'tick') {                                   // 用户手动触发某个源的"现在试试"
        const i = inst(arg && arg.name);
        if (i && typeof i.refresh === 'function') { const r = await i.refresh(); return { ok: true, result: r }; }
        return { ok: false, error: '该模块不支持手动触发' };
      }
      if (a === 'setNote') {
        cfg.note = Object.assign({}, cfg.note, arg || {});
        saveCfg(); return { ok: true, note: cfg.note };
      }
      /* 待办 / 专注 / 喝水 */
      const rem = inst('reminders');
      if (rem) {
        if (a === 'todoAdd' && rem.addTodo) return { ok: true, state: await rem.addTodo(arg || {}) };
        if (a === 'todoRemove' && rem.removeTodo) return { ok: true, state: await rem.removeTodo(arg && arg.id) };
        if (a === 'todoToggle' && rem.toggleTodo) return { ok: true, state: await rem.toggleTodo(arg && arg.id) };
        if (a === 'focusStart' && rem.focusStart) return { ok: true, state: await rem.focusStart(arg && arg.minutes) };
        if (a === 'focusStop' && rem.focusStop) return { ok: true, state: await rem.focusStop() };
        if (a === 'waterAdd' && rem.waterAdd) return { ok: true, state: await rem.waterAdd(arg && arg.ml) };
        if (a === 'waterUndo' && rem.waterUndo) return { ok: true, state: await rem.waterUndo() };
        if (a === 'remindersState' && rem.getState) return { ok: true, state: await rem.getState() };
      }
      /* 剪贴板 */
      const clip = inst('clip');
      if (clip) {
        if (a === 'clipList') return { ok: true, list: clip.list() };
        if (a === 'clipCopy') return { ok: true, result: await clip.copyToClipboard(arg && arg.id) };
        if (a === 'clipPin') return { ok: true, list: clip.pin(arg && arg.id, !!(arg && arg.on)) };
        if (a === 'clipRemove') return { ok: true, list: clip.remove(arg && arg.id) };
        if (a === 'clipClear') return { ok: true, list: clip.clear() };
      }
      /* 音乐 */
      const music = inst('music');
      if (music && a.startsWith('music')) {
        if (a === 'musicState') return { ok: true, state: await music.state() };
        if (a === 'musicControl') return { ok: true, result: await music.control(arg && arg.verb, arg || {}) };
      }
      /* 把某个聊天软件的前台窗口调出来（弹窗上"打开"按钮用） */
      if (a === 'openApp') {
        const target = String((arg && arg.target) || '').toLowerCase();
        // 没有独立客户端的（邮件/日历）直接开信息中枢对应页签
        if (target === 'mail' || target === 'calendar') {
          if (typeof o.openHub === 'function') { try { o.openHub(target === 'mail' ? 'mail' : 'calendar'); } catch (e) {} }
          return { ok: true, detail: '已打开信息中枢' };
        }
        // 进程名候选：微信 4.x 是 Weixin.exe、3.x 是 WeChat.exe；企微是 WXWork.exe
        const map = {
          qq: ['QQ'],
          wechat: ['Weixin', 'WeChat'], wx: ['Weixin', 'WeChat'],
          feishu: ['Feishu'], lark: ['Lark', 'Feishu'],
          dingtalk: ['DingTalk'], wecom: ['WXWork'], wework: ['WXWork'],
        };
        const procs = map[target] || [target];
        let out = 'not-running';
        for (const proc of procs) {
          const r = require('node:child_process').spawnSync('powershell',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'activate.ps1'), '-Name', proc],
            { timeout: 8000, encoding: 'utf8', windowsHide: true });
          out = String((r && r.stdout) || '').trim();
          if (out === 'ok') break;
        }
        return { ok: out === 'ok', detail: out || '未启动或没有窗口' };
      }
      /* 自检：弹一条示例卡片，方便用户确认弹窗链路通不通 */
      if (a === 'testNote') {
        pushNote({
          source: 'winnotify', kind: 'message', level: 'warn',
          title: '这是测试卡片 · 张三', body: '弹窗链路正常，鼠标移上来才能点按钮',
          ts: nowMs(), key: 'test:' + nowMs(),
          actions: [{ id: 'copy', label: '复制', kind: 'copy', payload: '弹窗链路正常' },
                    { id: 'open', label: '打开QQ', kind: 'app', payload: 'qq' }],
        });
        return { ok: true };
      }
      return { ok: false, error: '未知动作: ' + a };
    } catch (e) {
      log('动作 ' + a + ' 失败: ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  /* 弹窗上的按钮点击（copy / app / dismiss） */
  async function noteAction(noteId, actionId) {
    const n = notes.find((x) => x.id === noteId || x.key === noteId);
    if (!n) return { ok: false, error: '事件已过期' };
    const act = (n.actions || []).find((x) => x.id === actionId);
    if (!act) return { ok: false, error: '动作不存在' };
    if (act.kind === 'copy') {
      try { require('electron').clipboard.writeText(act.payload || ''); return { ok: true, copied: true }; }
      catch (e) { return { ok: false, error: e.message }; }
    }
    if (act.kind === 'open' || act.kind === 'app') {
      return await doAction('openApp', { target: act.payload });
    }
    if (act.kind === 'url') {
      try { require('electron').shell.openExternal(act.payload || ''); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
    }
    return { ok: false, error: '未实现的动作类型' };
  }

  return {
    start, stop, getState, getSnapshots, doAction, noteAction, setEnabled,
    setSrcCfg, saveCfg,
    get cfg() { return cfg; },
    _instances: instances,
  };
}

module.exports = { createHub, SOURCE_LIST };
