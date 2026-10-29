#!/usr/bin/env node
/**
 * dock-demo.js — 手边没有 Agent 也能验收「Agent 看板」：往本地 hub 按剧本推状态
 *
 * 跑法（桌宠开着、看板服务在跑）：
 *   node tools/dock-demo.js                 # 默认推给 hermes + claude-code + codex
 *   node tools/dock-demo.js --port=8770 --agent=hermes
 *
 * 剧本：开始干活 → 调工具 → 流式输出 → 等你确认 → 结束（done）→ 报错（error）
 * 全程约 14 秒，桌宠会跟着演：操作中 → 举手 → 跳一下（庆祝）→ 晕菜（报错）。
 */
'use strict';

const http = require('node:http');

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};
const PORT = Number(arg('port', '8770'));
const AGENT = arg('agent', 'hermes');
const SESSION = arg('session', 'demo-' + Math.random().toString(36).slice(2, 7));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/state', method: 'POST',
      headers: { 'Content-Type': 'application/json' } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

(async () => {
  const base = { agent: AGENT, session_id: SESSION, session_title: '看板演示会话', cwd: process.cwd() };
  const steps = [
    [0, '开始处理：帮我整理这周的日志', { hook_event_name: 'on_session_start' }, {}],
    [700, '提交提问', { hook_event_name: 'pre_llm_call', prompt: '帮我整理这周的日志' }, {}],
    [900, '调用工具 terminal', { hook_event_name: 'pre_tool_call', tool_name: 'terminal' }, {}],
    [1200, '工具返回', { hook_event_name: 'post_tool_call', tool_name: 'terminal' }, {}],
    [1200, '流式输出中', { hook_event_name: 'on_stream_delta', last_assistant_message: '正在汇总这周的构建与测试结果…' }, {}],
    [1500, '等你确认', { hook_event_name: 'on_human_input_request', message: '要我把结果写进文件吗？' }, {}],
    [2200, '你点了确认', { hook_event_name: 'on_human_input_resolved' }, {}],
    [1800, '收尾输出', { hook_event_name: 'on_stream_end', last_assistant_message: '整理完了，共 12 条记录。' }, {}],
    [900, '结束', { hook_event_name: 'agent_loop_stopped' }, {}],
  ];
  console.log(`demo → http://127.0.0.1:${PORT}/state  agent=${AGENT} session=${SESSION}`);
  for (const [wait, label, payload] of steps) {
    await sleep(wait);
    const r = await post({ ...base, ...payload });
    console.log(`  ${r.status}  ${label}`);
    if (r.status !== 200) { console.log('  响应：', r.body); break; }
  }
  await sleep(600);
  const err = await post({ ...base, hook_event_name: 'api_request_error', message: '演示：错误态' });
  console.log(`  ${err.status}  演示错误态（桌宠会演"晕菜"，60 秒后自动收起）`);
})().catch((e) => {
  console.error('演示失败：hub 没在跑？先启动桌宠。\n' + ((e && e.message) || e));
  process.exit(1);
});
