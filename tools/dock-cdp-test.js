#!/usr/bin/env node
/**
 * dock-cdp-test.js — 真机（真 Electron 窗口）验收 Agent 看板的界面与联动
 *
 * 前置：桌宠已启动且带调试口，例如
 *   ./app/node_modules/electron/dist/electron.exe app \
 *     --user-data-dir="H:/hermes project/桌宠/build/_dock_ud" --remote-debugging-port=9333
 *
 * 跑法：node tools/dock-cdp-test.js [--port=9333] [--dock=8770] [--shot=build/dock.png]
 * 覆盖：dock.js 是否加载 / 快照通道 / 推 3 个 Agent 后胶囊与列表 /
 *       点卡片选中与详情开合 / 静音开关 / 桌宠状态机是否跟着变 / 控制台报错。
 *       按键台（SW1-3 + 五向）已按用户要求删除，这里断言它确实不存在。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const CDP_PORT = Number(arg('port', '9333'));
const DOCK_PORT = Number(arg('dock', '8770'));
const SHOT = arg('shot', 'build/dock-cdp.png');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function postState(body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: DOCK_PORT, path: '/state', method: 'POST',
      headers: { 'Content-Type': 'application/json' } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, error: String(e && e.message) }));
    req.end(data);
  });
}

async function cdpTarget() {
  for (let i = 0; i < 20; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch { /* 调试口刚起时偶尔连不上 */ }
    await sleep(500);
  }
  throw new Error('找不到 CDP 页面靶子，确认桌宠带 --remote-debugging-port=' + CDP_PORT + ' 在跑');
}

