'use strict';
/* =============================================================================
 * 邮箱验证码模块 · 真实协议测试（不是字符串假断言）
 * -----------------------------------------------------------------------------
 * 用一个 node:net 手写的假 IMAP 服务端，按真实报文格式回话（`* OK` 问候、
 * `* 3 EXISTS`、`* OK [UIDNEXT 103]`、`* SEARCH 101`、`* 2 FETCH (... BODY[]
 * {n}\r\n<原始字节>)`、`A5 OK ...`），并且把 FETCH 的响应拆成三段 TCP 写入，
 * 逼客户端真的处理半包与字面量。
 *
 * 覆盖：
 *   1. MIME：multipart 递归 + base64 + GBK 正文 + GBK 主题（RFC 2047 B）
 *   2. MIME：quoted-printable + UTF-8 + 折行主题（RFC 2047 Q/B 混合）
 *   3. 验证码抽取：关键词优先、手机号/金额/日期/订单号排除、全角数字
 *   4. IMAP 全链路：CAPABILITY → LOGIN → SELECT → UID SEARCH UNSEEN →
 *      UID FETCH BODY.PEEK[] → 解码 → 抽出 123456
 *   5. source 端到端：首次只建基线不弹 → 新邮件 emit/snapshot
 *   6. 错误路径：密码错不抛顶层且日志脱敏；服务器不回话则超时
 *
 * 运行：node tests/infohub/mail.test.js
 * 全程本地回环，不连任何真实邮箱。
 * ============================================================================= */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { ImapClient, maskSecret, utf7Encode } = require('../../app/infohub/lib/imap-lite.js');
const { parseMessage, decodeWords, htmlToText } = require('../../app/infohub/lib/mail-parse.js');
const { extractCode } = require('../../app/infohub/lib/code-extract.js');
const createMailSource = require('../../app/infohub/sources/mail.js');

/* ============================ GBK 编码器（测试专用） ============================
 * Node 只有 GBK 解码器、没有编码器。这里反过来用 TextDecoder('gbk') 建一张
 * 字符 → 字节 的反查表，就能造出**真正的 GBK 字节**，这样测的是真解码路径，
 * 而不是拿 UTF-8 假装的 GBK。
 * ============================================================================ */
function buildGbkEncoder() {
  const dec = new TextDecoder('gbk');
  const map = new Map();
  for (let hi = 0x81; hi <= 0xfe; hi++) {
    for (let lo = 0x40; lo <= 0xfe; lo++) {
      const b = Buffer.from([hi, lo]);
      const s = dec.decode(b);
      if (s.length === 1 && s !== '\uFFFD' && !map.has(s)) map.set(s, b);
    }
  }
  return function gbkEncode(str) {
    const parts = [];
    for (const ch of String(str)) {
      const code = ch.codePointAt(0);
      if (code < 0x80) { parts.push(Buffer.from([code])); continue; }
      const b = map.get(ch);
      if (!b) throw new Error('GBK 反查表里没有字符：' + ch);
      parts.push(b);
    }
    return Buffer.concat(parts);
  };
}

const gbk = buildGbkEncoder();

function b64Wrap(buf) {
  return buf.toString('base64').replace(/(.{76})/g, '$1\r\n');
}

/** 极简 QP 编码（够造测试邮件：非 ASCII 全转 =XX，行宽 74 软换行） */
function qpEncode(buf) {
  let out = '';
  let col = 0;
  const put = (tok) => {
    if (col + tok.length > 74) { out += '=\r\n'; col = 0; }
    out += tok;
    col += tok.length;
  };
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x0d && buf[i + 1] === 0x0a) { out += '\r\n'; col = 0; i++; continue; }
    if (b === 0x0a) { out += '\r\n'; col = 0; continue; }
    if (b >= 0x21 && b <= 0x7e && b !== 0x3d) { put(String.fromCharCode(b)); continue; }
    put('=' + b.toString(16).toUpperCase().padStart(2, '0'));
  }
  return out;
}

