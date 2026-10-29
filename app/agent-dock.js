/**
 * agent-dock.js — 桌宠的「Agent 看板」中枢（纯 Node，无第三方依赖）
 *
 * 目标：让猫鲸桌宠像实体小屏一样跟随本机正在跑的 AI Agent。
 *   ① 收：本地 HTTP（默认 127.0.0.1:8770）收各 Agent 的状态推送；
 *   ② 采：对没有 hook 的 Agent，按会话日志（jsonl）活跃度推断状态；
 *   ③ 归一：所有来源压成同一套状态词（idle/working/speaking/waiting_user/done/error/sleeping）；
 *   ④ 发：变更时把快照推给渲染层（主进程转 IPC），由页面演动作 + 显示气泡。
 *
 * 设计边界（刻意的）：
 *   - 只绑 127.0.0.1，不开放局域网；不执行任何 Agent 的命令、不读凭据、不写对方目录。
 *   - 日志适配器只读文件尾部 96KB 做摘要，不解析完整会话、不落盘用户内容。
 *   - 状态是"推断"，不确定就退到 done/离开列表，不假装知道得更细。
 *
 * 状态词统一后，页面只需认 7 个值：
 *   working（干活）/ speaking（说话或流式输出中）/ waiting_user（等确认）/
 *   done（刚结束，留 keepDoneMs）/ error（出错）/ idle（在但闲着）/ sleeping（会话关了）
 *
 * @module agent-dock
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const STATES = ['idle', 'working', 'speaking', 'waiting_user', 'done', 'error', 'sleeping'];
const STATE_RANK = { waiting_user: 6, error: 5, working: 4, speaking: 3, done: 2, idle: 1, sleeping: 0 };

/* 事件名 → 状态。三套命名都收：Hermes hook 事件、Claude Code hook 事件、Copilot/小写变体。 */
const EVENT_STATE = {
  /* Hermes（agent/outbound_webhooks.py 的 VALID_HOOKS 子集） */
  pre_llm_call: 'working', post_llm_call: 'working',
  pre_api_request: 'working', post_api_request: 'working', api_request_error: 'error',
  on_stream_start: 'speaking', on_stream_delta: 'speaking', on_stream_end: 'working',
  pre_tool_call: 'working', post_tool_call: 'working',
  pre_approval_request: 'waiting_user', post_approval_response: 'working',
  on_human_input_request: 'waiting_user', on_human_input_resolved: 'working',
  subagent_start: 'working', subagent_stop: 'working',
  on_session_start: 'idle', on_session_end: 'done', on_session_finalize: 'done',
  on_session_reset: 'idle', agent_loop_stopped: 'done',
  /* Claude Code / Codex hook 风格 */
  SessionStart: 'idle', SessionEnd: 'sleeping', UserPromptSubmit: 'working',
  PreToolUse: 'working', PostToolUse: 'working', PostToolUseFailure: 'error',
  AssistantMessage: 'speaking', AssistantOutput: 'speaking',
  Stop: 'done', StopFailure: 'error', PermissionRequest: 'waiting_user',
  Notification: 'waiting_user', Elicitation: 'waiting_user',
  SubagentStart: 'working', SubagentStop: 'working',
  PreCompact: 'working', PostCompact: 'working',
  /* Copilot / 小写变体 */
  sessionStart: 'idle', sessionEnd: 'sleeping', userPromptSubmitted: 'working',
  preToolUse: 'working', postToolUse: 'working', errorOccurred: 'error',
  agentStop: 'done', subagentStart: 'working', subagentStop: 'working', preCompact: 'working',
};

/* 别的项目（HachimoDock / Clawd）用的形象词 → 我们的状态词 */
const ALIAS_STATE = {
  attention: 'done', juggling: 'working', sweeping: 'working', carrying: 'working',
  notification: 'waiting_user', tool_running: 'working', thinking: 'working',
  typing: 'speaking', talking: 'speaking', finished: 'done', failed: 'error',
  busy: 'working', ready: 'idle', offline: 'sleeping',
};

