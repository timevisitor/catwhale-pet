'use strict';
/* =============================================================================
 * 邮件 MIME 解析（纯 Node，零第三方依赖）
 * -----------------------------------------------------------------------------
 * 只需要「拿到主题 / 发件人 / 正文纯文本」三样东西，所以这里按最小够用原则
 * 实现 RFC 5322 + MIME 的一个子集：
 *
 *   - 头部：折叠行（续行以空格/Tab 开头）拼回一行；同名头合并。
 *   - multipart：递归拆 boundary，取第一份可用的 text/plain；没有 plain 才
 *     退回 text/html（再去标签）。
 *   - 传输编码：base64（容忍缺 = / 夹空行）、quoted-printable（含软换行
 *     "=\r\n"，先解成字节再按 charset 解码，否则 GBK 多字节会被拆坏）。
 *   - 字符集：gbk / gb18030 / gb2312 走 TextDecoder('gbk')（Node 内置 full-icu
 *     支持）。顺序是「声明 charset → utf-8 → gb18030」，一律用 fatal 模式，
 *     解不开再落到宽松 utf-8，最后 latin1 兜底，绝不抛错。
 *   - RFC 2047 编码字：=?utf-8?B?...?= / =?GBK?Q?...?=，相邻编码字之间的
 *     空白按标准丢弃。
 *
 * 为什么不能直接 buf.toString('utf8')：QQ/163 的中文营销邮件大量用 GBK，
 * toString 会得到一片乱码，验证码数字虽在，但「验证码」这几个字就认不出来了。
 * ============================================================================= */

const MAX_PART_DEPTH = 6;   // multipart 嵌套深度上限，防递归炸弹

/* ---------------------------- 字符集解码 ---------------------------- */

/**
 * 按声明字符集解码字节；失败逐级降级，永远返回字符串。
 * @param {Buffer} buf
 * @param {string} [charset] 比如 'GBK' / 'gb2312' / 'utf-8' / 'ISO-8859-1'
 */
function decodeBytes(buf, charset) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  if (!bytes.length) return '';
  const cs = String(charset || '').trim().toLowerCase().replace(/^["']|["']$/g, '');
  const order = [];
  if (cs) order.push(cs);
  order.push('utf-8', 'gb18030');

  for (const label of order) {
    // gb2312 在 WHATWG 里就映射到 gbk，这里显式说清楚
    const name = label === 'gb2312' ? 'gbk' : label;
    try {
      return new TextDecoder(name, { fatal: true }).decode(bytes);
    } catch (e) {
      // 该字符集不认识，或这段字节不合法 → 试下一个
    }
  }
  try {
    return new TextDecoder('utf-8').decode(bytes);   // 宽松 utf-8，坏字节变 \uFFFD
  } catch (e) {
    return bytes.toString('latin1');
  }
}

/* ---------------------------- 传输编码 ---------------------------- */

/** quoted-printable → Buffer（先出字节，再由调用方按 charset 解码）。 */
function decodeQP(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b !== 0x3d) { out.push(b); continue; }        // 不是 '='
    if (bytes[i + 1] === 0x0d && bytes[i + 2] === 0x0a) { i += 2; continue; }  // 软换行
    if (bytes[i + 1] === 0x0a) { i += 1; continue; }                            // 裸 LF 软换行
    const hex = bytes.subarray(i + 1, i + 3).toString('latin1');
    if (/^[0-9a-fA-F]{2}$/.test(hex)) { out.push(parseInt(hex, 16)); i += 2; continue; }
    out.push(b);   // 单个 '=' 原样保留
  }
  return Buffer.from(out);
}

/** base64 → Buffer（容忍换行、缺省 padding、夹带非法字符）。 */
function decodeBase64(buf) {
  let s = (Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf || ''))
    .replace(/[^A-Za-z0-9+/=]/g, '');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  return Buffer.from(s, 'base64');
}

/** 按 Content-Transfer-Encoding 解传输编码，返回原始字节。 */
function decodeTransfer(buf, cte) {
  const enc = String(cte || '').trim().toLowerCase();
  if (enc === 'base64') return decodeBase64(buf);
  if (enc === 'quoted-printable') return decodeQP(buf);
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');   // 7bit/8bit/binary/空
}

/* ---------------------------- 头部 ---------------------------- */

