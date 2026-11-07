#!/usr/bin/env node
/**
 * dock-selftest.js — Agent 看板中枢（app/agent-dock.js）的无界面自检
 *
 * 跑法：node tools/dock-selftest.js
 * 覆盖：HTTP 契约 / 三套 payload 形状 / 状态归一 / 生命周期与保留 / dsh 原生通道 /
 *       日志适配（近实时 working、刚结束 done、过旧丢弃）/ 列表排序 / 选择与清理 / 大包与坏包。
 * 输出每项 PASS/FAIL，最后给汇总；退出码 0 = 全过。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createAgentDock } = require('../app/agent-dock.js');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
}
function eq(name, actual, expected) { ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected }); }

function post(port, body, { raw = false } = {}) {
  return new Promise((resolve) => {
    const data = raw ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/state', method: 'POST',
      headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* 非 JSON 时留 null */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: String(e && e.message) }));
    req.end(data);
  });
}

function get(port, p) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch { /* ignore */ } resolve({ status: res.statusCode, body: j }); });
    }).on('error', (e) => resolve({ status: 0, error: String(e && e.message) }));
  });
}

(async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-selftest-'));
  const claudeRoot = path.join(tmpHome, '.claude', 'projects', 'demo');
  fs.mkdirSync(claudeRoot, { recursive: true });

  const dock = createAgentDock({
    port: 0,
    env: { USERPROFILE: tmpHome, HOME: tmpHome, APPDATA: path.join(tmpHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(tmpHome, 'AppData', 'Local') },
    cfg: { claudeRoot, codexRoot: path.join(tmpHome, '.codex', 'sessions'), pollMs: 100_000 },
    log: () => {},
  });
  const info = await dock.start();
  const port = info.port;
  ok('服务只绑 127.0.0.1', info.host === '127.0.0.1', info);
  ok('端口拿到（随机）', port > 1024, info);

  /* ---------- 1. 健康检查 / 空快照 ---------- */
  const health = await get(port, '/health');
  ok('GET /health 200 + app 标识', health.status === 200 && health.body.app === 'catwhale-agent-dock', health.body);
  const empty = await get(port, '/api');
  eq('空快照 sessions=[] 且 state=idle', [empty.status, empty.body.sessions.length, empty.body.state], [200, 0, 'idle']);
  ok('快照带 8 个通道', empty.body.channels.length === 8, empty.body.channels.map((c) => c.id));

  /* ---------- 2. Hermes 形状 ---------- */
  let r = await post(port, {
    hook_event_name: 'pre_tool_call', profile: 'default', session_id: 'sessA',
    tool_name: 'terminal', cwd: 'H:\\Hermes交付\\demo', timestamp: new Date().toISOString(),
  });
  ok('Hermes pre_tool_call 接收成功', r.status === 200 && r.body.session.agent === 'hermes', r.body);
  let snap = (await get(port, '/api')).body;
  const h1 = snap.sessions.find((s) => s.sessionId === 'sessA');
  ok('Hermes 会话 state=working', h1 && h1.state === 'working', h1);
  eq('Hermes 会话保留工具名', h1 && h1.tool, 'terminal');
  eq('标题回落到 cwd 目录名', h1 && h1.title, 'demo');

  r = await post(port, { hook_event_name: 'pre_tool_call', session_id: 'sessA', tool_name: 'read_file', cwd: 'H:\\Hermes交付\\demo' });
  snap = (await get(port, '/api')).body;
  eq('同一 session 不新增气泡（去重）', snap.sessions.filter((s) => s.agent === 'hermes').length, 1);

  await post(port, { hook_event_name: 'on_human_input_request', session_id: 'sessA' });
  snap = (await get(port, '/api')).body;
  eq('on_human_input_request → waiting_user', snap.sessions.find((s) => s.sessionId === 'sessA').state, 'waiting_user');

  await post(port, { hook_event_name: 'agent_loop_stopped', session_id: 'sessA' });
  snap = (await get(port, '/api')).body;
  eq('agent_loop_stopped → done', snap.sessions.find((s) => s.sessionId === 'sessA').state, 'done');

  /* ---------- 3. 别的项目（Clawd/HachimoDock）形状 ---------- */
  await post(port, { state: 'attention', agent_id: 'claude-code', session_id: 'cc1', session_title: '重构外壳', prompt: '把窗口改透明' });
  snap = (await get(port, '/api')).body;
  const cc = snap.sessions.find((s) => s.sessionId === 'cc1');
  ok('裸 state=attention 归一到 done', cc && cc.state === 'done', cc);
  eq('session_title 生效', cc && cc.title, '重构外壳');
  eq('prompt 落到 lastUser', cc && cc.lastUser, '把窗口改透明');

  await post(port, { state: 'juggling', agent_id: 'claude-code', session_id: 'cc2' });
  snap = (await get(port, '/api')).body;
  eq('state=juggling 归一到 working', snap.sessions.find((s) => s.sessionId === 'cc2').state, 'working');

  /* ---------- 4. 自定义 agent ---------- */
  r = await post(port, { agent: 'my-bot', state: 'working', session_id: 'x1' });
  ok('自定义 agent 被接受', r.status === 200 && r.body.session.agent === 'my-bot', r.body);
  snap = (await get(port, '/api')).body;
  ok('自定义 agent 有显示名回落', !!snap.sessions.find((s) => s.sessionId === 'x1'));

  /* ---------- 5. 排序：等确认/报错优先 ---------- */
  const order = snap.sessions.map((s) => s.state);
  ok('waiting_user 排在 working 之前', order.indexOf('waiting_user') < order.indexOf('working'), order);

  /* ---------- 6. dsh 原生通道 ---------- */
  dock.feedHarness('status', { state: 'busy' });
  snap = (await get(port, '/api')).body;
  eq('dsh busy → working', snap.sessions.find((s) => s.agent === 'dsh').state, 'working');
  dock.feedHarness('event', { kind: 'delta', text: '正在写代码' });
  snap = (await get(port, '/api')).body;
  const dsh = snap.sessions.find((s) => s.agent === 'dsh');
  eq('dsh delta → speaking', dsh.state, 'speaking');
  eq('dsh 最后一句被记录', dsh.lastAgent, '正在写代码');
  dock.feedHarness('event', { kind: 'turnEnd', reason: { kind: 'error' } });
  snap = (await get(port, '/api')).body;
  eq('dsh turnEnd(error) → error', snap.sessions.find((s) => s.agent === 'dsh').state, 'error');

  /* ---------- 7. 生命周期：done 保留 / 过期移除 ---------- */
  const keepDoneMs = dock.cfg.keepDoneMs;
  dock.sessions.get('hermes::sessA').updatedAt = Date.now() - keepDoneMs - 1000;
  dock._expire(Date.now());
  ok('done 超过保留期被移除', !dock.sessions.has('hermes::sessA'));

  /* 等确认一直没有结果（Agent 已死、没发事件）→ 到 staleWaitingMs 也要收掉 */
  dock.sessions.set('hermes::wait-stale', {
    key: 'hermes::wait-stale', agent: 'hermes', agentName: 'Hermes', accent: '#5b9dff', sessionId: 'wait-stale',
    state: 'waiting_user', event: 'on_human_input_request', title: 'x', cwd: '', tool: '',
    lastUser: '', lastAgent: '', source: 'push', firstSeenAt: Date.now(), updatedAt: Date.now(), stateSince: Date.now(),
  });
  dock._expire(Date.now());
  ok('waiting_user 在 staleWaitingMs 内保留', dock.sessions.has('hermes::wait-stale'));
  dock.sessions.get('hermes::wait-stale').updatedAt = Date.now() - dock.cfg.staleWaitingMs - 1000;
  dock._expire(Date.now());
  ok('waiting_user 超过 staleWaitingMs 被收起', !dock.sessions.has('hermes::wait-stale'));

  dock.sessions.get('claude-code::cc2').updatedAt = Date.now() - dock.cfg.staleWorkingMs - 1000;
  dock._expire(Date.now());
  ok('working 失联超时被移除', !dock.sessions.has('claude-code::cc2'));

  /* 流式输出中（speaking）：Hermes 会话被中断/关窗时不会有收尾事件，最后一条往往是 on_stream_delta，
     以前这类会话会永久挂在"输出中"（实测挂过 839 分钟）。必须和 working 一样有失联超时。 */
  const mkPush = (key, state) => dock.sessions.set(key, {
    key, agent: 'hermes', agentName: 'Hermes', accent: '#5b9dff', sessionId: key.split('::')[1],
    state, event: 'on_stream_delta', title: 'x', cwd: '', tool: '', lastUser: '', lastAgent: '',
    source: 'push', firstSeenAt: Date.now(), updatedAt: Date.now(), stateSince: Date.now(),
  });
  mkPush('hermes::speak-live', 'speaking');
  dock._expire(Date.now());
  ok('speaking 在 staleSpeakingMs 内保留', dock.sessions.has('hermes::speak-live'));
  dock.sessions.get('hermes::speak-live').updatedAt = Date.now() - dock.cfg.staleSpeakingMs - 1000;
  dock._expire(Date.now());
  ok('speaking 超过 staleSpeakingMs 被收起', !dock.sessions.has('hermes::speak-live'));

  mkPush('hermes::idle-stale', 'idle');
  dock.sessions.get('hermes::idle-stale').updatedAt = Date.now() - dock.cfg.staleIdleMs - 1000;
  dock._expire(Date.now());
  ok('idle 超过 staleIdleMs 被收起', !dock.sessions.has('hermes::idle-stale'));

  /* ---------- 8. 日志适配器 ---------- */
  const claudeFile = path.join(claudeRoot, 'sess-log.jsonl');
  const lines = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '帮我看看这个报错' }] }, timestamp: new Date().toISOString() },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '先定位到 loadActiveSkin' }] }, timestamp: new Date().toISOString() },
  ];
  fs.writeFileSync(claudeFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  dock._scanLogs(Date.now());
  snap = (await get(port, '/api')).body;
  const logSess = snap.sessions.find((s) => s.source === 'log');
  ok('日志里 10 秒内的会话被识别为 working', logSess && logSess.state === 'working', logSess);
  eq('日志会话标题取最后一句用户话', logSess && logSess.title, '帮我看看这个报错');
  eq('日志会话带上 Agent 最后一句', logSess && logSess.lastAgent, '先定位到 loadActiveSkin');

  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(claudeFile, old, old);
  dock._scanLogs(Date.now());
  snap = (await get(port, '/api')).body;
  eq('日志 60 秒前 → done', snap.sessions.find((s) => s.sessionId === 'sess-log').state, 'done');

  const veryOld = new Date(Date.now() - 200_000);
  fs.utimesSync(claudeFile, veryOld, veryOld);
  dock._scanLogs(Date.now());
  snap = (await get(port, '/api')).body;
  ok('日志 200 秒前不产生气泡', !snap.sessions.find((s) => s.sessionId === 'sess-log'));

  /* ---------- 9. 选择 / 翻页 / 钉住 / 清理 ---------- */
  dock.pin(null);
  const cyc = dock.cycleSession(1);
  ok('cycleSession 能选中一个会话', typeof cyc === 'string' && !!dock.sessions.get(cyc), cyc);
  eq('选中后 selected 同步为它的 agent', dock.snapshot().selected, dock.sessions.get(cyc).agent);
  const before = dock.sessions.size;
  const removed = dock.clearEnded();
  ok('clearEnded 只清已结束的', removed >= 1 && dock.sessions.size === before - removed, { before, removed, after: dock.sessions.size });

  /* ---------- 10. 坏包 / 大包 ---------- */
  const bad = await post(port, '{not json', { raw: true });
  eq('坏 JSON → 400', bad.status, 400);
  const big = await post(port, JSON.stringify({ agent: 'hermes', state: 'working', blob: 'x'.repeat(70 * 1024) }), { raw: true });
  eq('超过 64KB → 413', big.status, 413);

  /* ---------- 11. 高频推送不崩 ---------- */
  const t0 = Date.now();
  for (let i = 0; i < 40; i++) await post(port, { agent: 'hermes', state: 'working', session_id: 'burst' });
  const dt = Date.now() - t0;
  snap = (await get(port, '/api')).body;
  ok('40 次连推后仍是 1 个气泡', snap.sessions.filter((s) => s.sessionId === 'burst').length === 1, { dt });
  ok('40 次连推耗时可接受(<3s)', dt < 3000, { dt });

  await dock.stop();
  fs.rmSync(tmpHome, { recursive: true, force: true });

  console.log('\n===== ' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ` : ${pass} passed, ${fail} failed =====`);
  if (fail) console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('SELFTEST CRASH', e); process.exit(2); });
