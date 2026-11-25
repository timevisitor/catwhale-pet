'use strict';
/* =============================================================================
 * 极简 IMAP 客户端（纯 node:tls / node:net，零第三方依赖）
 * -----------------------------------------------------------------------------
 * 为什么自己写：app/node_modules 里只有 electron，不能 require('imapflow')。
 * 邮箱验证码只需要「登录 → 选中信箱 → 找未读 → 取回整封原文」四步，所以这里
 * 只实现这四步需要的协议子集，但把协议里最容易踩坑的三处做扎实：
 *
 *   1. 字面量 {n}：服务器用 `BODY[] {1234}\r\n<1234 字节原始数据>)\r\n` 返回
 *      正文，中间的原始字节里可能包含任意 \r\n，绝不能按行切。这里按「逻辑
 *      行 = 若干文本片段 + 若干字面量」读取：读到行尾的 {n} 就精确读 n 字节，
 *      存进 literals 数组，文本里留 \u0000LIT<i>\u0000 占位，然后继续读同一
 *      逻辑行的剩余部分，直到某一行不再以 {n} 结尾。
 *   2. tag 匹配：只有 `<tag> OK/NO/BAD` 才结束一条命令；`*` 开头的无标签行
 *      全部收进 lines，供调用方解析（EXISTS/UIDNEXT/SEARCH/FETCH）。
 *   3. 超时与半包：socket 数据可能被 TCP 切成任意碎片，这里用累积缓冲 +
 *      「等更多数据」的 promise 处理，单个命令整体受 timeout 约束（默认 15s），
 *      连接建立也单独计时。
 *
 * 安全：LOGIN 的密码只可能存在 this.secret 里一份，用于把服务器回显的命令
 * 从错误信息里抹掉；对外只暴露 maskSecret()（前 2 位 + 长度）。
 * 所有定时器 unref()，close() 会唤醒所有在途等待并让它们失败，不会挂住进程。
 * ============================================================================= */
const net = require('node:net');
const tls = require('node:tls');

const DEFAULT_TIMEOUT = 15000;   // 单条命令/建连超时（毫秒）
const MAX_TEXT_LINE = 1 << 20;   // 单行文本上限 1MB，超了判协议错位
const MAX_LITERAL = 32 << 20;    // 单个字面量上限 32MB（够任何邮件正文）

/* 文本行解码：IMAP 的状态文本按标准是 ASCII，但不少服务器（尤其国内邮箱）
   会塞中文提示。先试严格 UTF-8，不合法再退回 latin1 保证字节透明。 */
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

function decodeLine(bytes) {
  try {
    return UTF8_STRICT.decode(bytes);
  } catch (e) {
    return bytes.toString('latin1');
  }
}

/** 凭据脱敏：只留前 2 位 + 长度，日志/错误信息里只允许出现这个形态。 */
function maskSecret(secret) {
  const str = String(secret == null ? '' : secret);
  if (!str) return '(空)';
  return str.slice(0, 2) + '…' + str.length;
}

