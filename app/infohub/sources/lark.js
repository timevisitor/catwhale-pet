'use strict';
/* =====================================================================
   infohub/sources/lark.js —— 飞书消息源（lark-cli）
   ---------------------------------------------------------------------
   实测过的真实命令（lark-cli 1.0.96，本机 2026-11-25 跑的）：

     # 1) 认证状态（决定用 user 还是 bot 身份）
     lark-cli auth status
       → {"appId":"cli_aa95…","identities":{"bot":{"status":"ready"},
          "user":{"status":"missing","hint":"run: lark-cli auth login"}},"identity":"bot"}

     # 2) 会话列表（按活跃时间倒序，含单聊）
     lark-cli im +chat-list --as user --types p2p,group --sort active_time --page-size 50
       → GET /open-apis/im/v1/chats
         params: {page_size, sort_type:"ByActiveTimeDesc", types:"p2p,group", user_id_type}

     # 3) 单个会话的最后一条消息（拿摘要用）
     lark-cli im +chat-messages-list --as user --chat-id oc_xxx --page-size 1 --order desc --no-reactions
       → GET /open-apis/im/v1/messages
         params: {container_id_type:"chat", container_id:"oc_xxx", page_size:"1",
                  sort_type:"ByCreateTimeDesc", with_sender_name:"true"}

     # 4) 机器人身份（user 未登录时的兜底，只能看 bot 自己加入的群）
     lark-cli im +chat-list --as bot --page-size 3
       → {"ok":true,"identity":"bot","data":{"chats":null,"has_more":false}}   # 本机 bot 未入群

   结论（实测）：lark-cli 的 OpenAPI 里**没有「未读计数」接口**（没有 im/v1/unread 之类，
   `grep -ri unread` 只在二进制里命中）。所以本模块用「会话 + 最后一条消息 id」做去重：
   chat_id 的最后一条 message_id 变了 = 有新消息；条数拿不到就写「有新消息」。

   契约 §4.3：轮询 30s，按 chat_id + message_id 去重，启动前 60 秒只建基线不弹。
   ===================================================================== */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BODY_MAX = 90;
const CLI_TIMEOUT = 20000;          // 子进程超时（契约：≤20s）
const POLL_MS = 30000;              // 30 秒轮询
const WARMUP_MS = 60000;            // 启动后 60 秒只建基线

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const clip = (t, max) => {
  const s = clean(t);
  const n = max || BODY_MAX;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

/** 消息类型 → 中文占位（拿不到正文字段时的兜底） */
const TYPE_LABEL = {
  text: '',
  post: '[富文本]',
  image: '[图片]',
  file: '[文件]',
  audio: '[语音]',
  media: '[视频]',
  sticker: '[表情]',
  interactive: '[卡片]',
  share_chat: '[群名片]',
  share_user: '[名片]',
  system: '[系统消息]',
  merge_forward: '[聊天记录]',
};

/** 从一条 lark 消息里抠出正文：body.content 是 JSON 字符串 */
function extractText(item) {
  if (!item) return '';
  const type = String(item.msg_type || item.message_type || '').toLowerCase();
  let raw = item.body && item.body.content;
  if (raw == null) raw = item.content;
  let obj = null;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch (e) { obj = null; }
  } else if (raw && typeof raw === 'object') {
    obj = raw;
  }
  let text = '';
  if (obj) {
    if (typeof obj.text === 'string') text = obj.text;
    else if (Array.isArray(obj.content)) {          // post 富文本：[[{tag:"text",text:"..."}]]
      const parts = [];
      for (const para of obj.content) {
        if (!Array.isArray(para)) continue;
        for (const seg of para) {
          if (!seg) continue;
          if (seg.tag === 'text' && seg.text) parts.push(seg.text);
          else if (seg.tag === 'a' && seg.text) parts.push(seg.text);
          else if (seg.tag === 'at' && seg.user_name) parts.push('@' + seg.user_name);
          else if (seg.tag === 'img') parts.push('[图片]');
        }
      }
      text = parts.join('');
    }
    if (!text && typeof obj.title === 'string') text = obj.title;
  } else if (typeof raw === 'string') {
    text = raw;
  }
  if (!text) text = clean(item.summary || item.preview || '');
  if (!text && type) text = TYPE_LABEL[type] || ('[' + type + ']');
  return clean(text);
}