const AGENT_DEFS = [
  { id: 'hermes', name: 'Hermes', kind: 'push', accent: '#5b9dff' },
  { id: 'codex', name: 'ChatGPT Codex', kind: 'log', accent: '#10a37f' },
  { id: 'claude-code', name: 'Claude Code', kind: 'log', accent: '#d97757' },
  { id: 'openclaw', name: 'OpenClaw', kind: 'push', accent: '#8b5cf6' },
  { id: 'mimocode', name: 'MiMoCode', kind: 'cli', accent: '#f59e0b' },
  { id: 'workbuddy', name: 'WorkBuddy', kind: 'push', accent: '#0ea5e9' },
  { id: 'dsh', name: 'DeepSeek Harness', kind: 'native', accent: '#4d6bfe' },
  { id: 'generic', name: '其它 Agent', kind: 'push', accent: '#94a3b8' },
];
const AGENT_BY_ID = new Map(AGENT_DEFS.map((a) => [a.id, a]));

const DEFAULTS = {
  port: 8770,
  host: '127.0.0.1',
  keepDoneMs: 60_000,      // done/error 在列表里停留多久
  staleWorkingMs: 150_000, // working 这么久没新推送 → 视为失联，收起
  staleWaitingMs: 600_000, // waiting_user 一直没有结果（Agent 已死没发事件）→ 10 分钟后收起，别永远挂着
  sleepingMs: 20_000,
  pollMs: 2000,            // 日志轮询
  logActiveMs: 10_000,     // 日志 10 秒内有写入 = 正在干活
  logLiveMs: 120_000,      // 120 秒内有过写入 = 刚结束（显示 done）
  maxBodyBytes: 64 * 1024,
  probeTtlMs: 20_000,
};

/* ============================ 小工具 ============================ */

