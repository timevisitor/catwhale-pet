'use strict';
/* =====================================================================
   infohub/sources/napcat.js —— QQ 消息源（OneBot v11 / NapCat）
   ---------------------------------------------------------------------
   · 连 NapCat 的 OneBot WebSocket 正向服务（默认 ws://127.0.0.1:3000），
     可带 access_token（header `Authorization: Bearer ***，同时兼容 query）。
   · Node 22 自带全局 WebSocket 时优先用它；若宿主环境里 WebSocket 不存在
     （老 Electron / 被安全策略裁掉），自动退回本文件手写的 WsLite：
     node:net + node:tls 完成握手、掩码文本帧、ping/pong、close、分片重组。
   · 只吃 post_type === 'message'，忽略自己发的（message_sent / user_id==self_id）。
   · 纯 Node 内置模块，零第三方依赖；不认识 Electron，可单测。
   ===================================================================== */

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const BODY_MAX = 90;                 // 弹窗正文上限（契约 §2：不超过 90 字）
const RECONNECT_BASE = 2000;         // 断线重连初始退避 2s
const RECONNECT_MAX = 30000;         // 封顶 30s
const CONNECT_TIMEOUT = 10000;       // 建连超时 10s（契约：网络 ≤15s）
const MAX_FRAME = 8 * 1024 * 1024;   // 单帧上限，防内存被灌爆

/** 密钥脱敏：只留前 4 位 + 长度，永不把完整 token 写进日志/事件 */
function maskSecret(s) {
  const str = String(s == null ? '' : s);
  if (!str) return '（空）';
  return str.slice(0, 4) + '…(' + str.length + '位)';
}

