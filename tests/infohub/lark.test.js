'use strict';
/* =====================================================================
   tests/infohub/lark.test.js —— lark 源模块测试（零依赖，自带 assert）
   · 纯解析函数用固定 JSON 样本断言
   · 整条轮询链路用「假 lark-cli」（node 脚本）驱动：基线 → 新消息 → 去重 → 60 秒静默
   · 最后真跑本机 lark-cli --version / --probe，把真实环境结论打出来
   跑法：node tests/infohub/lark.test.js
   ===================================================================== */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SRC = path.join(__dirname, '..', '..', 'app', 'infohub', 'sources', 'lark.js');
const createLark = require(SRC);
const { parseChats, parseMessages, toEvent, parseCliJson, resolveCli } = createLark._internals;

/* ---------------- 极简断言框架 ---------------- */
let pass = 0;
const fails = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { pass++; console.log('  ok   ' + name); },
        (e) => { fails.push({ name, e }); console.log('  FAIL ' + name + ' → ' + e.message); });
    }
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    fails.push({ name, e });
    console.log('  FAIL ' + name + ' → ' + e.message);
  }
  return Promise.resolve();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 固定 JSON 样本（按真实 lark OpenAPI 形状） ---------------- */
const SAMPLE_CHAT_LIST = {
  ok: true,
  identity: 'user',
  data: {
    chats: [
      { chat_id: 'oc_aaa111', name: '项目组', chat_type: 'group', external: false },
      { chat_id: 'oc_bbb222', name: '', chat_type: 'p2p', external: false },
    ],
    has_more: false,
    page_token: '',
  },
};

const SAMPLE_MESSAGES = {
  ok: true,
  identity: 'user',
  data: {
    items: [
      {
        message_id: 'om_0001',
        chat_id: 'oc_aaa111',
        msg_type: 'text',
        create_time: '1763100000000',
        sender: { id: 'ou_xxxx', sender_type: 'user', name: '张三' },
        body: { content: '{"text":"晚上开会吗"}' },
        deleted: false,
      },
      {
        message_id: 'om_0002',
        chat_id: 'oc_aaa111',
        msg_type: 'post',
        create_time: '1763100010000',
        sender: { id: 'ou_yyyy', name: '李四' },
        body: { content: '{"title":"周报","content":[[{"tag":"text","text":"本周进度 "},{"tag":"at","user_id":"ou_me","user_name":"我"},{"tag":"img"}]]}' },
      },
      {
        message_id: 'om_0003',
        chat_id: 'oc_aaa111',
        msg_type: 'image',
        create_time: '1763100020000',
        sender: { id: 'ou_yyyy', name: '李四' },
        body: { content: '{"image_key":"img_v2_xxx"}' },
      },
    ],
    has_more: false,
  },
};

/* ---------------- 假 lark-cli（node 脚本） ---------------- */
function makeMockCli(dir) {
  const stateFile = path.join(dir, 'state.json');
  const cliFile = path.join(dir, 'fake-lark-cli.js');
  const script = `'use strict';
const fs = require('fs');
const path = require('path');
const stateFile = ${JSON.stringify(stateFile)};
const argv = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
function out(o, code) { process.stdout.write(JSON.stringify(o)); process.exitCode = code || 0; }
function fail(msg) {
  const payload = { ok: false, identity: 'user', error: { type: st.authError || 'authentication', message: msg } };
  process.stderr.write(JSON.stringify(payload));
  process.exitCode = 3;
}
if (argv[0] === 'auth') {
  out({ appId: 'cli_mock', identities: { user: { status: 'ready', available: true }, bot: { status: 'ready', available: true } }, identity: 'user' });
} else if (argv[1] === '+chat-list') {
  if (st.authError) { fail('need_user_authorization (mock)'); }
  else { out({ ok: true, identity: 'user', data: { chats: st.chats, has_more: false } }); }
} else if (argv[1] === '+chat-messages-list') {
  const ci = argv.indexOf('--chat-id');
  const chatId = ci > 0 ? argv[ci + 1] : '';
  if (st.authError) { fail('need_user_authorization (mock)'); }
  else {
    const m = (st.last || {})[chatId];
    out({ ok: true, identity: 'user', data: { items: m ? [m] : [], has_more: false } });
  }
} else {
  out({ ok: true, version: 'fake-1.0.0' });
}
`;
  fs.writeFileSync(cliFile, script, 'utf8');
  const write = (obj) => fs.writeFileSync(stateFile, JSON.stringify(obj), 'utf8');
  return { cliFile, write };
}