function clampText(v, n) {
  if (typeof v !== 'string') return '';
  const s = v.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function normalizeState(value) {
  if (typeof value !== 'string') return '';
  const s = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return '';
  if (STATES.includes(s)) return s;
  if (ALIAS_STATE[s]) return ALIAS_STATE[s];
  return '';
}

function stateFromEvent(event) {
  if (typeof event !== 'string' || !event) return '';
  return EVENT_STATE[event] || EVENT_STATE[event.trim()] || '';
}

function normalizeAgentId(value) {
  if (typeof value !== 'string') return '';
  const s = value.trim().toLowerCase();
  if (!s) return '';
  if (AGENT_BY_ID.has(s)) return s;
  /* 常见写法归一 */
  if (s === 'claude' || s === 'claudecode' || s === 'claude_code') return 'claude-code';
  if (s === 'chatgpt' || s === 'openai-codex' || s === 'codex-cli') return 'codex';
  if (s === 'clawd' || s === 'open-claw') return 'openclaw';
  if (s === 'mimo' || s === 'mimo-code') return 'mimocode';
  if (s === 'deepseek-harness' || s === 'deepseekharness' || s === 'harness') return 'dsh';
  if (/^[a-z0-9._-]{1,32}$/.test(s)) return s;   // 允许自定义 id（走 generic 显示）
  return 'generic';
}

function agentMeta(id) {
  return AGENT_BY_ID.get(id) || { id, name: id === 'generic' ? '其它 Agent' : id, kind: 'push', accent: '#94a3b8' };
}

/* ============================ 通道探测 ============================ */

function existsDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function existsFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function appDataDir(env = process.env) {
  return env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}
function localAppDataDir(env = process.env) {
  return env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

/** 每个通道的默认探测：返回 {available, detail, paths} —— 只做存在性检查，不跑对方命令。 */
function defaultProbes(cfg, env = process.env) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return {
    hermes() {
      const conf = path.join(localAppDataDir(env), 'hermes', 'config.yaml');
      if (!existsFile(conf)) return { available: false, detail: '没找到 Hermes 配置（%LOCALAPPDATA%\\hermes\\config.yaml）' };
      let txt = '';
      try { txt = fs.readFileSync(conf, 'utf8').slice(0, 400_000); } catch { /* 读不到就当没配 */ }
      const wired = /hooks\s*:\s*[\s\S]{0,2000}outbound/.test(txt) && txt.includes(String(cfg.port));
      return {
        available: true,
        wired,
        detail: wired ? 'hooks.outbound 已指向本机端口' : '未接 hooks.outbound（见 tools/dock-install-hermes-hooks.js）',
        paths: [conf],
      };
    },
    codex() {
      const dir = path.join(home, '.codex', 'sessions');
      return existsDir(dir)
        ? { available: true, detail: '按会话日志跟随', paths: [dir] }
        : { available: false, detail: '没有 %USERPROFILE%\\.codex\\sessions' };
    },
    'claude-code'() {
      const dir = path.join(home, '.claude', 'projects');
      return existsDir(dir)
        ? { available: true, detail: '按会话日志跟随', paths: [dir] }
        : { available: false, detail: '没有 %USERPROFILE%\\.claude\\projects' };
    },
    openclaw() {
      const dir = env.OPENCLAW_HOME || path.join(home, '.openclaw');
      return existsDir(dir)
        ? { available: true, detail: '目录已找到；状态需从它的网关/插件推送（POST /state）', paths: [dir] }
        : { available: false, detail: '没找到 OpenClaw 安装（可用 POST /state 推送）' };
    },
    mimocode() {
      const bin = [path.join(home, '.mimocode', 'bin', 'mimo.exe'), path.join(home, '.mimocode', 'bin', 'mimo')]
        .find(existsFile);
      return bin
        ? { available: true, detail: '已找到 mimo 可执行文件；状态需由插件推送', paths: [bin] }
        : { available: false, detail: '没找到 ~/.mimocode/bin/mimo（可用 POST /state 推送）' };
    },
    workbuddy() {
      const cands = [
        path.join(appDataDir(env), 'WorkBuddy'),
        path.join(localAppDataDir(env), 'Programs', 'WorkBuddy'),
        path.join(home, '.workbuddy'),
      ];
      const hit = cands.find(existsDir);
      return hit
        ? { available: true, detail: '目录已找到；状态需由它的 hook 推送', paths: [hit] }
        : { available: false, detail: '没找到 WorkBuddy（可用 POST /state 推送）' };
    },
    dsh() {
      const cands = [
        cfg.harnessRepo,
        path.join(home, 'Documents', 'deepseek-harness'),
        path.join(home, 'deepseek-harness'),
      ].filter(Boolean);
      const hit = cands.find((p) => existsDir(p) && existsDir(path.join(p, 'packages')));
      return hit
        ? { available: true, detail: '桌宠内置通道（聊天时实时上报）', paths: [hit] }
        : { available: false, detail: '没找到 harness 仓库（托盘设置里指定后可用）' };
    },
    generic() { return { available: true, detail: '通用推送通道：任何程序 POST /state 即可' }; },
  };
}

/* ============================ 日志摘要 ============================ */

/** 只读尾部：避免为了看一眼状态把几百 MB 的会话全读进内存 */
function readTail(file, bytes) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    const len = Math.min(bytes, st.size);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * 从若干条会话记录里提出「最后一句用户话 / 最后一句 Agent 话 / 最后一条记录类型」。
 * 兼容三种写法：Claude Code（type+message）、Codex rollout（type+payload）、通用 {role,content}。
 */
function summarizeRecords(text) {
  const out = { lastUser: '', lastAgent: '', lastTool: '', lastType: '', sawError: false };
  const lines = text.split('\n');
  for (const line of lines) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let rec;
    try { rec = JSON.parse(s); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    const p = rec.payload && typeof rec.payload === 'object' ? rec.payload : null;
    const msg = rec.message && typeof rec.message === 'object' ? rec.message : null;
    const type = String(rec.type || (p && p.type) || '');
    if (type) out.lastType = type;
    if (type === 'error' || rec.error || p && p.ok === false) out.sawError = true;

    const role = msg?.role || p?.role || rec.role || '';
    let text2 = '';
    const content = (msg && msg.content) || (p && p.content) || rec.content;
    if (typeof content === 'string') text2 = content;
    else if (Array.isArray(content)) {
      text2 = content.map((c) => (c && (c.text || c.input_text || c.output_text)) || '').join(' ').trim();
    }
    if (!text2 && typeof p?.message === 'string') text2 = p.message;

    const toolName = (p && p.name) || rec.tool_name || '';
    if (toolName && typeof toolName === 'string') out.lastTool = toolName;

    if (role === 'user' && text2) out.lastUser = clampText(text2, 300);
    else if ((role === 'assistant' || role === 'agent') && text2) out.lastAgent = clampText(text2, 400);
    else if (type === 'event_msg' && p) {
      if (p.type === 'user_message' && p.message) out.lastUser = clampText(String(p.message), 300);
      if (p.type === 'agent_message' && p.message) out.lastAgent = clampText(String(p.message), 400);
    }
  }
  return out;
}

/** 递归收集 .jsonl（限深度/条数，按 mtime 倒序） */
function listJsonl(root, { maxDepth = 6, maxFiles = 400 } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length > maxFiles) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { const st = fs.statSync(p); out.push({ file: p, mtimeMs: st.mtimeMs, size: st.size }); } catch { /* skip */ }
        if (out.length > maxFiles) return;
      }
    }
  };
  walk(root, 0);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/* ============================ 主体 ============================ */

