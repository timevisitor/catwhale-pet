/**
 * harness-client.js — 桌宠侧的 DeepSeek Harness SDK JSON-RPC 客户端
 *
 * 为什么要这个：
 *   原来的做法是"每条消息起一个 `dsh --profile headless "<任务>"` 进程"，问题有三个——
 *   ① 每条消息都要重新启动（tsx 转译 + 装配插件树，实测 ~7~10 秒）；
 *   ② 只能拿到"最终答案"，看不到过程（没有流式、没有工具调用、没有 token 计量）；
 *   ③ 每条消息是一个全新会话，多轮记忆只能靠把历史内联进任务文本。
 *
 *   而 harness 自己就提供了给外部客户端用的协议：packages/sdk —— 一个**常驻**运行时进程，
 *   通过 stdio 讲换行分隔的 JSON-RPC 2.0：
 *     client→server: initialize / session/prompt / shutdown
 *     server→client: session.event（每条事件都推！）/ session.status / subagent.*
 *   把事件流接上，桌宠就真的变成了"改了 UI 的 harness"。
 *
 * 实测要点（都踩过）：
 *   - 组合：用官方 headless profile 打补丁挂上 `@deepseek-ai/dsh-sdk-jsonrpc-server`，
 *     必须把 `headless-startup` 与 `headless-runner` 两行 disabled（否则它强制要任务参数、
 *     并把答案打到 stdout 撕碎 JSON-RPC 帧）。
 *   - **session id 与进程绑定**：同一个 id 换个进程再用会报
 *     `already has a persisted log on disk that does not match this live session (id collision)`。
 *     → 每次启动运行时用**新的** session id；跨重启的上下文靠上层内联 + harness 自己的持久记忆。
 *   - 协议没有 cancel/close 方法 → 取消 = 杀掉子进程（会话日志已在盘上），下次用新的 id 重启。
 *   - stdout 只能是协议帧；诊断在 stderr（SQLite 实验性警告是**正常**的，别当失败）。
 *
 * @module harness-client
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** 运行时仓库位置：配置 > 环境变量 > 常见位置自动探测（发布版不含任何个人信息） */
function detectRepo() {
  const env = process.env;
  const cands = [
    env.DSH_HARNESS_REPO, env.DSH_HARNESS_SRC,
    path.join(env.USERPROFILE || env.HOME || '', 'deepseek-harness', 'src'),
    path.join(env.USERPROFILE || env.HOME || '', '.dsh', 'harness'),
    'C:\\deepseek-harness\\src', 'D:\\deepseek-harness\\src', 'F:\\deepseek-harness\\src',
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (c && fs.existsSync(path.join(c, 'apps', 'cli', 'src', 'bin.ts'))) return c;
    } catch (e) {}
  }
  return cands[0] || '';
}

const DEFAULTS = {
  repo: detectRepo(),
  profile: 'headless',
  bootMs: 60000,          // 冷启动（含 tsx 转译）给足时间
  idleKillMs: 15 * 60 * 1000,
  maxTokens: 8192,
};

/** 从 ~/.dsh/settings.yaml 里读默认 provider/model（不引 yaml 依赖，解析够用就行） */
function readHarnessDefaults(dshHome) {
  const out = { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' };
  try {
    const p = path.join(dshHome || path.join(process.env.USERPROFILE || '', '.dsh'), 'settings.yaml');
    const txt = fs.readFileSync(p, 'utf8');
    const m = txt.match(/agent-default-model\s*:\s*\n?\s*\{?\s*([\s\S]{0,200}?)(?:\n\S|\n$)/);
    const block = m ? m[1] : txt;
    const pv = block.match(/provider\s*:\s*([^\s,}]+)/);
    const md = block.match(/model\s*:\s*([^\s,}]+)/);
    if (pv) out.provider = pv[1].trim();
    if (md) out.model = md[1].trim();
  } catch (e) { /* 用默认值 */ }
  return out;
}