(async () => {
  const target = await cdpTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  async function ev(expr, awaitPromise = false) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    if (r.result && r.result.exceptionDetails) return { __error: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  await send('Runtime.enable');
  await send('Page.enable');

  /* ---------- 1. 页面基础 ---------- */
  ok('页面没有脚本错误', !(await ev('window.__petError || ""')), await ev('window.__petError || ""'));
  ok('页面初始化完成', (await ev('!!window.__petInitOK')) === true);
  ok('DockUI 已挂上 window', (await ev('!!window.DockUI')) === true);
  ok('#dockcdn' && '胶囊与面板节点存在', (await ev('!!document.getElementById("dockchip") && !!document.getElementById("dockpan")')) === true);

  const snap0 = await ev('window.petHost.dock.get()', true);
  ok('主进程返回快照', snap0 && snap0.ok === true && Array.isArray(snap0.sessions), snap0 && snap0.error);
  ok('快照里有 8 个通道', snap0 && snap0.channels && snap0.channels.length === 8, snap0 && snap0.channels && snap0.channels.map((c) => c.id));
  ok('端口与 hub 一致', snap0 && Number(snap0.port) === DOCK_PORT, snap0 && snap0.port);
  const chMap = Object.fromEntries(((snap0 && snap0.channels) || []).map((c) => [c.id, c]));
  ok('Hermes 通道可用', !!(chMap.hermes && chMap.hermes.available));
  ok('Codex 通道可用（本机装了）', !!(chMap.codex && chMap.codex.available), chMap.codex && chMap.codex.detail);
  ok('DeepSeek Harness 通道可用', !!(chMap.dsh && chMap.dsh.available), chMap.dsh && chMap.dsh.detail);

  /* ---------- 2. 推 3 个 Agent（会话 id 每次唯一，hub 有历史残留也不影响本用例） ---------- */
  const RUN = Date.now().toString(36);
  const SID = { h: 'cdp-h-' + RUN, cc: 'cdp-cc-' + RUN, wb: 'cdp-wb-' + RUN, cel: 'cdp-cel-' + RUN };
  const r1 = await postState({ hook_event_name: 'pre_tool_call', session_id: SID.h, tool_name: 'terminal', cwd: 'H:\\Hermes交付\\Agent看板' });
  const r2 = await postState({ agent: 'claude-code', state: 'waiting_user', session_id: SID.cc, session_title: '改窗口透明' });
  const r3 = await postState({ state: 'attention', agent_id: 'workbuddy', session_id: SID.wb, session_title: '写周报', prompt: '整理这周的记录' });
  ok('三次推送都被接收', r1.status === 200 && r2.status === 200 && r3.status === 200, [r1.status, r2.status, r3.status]);
  await sleep(700);

  const chipVis = await ev('getComputedStyle(document.getElementById("dockchip")).display !== "none"');
  ok('胶囊自动出现', chipVis === true);
  const chipTxt = await ev('document.getElementById("dockchip").innerText.replace(/\\s+/g," ")');
  const snapC = await ev('window.DockUI.snapshot()');
  const totalC = ((snapC && snapC.sessions) || []).length;
  ok('胶囊上的会话数与快照一致', totalC <= 1 || String(chipTxt).includes(String(totalC)), { chipTxt, totalC });

  /* ---------- 3. 打开面板 ---------- */
  await ev('window.DockUI.open(); true');
  await sleep(400);
  const panShown = await ev('document.getElementById("dockpan").classList.contains("show")');
  ok('面板能打开', panShown === true);
  const ourIds = [SID.h, SID.cc, SID.wb];
  const ours = await ev(`(()=>{ const ids=${JSON.stringify(ourIds)};
    return [...document.querySelectorAll('#dockpan .dk-item')]
      .filter(n=>ids.includes(String(n.dataset.key||'').split('::')[1])).length; })()`);
  ok('面板列出本轮推的 3 个会话气泡', ours === 3, ours);
  const padLeft = await ev('document.querySelectorAll("#dockpan [data-k]").length + document.querySelectorAll("#dockpan .dk-pad").length');
  ok('按键台已删除（无 SW / 方向键 / 按键区）', padLeft === 0, padLeft);
  ok('头部只剩静音 + 关闭两个图标', (await ev('!!document.getElementById("dkMute") && !!document.querySelector("#dockpan .dk-x")')) === true);
  const subTxt = await ev('document.getElementById("dkSub").innerText');
  ok('状态条写出通道数', /通道/.test(String(subTxt)), subTxt);

  /* ---------- 4. 桌宠状态跟着变 ---------- */
  const dockState = await ev('(typeof M !== "undefined") ? M.dockState : "no-M"');
  ok('waiting_user 优先上报到状态机', dockState === 'waiting_user', dockState);
  const resolved = await ev('(typeof resolveState === "function") ? resolveState() : "no-fn"');
  ok('等待确认时桌宠演"举手"（stand_arms）', resolved === 'stand_arms', resolved);

  /* ---------- 5. 点卡片 / 再点看详情 / 静音（按键台已删，交互全靠点） ---------- */
  const keypad = await ev('document.querySelectorAll("#dockpan [data-k]").length');
  ok('按键台已移除（没有 SW / 方向键）', keypad === 0, keypad);
  ok('头部有静音图标', (await ev('!!document.getElementById("dkMute")')) === true);

  const clickCard = (key) => `(()=>{ const n=[...document.querySelectorAll('#dockpan .dk-item')]
      .find(x=>(x.dataset.key||'').endsWith(${JSON.stringify('::' + key)}));
    if(!n) return false;
    const r=n.getBoundingClientRect();
    n.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+20,clientY:r.top+10}));
    return true; })()`;

  /* 点一张卡片 → 选中它 */
  const clicked = await ev(clickCard(SID.h));
  await sleep(350);
  const pin1 = await ev('window.petHost.dock.get().then(s=>s.pinned)', true);
  ok('点卡片＝选中该会话', clicked === true && pin1 === 'hermes::' + SID.h, { clicked, pin1 });

  /* 再点同一张 → 展开详情；第三次 → 收起 */
  await ev(clickCard(SID.h));
  await sleep(300);
  ok('再点同一张卡片展开详情', (await ev('window.DockUI.detailOpen()')) === true);
  const detText = await ev('(document.getElementById("dkDet").innerText||"").replace(/\\s+/g," ")');
  ok('详情里是这条会话的内容', String(detText).includes(SID.h) || String(detText).includes('Hermes'), String(detText).slice(0, 80));
  await ev(clickCard(SID.h));
  await sleep(300);
  ok('第三次点击收起详情', (await ev('window.DockUI.detailOpen()')) === false);

  /* 点另一张 → 选中跟着换 */
  await ev(clickCard(SID.cc));
  await sleep(350);
  const pin2 = await ev('window.petHost.dock.get().then(s=>s.pinned)', true);
  ok('点另一张卡片切换选中', pin2 === 'claude-code::' + SID.cc, pin2);

  /* 静音：不再驱动桌宠动作；取消静音立刻恢复 */
  await ev('document.getElementById("dkMute").click(); true');
  await sleep(300);
  ok('静音图标切换生效', (await ev('window.DockUI.muted()')) === true);
  const SIDm = 'cdp-mute-' + RUN;
  await postState({ hook_event_name: 'pre_tool_call', session_id: SIDm, tool_name: 'terminal' });
  await sleep(700);
  const snapM = await ev('window.DockUI.snapshot()');
  const mineM = ((snapM && snapM.sessions) || []).find((x) => x.sessionId === SIDm);
  ok('静音不影响快照（新会话照常进来）', mineM && mineM.state === 'working', mineM && mineM.state);
  ok('静音期间不驱动桌宠状态机', (await ev('(typeof M !== "undefined") ? M.dockState : "no-M"')) === '');
  await ev('document.getElementById("dkMute").click(); true');
  await sleep(600);
  /* 主导状态可能是别的会话（比如另一条在等确认），所以与快照对齐而不是写死 working */
  ok('取消静音后立刻恢复驱动（等于当前主导状态）',
     (await ev('(typeof M !== "undefined") ? M.dockState : "no-M"')) === (snapM && snapM.state),
     { dockState: await ev('M.dockState'), snap: snapM && snapM.state });
  await postState({ agent: 'hermes', hook_event_name: 'agent_loop_stopped', session_id: SIDm });

  /* ---------- 6. done / 庆祝动作 ----------
     注意：桌宠只按"最紧急状态"演动作，所以只要有别的 Agent 还在干活，
     主导状态就不会变成 done、也不会演庆祝——这时只验"本条会话变 done"，
     把主导状态相关的断言标 SKIP（不算失败），避免一边跑 demo 一边跑测试就误报。 */
  const oursSet = new Set([SID.h, SID.cc, SID.wb, SID.cel]);
  const othersActive = async () => {
    const sn = await ev('window.DockUI.snapshot()');
    return ((sn && sn.sessions) || []).filter((x) => !oursSet.has(x.sessionId)
      && (x.state === 'working' || x.state === 'speaking' || x.state === 'waiting_user' || x.state === 'error'));
  };

  await postState({ hook_event_name: 'agent_loop_stopped', session_id: SID.h });
  await sleep(500);
  const sessH = await ev('(window.DockUI.snapshot().sessions||[]).find(s=>s.sessionId==="' + SID.h + '")');
  ok('单条会话结束后自己的状态是 done', sessH && sessH.state === 'done', sessH && sessH.state);

  const busy = await othersActive();
  if (busy.length) {
    console.log('SKIP  主导状态/庆祝动作断言（还有 ' + busy.length + ' 个其它 Agent 在活跃：'
      + busy.map((x) => x.agent + '/' + x.state).join(', ') + '）');
  } else {
    const stWait = await ev('window.DockUI.snapshot().state');
    ok('还有一条在等确认时主导状态保持 waiting_user', stWait === 'waiting_user', stWait);

    await postState({ agent: 'claude-code', hook_event_name: 'agent_loop_stopped', session_id: SID.cc });
    await sleep(500);
    const stDone = await ev('window.DockUI.snapshot().state');
    ok('本轮全部结束后主导状态变为 done', stDone === 'done', stDone);

    await postState({ hook_event_name: 'pre_tool_call', session_id: SID.cel, tool_name: 'terminal' });
    await sleep(500);
    const stWork = await ev('window.DockUI.snapshot().state');
    ok('新推送把主导状态拉回 working', stWork === 'working', stWork);
    await postState({ hook_event_name: 'agent_loop_stopped', session_id: SID.cel });
    await sleep(700);
    const react = await ev('(window.__petDebug && window.__petDebug.lastPlayOnce) ? window.__petDebug.lastPlayOnce.id : ""');
    ok('working → done 时演一次庆祝动作 jump_high', react === 'jump_high', react);
  }

  /* ---------- 7. 截图 + 收尾 ---------- */
  await ev('document.getElementById("dockpan").classList.remove("collapsed"); true');
  await sleep(200);
  const clip = await ev(`(()=>{ const a=document.getElementById('dockpan').getBoundingClientRect();
      const b=document.getElementById('pet').getBoundingClientRect();
      const x=Math.max(0,Math.min(a.left,b.left)-16), y=Math.max(0,Math.min(a.top,b.top)-16);
      return { x:Math.round(x), y:Math.round(y),
               width:Math.round(Math.min(window.innerWidth,Math.max(a.right,b.right)+16)-x),
               height:Math.round(Math.min(window.innerHeight,Math.max(a.bottom,b.bottom)+16)-y) }; })()`);
  const shot = await send('Page.captureScreenshot', clip && clip.width
    ? { format: 'png', clip: { ...clip, scale: 1 } }
    : { format: 'png' });
  if (shot.result && shot.result.data) {
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
    ok('截图落盘 ' + SHOT, fs.statSync(SHOT).size > 1000, fs.statSync(SHOT).size);
  } else ok('截图落盘', false, shot);

  const errs = await send('Runtime.evaluate', { expression: 'window.__petError || ""', returnByValue: true });
  ok('全程无脚本错误', !(errs.result && errs.result.result && errs.result.result.value), errs.result && errs.result.result && errs.result.result.value);

  await ev('window.petHost.dock.clearEnded(); true');   // 收尾：清掉本轮结束态气泡，方便下一轮复跑
  ws.close();
  console.log('\n===== ' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ` : ${pass} passed, ${fail} failed =====`);
  if (fail) console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('CDP TEST CRASH', e && (e.stack || e.message || e)); process.exit(2); });
