'use strict';
/* =====================================================================
   tests/infohub/napcat.test.js —— napcat 源模块测试（零依赖，自带 assert）
   自带一个 node:net 假 OneBot WS 服务端（真握手 + 掩码帧解析），
   分别驱动「原生 WebSocket」与「内建 WsLite」两条链路。
   跑法：node tests/infohub/napcat.test.js
   ===================================================================== */

const assert = require('node:assert');
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');

const createNapcat = require(path.join(__dirname, '..', '..', 'app', 'infohub', 'sources', 'napcat.js'));

/* ---------------- 极简断言框架 ---------------- */
let pass = 0;
const fails = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(() => { pass++; console.log('  ok   ' + name); },
      (e) => { fails.push({ name, e }); console.log('  FAIL ' + name + ' → ' + e.message); });
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    fails.push({ name, e });
    console.log('  FAIL ' + name + ' → ' + e.message);
  }
  return Promise.resolve();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 假 OneBot WS 服务端 ---------------- */
function frame(op, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
  head[0] = 0x80 | (op & 0x0f);
  return Buffer.concat([head, data]);
}

function startFakeOneBot() {
  const state = { conns: 0, frames: [], sockets: [] };
  const server = net.createServer((socket) => {
    let hs = false;
    let buf = Buffer.alloc(0);
    state.sockets.push(socket);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!hs) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.slice(0, end).toString('latin1');
        buf = buf.slice(end + 4);
        const key = (/sec-websocket-key:\s*(\S+)/i.exec(head) || [])[1];
        const accept = crypto.createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
          'Connection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        hs = true;
        state.conns += 1;
        return;
      }
      // 解析客户端帧（带掩码）
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        let mask = null;
        if (masked) { if (buf.length < off + 4) return; mask = buf.slice(off, off + 4); off += 4; }
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.slice(off, off + len));
        buf = buf.slice(off + len);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        state.frames.push({ op, text: payload.toString('utf8') });
        if (op === 0x9) socket.write(frame(0xa, payload));      // 回 pong
        if (op === 0x8) { try { socket.end(); } catch (e) {} }
      }
    });
    socket.on('close', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        state,
        port,
        url: 'ws://127.0.0.1:' + port,
        send(obj) {
          const s = state.sockets[state.sockets.length - 1];
          if (!s || s.destroyed) throw new Error('没有活跃连接');
          s.write(frame(0x1, JSON.stringify(obj)));
        },
        ping() {
          const s = state.sockets[state.sockets.length - 1];
          if (!s || s.destroyed) throw new Error('没有活跃连接');
          s.write(frame(0x9, 'hi'));
        },
        kill() {
          for (const s of state.sockets) { try { s.destroy(); } catch (e) {} }
        },
        close() { return new Promise((r) => server.close(() => r())); },
      });
    });
  });
}

/* ---------------- 单测：纯函数 ---------------- */
function makeCtx(cfgOver, events) {
  return {
    cfg: () => cfgOver,
    setCfg: () => {},
    emit: (e) => events.push(e),
    snapshot: () => {},
    log: () => {},
    dataDir: __dirname,
    appDir: path.join(__dirname, '..', '..', 'app'),
    paths: {},
  };
}

const SAMPLE_PRIVATE = {
  time: 1763100000, self_id: 10001, post_type: 'message', message_type: 'private',
  sub_type: 'friend', message_id: 9001, user_id: 20002,
  raw_message: '晚上吃饭吗', font: 0,
  sender: { user_id: 20002, nickname: '张三' },
};

const SAMPLE_GROUP = {
  time: 1763100100, self_id: 10001, post_type: 'message', message_type: 'group',
  sub_type: 'normal', message_id: 9002, group_id: 30003, group_name: '约120群',
  user_id: 20003, raw_message: '&#91;CQ:at,qq=10001&#93; 看这个[CQ:image,file=a.jpg]&#91;CQ:face,id=14&#93;',
  sender: { user_id: 20003, nickname: '李四', card: '李四' },
};