/** 拆头部与正文（第一个空行）。 */
function splitHeadersBody(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  let idx = bytes.indexOf('\r\n\r\n');
  if (idx >= 0) return { head: bytes.subarray(0, idx), body: bytes.subarray(idx + 4) };
  idx = bytes.indexOf('\n\n');
  if (idx >= 0) return { head: bytes.subarray(0, idx), body: bytes.subarray(idx + 2) };
  return { head: bytes, body: Buffer.alloc(0) };
}

/** 头部块 → Map（键小写；折叠行拼回；同名头用 ', ' 合并）。 */
function parseHeaderBlock(headBuf) {
  const text = decodeBytes(headBuf, 'utf-8');   // 头部基本是 ASCII（编码字本来也是 ASCII）
  const map = new Map();
  let lastKey = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    if (/^[ \t]/.test(line) && lastKey) {           // 折叠续行
      map.set(lastKey, map.get(lastKey) + ' ' + line.trim());
      continue;
    }
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (map.has(key)) map.set(key, map.get(key) + ', ' + val);
    else map.set(key, val);
    lastKey = key;
  }
  return map;
}

/* ---------------------------- 参数与 Content-Type ---------------------------- */

/** 解析 `; key=value` / `; key="quoted; value"`，以及 RFC 2231 的 `charset*=utf-8''x` */
function parseParams(str) {
  const params = {};
  const re = /;\s*([^=;\s]+)\s*=\s*("([^"]*)"|[^;]*)/g;
  let m;
  const src = String(str || '');
  while ((m = re.exec(src)) !== null) {
    const key = m[1].trim().toLowerCase();
    let val = m[3] != null ? m[3] : m[2].trim();
    if (/^'.*'/.test(val) === false && /%[0-9A-Fa-f]{2}/.test(val)) {
      val = safeDecodeURIComponent(val);            // RFC 2231 百分号编码
    }
    params[key] = val;
  }
  // charset*=utf-8''gbk → charset
  for (const key of Object.keys(params)) {
    if (!key.endsWith('*')) continue;
    const base = key.slice(0, -1);
    if (!(base in params)) params[base] = params[key];
    delete params[key];
  }
  return params;
}

function safeDecodeURIComponent(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

function parseContentType(value) {
  const raw = String(value || '').trim();
  const semi = raw.indexOf(';');
  const type = (semi < 0 ? raw : raw.slice(0, semi)).trim().toLowerCase() || 'text/plain';
  return { type, params: parseParams(semi < 0 ? '' : raw.slice(semi)) };
}

/** 正文没写 charset 时，从 <meta charset=...> 里嗅一把。 */
function sniffCharset(bytes) {
  const head = (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || ''))
    .subarray(0, 2048).toString('latin1');
  const m = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)
    || /charset\s*=\s*["']?([\w-]+)/i.exec(head);
  return m ? m[1].toLowerCase() : '';
}

/* ---------------------------- RFC 2047 编码字 ---------------------------- */

/** Q 编码（编码字里 `_` 代表空格）→ 字节。注意正文 QP 不适用这条规则。 */
function qpWordBytes(data) {
  const s = String(data || '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '_') { out.push(0x20); continue; }
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) {
      out.push(parseInt(s.substr(i + 1, 2), 16));
      i += 2;
      continue;
    }
    out.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

const WORD_RE = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g;

/**
 * 解 RFC 2047 编码字：=?charset?B?base64?= / =?charset?Q?qp?=
 * 相邻编码字之间的空白按标准丢弃（否则中文主题会出现多余空格）。
 */
function decodeWords(input) {
  const s = String(input == null ? '' : input);
  if (s.indexOf('=?') < 0) return s;
  const joined = s.replace(/(\?=)[ \t\r\n]+(=\?)/g, '$1$2');
  return joined.replace(WORD_RE, (whole, charset, enc, data) => {
    try {
      const bytes = enc.toUpperCase() === 'B' ? decodeBase64(data) : qpWordBytes(data);
      return decodeBytes(bytes, charset);
    } catch (e) {
      return whole;
    }
  });
}

/* ---------------------------- HTML → 文本 ---------------------------- */

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", copy: '©',
  reg: '®', hellip: '…', mdash: '—', ndash: '–', middot: '·', times: '×'
};

function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code) : m;
    }
    const key = body.toLowerCase();
    return key in ENTITIES ? ENTITIES[key] : m;
  });
}

/** 粗略去标签：够用来从 HTML 里找验证码，不追求排版还原。 */
function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------------------------- multipart 拆分 ---------------------------- */