/** CQ 码里可能被转义的方括号/& 还原（NapCat 会把 [ 写成 &#91;） */
function unescapeCq(text) {
  return String(text)
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

const CQ_TEXT = {
  face: '[表情]',
  mface: '[表情]',
  image: '[图片]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  json: '[卡片]',
  xml: '[卡片]',
  forward: '[聊天记录]',
  markdown: '[卡片]',
  location: '[位置]',
  shake: '[窗口抖动]',
  poke: '[戳一戳]',
  dice: '[骰子]',
  rps: '[猜拳]',
  music: '[音乐]',
  reply: '',            // 回复引用的元数据对用户没意义，直接丢
  at: '@某人',
  contact: '[推荐好友]',
};

/**
 * CQ 码清洗：表情/图片/艾特成中文占位，未知 CQ 码丢弃，空白折叠。
 * @param {string} raw  原始 raw_message
 * @param {number|string} [selfId] 自己的 QQ 号，用来把「@自己」写成 @我
 */
function cleanCq(raw, selfId) {
  let s = unescapeCq(raw);
  s = s.replace(/\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g, (whole, type, args) => {
    const key = String(type).toLowerCase();
    if (key === 'at') {
      const m = /(?:^|,)qq=([^,]+)/.exec(args || '');
      const qq = m ? m[1] : '';
      if (selfId != null && String(qq) === String(selfId)) return '@我';
      if (qq === 'all') return '@全体成员';
      return '@某人';
    }
    if (Object.prototype.hasOwnProperty.call(CQ_TEXT, key)) return CQ_TEXT[key];
    return '';                                  // 未知 CQ 码一律剥掉，不留垃圾
  });
  return s.replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
}

/** 正文截断：超过 90 字加省略号 */
function clip(text, max) {
  const s = String(text == null ? '' : text).trim();
  const n = max || BODY_MAX;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * OneBot v11 事件 → 归一化事件（纯函数，方便单测）。
 * 不符合条件（非消息 / 自己发的 / 空消息）返回 null。
 * @param {object} evt  OneBot 原始事件
 * @param {object} [opts] { selfId }
 */
function toEvent(evt, opts) {
  const o = opts || {};
  if (!evt || typeof evt !== 'object') return null;
  if (evt.post_type !== 'message') return null;              // message_sent / notice / meta_event 全丢
  const selfId = o.selfId != null ? o.selfId : evt.self_id;
  if (evt.user_id != null && selfId != null && String(evt.user_id) === String(selfId)) return null;

  const rawText = typeof evt.raw_message === 'string'
    ? evt.raw_message
    : (Array.isArray(evt.message)
      ? evt.message.map((seg) => (seg && seg.type === 'text' ? String((seg.data && seg.data.text) || '') : (seg && seg.type === 'at' ? '[CQ:at,qq=' + ((seg.data && seg.data.qq) || '') + ']' : '[CQ:' + (seg && seg.type) + ']'))).join('')
      : '');
  const body = cleanCq(rawText, selfId);
  if (!body) return null;                                    // 纯图片无文字也允许；纯 CQ 剥空就跳过

  const isGroup = evt.message_type === 'group';
  const sender = evt.sender || {};
  const senderName = String(sender.card || sender.nickname || sender.name || (evt.user_id ? 'QQ ' + evt.user_id : '未知')).trim();
  const groupName = String(evt.group_name || (isGroup ? '群' + (evt.group_id || '') : '')).trim();
  const atMe = body.includes('@我');
  const level = (!isGroup || atMe) ? 'warn' : 'info';
  const title = isGroup ? ('QQ · ' + groupName + ' / ' + senderName) : ('QQ · ' + senderName);

  return {
    source: 'napcat',
    kind: 'message',
    level,
    title: title.slice(0, 40),
    body: clip(body),
    ts: Number(evt.time) ? Number(evt.time) * 1000 : Date.now(),
    key: 'napcat:m:' + (evt.message_id != null ? evt.message_id : (evt.user_id + ':' + Date.now())),
    actions: [
      { id: 'copy', label: '复制', kind: 'copy', payload: clip(body, 200) },
      { id: 'open', label: '打开QQ', kind: 'app', payload: 'qq' },
    ],
    data: {
      messageId: evt.message_id != null ? evt.message_id : null,
      chatType: isGroup ? 'group' : 'private',
      groupId: isGroup ? (evt.group_id || null) : null,
      groupName: isGroup ? groupName : null,
      userId: evt.user_id != null ? evt.user_id : null,
      senderName,
      atMe,
    },
  };
}

/* ---------------------------------------------------------------------
   WsLite —— 最小 WebSocket 客户端（RFC 6455 子集）
   只在全局 WebSocket 不存在时启用。支持：握手、文本帧收发、分片重组、
   客户端掩码、ping→pong、close。
   --------------------------------------------------------------------- */
class WsLite {
  /**
   * @param {string} url  ws:// 或 wss://
   * @param {object} [opts] { token, timeoutMs, onOpen, onText, onClose, onError }
   */
  constructor(url, opts) {
    const o = opts || {};
    const u = new URL(String(url));
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error('wsUrl 必须是 ws:// 或 wss://');
    this.secure = u.protocol === 'wss:';
    this.host = u.hostname;
    this.port = Number(u.port) || (this.secure ? 443 : 80);
    this.path = (u.pathname || '/') + (u.search || '');
    this.token = o.token || '';
    this.timeoutMs = Number(o.timeoutMs) || CONNECT_TIMEOUT;
    this.onOpen = o.onOpen || (() => {});
    this.onText = o.onText || (() => {});
    this.onClose = o.onClose || (() => {});
    this.onError = o.onError || (() => {});
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.handshaken = false;
    this.closed = false;
    this._frag = null;      // 分片累积
    this._fragOp = 1;
  }

  connect() {
    const opts = { host: this.host, port: this.port };
    const sock = this.secure ? tls.connect({ ...opts, servername: this.host, rejectUnauthorized: false }) : net.connect(opts);
    this.socket = sock;
    sock.setNoDelay(true);
    this._timer = setTimeout(() => {
      this._fail(new Error('连接超时（' + Math.round(this.timeoutMs / 1000) + 's）'));
    }, this.timeoutMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();

    sock.on(this.secure ? 'secureConnect' : 'connect', () => this._handshake());
    sock.on('data', (chunk) => this._onData(chunk));
    sock.on('error', (err) => this._fail(err));
    sock.on('close', () => this._fireClose(this._closeCode));
    return this;
  }

  _handshake() {
    const key = crypto.randomBytes(16).toString('base64');
    this._key = key;
    const lines = [
      'GET ' + this.path + ' HTTP/1.1',
      'Host: ' + this.host + (this.port === (this.secure ? 443 : 80) ? '' : ':' + this.port),
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + key,
      'Sec-WebSocket-Version: 13',
    ];
    if (this.token) lines.push('Authorization: Bearer ' + this.token);
    lines.push('', '');
    this.socket.write(lines.join('\r\n'));
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.handshaken) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (this.buf.length > 16384) this._fail(new Error('握手响应头过大'));
        return;
      }
      const head = this.buf.slice(0, end).toString('latin1');
      this.buf = this.buf.slice(end + 4);
      const first = head.split('\r\n')[0] || '';
      if (!/^HTTP\/1\.[01] 101/.test(first)) {
        this._fail(new Error('握手被拒绝：' + first.trim()));
        return;
      }
      const expect = crypto.createHash('sha1').update(this._key + WS_GUID).digest('base64');
      const got = (/sec-websocket-accept:\s*(\S+)/i.exec(head) || [])[1];
      if (got !== expect) {
        this._fail(new Error('Sec-WebSocket-Accept 校验失败'));
        return;
      }
      this.handshaken = true;
      clearTimeout(this._timer);
      this.onOpen();
    }
    this._parseFrames();
  }

  _parseFrames() {
    for (;;) {
      if (this.closed || this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;      // 服务端帧一般不加掩码
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) { this._fail(new Error('帧过大')); return; }
        len = Number(big);
        off = 10;
      }
      if (len > MAX_FRAME) { this._fail(new Error('帧过大')); return; }
      let mask = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        mask = this.buf.slice(off, off + 4);
        off += 4;
      }
      if (this.buf.length < off + len) return;
      let payload = Buffer.from(this.buf.slice(off, off + len));
      this.buf = this.buf.slice(off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

      if (op === 0x9) { this._sendFrame(0xA, payload); continue; }            // ping → pong
      if (op === 0xA) continue;                                              // pong 忽略
      if (op === 0x8) {                                                      // close
        this._closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        try { this._sendFrame(0x8, Buffer.alloc(0)); } catch (e) { /* 已经断了 */ }
        this.socket.destroy();
        return;
      }
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        if (op !== 0x0) { this._frag = payload; this._fragOp = op; } else if (this._frag) { this._frag = Buffer.concat([this._frag, payload]); }
        if (fin) {
          const full = this._frag || payload;
          this._frag = null;
          if (this._fragOp === 0x1) { try { this.onText(full.toString('utf8')); } catch (e) { /* 处理异常不影响连接 */ } }
        }
        continue;
      }
      // 其余控制帧忽略
    }
  }

  _sendFrame(op, payload) {
    if (!this.socket || this.socket.destroyed) throw new Error('连接已关闭');
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const len = data.length;
    let head;
    if (len < 126) {
      head = Buffer.alloc(2);
      head[1] = 0x80 | len;
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[1] = 0x80 | 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[1] = 0x80 | 127;
      head.writeUInt32BE(0, 2);
      head.writeUInt32BE(len, 6);
    }
    head[0] = 0x80 | (op & 0x0f);            // FIN + opcode
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([head, mask, masked]));
  }

  send(text) { this._sendFrame(0x1, text); }

  close() {
    if (this.closed) return;
    try { this._sendFrame(0x8, Buffer.from([0x03, 0xe8])); } catch (e) { /* 忽略 */ }
    try { this.socket && this.socket.destroy(); } catch (e) { /* 忽略 */ }
    this.closed = true;
    clearTimeout(this._timer);
  }

  _fail(err) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this._timer);
    try { this.socket && this.socket.destroy(); } catch (e) { /* 忽略 */ }
    this.onError(err);
    this._fireClose();
  }

  _fireClose() {
    if (this._firedClose) return;
    this._firedClose = true;
    clearTimeout(this._timer);
    try { this.onClose(this._closeCode); } catch (e) { /* 忽略 */ }
  }
}

