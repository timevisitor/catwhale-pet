'use strict';
// 运行：node --test tests/llm-character.test.cjs   （离线：本地起一个假 SSE 服务）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../app/llm-client');
const C = require('../app/character-card');

const ICON = fs.readFileSync(path.join(__dirname, '..', 'app', 'assets', 'icon.png'));
const SAMPLE = {
  spec: 'chara_card_v2', spec_version: '2.0',
  data: { name: '小鲸', description: '{{char}}是住在{{user}}桌面上的猫鲸。', personality: '傲娇、嘴硬心软',
    scenario: '深夜加班', first_mes: '{{user}}，又熬夜？', mes_example: '<START>\n{{user}}: 你好\n{{char}}: 哼。',
    system_prompt: '', post_history_instructions: '保持简短', tags: ['猫', '鲸'],
    extensions: { memory: '私密记忆不应被导出', chat: [{ text: '聊天记录' }] },
    character_book: { entries: [{ content: '世界书' }] } },
};

test('endpoint 规范化', () => {
  assert.equal(L.endpointFor('openai', 'https://api.deepseek.com/'), 'https://api.deepseek.com/chat/completions');
  assert.equal(L.endpointFor('openai', 'http://x/v1/chat/completions'), 'http://x/v1/chat/completions');
  assert.equal(L.endpointFor('anthropic', 'https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
  assert.equal(L.endpointFor('anthropic', 'https://ps.example.com/v1'), 'https://ps.example.com/v1/messages');
  assert.throws(() => L.endpointFor('openai', 'ftp://x'));
});

test('anthropic 请求体：system 抽出、相邻同角色合并、首条为 user', () => {
  const r = L.buildRequest({ protocol: 'anthropic', baseUrl: 'https://a', model: 'm', apiKey: 'k',
    messages: [{ role: 'system', content: 'S1' }, { role: 'assistant', content: 'hi' },
               { role: 'user', content: 'u1' }, { role: 'user', content: 'u2' }, { role: 'system', content: 'S2' }] });
  assert.equal(r.body.system, 'S1\n\nS2');
  assert.equal(r.body.messages[0].role, 'user');
  assert.deepEqual(r.body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(r.body.messages[2].content, 'u1\n\nu2');
  assert.equal(r.headers['x-api-key'], 'k');
  assert.ok(r.headers['anthropic-version']);
});

function sseServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('openai 流式：拼接增量 + usage + [DONE]', async () => {
  let got = null;
  const srv = await sseServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      got = { url: req.url, auth: req.headers.authorization, body: JSON.parse(b) };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // 故意把一个事件拆成两半发，验证跨块解析
      res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"de');
      setTimeout(() => {
        res.write('lta":{"content":"好"}}]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n');
        res.end('data: [DONE]\n\n');
      }, 20);
    });
  });
  const evts = [];
  const r = await L.streamChat({ protocol: 'openai', baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, model: 'gpt-x', apiKey: 'sk-1',
    messages: [{ role: 'user', content: 'hi' }] }, (e) => evts.push(e)).promise;
  srv.close();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, '你好');
  assert.equal(got.url, '/v1/chat/completions');
  assert.equal(got.auth, 'Bearer sk-1');
  assert.equal(got.body.stream, true);
  assert.deepEqual(r.usage, { inputTokens: 5, outputTokens: 2 });
  assert.deepEqual(evts.filter((e) => e.kind === 'delta').map((e) => e.text), ['你', '好']);
  assert.equal(evts.at(-1).kind, 'turnEnd');
});

test('anthropic 流式：content_block_delta', async () => {
  const srv = await sseServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"喵"}}\n\n');
      res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":1}}\n\n');
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
  });
  const r = await L.streamChat({ protocol: 'anthropic', baseUrl: `http://127.0.0.1:${srv.address().port}`, model: 'c', apiKey: 'k',
    messages: [{ role: 'user', content: 'hi' }] }).promise;
  srv.close();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, '喵');
  assert.deepEqual(r.usage, { inputTokens: 9, outputTokens: 1 });
});