class HarnessClient {
  /**
   * @param {object} opts
   * @param {string} [opts.repo]       harness 仓库根（含 apps/cli/src/bin.ts）
   * @param {string} [opts.profile]    profile 名（默认 headless）
   * @param {string} [opts.patch]      叠加补丁文件路径（挂 jsonrpc server 用）
   * @param {string} [opts.cwd]        运行时工作目录（agent 的文件工具在这里干活）
   * @param {string} [opts.provider]   provider id
   * @param {string} [opts.model]      model id
   * @param {number} [opts.maxTokens]
   * @param {string} [opts.nodeExe]    用哪个 node（没有则退回 Electron 自身）
   * @param {function} [opts.onEvent]  (evt) => void   原始/归一化事件
   * @param {function} [opts.onStatus] ('starting'|'running'|'idle'|'dead', info) => void
   * @param {function} [opts.log]      (line) => void
   */
  constructor(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    this.repo = o.repo;
    this.profile = o.profile;
    this.patch = o.patch || path.join(__dirname, 'harness-sdk', 'pet-sdk.patch.yml');
    this.cwd = o.cwd || this.repo;
    this.provider = o.provider;
    this.model = o.model;
    this.maxTokens = o.maxTokens;
    this.nodeExe = o.nodeExe || process.execPath;
    this.envExtras = o.envExtras || {};      // 注入给运行时的环境变量（如 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL）
    this.useElectronAsNode = !o.nodeExe || o.nodeExe === process.execPath;
    this.onEvent = o.onEvent || (() => {});
    this.onStatus = o.onStatus || (() => {});
    this.log = o.log || (() => {});
    this.child = null;
    this.ready = false;
    this.starting = null;
    this.buf = '';
    this.seqId = 0;
    this.pending = new Map();
    this.sessionId = null;
    this.lastActivity = 0;
    this.stderrTail = '';
    this.turnText = '';
    this.deadReason = null;
    this.idleTimer = setInterval(() => this._reapIdle(), 60000);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  get alive() { return !!(this.child && this.child.exitCode === null && !this.child.killed); }

  /** 启动运行时并完成 initialize 握手；重复调用共享同一次启动 */
  async start() {
    if (this.ready && this.alive) return this;
    if (this.starting) return this.starting;
    this.starting = this._boot().finally(() => { this.starting = null; });
    return this.starting;
  }

  async _boot() {
    if (!this.repo) throw new Error('未找到 DeepSeek Harness 运行时：请把 harness 仓库路径写进配置（%APPDATA%\\桌宠\\pet-state.json 的 harnessRepo），或设置环境变量 DSH_HARNESS_REPO');
    const bin = path.join(this.repo, 'apps', 'cli', 'src', 'bin.ts');
    if (!fs.existsSync(bin)) throw new Error('harness 入口不存在：' + bin + '（请确认 harnessRepo 指向仓库根目录）');
    if (!fs.existsSync(this.patch)) throw new Error('找不到补丁文件：' + this.patch);
    const args = ['--import', 'tsx/esm', bin, '--profile', this.profile, '--patch', this.patch];
    this.log('HARNESS_SPAWN ' + path.basename(this.nodeExe) + ' ' + args.join(' '));
    const env = Object.assign({}, process.env, this.envExtras);
    if (this.useElectronAsNode) env.ELECTRON_RUN_AS_NODE = '1';
    const t0 = Date.now();
    this.deadReason = null;
    this.stderrTail = '';
    this.buf = '';
    this.child = spawn(this.nodeExe, args, { cwd: this.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (d) => this._onStdout(d));
    this.child.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
      const t = String(d).trim();
      if (t && !/ExperimentalWarning|trace-warnings/.test(t)) this.log('HARNESS_STDERR ' + t.slice(0, 300));
    });
    this.child.on('exit', (code, sig) => {
      this.ready = false;
      this.deadReason = 'harness 已退出（code=' + code + (sig ? ', sig=' + sig : '') + '）';
      try { this.child = null; } catch (e) {}
      for (const [, { reject }] of this.pending) reject(new Error(this.deadReason));
      this.pending.clear();
      this.onStatus('dead', { code, reason: this.deadReason, stderr: this.stderrTail.slice(-600) });
    });
    this.onStatus('starting', {});
    const defaults = readHarnessDefaults();
    const provider = this.provider || defaults.provider;
    const model = this.model || defaults.model;
    const res = await this._request('initialize', {
      cwd: this.cwd,
      provider,
      model,
      maxTokens: this.maxTokens || DEFAULTS.maxTokens,
    }, DEFAULTS.bootMs);
    this.ready = true;
    this.provider = provider;
    this.model = model;
    this.sessionId = 'pet-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    this.log('HARNESS_READY ' + JSON.stringify(res && res.serverInfo ? res.serverInfo : res) +
             ' boot=' + ((Date.now() - t0) / 1000).toFixed(1) + 's session=' + this.sessionId);
    this.onStatus('idle', { sessionId: this.sessionId, provider, model });
    return this;
  }

  /** 发一条用户消息；立即返回回执（回复通过事件流回来） */
  async prompt(text) {
    await this.start();
    this.lastActivity = Date.now();
    this.turnText = '';
    this.onStatus('running', {});
    const r = await this._request('session/prompt', {
      sessionId: this.sessionId,
      contentBlocks: [{ type: 'text', text: String(text == null ? '' : text) }],
    }, 30000);
    return r;
  }

  _request(method, params, timeoutMs) {
    if (!this.child) return Promise.reject(new Error('harness 未运行'));
    const id = ++this.seqId;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('harness 请求超时：' + method));
      }, timeoutMs || 30000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); },
                            reject: (e) => { clearTimeout(timer); reject(e); } });
      try { this.child.stdin.write(payload + '\n'); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  _onStdout(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch (e) { continue; }   // 协议规定：非 JSON 行忽略
      if (m.id && !m.method) {                                 // 响应
        const p = this.pending.get(m.id);
        if (!p) continue;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message || 'harness 错误'));
        else p.resolve(m.result);
        continue;
      }
      if (m.method === 'session.event') this._onSessionEvent(m.params && m.params.event);
      else if (m.method === 'session.status') {
        const st = (m.params && m.params.status) || '';
        if (st === 'running') this.onStatus('running', { sessionId: m.params.sessionId });
        if (st === 'idle') this.onStatus('idle', { sessionId: m.params.sessionId });
      } else if (m.method === 'subagent.started' || m.method === 'subagent.finished') {
        this.onEvent({ kind: m.method, payload: m.params });
      }
    }
  }

  /** 把 harness 的原始会话事件归一化成 UI 能直接画的东西 */
  _onSessionEvent(ev) {
    if (!ev || !ev.type) return;
    const d = ev.data || {};
    this.lastActivity = Date.now();
    switch (ev.type) {
      case 'assistant/chunk': {
        const c = d.chunk || {};
        if (c.type === 'text-delta') { this.turnText += c.text || ''; this.onEvent({ kind: 'delta', text: c.text || '' }); }
        else if (c.type === 'reasoning-delta') this.onEvent({ kind: 'reasoning', text: c.reasoning || c.text || '' });
        else if (c.type === 'usage') this.onEvent({ kind: 'usage', usage: c.usage });
        else if (c.type === 'block-end' && c.block && c.block.type === 'text') this.onEvent({ kind: 'blockEnd', text: c.block.text || '' });
        break;
      }
      case 'assistant/message': {
        const txt = ((d.message && d.message.content) || []).filter((x) => x && x.type === 'text').map((x) => x.text).join('');
        this.onEvent({ kind: 'message', text: txt, usage: d.usage });
        break;
      }
      case 'tool/call':
        this.onEvent({ kind: 'toolCall', name: d.name, args: d.arguments, callId: d.callId });
        break;
      case 'tool/result': {
        const c = ((d.message && d.message.content) || [])[0];
        const inner = (c && c.content) || [];
        const txt = inner.filter((x) => x && x.type === 'text').map((x) => x.text).join('');
        this.onEvent({ kind: 'toolResult', callId: c && c.toolCallId, text: txt.slice(0, 4000), isError: !!(c && c.isError) });
        break;
      }
      case 'session/title':
        this.onEvent({ kind: 'title', title: d.title });
        break;
      case 'turn/end':
        this.onEvent({ kind: 'turnEnd', reason: d.reason });
        break;
      case 'request/context':
        this.onEvent({ kind: 'route', provider: d.provider, model: d.model, contextWindow: d.contextWindow });
        break;
      default: break;
    }
  }

  _reapIdle() {
    if (!this.alive || !this.lastActivity) return;
    if (Date.now() - this.lastActivity > DEFAULTS.idleKillMs && !this.pending.size) {
      this.log('HARNESS_IDLE_KILL');
      this.kill();
    }
  }

  /** 硬杀（取消 / 退出）。会话日志已在盘上，下次用新 id 重启即可。 */
  kill() {
    this.ready = false;
    for (const [, { reject }] of this.pending) reject(new Error('已取消'));
    this.pending.clear();
    const c = this.child;
    this.child = null;
    if (c) {
      try { c.stdin.end(); } catch (e) {}
      try { c.kill(); } catch (e) {}
      setTimeout(() => { try { if (c.exitCode === null) c.kill('SIGKILL'); } catch (e) {} }, 1500).unref();
    }
    this.deadReason = '已停止';
  }

  /** 优雅关闭：先协议 shutdown，再走 kill 阶梯 */
  async shutdown() {
    try {
      if (this.alive) await this._request('shutdown', {}, 2000);
    } catch (e) { /* 忽略 */ }
    this.kill();
    if (this.idleTimer) clearInterval(this.idleTimer);
  }
}

module.exports = { HarnessClient, readHarnessDefaults, detectRepo, DEFAULTS };