/** 按 boundary 拆出各段原始字节（不含分隔行本身，段尾 CRLF 去掉）。 */
function splitMultipart(buf, boundary) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  const delim = Buffer.from('--' + boundary, 'latin1');
  const parts = [];
  let pos = bytes.indexOf(delim, 0);
  if (pos < 0) return parts;

  for (;;) {
    const nl = bytes.indexOf(0x0a, pos);
    if (nl < 0) break;
    const marker = bytes.subarray(pos + delim.length, nl).toString('latin1').trim();
    const bodyStart = nl + 1;
    if (marker === '--') break;                    // 结束标记 --boundary--
    const next = bytes.indexOf(delim, bodyStart);
    if (next < 0) { parts.push(bytes.subarray(bodyStart)); break; }
    let bodyEnd = next;
    if (bodyEnd - 1 >= bodyStart && bytes[bodyEnd - 1] === 0x0a) bodyEnd--;
    if (bodyEnd - 1 >= bodyStart && bytes[bodyEnd - 1] === 0x0d) bodyEnd--;
    parts.push(bytes.subarray(bodyStart, bodyEnd));
    pos = next;
  }
  return parts;
}

/* ---------------------------- 正文收集 ---------------------------- */

function collectText(bodyBuf, ct, cte, depth) {
  const out = { text: '', html: '' };
  if (depth > MAX_PART_DEPTH) return out;

  if (ct.type.startsWith('multipart/')) {
    const boundary = ct.params.boundary;
    if (!boundary) return out;
    for (const part of splitMultipart(bodyBuf, boundary)) {
      const { head, body } = splitHeadersBody(part);
      const ph = parseHeaderBlock(head);
      const pct = parseContentType(ph.get('content-type') || 'text/plain; charset=us-ascii');
      const pcte = ph.get('content-transfer-encoding') || '';
      // 附件正文不当正文用（但 multipart/* 里套的附件也可能带 text/plain）
      const disp = String(ph.get('content-disposition') || '').toLowerCase();
      if (disp.startsWith('attachment') || pct.type === 'message/rfc822') continue;
      const sub = collectText(body, pct, pcte, depth + 1);
      if (!out.text && sub.text) out.text = sub.text;
      if (!out.html && sub.html) out.html = sub.html;
      if (out.text && out.html) break;              // 两样都拿到了，不用再看后面
    }
    return out;
  }

  if (ct.type === 'text/plain' || ct.type === 'text/html') {
    const bytes = decodeTransfer(bodyBuf, cte);
    const charset = ct.params.charset || sniffCharset(bytes) || 'utf-8';
    const txt = decodeBytes(bytes, charset);
    if (ct.type === 'text/plain') out.text = txt;
    else out.html = txt;
  }
  return out;
}

/** `"张三" <a@b.com>` → {name:'张三', address:'a@b.com'} */
function parseAddress(raw) {
  const s = String(raw || '').trim();
  if (!s) return { name: '', address: '' };
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>\s]+)>\s*$/.exec(s);
  if (m) return { name: (m[1] || '').trim(), address: (m[2] || '').trim() };
  const mail = /([^\s<>,"']+@[^\s<>,"']+)/.exec(s);
  return { name: s, address: mail ? mail[1] : '' };
}

/**
 * 解析整封邮件。
 * @param {Buffer} buf 原始邮件字节
 * @returns {{subject:string, from:{name:string,address:string}, to:string, date:string,
 *            messageId:string, text:string, html:string, headers:Map<string,string>}}
 */
function parseMessage(buf) {
  const { head, body } = splitHeadersBody(buf);
  const headers = parseHeaderBlock(head);
  const ct = parseContentType(headers.get('content-type') || 'text/plain; charset=us-ascii');
  const cte = headers.get('content-transfer-encoding') || '';

  let { text, html } = collectText(body, ct, cte, 0);
  if (!text && html) text = htmlToText(html);

  return {
    subject: decodeWords(headers.get('subject') || ''),
    from: parseAddress(decodeWords(headers.get('from') || '')),
    to: decodeWords(headers.get('to') || ''),
    date: headers.get('date') || '',
    messageId: (headers.get('message-id') || '').trim(),
    text: String(text || '').trim(),
    html: String(html || '').trim(),
    headers
  };
}

module.exports = {
  parseMessage,
  parseHeaderBlock,
  parseContentType,
  parseParams,
  decodeBytes,
  decodeWords,
  decodeTransfer,
  decodeQP,
  decodeBase64,
  htmlToText,
  decodeEntities,
  splitMultipart,
  splitHeadersBody,
  sniffCharset
};