class AgentDock extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} [opts.port]         HTTP 端口；0 = 随机（测试用）
   * @param {string} [opts.host]         默认 127.0.0.1
   * @param {string} [opts.harnessRepo]  供 dsh 通道探测
   * @param {(line:string)=>void} [opts.log]
   * @param {object} [opts.env]          测试注入
   */
  constructor(opts = {}) {
    super();
    this.cfg = Object.assign({}, DEFAULTS, opts.cfg || {}, opts);
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    this.env = opts.env || process.env;
    this.sessions = new Map();      // key: agent::sessionId
    this.selected = null;           // 当前选中的 agent id
    this.pinned = null;             // 钉住的会话 key
    this.channels = new Map();      // agent id -> {available, wired, detail, checkedAt}
    this.counters = { received: 0, dropped: 0, parseErrors: 0 };
    this.startedAt = Date.now();
    this.server = null;
    this.timer = null;
    this.lastEmit = 0;
    this.emitQueued = false;
    this._probes = defaultProbes(this.cfg, this.env);
  }

  /* ---------------- 生命周期 ---------------- */

  async start() {
    if (this.server) return this.info();
    await new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => this._handle(req, res));
      srv.on('error', reject);
      srv.listen(this.cfg.port, this.cfg.host, () => {
        this.server = srv;
        this.cfg.port = srv.address().port;
        resolve();
      });
    });
    this.refreshChannels();
    this.timer = setInterval(() => this._tick(), this.cfg.pollMs);
    if (this.timer.unref) this.timer.unref();
    this.log(`[dock] listening on http://${this.cfg.host}:${this.cfg.port}`);
    return this.info();
  }

  async stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise((r) => srv.close(r));
    }
  }

  info() {
    return { ok: !!this.server, host: this.cfg.host, port: this.cfg.port, startedAt: this.startedAt };
  }

  /* ---------------- HTTP ---------------- */

  _handle(req, res) {
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    };
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && (url === '/health' || url === '/')) return send(200, { ok: true, app: 'catwhale-agent-dock', ...this.info() });
    if (req.method === 'GET' && url === '/api') return send(200, this.snapshot());
    if (req.method === 'POST' && url === '/state') {
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > this.cfg.maxBodyBytes) {
          tooBig = true;
          /* 已经收满还继续发的，直接断开；只超一点点的读完再回 413（否则响应发不出去） */
          if (size > this.cfg.maxBodyBytes * 4) { this.counters.dropped++; req.destroy(); }
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) {
          this.counters.dropped++;
          try { send(413, { ok: false, error: 'body too large' }); } catch { /* 连接已断 */ }
          return;
        }
        let payload;
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
        catch (e) { this.counters.parseErrors++; return send(400, { ok: false, error: 'invalid json' }); }
        const r = this.ingest(payload, { headers: req.headers });
        send(r.ok ? 200 : 400, r);
      });
      return;
    }
    return send(404, { ok: false, error: 'not found' });
  }

  /* ---------------- 收：状态推送 ---------------- */

  /**
   * 接受多种 payload 形状：
   *   Hermes:      {hook_event_name, session_id, cwd, tool_name, profile, ...}
   *   Claude hook: {hook_event_name | event, session_id, ...}（同 Hermes）
   *   通用/其它:   {agent|agent_id, state, session_id, title, prompt, last_assistant_message}
   */
  ingest(raw, meta = {}) {
    this.counters.received++;
    if (!raw || typeof raw !== 'object') {
      this.counters.dropped++;
      return { ok: false, error: 'payload must be an object' };
    }
    const headers = meta.headers || {};
    const event = String(raw.event || raw.hook_event_name || raw.hookName || '').trim();
    let agent = normalizeAgentId(raw.agent || raw.agent_id || raw.source || headers['x-agent'] || '');
    if (!agent) agent = event && (raw.profile || raw.hook_event_name) ? 'hermes' : 'generic';

    const claudeLikeState = normalizeState(raw.state);
    const state = claudeLikeState || stateFromEvent(event) || normalizeState(raw.status) || 'working';

    const sessionId = clampText(String(raw.session_id || raw.sessionId || raw.session || 'default'), 120) || 'default';
    const key = `${agent}::${sessionId}`;
    const now = Date.now();
    const prev = this.sessions.get(key) || {};

    const title = clampText(
      raw.session_title || raw.title || prev.title || raw.name || '',
      48,
    );
    const session = {
      key,
      agent,
      agentName: agentMeta(agent).name,
      accent: agentMeta(agent).accent,
      sessionId,
      state,
      event: event || prev.event || '',
      title: title || (raw.cwd ? path.basename(String(raw.cwd)) : '') || sessionId.slice(0, 12),
      cwd: clampText(String(raw.cwd || prev.cwd || ''), 200),
      tool: clampText(String(raw.tool_name || raw.tool || prev.tool || ''), 40),
      lastUser: clampText(String(raw.prompt || raw.last_user_message || prev.lastUser || ''), 300),
      lastAgent: clampText(String(raw.last_assistant_message || raw.message || raw.text || prev.lastAgent || ''), 400),
      source: 'push',
      firstSeenAt: prev.firstSeenAt || now,
      updatedAt: now,
      stateSince: prev.state === state ? (prev.stateSince || now) : now,
    };
    this.sessions.set(key, session);
    this._emit();
    return { ok: true, session: { key, agent, state, sessionId }, port: this.cfg.port };
  }

  /** DeepSeek Harness 通道：由主进程把 harness 的 status/event 直接喂进来 */
  feedHarness(kind, payload = {}) {
    const now = Date.now();
    const key = 'dsh::live';
    const prev = this.sessions.get(key) || { firstSeenAt: now };
    if (kind === 'status') {
      const st = String(payload.state || '').toLowerCase();
      if (!st || st === 'stopped' || st === 'dead') {
        if (prev.state && prev.state !== 'done') {
          this.sessions.set(key, { ...prev, agent: 'dsh', agentName: agentMeta('dsh').name, accent: agentMeta('dsh').accent,
            key, sessionId: 'live', state: 'done', event: 'status', source: 'native', updatedAt: now,
            stateSince: now, lastAgent: prev.lastAgent || '', lastUser: prev.lastUser || '', cwd: prev.cwd || '',
            title: prev.title || '桌宠对话', tool: '' });
          this._emit();
        }
        return;
      }
      const mapped = st === 'busy' || st === 'working' || st === 'starting' ? 'working' : 'idle';
      this.sessions.set(key, { ...prev, key, agent: 'dsh', agentName: agentMeta('dsh').name, accent: agentMeta('dsh').accent,
        sessionId: 'live', state: mapped, event: 'harness:' + st, source: 'native', updatedAt: now,
        stateSince: prev.state === mapped ? (prev.stateSince || now) : now,
        title: prev.title || '桌宠对话', lastUser: prev.lastUser || '', lastAgent: prev.lastAgent || '',
        cwd: prev.cwd || '', tool: '' });
      this._emit();
      return;
    }
    /* kind === 'event'：delta / tool / turnEnd / message / error */
    const k = String(payload.kind || '');
    const patch = { updatedAt: now };
    let state = prev.state || 'working';
    let event = prev.event || '';
    if (k === 'delta') { state = 'speaking'; event = 'stream'; patch.lastAgent = clampText(String(payload.text || '').slice(-400), 400); }
    else if (k === 'message') { state = 'speaking'; event = 'message'; patch.lastAgent = clampText(String(payload.text || '').slice(-400), 400); }
    else if (k === 'tool') { state = 'working'; event = 'tool'; patch.tool = clampText(String(payload.name || ''), 40); }
    else if (k === 'turnEnd') {
      const reason = payload.reason || {};
      state = reason && reason.kind === 'error' ? 'error' : 'done';
      event = 'turnEnd'; patch.tool = '';
    } else if (k === 'error') { state = 'error'; event = 'error'; }
    else return;
    this.sessions.set(key, { ...prev, ...patch, key, agent: 'dsh', agentName: agentMeta('dsh').name,
      accent: agentMeta('dsh').accent, sessionId: 'live', state, event, source: 'native',
      stateSince: prev.state === state ? (prev.stateSince || now) : now,
      title: prev.title || '桌宠对话', lastUser: prev.lastUser || '', lastAgent: (patch.lastAgent ?? prev.lastAgent) ?? '',
      cwd: prev.cwd || '', tool: (patch.tool ?? prev.tool) ?? '' });
    this._emit();
  }

  /* ---------------- 采：日志适配器 ---------------- */

  _tick() {
    const now = Date.now();
    this._expire(now);
    this._scanLogs(now);
    this.refreshChannels(false);
    this._emit(true);
  }

  _expire(now) {
    for (const [key, s] of this.sessions) {
      if (s.source === 'push' || s.source === 'native') {
        if ((s.state === 'done' || s.state === 'error') && now - s.updatedAt > this.cfg.keepDoneMs) this.sessions.delete(key);
        else if (s.state === 'sleeping' && now - s.updatedAt > this.cfg.sleepingMs) this.sessions.delete(key);
        else if (s.state === 'working' && now - s.updatedAt > this.cfg.staleWorkingMs) this.sessions.delete(key);
        else if (s.state === 'waiting_user' && now - s.updatedAt > this.cfg.staleWaitingMs) this.sessions.delete(key);
      } else if (s.source === 'log') {
        if (now - s.updatedAt > this.cfg.logLiveMs + 60_000) this.sessions.delete(key);
      }
    }
  }

  _scanLogs(now) {
    const pick = { codex: this.cfg.codexRoot, 'claude-code': this.cfg.claudeRoot };
    const home = this.env.USERPROFILE || this.env.HOME || os.homedir();
    if (!pick.codex) pick.codex = path.join(home, '.codex', 'sessions');
    if (!pick['claude-code']) pick['claude-code'] = path.join(home, '.claude', 'projects');

    for (const agent of Object.keys(pick)) {
      const ch = this.channels.get(agent);
      if (ch && ch.available === false) continue;         // 没装就不扫
      if (this.disabledAgents && this.disabledAgents.has(agent)) continue;
      const root = pick[agent];
      const files = listJsonl(root, { maxFiles: 60 }).slice(0, 3);
      const touched = new Set();
      for (const f of files) {
        const age = now - f.mtimeMs;
        if (age > this.cfg.logLiveMs) continue;
        const state = age <= this.cfg.logActiveMs ? 'working' : 'done';
        const key = `${agent}::${path.basename(f.file, '.jsonl')}`;
        const prev = this.sessions.get(key);
        if (prev && prev.source === 'push') continue;      // 有 hook 推送时日志只做兜底
        if (prev && prev.state === state && now - prev.updatedAt < 1500) continue;
        const sum = prev && prev.__sum && prev.__sumAt && now - prev.__sumAt < 4000
          ? prev.__sum
          : (() => { const v = summarizeRecords(readTail(f.file, 96 * 1024)); return v; })();
        const title = sum.lastUser ? sum.lastUser.slice(0, 48) : path.basename(f.file, '.jsonl').slice(0, 12);
        this.sessions.set(key, {
          key, agent, agentName: agentMeta(agent).name, accent: agentMeta(agent).accent,
          sessionId: path.basename(f.file, '.jsonl'),
          state: sum.sawError && state === 'done' ? 'error' : state,
          event: 'log', title,
          cwd: '', tool: sum.lastTool || '',
          lastUser: sum.lastUser || '', lastAgent: sum.lastAgent || '',
          source: 'log',
          firstSeenAt: prev?.firstSeenAt || f.mtimeMs,
          updatedAt: f.mtimeMs,
          stateSince: prev?.state === state ? (prev.stateSince || f.mtimeMs) : f.mtimeMs,
          __sum: sum, __sumAt: now, __file: f.file,
        });
        touched.add(key);
      }
      /* 本轮没扫到的日志会话：文件过旧（或被删）就撤掉气泡，不留僵尸。
         判据必须重新 stat 文件——会话上的 updatedAt 是"上次看到的 mtime"，不会自己变旧。 */
      for (const [key, s] of this.sessions) {
        if (s.agent !== agent || s.source !== 'log' || touched.has(key)) continue;
        let mtime = 0;
        try { mtime = fs.statSync(s.__file || '').mtimeMs; } catch { mtime = 0; }
        if (!mtime || now - mtime > this.cfg.logLiveMs) this.sessions.delete(key);
      }
    }
  }

  /* ---------------- 通道状态 ---------------- */

  refreshChannels(force = true) {
    const now = Date.now();
    for (const def of AGENT_DEFS) {
      const cached = this.channels.get(def.id);
      if (!force && cached && now - cached.checkedAt < this.cfg.probeTtlMs) continue;
      let probe = { available: false, detail: '未探测' };
      try {
        const fn = this._probes[def.id];
        if (fn) probe = fn() || probe;
      } catch (e) {
        probe = { available: false, detail: '探测失败：' + ((e && e.message) || e) };
      }
      this.channels.set(def.id, {
        id: def.id, name: def.name, kind: def.kind, accent: def.accent,
        available: !!probe.available, wired: probe.wired === true,
        detail: probe.detail || '', paths: probe.paths || [],
        checkedAt: now,
      });
    }
  }

  setChannelEnabled(agent, on) {
    if (!this.disabledAgents) this.disabledAgents = new Set();
    if (on) this.disabledAgents.delete(agent); else this.disabledAgents.add(agent);
    this._emit(true);
    return this.snapshot();
  }

  /* ---------------- 选择 / 清理 ---------------- */

  select(agentId) {
    const id = agentId === null ? null : normalizeAgentId(agentId);
    this.selected = id && id !== this.selected ? id : null;
    this._emit(true);
    return this.selected;
  }

  cycleSession(dir = 1) {
    const list = this._orderedSessions();
    if (!list.length) return null;
    const curIdx = Math.max(0, list.findIndex((s) => s.key === this.pinned));
    const next = list[(curIdx + (dir > 0 ? 1 : -1) + list.length) % list.length];
    this.pinned = next.key;
    this.selected = next.agent;
    this._emit(true);
    return next.key;
  }

  pin(key) {
    this.pinned = this.pinned === key ? null : key;
    const s = this.pinned ? this.sessions.get(this.pinned) : null;
    if (s) this.selected = s.agent;
    this._emit(true);
    return this.pinned;
  }

  clearEnded() {
    let n = 0;
    for (const [key, s] of this.sessions) {
      if (s.state === 'done' || s.state === 'error' || s.state === 'sleeping') { this.sessions.delete(key); n++; }
    }
    this._emit(true);
    return n;
  }

  /* ---------------- 快照 ---------------- */

  _orderedSessions() {
    return [...this.sessions.values()]
      .map(({ __sum, __sumAt, __file, ...rest }) => rest)   // 内部缓存字段不外发
      .sort((a, b) => (STATE_RANK[b.state] - STATE_RANK[a.state]) || (b.updatedAt - a.updatedAt));
  }

  snapshot() {
    const list = this._orderedSessions();
    const counts = {};
    for (const s of list) counts[s.agent] = (counts[s.agent] || 0) + 1;
    const channels = [...this.channels.values()]
      .map((c) => ({ ...c, disabled: !!(this.disabledAgents && this.disabledAgents.has(c.id)), sessions: counts[c.id] || 0 }))
      .sort((a, b) => (b.sessions - a.sessions) || (Number(b.available) - Number(a.available)) || a.name.localeCompare(b.name));
    const rank = (s) => STATE_RANK[s] || 0;
    const dominant = list.slice().sort((a, b) => rank(b) - rank(a))[0] || null;
    return {
      ok: true,
      app: 'catwhale-agent-dock',
      port: this.cfg.port,
      host: this.cfg.host,
      updatedAt: Date.now(),
      selected: this.selected,
      pinned: this.pinned,
      state: dominant ? dominant.state : 'idle',
      dominant: dominant ? dominant.key : null,
      sessions: list,
      channels,
      counters: { ...this.counters },
      config: { keepDoneSec: Math.round(this.cfg.keepDoneMs / 1000), logActiveSec: Math.round(this.cfg.logActiveMs / 1000) },
    };
  }

  _emit(force = false) {
    if (!force && this.emitQueued) return;
    this.emitQueued = true;
    const run = () => {
      this.emitQueued = false;
      const now = Date.now();
      if (!force && now - this.lastEmit < 100) return;   // 高频工具事件最多 10Hz
      this.lastEmit = now;
      try { this.emit('update', this.snapshot()); } catch (e) { this.log('[dock] emit failed: ' + ((e && e.message) || e)); }
    };
    if (force) run(); else setTimeout(run, 100).unref?.();
  }
}

function createAgentDock(opts) { return new AgentDock(opts); }

module.exports = {
  createAgentDock, AgentDock,
  AGENT_DEFS, AGENT_BY_ID, STATES, EVENT_STATE,
  normalizeState, stateFromEvent, normalizeAgentId, agentMeta,
  summarizeRecords, listJsonl, readTail, DEFAULTS,
};