/** 一封 QQ 风格的中文验证码邮件：multipart/alternative，plain=base64+GBK，html=QP+GBK */
function buildGbkVerificationMail(code) {
  const subject = '【QQ邮箱】登录验证码';
  const fromName = 'QQ邮箱安全中心';
  const plain = [
    '尊敬的用户：',
    '',
    `您正在登录 QQ 邮箱，本次登录验证码是 ${code}，5 分钟内有效。`,
    '若非本人操作，请忽略本邮件。',
    '',
    '客服电话 400-670-0700',
    '订单号 202611250001234567',
    ''
  ].join('\r\n');
  const html = `<html><body><p>您正在登录 QQ 邮箱，本次登录验证码是 <b>${code}</b>，5 分钟内有效。</p>`
    + '<p>若非本人操作，请忽略本邮件。</p></body></html>';

  const head = [
    `From: =?GBK?B?${Buffer.from(gbk(fromName)).toString('base64')}?= <security@qq.com>`,
    'To: someone@example.com',
    `Subject: =?GBK?B?${Buffer.from(gbk(subject)).toString('base64')}?=`,
    'Date: Wed, 25 Nov 2026 10:00:00 +0800',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="----=_Part_0_abc"',
    'Message-ID: <fake-mail-1@qq.com>',
    ''
  ].join('\r\n');

  const body = [
    '------=_Part_0_abc',
    'Content-Type: text/plain; charset="GBK"',
    'Content-Transfer-Encoding: base64',
    '',
    b64Wrap(gbk(plain)),
    '------=_Part_0_abc',
    'Content-Type: text/html; charset="GBK"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    qpEncode(gbk(html)),
    '------=_Part_0_abc--',
    ''
  ].join('\r\n');

  return Buffer.concat([Buffer.from(head + '\r\n', 'latin1'), Buffer.from(body, 'latin1')]);
}

/** 一封普通中文广告邮件（用来当"历史未读"，验证基线不弹） */
function buildPlainMail() {
  const head = [
    'From: "每日优鲜" <news@example.com>',
    'Subject: =?utf-8?B?' + Buffer.from('本周生鲜优惠').toString('base64') + '?=',
    'Date: Tue, 24 Nov 2026 09:00:00 +0800',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    ''
  ].join('\r\n');
  return Buffer.from(head + '\r\n' + '本周生鲜优惠已更新，点击查看。\r\n', 'utf8');
}

/* ============================ 假 IMAP 服务端 ============================ */

function tokenize(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    if (line[i] === '"') {
      i++;
      let v = '';
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\') i++;
        v += line[i++];
      }
      i++;
      out.push(v);
      continue;
    }
    if (line[i] === '(') {
      const start = i;
      let depth = 0;
      while (i < line.length) {
        if (line[i] === '(') depth++;
        else if (line[i] === ')') { depth--; if (!depth) { i++; break; } }
        i++;
      }
      out.push(line.slice(start, i));
      continue;
    }
    let v = '';
    while (i < line.length && !/\s/.test(line[i])) v += line[i++];
    out.push(v);
  }
  return out;
}