function makeCtx(cfgOver, events) {
  return {
    cfg: () => cfgOver,
    setCfg: () => {},
    emit: (e) => events.push(e),
    snapshot: () => {},
    log: () => {},
    dataDir: os.tmpdir(),
    appDir: path.join(__dirname, '..', '..', 'app'),
    paths: { localAppData: process.env.LOCALAPPDATA || os.homedir(), home: os.homedir() },
  };
}

/* ---------------- 1. 纯解析 ---------------- */
async function runPure() {
  console.log('\n[解析函数]');

  await test('parseChats：群名/单聊兜底名/类型/顺序', () => {
    const chats = parseChats(SAMPLE_CHAT_LIST);
    assert.strictEqual(chats.length, 2);
    assert.strictEqual(chats[0].chatId, 'oc_aaa111');
    assert.strictEqual(chats[0].name, '项目组');
    assert.strictEqual(chats[0].type, 'group');
    assert.strictEqual(chats[1].name, '单聊');           // name 空 → 兜底
    assert.strictEqual(chats[1].rank, 1);
  });

  await test('parseChats：兼容 data.items 与空返回', () => {
    assert.strictEqual(parseChats({ data: { items: [{ chat_id: 'oc_x', name: 'X' }] } }).length, 1);
    assert.strictEqual(parseChats({ data: { chats: null } }).length, 0);
    assert.strictEqual(parseChats(null).length, 0);
  });

  await test('parseMessages：text / post 富文本 / image 都能抠出正文', () => {
    const msgs = parseMessages(SAMPLE_MESSAGES, { chatId: 'oc_aaa111' });
    assert.strictEqual(msgs.length, 3);
    assert.strictEqual(msgs[0].text, '晚上开会吗');
    assert.strictEqual(msgs[0].sender, '张三');
    assert.strictEqual(msgs[1].text, '本周进度 @我[图片]');
    assert.strictEqual(msgs[2].text, '[图片]');
    assert.strictEqual(msgs[0].createTime, 1763100000000);
  });

  await test('toEvent：title/body/key 正确', () => {
    const chat = parseChats(SAMPLE_CHAT_LIST)[0];
    const msg = parseMessages(SAMPLE_MESSAGES, chat)[0];
    const e = toEvent(msg, chat);
    assert.strictEqual(e.source, 'lark');
    assert.strictEqual(e.kind, 'message');
    assert.strictEqual(e.title, '飞书 · 项目组 / 张三');
    assert.strictEqual(e.body, '晚上开会吗');
    assert.strictEqual(e.key, 'lark:m:oc_aaa111:om_0001');
    assert.strictEqual(e.level, 'info');
    assert.strictEqual(e.actions.length, 2);
    assert.strictEqual(e.data.chatId, 'oc_aaa111');
  });

  await test('toEvent：@我 → warn；无正文 → 「有新消息」；deleted → null', () => {
    const chat = { chatId: 'oc_1', name: '团建群', type: 'group' };
    const at = toEvent({ chatId: 'oc_1', messageId: 'om_9', text: '@我 看下这个', sender: '王五', createTime: 1 }, chat);
    assert.strictEqual(at.level, 'warn');
    assert.strictEqual(at.title, '飞书 · 团建群 / 王五');
    const empty = toEvent({ chatId: 'oc_1', messageId: 'om_10', text: '', sender: '', createTime: 1 }, chat);
    assert.strictEqual(empty.body, '有新消息');
    const withUnread = toEvent({ chatId: 'oc_1', messageId: 'om_11', text: '', createTime: 1 }, chat, { unread: 3 });
    assert.strictEqual(withUnread.body, '3 条未读');
    assert.strictEqual(toEvent({ chatId: 'oc_1', messageId: 'om_12', text: 'x', deleted: true }, chat), null);
  });

  await test('parseCliJson：能从夹着日志的输出里取对象', () => {
    const j = parseCliJson('WARN something\n{"ok":true,"data":{"a":1}}\n');
    assert.strictEqual(j.ok, true);
    assert.strictEqual(parseCliJson('').ok, false);
    assert.strictEqual(parseCliJson('not json').ok, false);
  });
}