async function runWith(impl, label) {
  console.log('\n[' + label + ']');
  const srv = await startFakeOneBot();
  const events = [];
  const ctx = makeCtx({ enabled: true, wsUrl: srv.url, wsImpl: impl, reconnectBase: 60, reconnectMax: 200 }, events);
  const mod = createNapcat(ctx);

  await test('接口形状：name/label/defaults/方法齐全', () => {
    assert.strictEqual(mod.name, 'napcat');
    assert.strictEqual(mod.label, 'QQ 消息');
    assert.strictEqual(mod.defaults.wsUrl, 'ws://127.0.0.1:3000');
    assert.strictEqual(mod.defaults.enabled, false);
    for (const k of ['start', 'stop', 'status', 'refresh', 'probe']) assert.strictEqual(typeof mod[k], 'function', k);
  });

  await test('start() 后完成 WS 握手并进入运行中', async () => {
    await mod.start();
    for (let i = 0; i < 80 && !mod.status().ready; i++) await sleep(25);
    assert.strictEqual(mod.status().ready, true, '状态未就绪：' + JSON.stringify(mod.status()));
    assert.match(mod.status().detail, /运行中/);
    assert.ok(srv.state.conns >= 1, '服务端没收到连接');
    await sleep(30);
  });

  await test('私聊消息 → 一条 message 事件，title/body 正确', async () => {
    srv.send(SAMPLE_PRIVATE);
    for (let i = 0; i < 60 && events.length < 1; i++) await sleep(25);
    assert.strictEqual(events.length, 1, '事件数=' + events.length);
    const e = events[0];
    assert.strictEqual(e.source, 'napcat');
    assert.strictEqual(e.kind, 'message');
    assert.strictEqual(e.level, 'warn');                       // 私聊一律 warn
    assert.strictEqual(e.title, 'QQ · 张三');
    assert.strictEqual(e.body, '晚上吃饭吗');
    assert.strictEqual(e.key, 'napcat:m:9001');
    assert.strictEqual(e.actions.length, 2);
    assert.strictEqual(e.actions[0].kind, 'copy');
    assert.strictEqual(e.actions[1].payload, 'qq');
    assert.strictEqual(e.data.chatType, 'private');
    assert.ok(!('token' in e.data));
  });

  await test('群聊 + CQ 码清洗 + 被@ → warn、title 含群名/昵称', async () => {
    srv.send(SAMPLE_GROUP);
    for (let i = 0; i < 60 && events.length < 2; i++) await sleep(25);
    assert.strictEqual(events.length, 2, '事件数=' + events.length);
    const e = events[1];
    assert.strictEqual(e.title, 'QQ · 约120群 / 李四');
    assert.strictEqual(e.level, 'warn', '被@应为 warn');
    assert.strictEqual(e.body, '@我 看这个[图片][表情]');
    assert.ok(!/\[CQ:/.test(e.body), 'CQ 码没洗干净：' + e.body);
    assert.strictEqual(e.data.atMe, true);
    assert.strictEqual(e.data.groupId, 30003);
  });

  await test('自己的消息被忽略（message_sent / user_id==self_id）', async () => {
    const before = events.length;
    srv.send({ time: 1763100200, self_id: 10001, post_type: 'message_sent', message_type: 'private', message_id: 9003, user_id: 10001, raw_message: '我自己发的' });
    srv.send({ time: 1763100201, self_id: 10001, post_type: 'message', message_type: 'group', message_id: 9004, group_id: 30003, user_id: 10001, raw_message: '同号自发', sender: { nickname: '我' } });
    srv.send({ time: 1763100202, self_id: 10001, post_type: 'notice', notice_type: 'group_increase', message_id: 9005 });
    await sleep(150);
    assert.strictEqual(events.length, before, '自己/非消息事件被误处理了');
  });

  await test('正文截断到 90 字以内并加省略号', async () => {
    const long = '很长的消息'.repeat(40);
    srv.send({ ...SAMPLE_PRIVATE, message_id: 9006, raw_message: long });
    for (let i = 0; i < 60 && events.length < 3; i++) await sleep(25);
    const e = events[events.length - 1];
    assert.strictEqual(events.length, 3);
    assert.ok(e.body.length <= 90, 'body 长度=' + e.body.length);
    assert.ok(e.body.endsWith('…'));
  });

  await test('服务端杀连接 → 状态变「已断线，重试中」并自动重连', async () => {
    const connsBefore = srv.state.conns;
    srv.kill();
    for (let i = 0; i < 60 && mod.status().ready; i++) await sleep(20);
    assert.strictEqual(mod.status().ready, false, '断线后 ready 仍是 true');
    assert.match(mod.status().detail, /重试中/, mod.status().detail);
    for (let i = 0; i < 120 && srv.state.conns <= connsBefore; i++) await sleep(25);
    assert.ok(srv.state.conns > connsBefore, '没有发起重连');
    for (let i = 0; i < 80 && !mod.status().ready; i++) await sleep(25);
    assert.strictEqual(mod.status().ready, true, '重连后未 ready：' + JSON.stringify(mod.status()));
  });

  await test('重连后仍能收消息', async () => {
    const before = events.length;
    srv.send({ ...SAMPLE_PRIVATE, message_id: 9007, raw_message: '重连后的消息' });
    for (let i = 0; i < 80 && events.length <= before; i++) await sleep(25);
    assert.strictEqual(events.length, before + 1);
    assert.strictEqual(events[events.length - 1].body, '重连后的消息');
  });

  await test('stop() 清干净定时器且状态为已停止', async () => {
    await mod.stop();
    assert.strictEqual(mod.status().ready, false);
    assert.match(mod.status().detail, /已停止/);
    const n = events.length;
    srv.kill();
    await sleep(200);
    assert.strictEqual(events.length, n, 'stop() 后还有事件进来');
  });

  await srv.close();
}

/* ---------------- 纯函数级断言 ---------------- */
async function runPure() {
  console.log('\n[纯函数]');
  const { cleanCq, toEvent, clip } = createNapcat._internals;

  await test('cleanCq：face/image/at/未知码 全部转成中文占位', () => {
    assert.strictEqual(cleanCq('[CQ:face,id=1]'), '[表情]');
    assert.strictEqual(cleanCq('a[CQ:image,file=x.png,url=http://x]b'), 'a[图片]b');
    assert.strictEqual(cleanCq('[CQ:at,qq=all] 全体'), '@全体成员 全体');
    assert.strictEqual(cleanCq('[CQ:at,qq=10001] 你好', 10001), '@我 你好');
    assert.strictEqual(cleanCq('[CQ:at,qq=29999] 你好', 10001), '@某人 你好');
    assert.strictEqual(cleanCq('[CQ:reply,id=5]内容'), '内容');
    assert.strictEqual(cleanCq('  a   b \n c  '), 'a b c');
    assert.strictEqual(cleanCq('[CQ:unknown_type,id=1]hi'), 'hi');
  });

  await test('toEvent：非法/空消息返回 null', () => {
    assert.strictEqual(toEvent(null), null);
    assert.strictEqual(toEvent({ post_type: 'meta_event' }), null);
    assert.strictEqual(toEvent({ post_type: 'message', raw_message: '[CQ:reply,id=1]', user_id: 1, self_id: 2 }), null);
  });

  await test('clip：90 字上限', () => {
    assert.strictEqual(clip('abc'), 'abc');
    assert.strictEqual(clip('字'.repeat(200)).length, 90);
  });

  await test('群聊未被@ → info 级', () => {
    const e = toEvent({ post_type: 'message', message_type: 'group', group_id: 1, group_name: 'G', user_id: 5, self_id: 9, message_id: 77, raw_message: '大家好', sender: { nickname: '王五' } });
    assert.strictEqual(e.level, 'info');
    assert.strictEqual(e.title, 'QQ · G / 王五');
  });
}

/* ---------------- 全局 WebSocket 不存在时的自动降级 ---------------- */
async function runAuto(noNative) {
  console.log('\n[auto 模式' + (noNative ? '，且删除全局 WebSocket' : '') + ']');
  const saved = globalThis.WebSocket;
  if (noNative) delete globalThis.WebSocket;
  let srv = null;
  try {
    const events = [];
    await test('typeof WebSocket = ' + (noNative ? 'undefined（内建实现接管）' : 'function'), async () => {
      assert.strictEqual(typeof WebSocket, noNative ? 'undefined' : 'function');
    });
    await test('auto 模式自动选择实现并连上假 OneBot', async () => {
      srv = await startFakeOneBot();
      globalThis.__autoMod = createNapcat(makeCtx({ enabled: true, wsUrl: srv.url, reconnectBase: 60 }, events));
      await globalThis.__autoMod.start();
      for (let i = 0; i < 80 && !globalThis.__autoMod.status().ready; i++) await sleep(25);
      const detail = globalThis.__autoMod.status().detail;
      assert.strictEqual(globalThis.__autoMod.status().ready, true, '状态未就绪：' + detail);
      assert.match(detail, noNative ? /内建 WS/ : /原生 WS/, '实现选择不对：' + detail);
    });
    await test('auto 模式收消息正常，stop() 后干净退出', async () => {
      const mod = globalThis.__autoMod;
      srv.send(SAMPLE_PRIVATE);
      for (let i = 0; i < 60 && events.length < 1; i++) await sleep(25);
      assert.strictEqual(events.length, 1);
      await mod.stop();
      srv.kill();
      await srv.close();
    });
  } finally {
    delete globalThis.__autoMod;
    if (noNative && saved) globalThis.WebSocket = saved;
  }
}

/* ---------------- 主流程 ---------------- */
(async () => {
  await runPure();
  await runWith('lite', '内建 WsLite（node:net 手写 WS）');
  await runWith('native', '原生 WebSocket');
  await runAuto(false);
  await runAuto(true);

  console.log('\n===============================');
  if (fails.length) {
    console.log('失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项');
    for (const f of fails) console.log(' - ' + f.name + '：' + (f.e && f.e.stack ? f.e.stack.split('\n')[0] : f.e));
    process.exitCode = 1;
  } else {
    console.log('全部通过：' + pass + ' 项');
  }
})();