function createFakeImap(opts = {}) {
  const state = {
    user: opts.user || 'u@example.com',
    pass: opts.pass || 'fake-auth-code-123',
    messages: (opts.messages || []).map((m) => ({ uid: m.uid, raw: m.raw, flags: (m.flags || []).slice() })),
    requests: [],          // 收到的命令原文（脱敏后给断言用）
    connections: 0,
    nextUid: 0
  };
  state.nextUid = state.messages.reduce((a, m) => Math.max(a, m.uid), 100) + 1;

  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    state.connections++;
    sock.setNoDelay(true);
    sock.on('error', () => { /* 客户端粗暴断开时别炸 */ });
    sock.on('close', () => sockets.delete(sock));

    sock.write('* OK [CAPABILITY IMAP4rev1 UIDPLUS] 假 IMAP 服务端就绪\r\n');

    let buf = Buffer.alloc(0);
    let logical = '';          // 当前逻辑行已积累的文本
    let literals = [];         // 当前命令收到的字面量
    let waiting = 0;           // 正等 n 字节字面量
    let authed = false;

    const handle = (rawLine) => {
      const line = rawLine.replace(/\u0000(\d+)\u0000/g,
        (m, i) => (literals[Number(i)] || Buffer.alloc(0)).toString('utf8'));
      literals = [];
      state.requests.push(line);

      const tagm = /^(\S+)\s+([\s\S]*)$/.exec(line);
      if (!tagm) return;
      const tag = tagm[1];
      const toks = tokenize(tagm[2]);
      let verb = (toks.shift() || '').toUpperCase();
      let args = toks;
      let sub = '';
      if (verb === 'UID') {
        sub = (args.shift() || '').toUpperCase();
        verb = 'UID';
      }
      const reply = (s) => sock.write(s);
      const ok = (text, pre = '') => reply(`${pre}${tag} OK ${text}\r\n`);

      switch (verb) {
        case 'CAPABILITY':
          ok('CAPABILITY completed', '* CAPABILITY IMAP4rev1 UIDPLUS\r\n');
          return;

        case 'NOOP':
          ok('NOOP completed');
          return;

        case 'LOGIN': {
          const [u, p] = args;
          if (u !== state.user || p !== state.pass) {
            reply(`${tag} NO [AUTHENTICATIONFAILED] 认证失败\r\n`);
            return;
          }
          authed = true;
          ok('LOGIN completed');
          return;
        }

        case 'SELECT': {
          if (!authed) { reply(`${tag} NO 请先登录\r\n`); return; }
          const box = args[0] || 'INBOX';
          const maxUid = state.messages.reduce((a, m) => Math.max(a, m.uid), 0);
          reply('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n');
          reply(`* ${state.messages.length} EXISTS\r\n`);
          reply('* 0 RECENT\r\n');
          reply('* OK [UIDVALIDITY 7777] UIDs valid\r\n');
          reply(`* OK [UIDNEXT ${maxUid + 1}] Predicted next UID\r\n`);
          ok(`[READ-WRITE] SELECT ${box} completed`);
          return;
        }

        case 'UID': {
          if (!authed) { reply(`${tag} NO 请先登录\r\n`); return; }

          if (sub === 'SEARCH') {
            const unseen = state.messages
              .filter((m) => !m.flags.includes('\\Seen'))
              .map((m) => m.uid)
              .sort((a, b) => a - b);
            reply(`* SEARCH${unseen.length ? ' ' + unseen.join(' ') : ''}\r\n`);
            ok('SEARCH completed');
            return;
          }

          if (sub === 'FETCH') {
            const uid = Number(args[0]);
            const idx = state.messages.findIndex((m) => m.uid === uid);
            if (idx < 0) { ok('FETCH completed'); return; }
            const msg = state.messages[idx];
            const raw = msg.raw;
            const half = Math.floor(raw.length / 2);
            // 故意拆三段写：验证客户端能处理半包 + 字面量中间的任意切点
            sock.write(`* ${idx + 1} FETCH (UID ${uid} RFC822.SIZE ${raw.length} BODY[] {${raw.length}}\r\n`);
            sock.write(raw.subarray(0, half));
            setImmediate(() => {
              if (sock.destroyed) return;
              sock.write(raw.subarray(half));
              sock.write(')\r\n');
              ok('FETCH completed');
            });
            return;
          }

          reply(`${tag} BAD 不支持的 UID 子命令 ${sub}\r\n`);
          return;
        }

        case 'LOGOUT':
          reply('* BYE 再见\r\n');
          ok('LOGOUT completed');
          sock.end();
          return;

        default:
          reply(`${tag} BAD 未实现的命令 ${verb}\r\n`);
      }
    };

    const pump = () => {
      for (;;) {
        if (waiting) {
          if (buf.length < waiting) return;
          literals.push(Buffer.from(buf.subarray(0, waiting)));
          buf = buf.subarray(waiting);
          logical += `\u0000${literals.length - 1}\u0000`;
          waiting = 0;
          continue;
        }
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        let end = nl;
        if (end > 0 && buf[end - 1] === 0x0d) end--;
        const line = buf.subarray(0, end).toString('utf8');
        buf = buf.subarray(nl + 1);

        const lit = /\{(\d+)\}$/.exec(line);
        if (lit) {
          logical += line.slice(0, lit.index);
          waiting = Number(lit[1]);
          sock.write('+ 续行\r\n');
          continue;
        }
        const cmd = logical + line;
        logical = '';
        handle(cmd);
      }
    };

    sock.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      pump();
    });
  });

  return {
    server,
    state,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    addMessage(raw) {
      const uid = state.nextUid++;
      state.messages.push({ uid, raw, flags: [] });
      return uid;
    },
    close() {
      for (const s of sockets) { try { s.destroy(); } catch (e) { /* 忽略 */ } }
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

/* ============================ 1. MIME：base64 + GBK ============================ */

test('MIME：multipart + base64 + GBK 正文与 GBK 主题都能解对', () => {
  const raw = buildGbkVerificationMail('123456');

  // 先确认我们造的是真 GBK 字节：解回来必须一字不差
  const plainBytes = gbk('验证码');
  assert.equal(new TextDecoder('gbk').decode(plainBytes), '验证码');
  assert.notEqual(plainBytes[0], 0x3f);   // 不是被替换成 '?' 的假 GBK

  const mail = parseMessage(raw);

  assert.equal(mail.subject, '【QQ邮箱】登录验证码');
  assert.equal(mail.from.name, 'QQ邮箱安全中心');
  assert.equal(mail.from.address, 'security@qq.com');
  assert.match(mail.text, /您正在登录 QQ 邮箱/);
  assert.match(mail.text, /验证码是 123456/);
  assert.equal(mail.messageId, '<fake-mail-1@qq.com>');
  assert.ok(mail.html.includes('<b>123456</b>'), 'html 分支（QP + GBK）应解析成功');
  assert.match(htmlToText(mail.html), /验证码是 123456/);
  // 正文里的电话/订单号不该被当成验证码
  let got = extractCode({ subject: mail.subject, text: mail.text });
  assert.equal(got.code, '123456');

  // 只有 text/html 的 GBK 邮件：plain 拿不到时必须退回 html 去标签
  const htmlOnly = Buffer.concat([
    Buffer.from([
      'From: no-reply@example.com',
      'Subject: html only',
      'Content-Type: text/html; charset="gbk"',
      'Content-Transfer-Encoding: base64',
      ''
    ].join('\r\n') + '\r\n', 'latin1'),
    Buffer.from(b64Wrap(gbk('<div>您的动态码是 <b>246810</b>，请勿泄露</div>')), 'latin1')
  ]);
  const mail3 = parseMessage(htmlOnly);
  assert.match(mail3.text, /动态码是 246810/);
  assert.equal(extractCode({ subject: mail3.subject, text: mail3.text }).code, '246810');

  console.log('  [MIME] 主题=%s 发件人=%s 验证码=%s', mail.subject, mail.from.name, got.code);
});

test('字面量边界：正文里嵌伪造的 IMAP 响应也必须按长度原样取回', async (t) => {
  const evilBody = [
    'From: x@example.com',
    'Subject: 边界测试',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    ''
  ].join('\r\n') + '\r\n'
    + '正文里假装结束：\r\n)\r\nA9 OK FETCH completed\r\n* 9 FETCH (UID 9 BODY[] {5}\r\n'
    + '验证码 998877\r\n';
  const evil = Buffer.from(evilBody, 'utf8');

  const fake = createFakeImap({ messages: [{ uid: 201, raw: evil }] });
  const port = await fake.listen();
  t.after(() => fake.close());

  const client = new ImapClient({ host: '127.0.0.1', port, secure: false, timeout: 5000 });
  try {
    await client.connect();
    await client.login('u@example.com', 'fake-auth-code-123');
    await client.select('INBOX');
    const raw = await client.uidFetchBody(201);
    assert.ok(raw.equals(evil), '字面量必须逐字节一致（不能被正文里的伪响应截断）');
    assert.equal(extractCode({ text: parseMessage(raw).text }).code, '998877');
  } finally {
    await client.logout();
  }
});

/* ============================ 2. MIME：QP + UTF-8 ============================ */

test('MIME：quoted-printable + UTF-8 + 折行 RFC2047（B 与 Q 混用）', () => {
  const s1 = Buffer.from('您的', 'utf8').toString('base64');
  const s2 = Buffer.from('验证码', 'utf8').toString('base64');
  const qEnc = Array.from(Buffer.from('提醒：', 'utf8'))
    .map((b) => '=' + b.toString(16).toUpperCase().padStart(2, '0'))
    .join('');
  const bodyText = '您好，本次验证码是 987654，请在 10 分钟内使用。\r\n谢谢。\r\n';
  const head = [
    'From: test@example.com',
    `Subject: =?utf-8?B?${s1}?=\r\n =?utf-8?B?${s2}?= =?utf-8?Q?${qEnc}?=`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: quoted-printable',
    ''
  ].join('\r\n');

  const raw = Buffer.concat([Buffer.from(head + '\r\n', 'latin1'), Buffer.from(qpEncode(Buffer.from(bodyText, 'utf8')), 'latin1')]);
  const mail = parseMessage(raw);

  assert.equal(mail.subject, '您的验证码提醒：');     // 编码字之间的空白必须丢掉
  assert.match(mail.text, /本次验证码是 987654/);
  assert.equal(decodeWords('=?utf-8?B?6aqM6K+B56CB?='), '验证码');

  // multipart/mixed 里套 alternative，附件要跳过
  const nested = Buffer.from([
    'From: a@b.com',
    'Subject: nested',
    'Content-Type: multipart/mixed; boundary="OUT"',
    '',
    '--OUT',
    'Content-Type: multipart/alternative; boundary="IN"',
    '',
    '--IN',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('内层纯文本 4321', 'utf8').toString('base64'),
    '--IN',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>内层 HTML</p>',
    '--IN--',
    '',
    '--OUT',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Disposition: attachment; filename="a.txt"',
    '',
    '附件内容不应该被当成正文',
    '--OUT--',
    ''
  ].join('\r\n'), 'latin1');
  const mail2 = parseMessage(nested);
  assert.equal(mail2.text, '内层纯文本 4321');
  assert.ok(!mail2.text.includes('附件内容'));
});

/* ============================ 3. 验证码抽取 ============================ */

test('验证码抽取：关键词优先，排除手机号/金额/日期/订单号', () => {
  const cases = [
    ['【腾讯科技】验证码：849201，5 分钟内有效。', null, '849201'],
    ['您的登录校验码为 5521，请勿泄露。', null, '5521'],
    ['Your verification code is 552133. Do not share it.', null, '552133'],
    ['动态码 1234-5678 已发送', null, '12345678'],
    ['验证码：１２３４５６', null, '123456'],            // 全角数字
    ['您的手机号 13812345678，本次验证码 1234', null, '1234'],
    ['本次消费金额 5000 元，感谢惠顾', null, null],
    ['账户余额 ¥1,299.00', null, null],
    ['订单号 202611250001234567 已发货', null, null],
    ['会议时间 2026-11-25 10:30，地点 3 楼', null, null],
    ['您的验证码已过期，请重新获取', null, null],
    ['快递单号 SF1234567890123 派送中', null, null],
    ['2026 年度报告已生成，点击查看', null, null],
    ['验证码 847392 有效，此邮件为系统自动发送，订单号 88888888', null, '847392']
  ];
  for (const [text, subject, expect] of cases) {
    const got = extractCode({ subject: subject || '', text });
    assert.equal(got.code, expect, `文本「${text}」应抽到 ${expect}，实际 ${got.code}`);
    if (expect) {
      // 候选里可能带分隔符（1234-5678），context 按原文回显，比对时去掉分隔符
      assert.ok(got.context.replace(/[\s-]/g, '').includes(expect),
        `context 里应回显 ${expect}，实际 ${got.context}`);
    }
  }
  // 主题里带验证码
  assert.equal(extractCode({ subject: '验证码 776655', text: '这是一封很长的推广邮件，正文里有很多无关内容。'.repeat(20) }).code, '776655');
  console.log('  验证码抽取 %d 条用例全部通过', cases.length);
});

/* ============================ 4. IMAP 全链路 ============================ */

test('IMAP 全链路：CAPABILITY → LOGIN → SELECT → UID SEARCH → UID FETCH → 解码', async (t) => {
  const fake = createFakeImap({
    messages: [
      { uid: 101, raw: buildPlainMail() },
      { uid: 102, raw: buildGbkVerificationMail('123456') }
    ]
  });
  const port = await fake.listen();
  t.after(() => fake.close());

  const logs = [];
  const client = new ImapClient({
    host: '127.0.0.1', port, secure: false, timeout: 5000,
    log: (m) => logs.push(m)
  });
  try {
    await client.connect();

    const caps = await client.capability();
    assert.ok(caps.includes('IMAP4rev1'), 'CAPABILITY 应包含 IMAP4rev1');

    await client.login('u@example.com', 'fake-auth-code-123');

    // 中文邮箱名要先转成修改版 UTF-7（纯 ASCII）再上线路
    const box = await client.select('收件箱');
    assert.equal(box.exists, 2);
    assert.equal(box.uidNext, 103);
    assert.equal(box.uidValidity, 7777);
    const selectLine = fake.state.requests.find((r) => /SELECT/.test(r));
    assert.match(selectLine, /SELECT "&/, 'SELECT 的邮箱名必须是 UTF-7 编码');
    assert.ok(/^[\x20-\x7e]+$/.test(selectLine), '上线路必须是纯 ASCII');

    const uids = await client.uidSearch('UNSEEN');
    assert.deepEqual(uids, [101, 102]);

    const raw = await client.uidFetchBody(102);
    assert.ok(Buffer.isBuffer(raw) && raw.length > 200, '字面量应完整取回');

    const mail = parseMessage(raw);
    const got = extractCode({ subject: mail.subject, text: mail.text });
    assert.equal(mail.subject, '【QQ邮箱】登录验证码');
    assert.equal(got.code, '123456');

    // 取正文不能把未读标记改掉（BODY.PEEK）
    const fetchLine = fake.state.requests.find((r) => /FETCH/.test(r));
    assert.match(fetchLine, /BODY\.PEEK\[\]/);
    const again = await client.uidSearch('UNSEEN');
    assert.deepEqual(again, [101, 102], 'PEEK 不应改变 \\Seen 状态');

    console.log('  [全链路] caps=%s uids=%j 主题=%s 验证码=%s 原文=%d 字节',
      caps.join(','), uids, mail.subject, got.code, raw.length);
  } finally {
    await client.logout();
  }
});

/* ============================ 5. source 端到端 ============================ */

function makeCtx(cfg) {
  const events = [];
  const snaps = [];
  const logs = [];
  return {
    events, snaps, logs,
    ctx: {
      cfg: () => cfg,
      setCfg: () => {},
      emit: (e) => events.push(e),
      snapshot: (kind, data) => snaps.push({ kind, data }),
      log: (m) => logs.push(String(m)),
      dataDir: '.',
      appDir: '.',
      paths: {},
      hasFeature: () => false
    }
  };
}

test('source 端到端：首次只建基线不弹历史，新邮件 emit + snapshot', async (t) => {
  const fake = createFakeImap({ messages: [{ uid: 101, raw: buildPlainMail() }] });
  const port = await fake.listen();
  t.after(() => fake.close());

  const { ctx, events, snaps, logs } = makeCtx({
    enabled: true,
    host: '127.0.0.1',
    port,
    user: 'u@example.com',
    pass: 'fake-auth-code-123',
    folder: '收件箱',
    pollSec: 60,
    timeoutMs: 5000,
    secure: false              // 假服务端是明文，告诉 source 别握手
  });

  const src = createMailSource(ctx);
  assert.equal(src.name, 'mail');
  assert.equal(src.defaults.port, 993);

  try {
    await src.start();
    // 首次：只有基线快照，没有弹窗
    assert.equal(events.length, 0, '首次启动不能弹历史邮件');
    const base = snaps[snaps.length - 1];
    assert.equal(base.kind, 'mail');
    assert.equal(base.data.baseline, 101);
    assert.deepEqual(base.data.list, []);
    assert.match(src.status().detail, /运行中/);

    // 服务端"收到"一封新的 GBK 验证码邮件
    const newUid = fake.addMessage(buildGbkVerificationMail('123456'));
    assert.equal(newUid, 102);

    const r = await src.refresh();
    assert.equal(r.ok, true, JSON.stringify(r));

    assert.equal(events.length, 1, '应只弹一封');
    const evt = events[0];
    assert.equal(evt.source, 'mail');
    assert.equal(evt.kind, 'mail');
    assert.equal(evt.level, 'warn');
    assert.match(evt.title, /^邮件 · /);
    assert.match(evt.body, /验证码 123456/);
    assert.equal(evt.data.code, '123456');
    assert.equal(evt.data.uid, 102);
    assert.equal(evt.key, 'mail:127.0.0.1:102');
    assert.equal(evt.actions[0].kind, 'copy');
    assert.equal(evt.actions[0].payload, '123456');
    assert.ok(evt.body.length <= 90, 'body 不超过 90 字');

    const snap = snaps[snaps.length - 1];
    assert.equal(snap.data.list.length, 1);
    assert.equal(snap.data.list[0].code, '123456');

    // 再刷一次：同一封不会重复弹
    await src.refresh();
    assert.equal(events.length, 1, '同一封邮件不能重复弹窗');

    // 日志里绝不能出现授权码明文
    assert.ok(!logs.join('\n').includes('fake-auth-code-123'), '日志不能出现授权码明文');
    assert.ok(logs.some((l) => l.includes('fa…18')), '日志里的授权码应为 前2位+长度 形态');

    console.log('  [source] 基线=%s 事件=%j', base.data.baseline, {
      title: evt.title, body: evt.body, code: evt.data.code, key: evt.key
    });
  } finally {
    await src.stop();
  }
});

/* ============================ 6. 错误路径 ============================ */

test('密码错误：不抛顶层，状态报错且日志脱敏', async (t) => {
  const fake = createFakeImap({});
  const port = await fake.listen();
  t.after(() => fake.close());

  const secret = 'wrong-secret-xyz-9';
  const { ctx, events, logs } = makeCtx({
    enabled: true, host: '127.0.0.1', port, user: 'u@example.com', pass: secret,
    folder: 'INBOX', pollSec: 60, timeoutMs: 5000, secure: false
  });
  const src = createMailSource(ctx);

  await src.start();                       // 不能抛
  const st = src.status();
  assert.equal(st.ready, false);
  assert.match(st.detail, /连接失败/);
  assert.ok(!st.detail.includes(secret), '状态里不能出现授权码');

  const probe = await src.probe();
  assert.equal(probe.ok, false);
  assert.ok(!probe.detail.includes(secret));

  assert.equal(events.length, 0);
  assert.ok(!logs.join('\n').includes(secret), '日志不能出现授权码明文');

  await src.stop();
  console.log('  [错误路径] status.detail=%s', st.detail);
});

test('服务器不回话：连接阶段超时，错误可捕获', async (t) => {
  const dead = net.createServer((sock) => { sock.on('error', () => {}); /* 静默，不回问候 */ });
  const port = await new Promise((resolve) => dead.listen(0, '127.0.0.1', () => resolve(dead.address().port)));
  t.after(() => new Promise((resolve) => { dead.close(resolve); }));

  const client = new ImapClient({ host: '127.0.0.1', port, secure: false, timeout: 300 });
  await assert.rejects(() => client.connect(), /超时/);
  client.close();
  console.log('  [超时] 300ms 内正确报超时');
});

test('非 ASCII 凭据走字面量 LOGIN（{n} 续行）', async (t) => {
  const fake = createFakeImap({ user: '测试用户', pass: '授权码-中文-123' });
  const port = await fake.listen();
  t.after(() => fake.close());

  const client = new ImapClient({ host: '127.0.0.1', port, secure: false, timeout: 5000 });
  try {
    await client.connect();
    await client.login('测试用户', '授权码-中文-123');
    const box = await client.select('INBOX');
    assert.equal(box.exists, 0);
    // 服务端确实收到了完整的 UTF-8 凭据（不是被截断的 '?'）
    const loginLine = fake.state.requests.find((r) => /LOGIN/.test(r));
    assert.ok(loginLine.includes('测试用户') && loginLine.includes('授权码-中文-123'),
      '字面量 LOGIN 应完整送达凭据：' + loginLine);
  } finally {
    await client.logout();
  }
});

/* ============================ 7. 工具函数 ============================ */

test('脱敏与 UTF-7 编码', () => {
  assert.equal(maskSecret('fake-auth-code-123'), 'fa…18');
  assert.equal(maskSecret(''), '(空)');
  const enc = utf7Encode('其他文件夹');
  assert.ok(/^[\x20-\x7e]+$/.test(enc), 'UTF-7 输出必须纯 ASCII');
  assert.match(enc, /^&/);
  assert.equal(utf7Encode('INBOX'), 'INBOX');
  assert.equal(utf7Encode('Tom & Jerry'), 'Tom &- Jerry');
});