/** 解析 `im +chat-list` 的 JSON（ok/identity/data.chats|items） */
function parseChats(json) {
  if (!json) return [];
  const d = json.data || {};
  const arr = d.chats || d.items || (Array.isArray(d) ? d : []);
  const out = [];
  (Array.isArray(arr) ? arr : []).forEach((c, i) => {
    if (!c) return;
    const chatId = clean(c.chat_id || c.chatId || c.id);
    if (!chatId) return;
    const type = clean(c.chat_type || (chatId.startsWith('oc_') ? 'group' : 'p2p'));
    out.push({
      chatId,
      name: clean(c.name || c.chat_name || c.title) || (type === 'p2p' ? '单聊' : '未命名群'),
      type,
      rank: i,
      isExternal: !!c.external,
    });
  });
  return out;
}

/** 解析 `im +chat-messages-list` 的 JSON → 消息数组 */
function parseMessages(json, chat) {
  if (!json) return [];
  const d = json.data || {};
  const arr = d.items || d.messages || (Array.isArray(d) ? d : []);
  const out = [];
  (Array.isArray(arr) ? arr : []).forEach((m) => {
    if (!m) return;
    const messageId = clean(m.message_id || m.messageId || m.id);
    if (!messageId) return;
    const sender = m.sender || {};
    out.push({
      chatId: clean(m.chat_id) || (chat && chat.chatId) || '',
      messageId,
      type: clean(m.msg_type || m.message_type),
      text: extractText(m),
      sender: clean(m.sender_name || sender.name || sender.sender_name || sender.id || ''),
      createTime: Number(m.create_time || m.createTime || 0) || 0,
      deleted: !!m.deleted,
    });
  });
  return out;
}

/**
 * 一条消息 + 会话信息 → 归一化事件（纯函数，单测用）
 * @param {object} msg  parseMessages 的产物
 * @param {object} chat parseChats 的产物
 * @param {object} [opts] { unread }
 */
function toEvent(msg, chat, opts) {
  const o = opts || {};
  if (!msg || !msg.messageId || !msg.chatId) return null;
  if (msg.deleted) return null;
  const chatName = clean(chat && chat.name) || '会话';
  const sender = clean(msg.sender);
  const summary = msg.text || '';
  const body = summary || ((Number(o.unread) || 0) > 1 ? o.unread + ' 条未读' : '有新消息');
  const atMe = /@我|@所有人|@all/i.test(summary);
  const title = '飞书 · ' + chatName + (sender ? ' / ' + sender : '');
  return {
    source: 'lark',
    kind: 'message',
    level: atMe ? 'warn' : 'info',
    title: title.slice(0, 40),
    body: clip(body),
    ts: msg.createTime || Date.now(),
    key: 'lark:m:' + msg.chatId + ':' + msg.messageId,
    actions: [
      { id: 'copy', label: '复制', kind: 'copy', payload: clip(body, 200) },
      { id: 'open', label: '打开飞书', kind: 'app', payload: 'lark' },
    ],
    data: {
      chatId: msg.chatId,
      chatName,
      chatType: (chat && chat.type) || '',
      messageId: msg.messageId,
      msgType: msg.type,
      sender,
      atMe,
      unread: Number(o.unread) || 0,
    },
  };
}

/** 从 lark-cli 的 stdout 里取 JSON（前面可能夹日志/notice） */
function parseCliJson(stdout) {
  const s = String(stdout || '').replace(/^\uFEFF/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) return { ok: false, error: '输出不是 JSON：' + clean(s).slice(0, 120) };
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return { ok: false, error: 'JSON 解析失败：' + e.message }; }
}

/* ---------------------------------------------------------------------
   定位 lark-cli：本机实测有三个可执行入口
     1) %LOCALAPPDATA%\hermes\node\node_modules\@larksuite\cli\bin\lark-cli.exe  ← 最稳，直接 spawn
     2) %LOCALAPPDATA%\hermes\node\lark-cli.cmd（本质是 node run.js，需要 shell 或 electron-as-node）
     3) PATH 里的 lark-cli（where lark-cli）
   --------------------------------------------------------------------- */