/* ---------------- 2. 假 CLI 驱动整条链路 ---------------- */
async function runPipeline() {
  console.log('\n[轮询链路（假 lark-cli）]');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infohub-lark-'));
  const mock = makeMockCli(dir);
  const msg = (id, text, sender) => ({
    message_id: id, chat_id: 'oc_aaa111', msg_type: 'text',
    create_time: String(Date.now()), sender: { id: 'ou_1', name: sender || '张三' },
    body: { content: JSON.stringify({ text }) },
  });
  mock.write({
    chats: [{ chat_id: 'oc_aaa111', name: '项目组', chat_type: 'group' }],
    last: { oc_aaa111: msg('om_1', '旧消息') },
  });

  const events = [];
  const ctx = makeCtx({ enabled: true, cliPath: mock.cliFile, warmupSec: 0, maxChats: 3, pollSec: 30 }, events);
  const mod = createLark(ctx);

  await test('接口形状：name/label/defaults/方法齐全', () => {
    assert.strictEqual(mod.name, 'lark');
    assert.strictEqual(mod.label, '飞书消息');
    assert.strictEqual(mod.defaults.pollSec, 30);
    for (const k of ['start', 'stop', 'status', 'refresh', 'probe']) assert.strictEqual(typeof mod[k], 'function', k);
  });

  await test('start()：首轮只建基线，不弹历史消息', async () => {
    await mod.start();
    await sleep(50);
    assert.strictEqual(events.length, 0, '基线阶段弹了 ' + events.length + ' 条');
    assert.strictEqual(mod.status().ready, true, mod.status().detail);
    assert.match(mod.status().detail, /1 个会话/);
  });

  await test('会话最后一条消息变了 → 产出一条 message 事件', async () => {
    mock.write({
      chats: [{ chat_id: 'oc_aaa111', name: '项目组', chat_type: 'group' }],
      last: { oc_aaa111: msg('om_2', '新消息来了') },
    });
    await mod.refresh();
    await sleep(20);
    assert.strictEqual(events.length, 1, '事件数=' + events.length);
    const e = events[0];
    assert.strictEqual(e.title, '飞书 · 项目组 / 张三');
    assert.strictEqual(e.body, '新消息来了');
    assert.strictEqual(e.key, 'lark:m:oc_aaa111:om_2');
    assert.strictEqual(e.data.chatType, 'group');
  });

  await test('同一条消息再轮询 → 按 chat_id+message_id 去重，不重复弹', async () => {
    await mod.refresh();
    await mod.refresh();
    await sleep(20);
    assert.strictEqual(events.length, 1, '重复弹了：' + events.length);
  });

  await test('又来一条新消息 → 正常再弹', async () => {
    mock.write({
      chats: [{ chat_id: 'oc_aaa111', name: '项目组', chat_type: 'group' }],
      last: { oc_aaa111: msg('om_3', '@我 帮忙看下') },
    });
    await mod.refresh();
    await sleep(20);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[1].level, 'warn');
  });

  await test('stop() 后状态为已停止，不再轮询', async () => {
    await mod.stop();
    assert.strictEqual(mod.status().ready, false);
    assert.match(mod.status().detail, /已停止/);
    const n = events.length;
    mock.write({ chats: [], last: {} });
    await sleep(120);
    assert.strictEqual(events.length, n);
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------------- 3. 60 秒静默期 ---------------- */
async function runWarmup() {
  console.log('\n[启动 60 秒静默]');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infohub-lark-warm-'));
  const mock = makeMockCli(dir);
  const last = (id, text) => ({ message_id: id, chat_id: 'oc_w', msg_type: 'text', create_time: String(Date.now()), sender: { name: '赵六' }, body: { content: JSON.stringify({ text }) } });
  mock.write({ chats: [{ chat_id: 'oc_w', name: '静默群', chat_type: 'group' }], last: { oc_w: last('om_10', '基线') } });
  const events = [];
  const mod = createLark(makeCtx({ enabled: true, cliPath: mock.cliFile, warmupSec: 60 }, events));

  await test('基线建立后，静默期内的新消息不弹但被记为已见', async () => {
    await mod.start();
    mock.write({ chats: [{ chat_id: 'oc_w', name: '静默群', chat_type: 'group' }], last: { oc_w: last('om_11', '静默期的新消息') } });
    await mod.refresh();
    await sleep(20);
    assert.strictEqual(events.length, 0, '静默期不该弹：' + events.length);
    assert.match(mod.status().detail, /本轮新消息 0 条/);
  });

  await test('静默期内同一 id 不会被下次补弹（不炸屏）', async () => {
    await mod.refresh();
    await sleep(20);
    assert.strictEqual(events.length, 0);
  });

  await mod.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------------- 4. 认证失败路径 ---------------- */
async function runAuthFail() {
  console.log('\n[认证失败路径]');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infohub-lark-auth-'));
  const mock = makeMockCli(dir);
  mock.write({ authError: 'authentication', chats: [], last: {} });
  const events = [];
  const mod = createLark(makeCtx({ enabled: true, cliPath: mock.cliFile, warmupSec: 0, as: 'user' }, events));

  await test('lark-cli 报 token 失效 → status 如实写原因，不抛异常', async () => {
    await mod.start();
    assert.strictEqual(mod.status().ready, false);
    assert.match(mod.status().detail, /未登录|token/i, mod.status().detail);
    assert.strictEqual(events.length, 0);
  });

  await test('probe() 返回 ok:false + errorType=authentication', async () => {
    const p = await mod.probe();
    assert.strictEqual(p.ok, false);
    assert.strictEqual(p.errorType, 'authentication');
  });

  await mod.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------------- 5. 真 CLI 环境 ---------------- */
function spawnOnce(file, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(file, args, { windowsHide: true }); } catch (e) { resolve({ ok: false, out: '', err: e.message }); return; }
    let out = '';
    let err = '';
    const t = setTimeout(() => { try { child.kill(); } catch (e) {} resolve({ ok: false, out, err: 'timeout' }); }, timeoutMs || 15000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, out, err, code }); });
  });
}