/* ---------------------------------------------------------------------
   工厂
   --------------------------------------------------------------------- */
/**
 * @param {object} ctx 宿主上下文（见 docs/infohub-contract.md §1）
 */
module.exports = function create(ctx) {
  const cfg = () => (typeof ctx.cfg === 'function' ? ctx.cfg() || {} : {});
  const log = (m) => { try { ctx.log(m); } catch (e) { /* 日志失败不影响主流程 */ } };
  const emit = (evt) => { try { ctx.emit(evt); } catch (e) { log('emit 失败：' + e.message); } };
  const snapshot = (kind, data) => { try { ctx.snapshot(kind, data); } catch (e) { /* 忽略 */ } };

  let state = { ready: false, detail: '未启动' };
  let sock = null;          // 当前连接句柄（native WebSocket 或 WsLite）
  let retryTimer = null;
  let attempt = 0;
  let stopped = true;
  let selfId = null;
  let recvCount = 0;

  function wsUrlWithToken(url, token) {
    if (!token) return url;
    const u = new URL(url);
    if (!u.searchParams.has('access_token')) u.searchParams.set('access_token', token);
    return u.toString();
  }

  /** 建一条连接；返回 { close() } */
  function openSocket(url, token, handlers) {
    const c = cfg();
    const prefer = c.wsImpl || 'auto';                  // auto | native | lite（测试用）
    const hasNative = typeof WebSocket !== 'undefined' && typeof WebSocket === 'function';
    const useNative = prefer === 'native' || (prefer === 'auto' && hasNative);

    if (useNative && hasNative) {
      // 原生 WebSocket 不能自定义 header，token 只能走 query（NapCat 两种都认）
      const ws = new WebSocket(wsUrlWithToken(url, token));
      ws.addEventListener('open', () => handlers.onOpen());
      ws.addEventListener('message', (e) => {
        const d = e && e.data;
        if (typeof d === 'string') handlers.onText(d);
        else if (d && typeof d.toString === 'function') handlers.onText(d.toString());
      });
      ws.addEventListener('error', () => { /* close 会跟着来，统一在 onclose 处理 */ });
      ws.addEventListener('close', (e) => handlers.onClose(e && e.code));
      return { close: () => { try { ws.close(); } catch (e) { /* 忽略 */ } }, kind: 'native' };
    }
    const lite = new WsLite(url, {
      token,
      timeoutMs: Number(c.timeoutMs) || CONNECT_TIMEOUT,
      onOpen: handlers.onOpen,
      onText: handlers.onText,
      onClose: handlers.onClose,
      onError: (err) => log('WS 错误：' + (err && err.message ? err.message : String(err))),
    });
    lite.connect();
    return { close: () => lite.close(), kind: 'lite' };
  }

  function scheduleRetry() {
    if (stopped) return;
    const c = cfg();
    const base = Math.max(20, Number(c.reconnectBase) || RECONNECT_BASE);   // 测试可调
    const cap = Math.max(base, Number(c.reconnectMax) || RECONNECT_MAX);
    const wait = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
    state = { ready: false, detail: '已断线，重试中（' + Math.round(wait / 1000) + 's 后重连）' };
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, wait);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
  }

  function connect() {
    if (stopped) return;
    const c = cfg();
    const url = String(c.wsUrl || 'ws://127.0.0.1:3000').trim();
    const token = c.token ? String(c.token) : '';
    attempt += 1;
    state = { ready: false, detail: attempt === 1 ? '连接中' : '重连中（第 ' + attempt + ' 次）' };
    try {
      sock = openSocket(url, token, {
        onOpen() {
          attempt = 0;
          state = { ready: true, detail: '运行中（' + (sock && sock.kind === 'lite' ? '内建 WS' : '原生 WS') + '）' };
          log('已连接 ' + url + (token ? '（token ' + maskSecret(token) + '）' : ''));
          snapshot('qq', { ok: true, connectedAt: Date.now(), url });
        },
        onText(text) {
          let evt;
          try { evt = JSON.parse(text); } catch (e) { return; }     // 非 JSON（心跳回执等）忽略
          if (evt && evt.self_id != null) selfId = evt.self_id;
          const norm = toEvent(evt, { selfId });
          if (!norm) return;
          recvCount += 1;
          emit(norm);
        },
        onClose() {
          if (stopped) return;
          log('连接已断开');
          try { sock && sock.close(); } catch (e) { /* 忽略 */ }
          sock = null;
          scheduleRetry();
        },
      });
    } catch (err) {
      log('建连失败：' + (err && err.message ? err.message : String(err)));
      state = { ready: false, detail: '建连失败：' + (err && err.message ? err.message : '未知错误') };
      scheduleRetry();
    }
  }

  return {
    name: 'napcat',
    label: 'QQ 消息',
    defaults: { enabled: false, wsUrl: 'ws://127.0.0.1:3000', token: '' },

    async start() {
      stopped = false;
      attempt = 0;
      const c = cfg();
      if (!c.wsUrl) log('未配置 wsUrl，使用默认 ' + 'ws://127.0.0.1:3000');
      connect();
      return { ok: true };
    },

    async stop() {
      stopped = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      try { if (sock) sock.close(); } catch (e) { /* 忽略 */ }
      sock = null;
      state = { ready: false, detail: '已停止' };
    },

    status() { return state; },

    async refresh() {
      if (stopped) return { ok: false, detail: '未启动' };
      if (state.ready) return { ok: true, detail: state.detail + '，累计收消息 ' + recvCount + ' 条' };
      // 手动刷新 = 立刻踢一次重连
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      attempt = 0;
      connect();
      return { ok: false, detail: '正在重连' };
    },

    async probe() {
      const c = cfg();
      const url = String(c.wsUrl || 'ws://127.0.0.1:3000');
      const token = c.token ? String(c.token) : '';
      return await new Promise((resolve) => {
        let done = false;
        let h;
        const finish = (ok, detail) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          try { h && h.close(); } catch (e) { /* 忽略 */ }
          resolve({ ok, detail });
        };
        const t = setTimeout(() => finish(false, '连接超时（' + Math.round((Number(c.timeoutMs) || CONNECT_TIMEOUT) / 1000) + 's），NapCat 没在 ' + url + ' 上监听'), Number(c.timeoutMs) || CONNECT_TIMEOUT);
        if (typeof t.unref === 'function') t.unref();
        try {
          h = openSocket(url, token, {
            onOpen: () => finish(true, '握手成功（' + h.kind + '），' + url),
            onText: () => {},
            onClose: () => finish(false, '能连上但握手被关闭，检查 token / 反向 WS 配置'),
          });
        } catch (err) {
          finish(false, '建连异常：' + (err && err.message ? err.message : String(err)));
        }
      });
    },
  };
};

// 测试/调试用内部导出（宿主不会用到）
module.exports._internals = { cleanCq, toEvent, clip, maskSecret, WsLite, unescapeCq };