function resolveCli(ctx) {
  const cfg = (ctx && typeof ctx.cfg === 'function' ? ctx.cfg() : {}) || {};
  const cands = [];
  if (cfg.cliPath) {
    const p = String(cfg.cliPath);
    if (/\.js$/i.test(p)) cands.push({ exe: p, kind: 'js', runJs: p, nodeExe: process.execPath });   // 测试用：直接跑一个 node 脚本当假 CLI
    else cands.push({ exe: p, kind: 'exe' });
  }

  const la = (ctx && ctx.paths && ctx.paths.localAppData) || process.env.LOCALAPPDATA || '';
  const nodeDir = la ? path.join(la, 'hermes', 'node') : '';
  if (nodeDir) {
    cands.push({ exe: path.join(nodeDir, 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli.exe'), kind: 'exe' });
    cands.push({ exe: path.join(nodeDir, 'lark-cli.cmd'), kind: 'js', runJs: path.join(nodeDir, 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js'), nodeExe: path.join(nodeDir, 'node.exe') });
  }
  // PATH 兜底：交给 cmd /c，避免 .cmd 在 Node 20+ 不能直接 spawn 的限制
  cands.push({ exe: 'lark-cli', kind: 'path' });

  for (const c of cands) {
    if (c.kind === 'path') return c;
    try { if (fs.existsSync(c.exe)) return c; } catch (e) { /* 忽略 */ }
  }
  return cands[cands.length - 1];
}

/** 把候选入口转成 spawn 的 (file, args, opts) */
function spawnSpec(cli, args) {
  if (cli.kind === 'exe') return { file: cli.exe, args, opts: { windowsHide: true } };
  if (cli.kind === 'js') {
    const nodeOk = cli.nodeExe && fs.existsSync(cli.nodeExe);
    const file = nodeOk ? cli.nodeExe : process.execPath;
    const env = Object.assign({}, process.env);
    // 宿主是 Electron 时，execPath 是 electron.exe，必须开 ELECTRON_RUN_AS_NODE
    if (!nodeOk) env.ELECTRON_RUN_AS_NODE = '1';
    return { file, args: [cli.runJs].concat(args), opts: { windowsHide: true, env } };
  }
  // PATH 模式：用 cmd /c，参数自己带引号
  const quoted = ['"' + cli.exe + '"'].concat(args.map((a) => (/[\s"]/.test(a) ? '"' + String(a).replace(/"/g, '""') + '"' : a)));
  return { file: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', quoted.join(' ')], opts: { windowsHide: true } };
}

/* ---------------------------------------------------------------------
   工厂
   --------------------------------------------------------------------- */
module.exports = function create(ctx) {
  const cfg = () => (typeof ctx.cfg === 'function' ? ctx.cfg() || {} : {});
  const log = (m) => { try { ctx.log(m); } catch (e) { /* 忽略 */ } };
  const emit = (e) => { try { ctx.emit(e); } catch (err) { log('emit 失败：' + err.message); } };
  const snapshot = (kind, data) => { try { ctx.snapshot(kind, data); } catch (e) { /* 忽略 */ } };

  let state = { ready: false, detail: '未启动' };
  let timer = null;
  let stopped = true;
  let cli = null;
  let identity = 'user';            // user 优先；user 未登录自动降为 bot
  let seenMsg = new Map();          // chatId -> 最后一条 message_id
  let baselineDone = false;
  let warmUntil = 0;
  let lastPoll = null;              // { chatCount, at }
  let pollBusy = false;

  /** 跑一条 lark-cli 命令；永不抛，带超时 */
  function runCli(args, timeoutMs) {
    return new Promise((resolve) => {
      if (!cli) cli = resolveCli(ctx);
      const spec = spawnSpec(cli, args);
      let child;
      try {
        child = spawn(spec.file, spec.args, spec.opts);
      } catch (err) {
        resolve({ ok: false, error: '启动 lark-cli 失败：' + (err && err.message ? err.message : String(err)) });
        return;
      }
      let out = '';
      let errOut = '';
      let done = false;
      const finish = (res) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(res);
      };
      const t = setTimeout(() => {
        try { child.kill(); } catch (e) { /* 忽略 */ }
        finish({ ok: false, error: 'lark-cli 超时（' + Math.round((timeoutMs || CLI_TIMEOUT) / 1000) + 's）：' + args.slice(0, 3).join(' ') });
      }, timeoutMs || CLI_TIMEOUT);
      if (typeof t.unref === 'function') t.unref();

      child.stdout.on('data', (d) => { if (out.length < 400000) out += String(d); });
      child.stderr.on('data', (d) => { if (errOut.length < 8000) errOut += String(d); });
      child.on('error', (err) => finish({ ok: false, error: 'lark-cli 不可用：' + (err && err.message ? err.message : String(err)) }));
      child.on('close', (code) => {
        // lark-cli 成功时 JSON 走 stdout，失败时 JSON 走 stderr（实测），两边都试
        const json = (out.trim() ? parseCliJson(out) : null) || (errOut.trim() ? parseCliJson(errOut) : null);
        if (json && json.ok) { finish({ ok: true, json, code }); return; }
        const e = (json && json.error) || {};
        finish({
          ok: false,
          code,
          error: clean(e.message || (typeof json.error === 'string' ? json.error : '') || errOut || out || ('退出码 ' + code)),
          errorType: e.type || '',
          errorSubtype: e.subtype || '',
          hint: clean(e.hint || ''),
          json,
        });
      });
    });
  }

  /** 读认证状态决定身份：user 可用则 user，否则 bot（auth status 本身就输出 JSON，不接受 --format） */
  async function resolveIdentity() {
    const r = await runCli(['auth', 'status'], 10000);
    if (!r.ok) return { identity: 'user', detail: '未取到认证状态：' + r.error };
    const st = r.json || {};
    const user = (st.identities && st.identities.user) || {};
    const bot = (st.identities && st.identities.bot) || {};
    if (user.available === true || user.status === 'ready') return { identity: 'user', detail: 'user 身份就绪' };
    if (bot.available === true || bot.status === 'ready') {
      return { identity: 'bot', detail: 'user 身份未登录（lark-cli auth login），临时用 bot 身份' };
    }
    return { identity: 'user', detail: '飞书未登录（需 lark-cli auth login）' };
  }

  /** 拉会话列表（user 身份失效时自动降级到 bot，并记住） */
  async function fetchChats() {
    const as = cfg().as || identity;
    const build = (id) => [
      'im', '+chat-list',
      '--as', id,
      '--types', 'p2p,group',
      '--sort', 'active_time',
      '--page-size', String(Math.min(50, Math.max(5, Number(cfg().maxChats) * 3 || 30))),
      '--format', 'json',
    ];
    let r = await runCli(build(as));
    if (!r.ok && as === 'user' && !cfg().as && r.errorType === 'authentication') {
      log('user 身份不可用（' + (r.errorType || 'authentication') + '），降级到 bot 身份');
      identity = 'bot';
      r = await runCli(build('bot'));
    }
    if (!r.ok) return { ok: false, error: r.error, errorType: r.errorType, hint: r.hint, chats: [] };
    return { ok: true, chats: parseChats(r.json) };
  }

  /** 拉某个会话的最后一条消息 */
  async function fetchLast(chat) {
    const as = cfg().as || identity;
    const r = await runCli([
      'im', '+chat-messages-list',
      '--as', as,
      '--chat-id', chat.chatId,
      '--page-size', '1',
      '--order', 'desc',
      '--no-reactions',
      '--format', 'json',
    ]);
    if (!r.ok) return { ok: false, error: r.error };
    const msgs = parseMessages(r.json, chat);
    return { ok: true, msg: msgs[0] || null };
  }

  /** 小并发批量取最后一条消息 */
  async function fetchLastMany(chats, concurrency) {
    const out = [];
    const queue = chats.slice();
    const workers = [];
    const n = Math.max(1, Math.min(concurrency || 3, queue.length));
    for (let i = 0; i < n; i++) {
      workers.push((async () => {
        for (;;) {
          const c = queue.shift();
          if (!c) return;
          const r = await fetchLast(c);
          if (r.ok && r.msg) out.push({ chat: c, msg: r.msg });
        }
      })());
    }
    await Promise.all(workers);
    return out;
  }

  function setDetail(text, ready) {
    state = { ready: !!ready, detail: text };
  }

  /** 一轮轮询：会话 → 各会话最后一条 → 去重上报 */
  async function poll() {
    if (stopped || pollBusy) return;
    pollBusy = true;
    try {
      const cr = await fetchChats();
      if (!cr.ok) {
        const authIssue = /need_user_authorization|token_missing|authentication|未登录|permission/i.test(cr.errorType + ' ' + cr.error);
        setDetail(authIssue
          ? '飞书未登录或 token 失效（' + (identity === 'user' ? 'lark-cli auth login 登录后自动恢复' : 'bot 无权限') + '）：' + clip(cr.error, 60)
          : '拉会话失败：' + clip(cr.error, 60), false);
        return;
      }

      const chats = cr.chats;
      const maxChats = Math.max(1, Number(cfg().maxChats) || 6);
      const watch = chats.slice(0, maxChats);

      if (!chats.length) {
        setDetail('已连接 lark-cli（' + identity + ' 身份）· 0 个会话' +
          (identity === 'bot' ? '（bot 未加入任何群；要看自己的消息请 lark-cli auth login）' : ''), true);
        snapshot('lark', { ok: true, chats: 0, items: [], updatedAt: Date.now() });
        return;
      }

      const lasts = await fetchLastMany(watch, 3);
      let emitted = 0;
      const now = Date.now();
      for (const { chat, msg } of lasts) {
        const prev = seenMsg.get(chat.chatId);
        seenMsg.set(chat.chatId, msg.messageId);
        if (!baselineDone) continue;                 // 首轮只建基线
        if (prev === msg.messageId) continue;        // 没变化
        if (now < warmUntil) continue;               // 启动 60 秒内不弹
        const evt = toEvent(msg, chat, {});
        if (!evt) continue;
        emit(evt);
        emitted += 1;
      }
      baselineDone = true;
      lastPoll = { chatCount: chats.length, at: now };

      setDetail('运行中（' + identity + ' 身份）· ' + chats.length + ' 个会话，跟踪前 ' + watch.length + ' 个' +
        '，本轮新消息 ' + emitted + ' 条', true);
      snapshot('lark', {
        ok: true,
        chats: chats.length,
        items: watch.map((c) => {
          const m = lasts.find((x) => x.chat.chatId === c.chatId);
          return {
            chatId: c.chatId,
            name: c.name,
            type: c.type,
            lastText: m && m.msg ? clip(m.msg.text, 60) : '',
            lastSender: m && m.msg ? m.msg.sender : '',
            lastAt: m && m.msg ? m.msg.createTime : 0,
          };
        }),
        updatedAt: now,
      });
    } catch (err) {
      setDetail('轮询异常：' + (err && err.message ? err.message : String(err)), false);
    } finally {
      pollBusy = false;
    }
  }

  function scheduleNext() {
    if (stopped) return;
    const sec = Math.max(10, Number(cfg().pollSec) || (POLL_MS / 1000));
    timer = setTimeout(async () => {
      timer = null;
      await poll();
      scheduleNext();
    }, sec * 1000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    name: 'lark',
    label: '飞书消息',
    defaults: { enabled: false, pollSec: 30, maxChats: 6, as: '' },

    async start() {
      stopped = false;
      baselineDone = false;
      seenMsg = new Map();
      const warmSec = Number(cfg().warmupSec);
      warmUntil = Date.now() + (Number.isFinite(warmSec) ? Math.max(0, warmSec) * 1000 : WARMUP_MS);
      cli = resolveCli(ctx);
      setDetail('正在探测 lark-cli', false);

      const idr = await resolveIdentity();
      identity = idr.identity;
      log('身份：' + identity + '（' + idr.detail + '）');
      setDetail('已探测身份：' + identity + '，首轮拉取中', false);

      await poll();          // 首轮：建基线
      scheduleNext();
      return { ok: state.ready, detail: state.detail };
    },

    async stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      setDetail('已停止', false);
    },

    status() { return state; },

    async refresh() {
      await poll();
      return { ok: state.ready, detail: state.detail };
    },

    /** 自检：认证 + 会话数，不发弹窗 */
    async probe() {
      if (!cli) cli = resolveCli(ctx);
      const idr = await resolveIdentity();
      identity = idr.identity;
      const cr = await fetchChats();
      if (!cr.ok) {
        return { ok: false, detail: 'lark-cli 调用失败：' + cr.error, identity, cliPath: cli.exe || cli.kind, errorType: cr.errorType };
      }
      return {
        ok: true,
        detail: 'lark-cli 可用（' + cli.kind + '）· ' + identity + ' 身份 · ' + cr.chats.length + ' 个会话',
        identity,
        cliPath: cli.exe || cli.kind,
        chats: cr.chats.length,
        sample: cr.chats.slice(0, 3),
      };
    },
  };
};

module.exports._internals = { parseChats, parseMessages, extractText, toEvent, parseCliJson, resolveCli, clip };

/* ---------------------------------------------------------------------
   命令行自检：node app/infohub/sources/lark.js --probe
   --------------------------------------------------------------------- */
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (!argv.includes('--probe')) {
    console.log('用法：node app/infohub/sources/lark.js --probe');
    process.exitCode = 2;
  } else {
    const home = process.env.LOCALAPPDATA || os.homedir();
    const inst = module.exports({
      cfg: () => ({}),
      setCfg: () => {},
      emit: (e) => console.log('[emit] ' + JSON.stringify(e).slice(0, 300)),
      snapshot: () => {},
      log: (m) => console.error('[log] ' + m),
      dataDir: path.join(os.tmpdir(), 'infohub-lark'),
      appDir: path.join(__dirname, '..', '..'),
      paths: { localAppData: home, home: os.homedir() },
    });
    const t0 = Date.now();
    Promise.resolve()
      .then(() => inst.probe())
      .then((r) => {
        r.elapsedMs = Date.now() - t0;
        console.log(JSON.stringify(r, null, 2));
        process.exitCode = r.ok ? 0 : 1;
      })
      .catch((e) => {
        console.log(JSON.stringify({ ok: false, detail: '未捕获异常：' + e.message }, null, 2));
        process.exitCode = 1;
      });
  }
}