/** IMAP 引号字符串：反斜杠与双引号要转义；非 ASCII 不能走这条路（改用字面量）。 */
function quote(str) {
  const s = String(str == null ? '' : str);
  if (/[^\x20-\x7e]/.test(s)) throw new Error('IMAP 引号字符串不允许非 ASCII，请改走字面量');
  return '"' + s.replace(/([\\"])/g, '\\$1') + '"';
}

/**
 * 邮箱名 → 修改版 UTF-7（RFC 3501 §5.1.3）。
 * 纯 ASCII 时只把 `&` 转义成 `&-`；含非 ASCII 时把连续的非 ASCII 片段按
 * UTF-16BE + base64 编码，用 `&...-` 包起来，`/` 换成 `,`，去掉 `=`。
 */
function utf7Encode(name) {
  const s = String(name == null ? '' : name);
  let out = '';
  let pending = '';

  const flush = () => {
    if (!pending) return;
    let buf = Buffer.from(pending, 'utf16le');
    for (let i = 0; i + 1 < buf.length; i += 2) {   // 字节对调 → UTF-16BE
      const t = buf[i]; buf[i] = buf[i + 1]; buf[i + 1] = t;
    }
    out += '&' + buf.toString('base64').replace(/=+$/, '').replace(/\//g, ',') + '-';
    pending = '';
  };

  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      out += ch === '&' ? '&-' : ch;
    } else {
      pending += ch;
    }
  }
  flush();
  return out;
}

function clip(str, max) {
  const s = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

class ImapClient {
  /**
   * @param {object} opts
   *   host/port  服务器地址（默认 993 走 TLS）
   *   secure     是否 TLS（默认 true；143 端口由调用方显式关掉）
   *   timeout    单命令超时，默认 15000
   *   log        日志函数（不得传入密码）
   */
  constructor(opts = {}) {
    this.host = String(opts.host || '').trim();
    this.port = Number(opts.port) || (opts.secure === false ? 143 : 993);
    this.secure = opts.secure !== false && this.port !== 143;
    this.timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : DEFAULT_TIMEOUT;
    this.log = typeof opts.log === 'function' ? opts.log : () => {};

    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.notify = null;      // 「来了新数据」的唤醒回调，同一时刻最多一个
    this.err = null;         // 一旦置位，后续所有读取立刻失败
    this.closed = false;
    this.tagSeq = 0;
    this.secret = '';        // 只用于脱敏，绝不输出
    this.queue = Promise.resolve();  // 命令串行化的锁链
  }

  /* ---------------------------- 生命周期 ---------------------------- */

  async connect() {
    if (this.sock) return this;
    if (!this.host) throw new Error('IMAP 未配置 host');
    const port = this.port;

    await new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (err) {
          try { sock.destroy(); } catch (e) { /* 忽略 */ }
          this.sock = null;
          reject(err);
        } else {
          resolve();
        }
      };

      const tlsOpts = { host: this.host, port };
      // 直连 IP 时不能带 SNI（RFC 6066 禁止），否则 Node 打 DeprecationWarning
      if (!net.isIP(this.host)) tlsOpts.servername = this.host;
      const sock = this.secure
        ? tls.connect(tlsOpts)
        : net.connect({ host: this.host, port });
      this.sock = sock;
      sock.setNoDelay(true);

      timer = setTimeout(
        () => finish(new Error(`连接 ${this.host}:${port} 超时（${this.timeout}ms）`)),
        this.timeout
      );
      if (timer.unref) timer.unref();

      sock.once(this.secure ? 'secureConnect' : 'connect', () => finish(null));
      sock.on('data', (d) => this._onData(d));
      sock.on('error', (e) => { this._onError(e); finish(e); });
      sock.on('close', () => this._onClose());
    });

    // 服务器第一句必须是 "* OK ..."（或 PREAUTH，免登录的少见情况）
    let greet;
    try {
      greet = await this._readResponse(this._deadline());
    } catch (e) {
      this.close();          // 问候读不到就立刻断开，别把半死连接留给调用方
      throw e;
    }
    if (!/^\*\s+(OK|PREAUTH)\b/i.test(greet.text)) {
      this.close();
      throw new Error(`IMAP 问候异常：${this._sanitize(greet.text).slice(0, 120)}`);
    }
    this.log(`IMAP 已连接 ${this.host}:${port}${this.secure ? '（TLS）' : ''}`);
    return this;
  }

  /** 立即断开：唤醒所有等待者让它们报「已关闭」，不会挂住调用方。 */
  close() {
    this.closed = true;
    if (!this.err) this.err = new Error('IMAP 连接已关闭');
    this._wake();
    const sock = this.sock;
    this.sock = null;
    if (sock) {
      try { sock.end(); } catch (e) { /* 忽略 */ }
      try { sock.destroy(); } catch (e) { /* 忽略 */ }
    }
  }

  async logout() {
    if (!this.sock) return;
    try {
      await this._run(() => this._exec('LOGOUT', 'LOGOUT'));
    } catch (e) {
      // 很多服务器回完 OK 立刻断链，这里失败属正常
    }
    this.close();
  }

  /* ---------------------------- 公开命令 ---------------------------- */

  /** CAPABILITY → ['IMAP4rev1', 'UIDPLUS', ...] */
  async capability() {
    return this._run(async () => {
      const res = await this._exec('CAPABILITY', 'CAPABILITY');
      const text = res.lines.map((l) => l.text).join('\n');
      const m = /^\*\s+CAPABILITY\s+(.*)$/im.exec(text);
      return (m ? m[1] : '').trim().split(/\s+/).filter(Boolean);
    });
  }

  /**
   * LOGIN。ASCII 凭据用引号形式；含非 ASCII（中文密码等）走字面量 {n} 续行，
   * 避免 UTF-8 多字节被服务器按 latin1 截断。
   */
  async login(user, pass) {
    const u = String(user == null ? '' : user);
    this.secret = String(pass == null ? '' : pass);
    return this._run(async () => {
      const needLiteral = /[^\x20-\x7e]/.test(u) || /[^\x20-\x7e]/.test(this.secret);
      if (needLiteral) {
        await this._loginLiteral(u, this.secret);
      } else {
        await this._exec(`LOGIN ${quote(u)} ${quote(this.secret)}`, 'LOGIN');
      }
      this.log(`IMAP 登录成功：${maskSecret(u)}`);
      return true;
    });
  }

  /** SELECT <folder> → {exists, uidValidity, uidNext, unseen, flags} */
  async select(folder) {
    const name = String(folder || 'INBOX');
    return this._run(async () => {
      const res = await this._exec(`SELECT ${quote(utf7Encode(name))}`, `SELECT ${name}`);
      const text = res.lines.map((l) => l.text).join('\n');
      const num = (m) => (m ? Number(m[1]) : null);
      const out = {
        exists: num(/^\*\s+(\d+)\s+EXISTS/im.exec(text)),
        uidValidity: num(/\[UIDVALIDITY\s+(\d+)\]/i.exec(text)),
        uidNext: num(/\[UIDNEXT\s+(\d+)\]/i.exec(text)),
        unseen: num(/\[UNSEEN\s+(\d+)\]/i.exec(text)),
        flags: (/^\*\s+FLAGS\s+\((.*)\)/im.exec(text) || [])[1] || ''
      };
      this.log(`已选中 ${name}：${out.exists == null ? '?' : out.exists} 封，UIDNEXT=${out.uidNext == null ? '?' : out.uidNext}`);
      return out;
    });
  }

  /** UID SEARCH <query>（'UNSEEN' / 'UNSEEN SINCE 1-Jan-2026' …）→ 升序 uid 数组 */
  async uidSearch(query) {
    const q = String(query || 'UNSEEN').trim() || 'UNSEEN';
    return this._run(async () => {
      const res = await this._exec(`UID SEARCH ${q}`, 'UID SEARCH');
      const out = [];
      for (const line of res.lines) {
        const m = /^\*\s+SEARCH\b(.*)$/i.exec(line.text);
        if (!m) continue;
        for (const tok of m[1].trim().split(/\s+/)) {
          if (/^\d+$/.test(tok)) out.push(Number(tok));
        }
      }
      // 去重 + 升序（服务器通常已排好，这里再保险一次）
      return Array.from(new Set(out)).sort((a, b) => a - b);
    });
  }

  /** UID FETCH <uid> (BODY.PEEK[]) → 整封原文 Buffer（不置 \Seen） */
  async uidFetchBody(uid) {
    const n = Number(uid);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`uid 非法：${uid}`);
    return this._run(async () => {
      const res = await this._exec(`UID FETCH ${n} (BODY.PEEK[])`, `UID FETCH ${n}`);
      const lit = res.literals.find((b) => b && b.length) || null;
      if (!lit) throw new Error(`邮件 ${n} 取回失败：响应里没有正文字面量`);
      return lit;
    });
  }

  /* ---------------------------- 内部：读写 ---------------------------- */

  _deadline() { return Date.now() + this.timeout; }

  _write(str) {
    if (!this.sock || this.sock.destroyed) throw new Error('IMAP 连接不可用（已断开）');
    this.sock.write(str, 'utf8');
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this._wake();
  }

  _onError(err) {
    if (!this.err) this.err = err instanceof Error ? err : new Error(String(err));
    this._wake();
  }

  _onClose() {
    this.closed = true;
    if (!this.err) this.err = new Error('IMAP 连接被服务器关闭');
    this.sock = null;
    this._wake();
  }

  _wake() {
    const fn = this.notify;
    this.notify = null;
    if (fn) fn();
  }

  /** 等下一批数据；带截止时间，超时抛错。 */
  _more(deadline) {
    if (this.err) return Promise.reject(this.err);
    if (this.closed) return Promise.reject(new Error('IMAP 连接已关闭'));
    const ms = deadline - Date.now();
    if (ms <= 0) return Promise.reject(new Error(`IMAP 读取超时（${this.timeout}ms）`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.notify = null;
        reject(new Error(`IMAP 读取超时（${this.timeout}ms）`));
      }, ms);
      if (timer.unref) timer.unref();
      this.notify = () => { clearTimeout(timer); resolve(); };
    });
  }

  /** 读一行文本（容忍只有 \n 的服务器），去掉行尾 CRLF。 */
  async _readLine(deadline) {
    for (;;) {
      const nl = this.buf.indexOf(0x0a);
      if (nl >= 0) {
        let end = nl;
        if (end > 0 && this.buf[end - 1] === 0x0d) end--;
        const line = decodeLine(this.buf.subarray(0, end));  // 文本行只用于匹配，正文走字面量
        this.buf = this.buf.subarray(nl + 1);
        return line;
      }
      if (this.buf.length > MAX_TEXT_LINE) throw new Error('IMAP 响应行过长，疑似协议错位');
      await this._more(deadline);
    }
  }

  /** 精确读 n 字节（字面量）。 */
  async _readBytes(n, deadline) {
    while (this.buf.length < n) await this._more(deadline);
    const out = Buffer.from(this.buf.subarray(0, n));   // 复制，别把大缓冲一起留住
    this.buf = this.buf.subarray(n);
    return out;
  }

  /**
   * 读一条「逻辑响应」：可能由多段文本 + 多个字面量拼成。
   * @returns {{text:string, literals:Buffer[]}}
   */
  async _readResponse(deadline) {
    let text = '';
    const literals = [];
    for (;;) {
      const line = await this._readLine(deadline);
      text += line;
      const m = /\{(\d+)\+?\}$/.exec(line);
      if (!m) break;
      const n = Number(m[1]);
      if (!Number.isFinite(n) || n < 0 || n > MAX_LITERAL) {
        throw new Error(`IMAP 字面量长度异常：${m[1]}`);
      }
      const lit = await this._readBytes(n, deadline);
      literals.push(lit);
      text += '\u0000LIT' + (literals.length - 1) + '\u0000';
      // 字面量后面紧接同一逻辑行的剩余部分，继续下一轮读取
    }
    return { text, literals };
  }

  /** 等服务器 `+ ` 续行请求（只用于字面量形式发命令）。 */
  async _expectContinuation(deadline, tag) {
    for (;;) {
      const res = await this._readResponse(deadline);
      if (/^\+/.test(res.text)) return;
      if (res.text.startsWith(tag + ' ')) {
        throw new Error(`服务器拒绝续行：${this._sanitize(res.text.slice(tag.length + 1))}`);
      }
    }
  }

  /** 读到一个 tag 结尾的响应为止。 */
  async _readTagged(tag, deadline) {
    const res = { tag, lines: [], literals: [], status: '' };
    for (;;) {
      const r = await this._readResponse(deadline);
      if (r.text.startsWith('+')) { this._write('\r\n'); continue; }
      if (r.text.startsWith(tag + ' ')) {
        res.status = r.text.slice(tag.length + 1);
        break;
      }
      res.lines.push(r);
      for (const lit of r.literals) res.literals.push(lit);
    }
    res.ok = /^OK\b/i.test(res.status || '');
    return res;
  }

  async _loginLiteral(user, pass) {
    const tag = 'A' + (++this.tagSeq);
    const deadline = this._deadline();
    const uBuf = Buffer.from(user, 'utf8');
    const pBuf = Buffer.from(pass, 'utf8');
    this._write(`${tag} LOGIN {${uBuf.length}}\r\n`);
    await this._expectContinuation(deadline, tag);
    this.sock.write(uBuf);                       // 原始字节，不走字符串编码
    this._write(` {${pBuf.length}}\r\n`);
    await this._expectContinuation(deadline, tag);
    this.sock.write(pBuf);
    this._write('\r\n');
    const res = await this._readTagged(tag, deadline);
    if (!res.ok) throw new Error(`IMAP 登录失败：${this._sanitize(res.status || '无响应')}`);
  }

  /* ---------------------------- 内部：命令 ---------------------------- */

  /** 发命令并收集响应；失败抛错（错误信息里不含原始命令，也不含密码）。 */
  async _exec(command, label) {
    const deadline = this._deadline();
    const tag = 'A' + (++this.tagSeq);
    const name = label || String(command).split(/\s+/)[0];
    this._write(`${tag} ${command}\r\n`);
    const res = await this._readTagged(tag, deadline);
    if (!res.ok) {
      const err = new Error(`IMAP 命令失败（${name}）：${this._sanitize(res.status || '无响应')}`);
      err.status = res.status;
      err.lines = res.lines;
      throw err;
    }
    return res;
  }

  /** 把回显里的密码抹掉，再截断。 */
  _sanitize(str) {
    let s = String(str == null ? '' : str);
    if (this.secret && this.secret.length >= 3) {
      s = s.split(this.secret).join(maskSecret(this.secret));
      s = s.split(quote(this.secret)).join('"' + maskSecret(this.secret) + '"');
    }
    return clip(s, 200);
  }

  /** 命令串行锁：同一个连接上不允许两条命令交叉读写。 */
  _lock() {
    const prev = this.queue;
    let release;
    this.queue = new Promise((r) => { release = r; });
    return prev.then(() => release);
  }

  async _run(fn) {
    const unlock = await this._lock();
    try {
      return await fn();
    } finally {
      unlock();
    }
  }
}

module.exports = {
  ImapClient,
  maskSecret,
  quote,
  utf7Encode,
  DEFAULT_TIMEOUT
};
