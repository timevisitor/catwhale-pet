#!/usr/bin/env node
/**
 * dock-install-hermes-hooks.js — 把 Hermes 的生命周期事件接到桌宠的 Agent 看板
 *
 * 做的事：在 Hermes 的 config.yaml 里加一条 hooks.outbound（只加不改），
 * 让 Hermes 的 pre_tool_call / on_human_input_request / api_request_error … 直接
 * POST 到 http://127.0.0.1:<port>/state。写之前备份，写完用 `hermes hooks list` 自检。
 *
 * 跑法：
 *   node tools/dock-install-hermes-hooks.js                # 安装（幂等，重复跑不会重复加）
 *   node tools/dock-install-hermes-hooks.js --dry-run      # 只打印将写入的片段
 *   node tools/dock-install-hermes-hooks.js --remove       # 摘掉这条（按 name 定位）
 *   node tools/dock-install-hermes-hooks.js --port=8770 --hermes="C:/Users/x/AppData/Local/hermes"
 *
 * 注意：Hermes 的 hooks 在**进程启动时注册**，改完要重启 Hermes（新会话不够）才生效。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a === undefined ? d : a.slice(n.length + 3);
};
const DRY = process.argv.includes('--dry-run');
const REMOVE = process.argv.includes('--remove');
const PORT = Number(arg('port', '8770'));
const NAME = 'catwhale-agent-dock';

const HERMES_HOME = arg('hermes', process.env.HERMES_HOME || path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes'));
const CONFIG = path.join(HERMES_HOME, 'config.yaml');

const EVENTS = [
  'pre_llm_call', 'post_llm_call',
  'pre_tool_call', 'post_tool_call',
  'on_stream_start', 'on_stream_delta', 'on_stream_end',
  'on_human_input_request', 'on_human_input_resolved',
  'pre_approval_request', 'post_approval_response',
  'subagent_start', 'subagent_stop',
  'api_request_error',
  'on_session_start', 'on_session_end', 'agent_loop_stopped',
];

function block() {
  const lines = [
    '  outbound:',
    `    # 桌宠「Agent 看板」：把 Hermes 的生命周期事件实时推到本机 127.0.0.1:${PORT}/state`,
    `    - name: ${NAME}`,
    `      url: http://127.0.0.1:${PORT}/state`,
    '      events:',
    ...EVENTS.map((e) => `        - ${e}`),
    '      timeout: 2',
  ];
  return lines.join('\n') + '\n';
}

function readConfig() {
  if (!fs.existsSync(CONFIG)) {
    console.error('找不到 Hermes 配置：' + CONFIG + '\n可用 --hermes=<目录> 指定（该目录下应有 config.yaml）');
    process.exit(2);
  }
  return fs.readFileSync(CONFIG, 'utf8');
}

function alreadyWired(text) {
  return text.includes(NAME) || text.includes(`127.0.0.1:${PORT}/state`);
}

function insertBlock(text) {
  const lines = text.split('\n');
  const hookIdx = lines.findIndex((l) => /^hooks\s*:\s*$/.test(l));
  if (hookIdx >= 0) {
    /* hooks: 已存在：若已有 outbound 就插到它下面，否则紧跟 hooks: 行插入 */
    const outIdx = lines.findIndex((l, i) => i > hookIdx && /^\s{2}outbound\s*:\s*$/.test(l));
    const anchor = outIdx >= 0 ? outIdx : hookIdx;
    const tail = block().split('\n').filter((l, i) => i > 0);   // 去掉 "  outbound:" 这行
    if (outIdx >= 0) {
      /* 已有 outbound：把 - name 起始的条目插到该段最后（找到下一个缩进 ≤2 的非空行） */
      let end = outIdx + 1;
      while (end < lines.length && (/^\s{4,}/.test(lines[end]) || lines[end].trim() === '')) end++;
      lines.splice(end, 0, ...tail.slice(2));                     // 跳过注释行与 outbound:
      return lines.join('\n');
    }
    lines.splice(anchor + 1, 0, ...tail);
    return lines.join('\n');
  }
  /* 完全没有 hooks: → 追加到文件末尾 */
  const tail = text.endsWith('\n') ? '' : '\n';
  return text + tail + '\nhooks:\n' + block();
}

function removeBlock(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.includes(NAME));
  if (start < 0) return { text, removed: false };
  let from = start;
  while (from > 0 && /^\s*#/.test(lines[from - 1])) from--;     // 连注释一起摘
  let to = start + 1;
  while (to < lines.length && (/^\s{6,}/.test(lines[to]) || lines[to].trim() === '')) to++;
  lines.splice(from, to - from);
  /* outbound: 空了就把这行也摘掉 */
  const outIdx = lines.findIndex((l) => /^\s{2}outbound\s*:\s*$/.test(l));
  if (outIdx >= 0 && !lines.slice(outIdx + 1, outIdx + 3).some((l) => /^\s{4,}-/.test(l))) lines.splice(outIdx, 1);
  return { text: lines.join('\n'), removed: true };
}

function hermesCli() {
  const cands = [
    path.join(HERMES_HOME, 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
    path.join(HERMES_HOME, 'bin', 'hermes.exe'),
    path.join(HERMES_HOME, 'bin', 'hermes.cmd'),
  ];
  return cands.find((p) => fs.existsSync(p)) || null;
}

function verify() {
  const cli = hermesCli();
  if (!cli) { console.log('（没找到 hermes 可执行文件，跳过 CLI 自检；配置语法可用 YAML 解析器复查）'); return; }
  execFile(cli, ['hooks', 'list'], { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
    const out = String(stdout || '') + String(stderr || '');
    const hit = out.includes(NAME) || out.includes(`127.0.0.1:${PORT}`);
    console.log('\n— hermes hooks list —');
    console.log(out.trim().split('\n').slice(0, 24).join('\n'));
    console.log('\n自检：' + (hit ? '✅ 配置已被 Hermes 识别' : '⚠️ hooks list 里没看到这条（可能 CLI 路径不对，或 events 名不合法）'));
  });
}

(function main() {
  const text = readConfig();
  console.log('配置：' + CONFIG);

  if (REMOVE) {
    const r = removeBlock(text);
    if (!r.removed) { console.log('没找到 ' + NAME + '，无需移除'); return; }
    if (DRY) { console.log('（dry-run）将移除 ' + NAME); return; }
    fs.writeFileSync(CONFIG + '.bak-dock-' + Date.now(), text, 'utf8');
    fs.writeFileSync(CONFIG, r.text, 'utf8');
    console.log('已移除。重新启动 Hermes 生效。');
    verify();
    return;
  }

  if (alreadyWired(text)) { console.log('已经接过了（配置里有 ' + NAME + ' 或同端口地址），跳过。'); verify(); return; }

  const next = insertBlock(text);
  const preview = next.slice(Math.max(0, next.indexOf('hooks:') - 0), next.indexOf('hooks:') + 700);
  if (DRY) { console.log('（dry-run）将写入：\n' + preview); return; }

  const bak = CONFIG + '.bak-dock-' + Date.now();
  fs.writeFileSync(bak, text, 'utf8');
  fs.writeFileSync(CONFIG, next, 'utf8');
  console.log('已写入，备份：' + bak);
  console.log('提示：Hermes 的 hooks 在进程启动时注册 → **重启 Hermes** 后才开始推送。');
  verify();
})();