test('HTTP 错误带回状态码与正文；取消可中断', async () => {
  const srv = await sseServer((req, res) => {
    req.resume();
    if (req.url.includes('bad')) { res.writeHead(401); res.end('{"error":"invalid key"}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ping\n\n');   // 挂住不结束
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const r1 = await L.streamChat({ protocol: 'openai', baseUrl: base + '/bad', model: 'm', messages: [{ role: 'user', content: 'x' }] }).promise;
  assert.equal(r1.ok, false); assert.match(r1.error, /HTTP 401.*invalid key/);
  const h = L.streamChat({ protocol: 'openai', baseUrl: base, model: 'm', messages: [{ role: 'user', content: 'x' }] });
  setTimeout(() => h.abort(), 50);
  const r2 = await h.promise;
  srv.closeAllConnections(); srv.close();
  assert.equal(r2.ok, false); assert.equal(r2.error, '已取消');
});

test('角色卡：V2 归一 + 导出白名单剥掉记忆/世界书/扩展', () => {
  const v2 = C.toV2(SAMPLE);
  const s = JSON.stringify(v2);
  assert.equal(v2.spec, 'chara_card_v2');
  assert.equal(v2.data.name, '小鲸');
  assert.ok(!s.includes('私密记忆'), '记忆被导出了');
  assert.ok(!s.includes('聊天记录'));
  assert.ok(!s.includes('世界书'));
  assert.equal(v2.data.extensions.catwhale.kind, 'persona-only');
});

test('角色卡：V1 扁平 / V3 / 缺 name 报错', () => {
  assert.equal(C.normalizeCard({ char_name: 'A', char_persona: 'p' }).description, 'p');
  assert.equal(C.normalizeCard({ spec: 'chara_card_v3', data: { name: 'B', description: 'd' } }).name, 'B');
  assert.throws(() => C.normalizeCard({ description: 'x' }), /name/);
  assert.throws(() => C.normalizeCard({ name: 'x' }), /人设/);
});

test('PNG 往返：写入 chara+ccv3，读回一致，图像块保持不变，CRC 正确', () => {
  const png = C.cardToPng(SAMPLE, ICON);
  const t = C.pngTextEntries(png);
  assert.ok(t.chara && t.ccv3);
  const back = C.parseCardFile(png);
  assert.equal(back.format, 'png');
  assert.equal(back.card.name, '小鲸');
  assert.equal(back.card.personality, '傲娇、嘴硬心软');
  // 图像数据块（IDAT）逐字节不变
  const idat = (b) => Buffer.concat(C.readPngChunks(b).filter((c) => c.type === 'IDAT').map((c) => c.data));
  assert.ok(idat(png).equals(idat(ICON)));
  // 每个块 CRC 都对
  let p = 8;
  while (p < png.length) {
    const len = png.readUInt32BE(p);
    const td = png.subarray(p + 4, p + 8 + len);
    assert.equal(png.readUInt32BE(p + 8 + len), C.crc32(td));
    p += 12 + len;
  }
  // 再写一次不会叠加出两份 chara
  const twice = C.cardToPng(back.card, png);
  assert.equal(C.readPngChunks(twice).filter((c) => c.type === 'tEXt').length, 2);
});

test('PNG 只有 V2 chara 块（酒馆旧版导出）也能读', () => {
  const b64 = Buffer.from(JSON.stringify(SAMPLE)).toString('base64');
  // 手工造一张只带 chara 的图
  const withBoth = C.cardToPng(SAMPLE, ICON);
  const chunks = C.readPngChunks(withBoth).filter((c) => !(c.type === 'tEXt' && c.data.toString('latin1', 0, 4) === 'ccv3'));
  const parts = [withBoth.subarray(0, 8)];
  for (const c of chunks) {
    const len = Buffer.alloc(4); len.writeUInt32BE(c.data.length);
    const td = Buffer.concat([Buffer.from(c.type, 'latin1'), c.data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(C.crc32(td));
    parts.push(len, td, crc);
  }
  const onlyV2 = Buffer.concat(parts);
  assert.ok(!C.pngTextEntries(onlyV2).ccv3);
  assert.equal(C.parseCardFile(onlyV2).card.name, '小鲸');
  assert.ok(b64.length > 0);
});

test('无卡的普通 PNG 给出明确错误', () => {
  assert.throws(() => C.parseCardFile(ICON), /没有角色卡数据/);
});

test('组提示词：宏替换 + 分层 + 历史后指令 + 预算裁剪顺序', () => {
  const p = C.composeSystemPrompt(SAMPLE, { userName: '主人' });
  assert.match(p.system, /小鲸是住在主人桌面上的猫鲸/);
  assert.match(p.system, /【场景】/);
  assert.match(p.system, /【对话示例/);
  assert.equal(p.greeting, '主人，又熬夜？');
  assert.equal(p.post, '保持简短');
  assert.ok(!p.system.includes('{{'));
  const small = C.composeSystemPrompt(SAMPLE, { maxChars: 120 });
  assert.deepEqual(small.omitted, ['example', 'scene']);
  assert.match(small.system, /【人设】/);
  const msgs = C.buildMessages(SAMPLE, [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }, { role: 'err', text: 'x' }], 'c');
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'system', 'user']);
  assert.equal(msgs.at(-1).content, 'c');
});

test('角色库：导入 PNG→激活→按角色分聊天记录→导出不含记忆→删除回落', () => {
  const os = require('node:os');
  const { createPersonaStore } = require('../app/persona-store');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-persona-'));
  try {
    const st = createPersonaStore(root);
    const png = C.cardToPng(SAMPLE, ICON);
    const r = st.importBuffer(png);
    assert.equal(r.format, 'png');
    assert.equal(st.list().length, 1);
    assert.equal(st.historyFile('LEGACY'), 'LEGACY');
    st.setActive(r.id);
    assert.equal(st.active().card.name, '小鲸');
    assert.ok(st.historyFile('LEGACY').includes(path.join('chat-history', r.id + '.json')));
    const outJson = JSON.parse(st.exportBuffer(r.id, 'json').toString('utf8'));
    assert.ok(!JSON.stringify(outJson).includes('私密记忆'));
    const outPng = st.exportBuffer(r.id, 'png');
    assert.equal(C.parseCardFile(outPng).card.name, '小鲸');
    assert.throws(() => st.get('../evil'), /非法/);
    st.remove(r.id);
    assert.equal(st.activeId(), '');
    assert.equal(st.list().length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