async function runRealCli() {
  console.log('\n[本机真实 lark-cli]');
  const cli = resolveCli({ cfg: () => ({}), paths: { localAppData: process.env.LOCALAPPDATA } });

  await test('能定位到 lark-cli 可执行文件', () => {
    assert.ok(cli && cli.exe, '没定位到 lark-cli');
    if (cli.kind !== 'path') assert.ok(fs.existsSync(cli.exe), '路径不存在：' + cli.exe);
    console.log('       入口：' + cli.exe + '（' + cli.kind + '）');
  });

  await test('lark-cli --version 真跑成功', async () => {
    const r = await spawnOnce(cli.exe, ['--version'], 15000);
    const line = (r.out || r.err || '').trim().split('\n')[0];
    assert.ok(/lark-cli version|version/i.test(line), '输出异常：' + JSON.stringify(r).slice(0, 200));
    console.log('       ' + line);
  });

  await test('probe() 真跑（身份/会话数按本机实际情况，不伪造）', async () => {
    const mod = createLark(makeCtx({ enabled: false }, []));
    const p = await mod.probe();
    console.log('       detail=' + p.detail + '  identity=' + p.identity + '  chats=' + p.chats);
    assert.strictEqual(typeof p.ok, 'boolean');
    assert.strictEqual(typeof p.detail, 'string');
  });
}

/* ---------------- 主流程 ---------------- */
(async () => {
  await runPure();
  await runPipeline();
  await runWarmup();
  await runAuthFail();
  await runRealCli();

  console.log('\n===============================');
  if (fails.length) {
    console.log('失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项');
    for (const f of fails) console.log(' - ' + f.name + '：' + (f.e && f.e.stack ? f.e.stack.split('\n')[0] : f.e));
    process.exitCode = 1;
  } else {
    console.log('全部通过：' + pass + ' 项');
  }
})();
