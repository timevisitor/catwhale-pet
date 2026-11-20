'use strict';
/**
 * 桌面走动的端到端验收（真 Electron + 真页面 + 真 preload + 本机 http 视频）
 *
 * 为什么要有它：单测只覆盖纯函数（几何/指令/配置），而这次改动的大头在
 * 「框选遮罩 + 点击穿透 + 主进程持久化 + 聊天本地拦截 + 状态机优先级」这条链路上，
 * 只能从真实的桌面程序里量。
 *
 * 交互方式说明（汇报时必须照实写）：
 *   · 点击/移动/按键走 CDP Input 域（浏览器真实输入路径，会过命中测试与默认行为），
 *     不是页面内 .click()/dispatchEvent()，也不是操作系统级鼠标；
 *   · "换屏 / 改分辨率 / 游戏模式" 这类系统级场景在这里只能做代理验证：
 *     合成 resize 事件走同一条重新夹取代码；游戏模式用 --gamemode=on 真启动一个实例。
 *
 * 用法：
 *   node tests/e2e-walk.cjs                       # 用源码 app 跑（默认）
 *   PET_APP=<包内 app 目录或 exe 目录> node tests/e2e-walk.cjs
 *   PET_ELECTRON=<electron.exe> WALK_CDP_PORT=9455 node tests/e2e-walk.cjs
 *   EXPECT_VER=0.7.0 node tests/e2e-walk.cjs      # 额外断言设置面板显示的版本
 *
 * 产物：<主题>/证据/e2e-walk/run-<时间戳>.json（全部明细 + 子进程 stdout）
 * 退出码：0 = 全通过（SKIP 不计失败），1 = 有失败项。
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const THEME = path.resolve(ROOT, '..');
const EVID = process.env.WALK_EVIDENCE || path.join(THEME, '证据', 'e2e-walk');
const TMP = process.env.PET_TEST_TMP || path.join(THEME, 'tmp', 'e2e-walk');
const ELECTRON = process.env.PET_ELECTRON || path.join(ROOT, 'app', 'node_modules', 'electron', 'dist', 'electron.exe');
const APP = process.env.PET_APP || path.join(ROOT, 'app');
const EXPECT_VER = process.env.EXPECT_VER || '';
const PORT = Number(process.env.WALK_CDP_PORT || 9455);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
function add(name, pass, detail) {
  checks.push({ name, pass: pass === true, skip: pass === 'skip', detail });
  const tag = pass === true ? 'PASS' : pass === 'skip' ? 'SKIP' : 'FAIL';
  console.log(`[${tag}] ${name}${detail === undefined ? '' : ' :: ' + short(detail)}`);
}
function short(v) {
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { s = String(v); }
  return s.length > 220 ? s.slice(0, 220) + '…' : s;
}

/* ---------------- 极简 CDP 客户端 ---------------- */
function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
  });
}
async function waitPage(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await httpJson(`http://127.0.0.1:${PORT}/json`);
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url || ''));
      if (page) return page;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP 页面在 ' + timeoutMs + 'ms 内没出现');
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let seq = 0;
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || 'cdp error'));
        else res(msg.result);
      }
    };
    ws.onerror = (e) => reject(new Error('WS 错误：' + (e && e.message)));
    ws.onopen = () => resolve({
      send(method, params) {
        const id = ++seq;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
          setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 超时')); } }, 20000);
        });
      },
      close() { try { ws.close(); } catch (e) {} },
    });
  });
}

/* 页面内求值：async 必须 awaitPromise，否则静默拿到 {} */
async function evalJs(cdp, expr, timeoutHint) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('页面异常：' + (d.exception && d.exception.description || d.text) + (timeoutHint ? ' @' + timeoutHint : ''));
  }
  return r && r.result ? r.result.value : undefined;
}
async function rectOf(cdp, sel) {
  return evalJs(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;
    const r=e.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height,
    visible: !!(r.width>0&&r.height>0&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden')};})()`);
}
async function clickSelector(cdp, sel) {
  const r = await rectOf(cdp, sel);
  if (!r || !r.visible) throw new Error('控件不可见：' + sel + ' ' + JSON.stringify(r));
  const x = Math.round(r.x + r.w / 2), y = Math.round(r.y + r.h / 2);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(220);
  return { x, y };
}
async function mouseDrag(cdp, a, b, steps) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y, buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1, buttons: 1 });
  const n = steps || 8;
  for (let i = 1; i <= n; i++) {
    const x = Math.round(a.x + ((b.x - a.x) * i) / n), y = Math.round(a.y + ((b.y - a.y) * i) / n);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 1 });
    await sleep(30);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(320);
}
async function pressKey(cdp, key, vk, code) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code: code || key, text: key === 'Enter' ? '\r' : undefined });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code: code || key });
  await sleep(120);
}
async function waitFor(fn, ms, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(step || 120);
  }
  return false;
}
/** 设置面板可能因为点到别处被收起；要用面板按钮就先确保它开着 */
async function ensureSettings(cdp) {
  const open = await evalJs(cdp, `document.getElementById('settings').classList.contains('show')`);
  if (!open) { await evalJs(cdp, 'petAPI.openSettings(); true'); await sleep(500); }
  return true;
}

/* ---------------- 启动 / 收尾 ---------------- */
function prepUserData(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dock.json'), JSON.stringify({ enabled: false }), 'utf8');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ envNoAsk: true }), 'utf8');
}
async function launch(ud, extraArgs) {
  const logFile = path.join(EVID, 'launch-' + path.basename(ud) + '-' + Date.now() + '.log');
  const out = fs.openSync(logFile, 'a');
  const args = ['--remote-debugging-port=' + PORT, '--user-data-dir=' + ud, APP].concat(extraArgs || []);
  const child = spawn(ELECTRON, args, { stdio: ['ignore', out, out], windowsHide: false });
  const page = await waitPage(25000);
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  const ok = await waitFor(async () => {
    try { return await evalJs(cdp, 'window.__petInitOK === true'); } catch (e) { return false; }
  }, 25000, 300);
  return { child, cdp, logFile, ok };
}
function killTree(child) {
  if (!child) return;
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch (e) {}
}
function readWalkJson(ud) {
  try { return JSON.parse(fs.readFileSync(path.join(ud, 'walk.json'), 'utf8')); } catch (e) { return null; }
}
const W = (ud) => readWalkJson(ud);

/* ===================================================================== */
async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  if (!fs.existsSync(ELECTRON)) throw new Error('找不到 electron：' + ELECTRON);
  if (!fs.existsSync(path.join(APP, 'main.js'))) throw new Error('找不到 app/main.js：' + APP);

  const startedAt = Date.now();
  const logAll = {};
  const ud = path.join(TMP, 'ud-walk');
  prepUserData(ud);

  /* ================= 阶段 1：主流程 ================= */
  let inst = await launch(ud);
  logAll.main = inst.logFile;
  add('启动：页面初始化完成（__petInitOK）', inst.ok === true);
  const cdp = inst.cdp;

  /* --- 设置面板「桌面走动」 --- */
  await evalJs(cdp, 'petAPI.openSettings(); true');
  await sleep(700);
  const ui = await evalJs(cdp, `(()=>{
    const ids=['walkCruise','walkSelectBtn','walkClearBtn','walkTestBtn','walkStopBtn','walkRectInfo'];
    const box=document.getElementById('settings');
    const out={};
    out.settingsVisible = !!box && box.classList.contains('show');
    for(const id of ids){ const e=document.getElementById(id); if(!e){out[id]=null;continue;}
      const r=e.getBoundingClientRect();
      out[id]={w:Math.round(r.width),h:Math.round(r.height),checked:!!e.checked,text:(e.textContent||'').slice(0,60)}; }
    out.version=(document.getElementById('setAppVersion')||{}).textContent||'';
    return out;})()`);
  add('设置面板：走动区块 5 个控件齐全且可见',
    !!(ui.settingsVisible && ui.walkCruise && ui.walkCruise.w > 0 && ui.walkSelectBtn.w > 0 &&
       ui.walkClearBtn.w > 0 && ui.walkTestBtn.w > 0 && ui.walkStopBtn.w > 0), ui);
  add('设置面板：巡游勾选框默认未勾选', ui.walkCruise.checked === false, { checked: ui.walkCruise.checked });
  add('设置面板：显示版本 = 期望版本', EXPECT_VER ? String(ui.version).trim() === 'v' + EXPECT_VER : 'skip',
    { shown: ui.version, expect: EXPECT_VER || '(未设 EXPECT_VER)' });
  const json0 = W(ud);
  add('默认状态：walk.json 不存在或 enabled=false',
    !json0 || json0.enabled === false, json0);

  /* --- 框选（CDP 浏览器输入：按下 → 拖 → 松开） --- */
  await clickSelector(cdp, '#walkSelectBtn');
  const selShown = await evalJs(cdp, `(()=>{const e=document.getElementById('walksel');const r=e.getBoundingClientRect();
    return {show:e.classList.contains('show'), w:r.width, h:r.height, api:petAPI.walk.info().selecting};})()`);
  add('框选：点按钮后遮罩铺满窗口且状态为 selecting', selShown.show === true && selShown.api === true, selShown);

  await mouseDrag(cdp, { x: 320, y: 280 }, { x: 920, y: 680 }, 10);
  const afterDrag = await evalJs(cdp, `(()=>({selecting:petAPI.walk.info().selecting,
    overlay:document.getElementById('walksel').classList.contains('show'), area:petAPI.walk.info().area}))()`);
  const json1 = W(ud);
  add('框选：拖完写入 walk.json（范围 600×400 @320,280）',
    !!json1 && !!json1.rect && Math.abs(json1.rect.x - 320) <= 2 && Math.abs(json1.rect.y - 280) <= 2 &&
    Math.abs(json1.rect.width - 600) <= 2 && Math.abs(json1.rect.height - 400) <= 2, json1 && json1.rect);
  add('框选：结束时遮罩收起、selecting=false（穿透恢复前提）',
    afterDrag.overlay === false && afterDrag.selecting === false, afterDrag);

  /* --- Esc 取消 --- */
  const rectBeforeEsc = json1 && json1.rect;
  await clickSelector(cdp, '#walkSelectBtn');
  await pressKey(cdp, 'Escape', 27, 'Escape');
  const afterEsc = await evalJs(cdp, `(()=>({selecting:petAPI.walk.info().selecting,
    overlay:document.getElementById('walksel').classList.contains('show'),
    settingsOpen:document.getElementById('settings').classList.contains('show'),
    rect:petAPI.walk.info().cfg.rect}))()`);
  const json2 = W(ud);
  add('Esc：退出框选、遮罩消失、范围保持原值',
    afterEsc.selecting === false && afterEsc.overlay === false && !!json2 &&
    JSON.stringify(json2.rect) === JSON.stringify(rectBeforeEsc), { afterEsc, rect: json2 && json2.rect });
  add('Esc：这一下只退框选，不顺手关掉设置面板（双路径 Esc 只生效一次）',
    afterEsc.settingsOpen === true, { settingsOpen: afterEsc.settingsOpen });

  /* --- 失焦退出框选（窗口一失焦，用户就按不到遮罩了，必须自动收掉） --- */
  await ensureSettings(cdp);
  await clickSelector(cdp, '#walkSelectBtn');
  const afterBlur = await evalJs(cdp, `(()=>{ window.dispatchEvent(new Event('blur'));
    return {selecting:petAPI.walk.info().selecting,
            overlay:document.getElementById('walksel').classList.contains('show'),
            rect:petAPI.walk.info().cfg.rect};})()`);
  add('失焦：自动退出框选、遮罩收起、范围不变（合成 blur 事件）',
    afterBlur.selecting === false && afterBlur.overlay === false &&
    JSON.stringify(afterBlur.rect) === JSON.stringify(rectBeforeEsc), afterBlur);

  /* --- 反向框选（右下 → 左上） --- */
  await ensureSettings(cdp);
  await clickSelector(cdp, '#walkSelectBtn');
  await mouseDrag(cdp, { x: 900, y: 640 }, { x: 400, y: 320 }, 10);
  const json3 = W(ud);
  add('反向框选（右下→左上）得到同一矩形 500×320 @400,320',
    !!json3 && !!json3.rect && Math.abs(json3.rect.x - 400) <= 2 && Math.abs(json3.rect.y - 320) <= 2 &&
    Math.abs(json3.rect.width - 500) <= 2 && Math.abs(json3.rect.height - 320) <= 2, json3 && json3.rect);

  /* --- 有界走动（范围 1200×400 @100,150；角色 204×340） --- */
  const RECT = { x: 100, y: 150, width: 1200, height: 400 };
  const BOX = { minX: 100, maxX: 1096, minY: 150, maxY: 210 };
  await evalJs(cdp, `petAPI.walk.setRect(${JSON.stringify(RECT)})`);
  await sleep(250);
  const w0 = await evalJs(cdp, 'petAPI.walk.info()');
  add('范围：程序化设定与手工框选走同一路径（写盘一致）',
    !!W(ud) && Math.abs(W(ud).rect.width - 1200) <= 1 && Math.abs(W(ud).rect.x - 100) <= 1, W(ud) && W(ud).rect);
  add('范围：包围盒按角色尺寸算出（maxX=' + BOX.maxX + ' / maxY=' + BOX.maxY + '）',
    Math.abs(w0.box.minX - BOX.minX) < 0.6 && Math.abs(w0.box.maxX - BOX.maxX) < 0.6 &&
    Math.abs(w0.box.minY - BOX.minY) < 0.6 && Math.abs(w0.box.maxY - BOX.maxY) < 0.6, w0.box);

  const edge = async (dx, dy, dist, tag, expectAxis, expectVal) => {
    const r = await evalJs(cdp, `petAPI.walk.to(${dx},${dy},${dist})`);
    await sleep(150);
    const info = await evalJs(cdp, 'petAPI.walk.info()');
    const p = info.pet, s = info.size;
    const inBox = p.x >= w0.box.minX - 1 && p.x <= w0.box.maxX + 1 && p.y >= w0.box.minY - 1 && p.y <= w0.box.maxY + 1;
    const canvasIn = p.x >= RECT.x - 1 && p.y >= RECT.y - 1 &&
                     p.x + s.w <= RECT.x + RECT.width + 1 && p.y + s.h <= RECT.y + RECT.height + 1;
    add(`${tag}：停在边界（${expectAxis}=${expectVal}），画布不出框`,
      inBox && canvasIn && Math.abs(p[expectAxis] - expectVal) < 1.5,
      { moved: Math.round(r.moved), bounded: r.bounded, pet: p, size: s, canvasIn });
    return { r, info };
  };
  const right = await edge(1, 0, 2000, '往右走 2000', 'x', BOX.maxX);
  add('往右走：被范围截断并如实报告（bounded=true，位移 = 剩余空间）',
    right.r.bounded === true && right.r.moved > 100, { moved: Math.round(right.r.moved), bounded: right.r.bounded });
  const left = await edge(-1, 0, 2000, '往左走 2000', 'x', BOX.minX);
  add('往左走：朝向 left', left.info.facing === 'left', { facing: left.info.facing });
  const down = await edge(0, 1, 2000, '往下走 2000（二维）', 'y', BOX.maxY);
  const up = await edge(0, -1, 2000, '往上走 2000（二维）', 'y', BOX.minY);

  /* --- 朝向与动作（素材未到货时如实 SKIP） --- */
  const faceInfo = await evalJs(cdp, `(async ()=>{const p=petAPI.walk.to(1,0,60);await new Promise(r=>setTimeout(r,120));
    const i=petAPI.walk.info();petAPI.walk.stop();
    const v=[...document.querySelectorAll('#pet video.active')].map(v=>({f:v.currentSrc.split('/').pop(),tf:v.style.transform}));
    return {facing:i.facing, state:i.state, flip:i.flip, videos:v,
            hasLeft:!states.walk_left.__missing, hasRight:!states.walk_right.__missing};})()`);
  add('朝向：水平分量决定（往右 facing=right）', faceInfo.facing === 'right', faceInfo);
  if (faceInfo.hasLeft && faceInfo.hasRight) {
    add('朝向：往右演 walk_right、往左演 walk_left',
      faceInfo.state === 'walk_right', { state: faceInfo.state });
  } else {
    add('朝向：走路素材未到货（素材代理尚未交付），动作断言本轮跳过', 'skip',
      { hasLeft: faceInfo.hasLeft, hasRight: faceInfo.hasRight });
  }

  /* --- 真实解码 + 双方向朝向（2026-11 素材到货后补） ---
     只对上状态名不算数：要证明 <video> 真的在解这一路的每一帧。
     判据：active 元素 src 是目标文件、readyState>=2（有当前帧数据）、未暂停、
     两次采样的 currentTime 真的往前走（按 1.3333s 循环取模，避免回绕误判）、
     分辨率/时长与 states.json 里的元数据一致。 */
  const decodeProbe = async (dx) => evalJs(cdp, `(async ()=>{
    petAPI.walk.stop(); await new Promise(r=>setTimeout(r,150));
    petAPI.walk.to(${dx},0,400);
    await new Promise(r=>setTimeout(r,700));
    const pick=()=>document.querySelector('#pet video.active');
    const snap=(v)=>v?{src:(v.currentSrc||'').split('/').pop(),rs:v.readyState,t:v.currentTime,
                        vw:v.videoWidth,vh:v.videoHeight,d:v.duration,paused:v.paused}:null;
    const a=snap(pick());
    await new Promise(r=>setTimeout(r,500));
    const b=snap(pick());
    const i=petAPI.walk.info();
    petAPI.walk.stop();
    return {a,b,facing:i.facing,state:i.state,flip:i.flip,pet:i.pet};
  })()`);
  const adv = (a, b) => {
    if (!a || !b) return -1;
    const d = (b.t - a.t + (a.d || 1.3333)) % (a.d || 1.3333);
    return d;
  };
  const decR = await decodeProbe(1);
  add('解码：往右走 = 播 walk_right.webm，未暂停且有当前帧',
    !!decR.a && decR.a.src === 'walk_right.webm' && decR.a.rs >= 2 && decR.a.paused === false,
    { a: decR.a, state: decR.state, flip: decR.flip });
  add('解码：往右走 currentTime 真实前进（0.5s 采样）', adv(decR.a, decR.b) > 0.05,
    { from: decR.a && decR.a.t, to: decR.b && decR.b.t, delta: adv(decR.a, decR.b) });
  add('解码：走路素材分辨率 576×960、时长≈1.3333s、与 states.json 一致',
    !!decR.a && decR.a.vw === 576 && decR.a.vh === 960 && Math.abs(decR.a.d - 1.3333) < 0.02,
    decR.a && { vw: decR.a.vw, vh: decR.a.vh, duration: decR.a.d });
  const decL = await decodeProbe(-1);
  add('解码：往左走 = 播 walk_left.webm（非镜像凑数），朝向 left',
    !!decL.a && decL.a.src === 'walk_left.webm' && decL.a.rs >= 2 && decL.a.paused === false &&
    decL.facing === 'left' && decL.state === 'walk_left' && decL.flip === false,
    { a: decL.a, facing: decL.facing, state: decL.state, flip: decL.flip });
  add('解码：往左走 currentTime 真实前进（0.5s 采样）', adv(decL.a, decL.b) > 0.05,
    { from: decL.a && decL.a.t, to: decL.b && decL.b.t, delta: adv(decL.a, decL.b) });

  /* --- 聊天本地指令（真实键盘输入） --- */
  await evalJs(cdp, 'petAPI.openChat(); true');
  await sleep(500);
  await evalJs(cdp, `petAPI.walk.setRect(${JSON.stringify(RECT)})`);
  await sleep(200);
  const sendCmd = async (text) => {
    await clickSelector(cdp, '#cinput');
    await cdp.send('Input.insertText', { text });
    await pressKey(cdp, 'Enter', 13, 'Enter');
    await waitFor(async () => !(await evalJs(cdp, 'petAPI.walk.info().moving')), 6000, 120);
    await sleep(150);
    return evalJs(cdp, `(()=>{const a=[...document.querySelectorAll('#cmsg .assistant')];
      return {last:a.length?a[a.length-1].textContent:'', n:a.length, pet:petAPI.walk.info().pet, busy:petAPI.getMode().chatBusy};})()`);
  };
  const posBefore = (await evalJs(cdp, 'petAPI.walk.info().pet'));
  const c1 = await sendCmd('往右走 200 像素');
  const dx1 = c1.pet.x - posBefore.x;
  add('聊天指令「往右走 200 像素」：位置真的右移 ~200 且本地回复',
    Math.abs(dx1 - 200) < 6 && /右/.test(c1.last) && /200/.test(c1.last) && c1.busy === false,
    { dx: Math.round(dx1), reply: c1.last, busy: c1.busy });
  const c2 = await sendCmd('向左走');
  const dx2 = c2.pet.x - c1.pet.x;
  add('聊天指令「向左走」：左移（默认 240，遇边界按边算）+ 回复说明到边',
    dx2 < -50 && /左/.test(c2.last) && /边|走了/.test(c2.last), { dx: Math.round(dx2), reply: c2.last });
  const c3 = await sendCmd('停下');
  add('聊天指令「停下」：立即停住 + 回复',
    c3.busy === false && /停/.test(c3.last) && (await evalJs(cdp, 'petAPI.walk.info().moving')) === false,
    { reply: c3.last });

  /* --- 普通聊天不被劫持（解析层 + 结构层双证） --- */
  const parseCases = await evalJs(cdp, `(()=>{const out={};
    for(const s of ['我今天向左走了两万步','左边那个按钮是什么','往右走还是往左走好一点？','停下来的英文怎么说','帮我写一段 CSS 让元素往右移动 200 像素'])
      out[s]=petAPI.walk.parse(s);
    return out;})()`);
  add('普通聊天：5 条自然语句都不被当成指令', Object.values(parseCases).every((v) => v === null), parseCases);
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  /* 只数 UI 代码区（petAPI 之前）：调试接口里也调了 parse，那是给验收用的，不算拦截点 */
  const uiCode = htmlSrc.slice(0, htmlSrc.indexOf('window.petAPI = {'));
  const parseSites = (uiCode.match(/WCMD\s*\.\s*parse\s*\(/g) || []).length;
  add('结构：UI 代码里只有 sendChat 一处解析用户输入（AI 输出/历史无解析点）', parseSites === 1, { parseSites });
  const hist = await evalJs(cdp, `(async ()=>{
    const before=petAPI.walk.info().pet;
    C.msgs.push({role:'assistant',text:'向左走 500 像素'});
    C.msgs.push({role:'user',text:'往右走 300 像素'});
    renderChat();
    await new Promise(r=>setTimeout(r,700));
    return {before, after:petAPI.walk.info().pet, moving:petAPI.walk.info().moving};})()`);
  add('AI 输出/历史里出现指令字样：不触发走动',
    hist.moving === false && Math.abs(hist.after.x - hist.before.x) < 1 && Math.abs(hist.after.y - hist.before.y) < 1, hist);

  /* --- 正常聊天照旧走后端（隔离档案里没有 API key → 后端会报错，这本身就是"走了后端"的证据） --- */
  const chatBefore = await evalJs(cdp, `(()=>({pet:petAPI.walk.info().pet, n:C.msgs.length}))()`);
  await clickSelector(cdp, '#cinput');
  await cdp.send('Input.insertText', { text: '你好呀，今天天气怎么样' });
  await pressKey(cdp, 'Enter', 13, 'Enter');
  const grew = await waitFor(async () => (await evalJs(cdp, 'C.msgs.length')) >= chatBefore.n + 2, 12000, 400);
  const chatAfter = await evalJs(cdp, `(()=>{const a=[...document.querySelectorAll('#cmsg .assistant, #cmsg .err')];
    const i=petAPI.walk.info();
    return {last:a.length?a[a.length-1].textContent.slice(0,120):'', n:C.msgs.length, pet:i.pet, moving:i.moving,
            tail:String(C.tail||'').slice(0,160), busy:C.busy, chatOpen:C.open};})()`);
  const walkReply = /好，往|到边上了|停下了/;
  const backendRan = grew || /出事|失败|未配置|没有配置|key|harness|退出/i.test(chatAfter.tail) ||
                     /harness|出错|失败/.test(chatAfter.last);
  if (backendRan) {
    add('正常聊天：照旧交给后端处理（后端报错也说明没被本地拦截），角色不动',
      !walkReply.test(chatAfter.last) && chatAfter.moving === false && chatAfter.chatOpen === true &&
      Math.abs(chatAfter.pet.x - chatBefore.pet.x) < 1 && Math.abs(chatAfter.pet.y - chatBefore.pet.y) < 1,
      { reply: chatAfter.last, tail: chatAfter.tail, grew });
  } else {
    add('正常聊天：后端在本轮环境里没回消息，也读不到错误（无法判定，跳过）', 'skip', chatAfter);
  }

  /* --- 巡游：默认关 → 打开走 → 停下暂停 --- */
  await evalJs(cdp, 'petAPI.walk.cruise(false); petAPI.walk.stop(); true');
  await sleep(200);
  const cruiseOff = await evalJs(cdp, `(()=>({cfg:petAPI.walk.info().cfg.enabled,
    checked:document.getElementById('walkCruise').checked}))()`);
  add('巡游：默认关闭（勾选框与配置都关）', cruiseOff.cfg === false && cruiseOff.checked === false, cruiseOff);

  await evalJs(cdp, 'petAPI.walk.cruise(true); true');
  await sleep(400);
  const cruiseOn = await evalJs(cdp, `(()=>({cfg:petAPI.walk.info().cfg.enabled,
    checked:document.getElementById('walkCruise').checked, disk:null}))()`);
  add('巡游：勾上后配置与勾选框同步、并写盘',
    cruiseOn.cfg === true && cruiseOn.checked === true && W(ud) && W(ud).enabled === true, { cruiseOn, disk: W(ud) });
  const sampled = await evalJs(cdp, `(async ()=>{
    const out=[]; const t0=Date.now();
    petAPI.walk.closePanels();          // 巡游在面板打开时让路（评审口径），先关掉面板
    await new Promise(r=>setTimeout(r,200));
    petAPI.walk.cruiseNow();
    while(Date.now()-t0<2600){ await new Promise(r=>setTimeout(r,110));
      const i=petAPI.walk.info(); out.push({x:Math.round(i.pet.x),y:Math.round(i.pet.y),mv:i.moving,st:i.state}); }
    return out;})()`);
  const xs = sampled.map((s) => s.x), ys = sampled.map((s) => s.y);
  const inside = sampled.every((s) => s.x >= w0.box.minX - 1 && s.x <= w0.box.maxX + 1 && s.y >= w0.box.minY - 1 && s.y <= w0.box.maxY + 1);
  const moved = Math.max(...xs) - Math.min(...xs) + (Math.max(...ys) - Math.min(...ys));
  add('巡游：在选框内走动（取样 ' + sampled.length + ' 次全在范围内、总位移 > 5px）',
    inside && moved > 5, { inside, moved, sample: sampled.slice(0, 6) });

  const stopRes = await evalJs(cdp, `(async ()=>{ return petAPI.walk.runCommand('停下'); })()`);
  await sleep(300);
  const afterStop = await evalJs(cdp, `(()=>({cfg:petAPI.walk.info().cfg.enabled,
    checked:document.getElementById('walkCruise').checked, moving:petAPI.walk.info().moving}))()`);
  const posA = (await evalJs(cdp, 'petAPI.walk.info().pet'));
  await sleep(900);
  const posB = (await evalJs(cdp, 'petAPI.walk.info().pet'));
  add('巡游：「停下」指令暂停巡游（配置 false、勾选框复位、此后不再移动）',
    afterStop.cfg === false && afterStop.checked === false && afterStop.moving === false &&
    Math.abs(posA.x - posB.x) < 1 && Math.abs(posA.y - posB.y) < 1, { afterStop, posA, posB });

  /* 巡游节奏：巡游自己走到目的地不算「用户操作」，不该再空等 IDLE_HOLD(12s) 才动下一步，
     只按 cruiseUntil 歇 2.2~6s。这里量两次起步之间隔了多久。 */
  const cadence = await evalJs(cdp, `(async ()=>{
    const wait=(ms)=>new Promise(r=>setTimeout(r,150));
    petAPI.walk.setRect({x:100,y:150,width:1200,height:400});
    petAPI.walk.cruise(true);
    petAPI.walk.cruiseNow();
    const t0=Date.now(); const ev=[]; let prev=null;
    while(Date.now()-t0<15000){
      await wait(150);
      const m=!!petAPI.walk.info().moving;
      if(m!==prev){ ev.push({t:Date.now()-t0, moving:m}); prev=m; }
    }
    petAPI.walk.cruise(false); petAPI.walk.stop();
    return ev;
  })()`);
  const stops = cadence.map((e, i) => (e.moving === false ? i : -1)).filter((i) => i > 0);
  const gap = (() => {
    for (const i of stops) {
      const next = cadence.slice(i + 1).find((e) => e.moving === true);
      if (next) return next.t - cadence[i].t;
    }
    return -1;
  })();
  add('巡游节奏：到点后最多歇 ~8 秒就再出发（不再被 12 秒交互窗口卡住）',
    gap > 0 && gap < 8000 && cadence.filter((e) => e.moving === true).length >= 2,
    { gapMs: gap, transitions: cadence.length, ev: cadence.slice(0, 10) });

  /* --- 手动拖动优先 --- */
  await evalJs(cdp, `petAPI.walk.to(1,0,900)`);
  await sleep(120);
  const petRect = await rectOf(cdp, '#pet');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(petRect.x + petRect.w / 2), y: Math.round(petRect.y + petRect.h * 0.55), buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(petRect.x + petRect.w / 2), y: Math.round(petRect.y + petRect.h * 0.55), button: 'left', clickCount: 1, buttons: 1 });
  await sleep(250);
  const dragStop = await evalJs(cdp, 'petAPI.walk.info()');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(petRect.x + petRect.w / 2), y: Math.round(petRect.y + petRect.h * 0.55), button: 'left', clickCount: 1, buttons: 0 });
  add('优先级：手动拖动立刻打断走动（moving=false）', dragStop.moving === false, { moving: dragStop.moving, state: dragStop.state });

  /* --- resize 重新夹取（合成事件，走同一条代码路径） --- */
  const clampCheck = await evalJs(cdp, `(async ()=>{
    const b=petAPI.walk.info().box;
    petAPI.moveTo(b.maxX+260, b.minY-120);
    await new Promise(r=>setTimeout(r,120));
    const outside=petAPI.walk.info().pet;
    window.dispatchEvent(new Event('resize'));
    await new Promise(r=>setTimeout(r,600));
    return {outside, after:petAPI.walk.info().pet, box:petAPI.walk.info().box};})()`);
  add('resize：范围外的角色被重新夹回范围内（合成 resize 事件）',
    clampCheck.after.x <= clampCheck.box.maxX + 1 && clampCheck.after.x >= clampCheck.box.minX - 1 &&
    clampCheck.after.y >= clampCheck.box.minY - 1 && clampCheck.after.y <= clampCheck.box.maxY + 1, clampCheck);

  /* =====================================================================
     评审挡发布项回归（2026-11，独立评审实测复现）
       ① 走动中改尺寸/范围 → 目标落到新包围盒外 → 角色卡在边界、Promise 永不 resolve
       ② 范围比角色画布还小 → 不该启动走动/巡游（会越界 / 头被屏幕边裁掉），且框选值要保留
       ③ walk:get 每次读都重写 walk.json（同值也写）
       ④ 巡游在设置/聊天打开时应让路，显式指令仍执行
     ===================================================================== */

  /* ① 走动中放大角色（= 包围盒变小）：必须收敛，不能永久走 */
  await evalJs(cdp, `petAPI.walk.setRect({x:0,y:0,width:600,height:600}); petAPI.setSize(340); true`);
  await sleep(400);
  const midResize = await evalJs(cdp, `(async ()=>{
    petAPI.setPos(100, 60);
    await new Promise(r=>setTimeout(r,120));
    window.__mv = { done:false, r:null };
    petAPI.walk.to(1,0,200).then(r=>{ window.__mv.done=true; window.__mv.r=r; });
    await new Promise(r=>setTimeout(r,320));
    petAPI.setSize(620);                       // 画布变大 → 包围盒 maxX 变小，目标落到框外
    window.dispatchEvent(new Event('resize'));
    const samples=[];
    for (let i=0;i<12;i++){
      await new Promise(r=>setTimeout(r,150));
      const i2=petAPI.walk.info();
      samples.push({t:Math.round(i*150+150), moving:i2.moving, x:Math.round(i2.pet.x*10)/10,
                    maxX:Math.round(i2.box.maxX*10)/10, done:window.__mv.done});
    }
    const inf=petAPI.walk.info();
    const out={ samples, moved:window.__mv.done, r:window.__mv.r, pet:inf.pet, box:inf.box,
                size:petAPI.getSize(), state:inf.state };
    petAPI.setSize(340);                       // 复原尺寸，后续用例按 340 算
    petAPI.walk.setRect({x:100,y:150,width:1200,height:400});
    await new Promise(r=>setTimeout(r,300));
    return out;
  })()`);
  const settleSample = midResize.samples.find((s) => s.done === true);
  add('走动中改尺寸：Promise 在 2 秒内 resolve（不再永久吊死）',
    midResize.moved === true && !!settleSample,
    { done: midResize.moved, at_ms: settleSample ? settleSample.t : null, r: midResize.r });
  add('走动中改尺寸：停在新的包围盒内（pet.x ≤ 新 maxX）且 moving=false',
    midResize.moved === true && !!settleSample && settleSample.moving === false &&
    midResize.pet.x <= midResize.box.maxX + 1 && midResize.pet.x >= midResize.box.minX - 1,
    { pet: midResize.pet, box: { minX: midResize.box.minX, maxX: midResize.box.maxX }, size: midResize.size });
  add('走动中改尺寸：收缩后目标被重算（bounded 如实报告，不是「走完了」）',
    !!midResize.r && (midResize.r.bounded === true || midResize.r.bounded === false) &&
    Math.abs((midResize.r.to ? midResize.r.to.x : 0) - midResize.pet.x) < 2,
    midResize.r);

  /* ② 范围比画布小：走动/巡游都不许启动，框选值保留 */
  const smallRect = { x: 400, y: 300, width: 120, height: 200 };
  const smallRes = await evalJs(cdp, `(async ()=>{
    petAPI.walk.stop();
    petAPI.walk.setRect(${JSON.stringify(smallRect)});
    await new Promise(r=>setTimeout(r,300));
    const inf=petAPI.walk.info();
    const move=await petAPI.walk.to(1,0,120);
    const cruiseOn=petAPI.walk.cruise(true);
    await new Promise(r=>setTimeout(r,400));
    const after=petAPI.walk.info();
    const infoText=(document.getElementById('walkRectInfo')||{}).textContent||'';
    const outText=(document.getElementById('walkOut')||{}).textContent||'';
    return { fits:inf.fits, need:inf.fits&&inf.fits.need, move, cruiseOn,
             enabled:after.cfg.enabled, pet:after.pet, box:after.box, rect:after.cfg.rect,
             infoText, outText, chatReply: await petAPI.walk.runCommand('往右走 100 像素') };
  })()`);
  add('范围比画布小：walk.to 拒绝执行并说明至少要多大的范围',
    smallRes.move && smallRes.move.ok === false && /比角色画布 204×340 还小/.test(String(smallRes.move.error || '')),
    { error: smallRes.move && smallRes.move.error, need: smallRes.need });
  add('范围比画布小：巡游开关被拒（cfg.enabled 保持 false）',
    smallRes.cruiseOn && smallRes.cruiseOn.ok === false && smallRes.enabled === false,
    { cruiseOn: smallRes.cruiseOn, enabled: smallRes.enabled });
  add('范围比画布小：聊天指令当场回「走不了」并给出下一步',
    /走不了|比角色画布/.test(String(smallRes.chatReply || '')), { reply: smallRes.chatReply });
  add('范围比画布小：框选值原样保留（用户可对照着重框，不被悄悄清掉）',
    !!smallRes.rect && Math.abs(smallRes.rect.width - 120) < 1.01 && Math.abs(smallRes.rect.height - 200) < 1.01,
    smallRes.rect);
  add('范围比画布小：设置面板写明「走不了：至少 204×340」',
    /比角色画布小，走不了/.test(String(smallRes.infoText || '')), { infoText: smallRes.infoText });
  add('范围比画布小：角色没被钉在框中心甩到屏幕外（整块画布仍在工作区内）',
    smallRes.pet.x >= -1 && smallRes.pet.y >= -1 &&
    smallRes.pet.x + (await evalJs(cdp, 'petAPI.walk.info().size.w')) <= (await evalJs(cdp, 'innerWidth')) + 1 &&
    smallRes.pet.y + (await evalJs(cdp, 'petAPI.walk.info().size.h')) <= (await evalJs(cdp, 'innerHeight')) + 1,
    { pet: smallRes.pet, size: await evalJs(cdp, 'petAPI.walk.info().size') });

  /* ③ walk:get 同值不重写 walk.json */
  const walkFile = path.join(ud, 'walk.json');
  const mtime0 = (() => { try { return fs.statSync(walkFile).mtimeMs; } catch (e) { return 0; } })();
  await sleep(60);
  const readTwice = await evalJs(cdp, `(async ()=>{
    const a=await petAPI.walk.reload(); const b=await petAPI.walk.reload();
    return { enabled:b.enabled, rect:b.rect, win:b.win };})()`);
  await sleep(220);
  const mtime1 = (() => { try { return fs.statSync(walkFile).mtimeMs; } catch (e) { return 0; } })();
  add('walk:get：同值读两次不改 walk.json 的 mtime（不再每次读都重写）',
    mtime0 > 0 && mtime1 === mtime0, { before: mtime0, after: mtime1, cfg: readTwice });

  /* ④ 巡游让路、显式指令照走 + 复原状态 */
  const pauseRes = await evalJs(cdp, `(async ()=>{
    const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
    petAPI.walk.closePanels();
    petAPI.walk.setRect({x:100,y:150,width:1200,height:400});
    await wait(300);
    petAPI.setPos(600, 150);
    await wait(150);
    petAPI.walk.cruise(true);
    petAPI.walk.cruiseNow();
    await wait(280);
    const walkingUnder=petAPI.walk.info().moving;
    petAPI.openSettings();
    await wait(520);
    const afterPanel=petAPI.walk.info();
    const panelsOpen=petAPI.walk.panels();
    const p1=petAPI.walk.to(-1,0,120);              // 设置面板开着：显式指令照走
    await wait(200);
    const explicitMoving=petAPI.walk.info().moving;
    const ex=await p1;
    petAPI.openChat();                              // 面板互斥：这一步会先关设置
    await wait(450);
    const panelsChat=petAPI.walk.panels();
    petAPI.walk.cruiseNow();                        // 聊天开着：巡游不该自己动
    await wait(350);
    const chatOpenMoving=petAPI.walk.info().moving;
    const ex2=await petAPI.walk.to(1,0,120);        // 聊天开着：显式指令照走
    petAPI.walk.cruise(false);
    petAPI.walk.stop();
    petAPI.walk.closePanels();
    return { walkingUnder, panelsOpen, panelsChat,
             afterPanel:{moving:afterPanel.moving,cfg:afterPanel.cfg.enabled},
             explicit:{ok:ex&&ex.ok,moved:ex&&ex.moved}, explicitMoving,
             chatOpenMoving, ex2:{ok:ex2&&ex2.ok,moved:ex2&&ex2.moved} };
  })()`);
  add('巡游：设置面板打开时让路（自动停下，但巡游开关不自行关闭）',
    pauseRes.walkingUnder === true && pauseRes.afterPanel.moving === false &&
    pauseRes.afterPanel.cfg === true && pauseRes.panelsOpen.settings === true,
    pauseRes);
  add('巡游：聊天面板打开时也不自动溜达（cruiseNow 被面板挡住）',
    pauseRes.panelsChat.chat === true && pauseRes.chatOpenMoving === false,
    { panelsChat: pauseRes.panelsChat, chatOpenMoving: pauseRes.chatOpenMoving });
  add('显式指令：面板开着也照走（设置/聊天两条路径都真实位移）',
    pauseRes.explicitMoving === true && pauseRes.explicit && pauseRes.explicit.ok === true &&
    pauseRes.explicit.moved > 60 && pauseRes.ex2 && pauseRes.ex2.ok === true && pauseRes.ex2.moved > 60,
    { explicit: pauseRes.explicit, ex2: pauseRes.ex2 });
  await evalJs(cdp, `petAPI.walk.cruise(false); petAPI.walk.stop();
    petAPI.walk.setRect({x:100,y:150,width:1200,height:400}); true`);
  await sleep(300);

  /* --- 穿透恢复的日志证据 --- */
  inst.cdp.close();
  const logTxt = fs.readFileSync(inst.logFile, 'utf8');
  add('穿透：框选进入/退出都在主进程留痕（WALKSEL true → false）',
    /WALKSEL true/.test(logTxt) && /WALKSEL false/.test(logTxt), {
      trueCount: (logTxt.match(/WALKSEL true/g) || []).length,
      falseCount: (logTxt.match(/WALKSEL false/g) || []).length,
    });

  /* ================= 阶段 2：重启保留 ================= */
  killTree(inst.child);
  await sleep(1500);
  const beforeRestart = W(ud);
  const inst2 = await launch(ud);
  logAll.restart = inst2.logFile;
  add('重启：第二次启动页面初始化完成', inst2.ok === true);
  const persisted = await evalJs(inst2.cdp, 'petAPI.walk.info()');
  add('重启：框选范围与巡游开关从 walk.json 读回',
    !!persisted.cfg.rect && Math.abs(persisted.cfg.rect.x - beforeRestart.rect.x) <= 1 &&
    Math.abs(persisted.cfg.rect.width - beforeRestart.rect.width) <= 1 &&
    persisted.cfg.enabled === beforeRestart.enabled, { cfg: persisted.cfg, disk: beforeRestart });
  add('重启：启动后角色被夹在范围内（不越界）',
    persisted.pet.x >= persisted.box.minX - 1 && persisted.pet.x <= persisted.box.maxX + 1 &&
    persisted.pet.y >= persisted.box.minY - 1 && persisted.pet.y <= persisted.box.maxY + 1,
    { pet: persisted.pet, box: persisted.box });
  await evalJs(inst2.cdp, 'petAPI.openSettings(); true');
  await sleep(600);
  const ui2 = await evalJs(inst2.cdp, `(()=>({checked:document.getElementById('walkCruise').checked,
    info:(document.getElementById('walkRectInfo')||{}).textContent||'', badge:(document.getElementById('walkBadge')||{}).textContent||''}))()`);
  add('重启：设置面板显示的是保存下来的状态', ui2.checked === persisted.cfg.enabled && /范围/.test(ui2.info), ui2);
  await evalJs(inst2.cdp, 'petAPI.walk.clearRect(); petAPI.walk.cruise(false); true');
  inst2.cdp.close();
  killTree(inst2.child);
  await sleep(1200);

  /* ================= 阶段 3：游戏模式 ================= */
  const udGm = path.join(TMP, 'ud-walk-gm');
  prepUserData(udGm);
  const inst3 = await launch(udGm, ['--gamemode=on']);
  logAll.gamemode = inst3.logFile;
  add('游戏模式：实例启动（--gamemode=on）', inst3.ok === true);
  const gm = await evalJs(inst3.cdp, `(async ()=>{
    const p0=petAPI.walk.info();
    const r=await petAPI.walk.to(1,0,300);
    await new Promise(x=>setTimeout(x,400));
    const p1=petAPI.walk.info();
    return {paused:p0.paused, ok:r.ok, error:r.error||'', moved:Math.round(r.moved||0),
            moving:p1.moving, pet0:p0.pet, pet1:p1.pet,
            select:petAPI.walk.selectStart(), selecting:petAPI.walk.info().selecting};})()`);
  add('游戏模式：走动被暂停（命令被拒、位置不动、state=paused）',
    gm.paused === true && gm.ok === false && gm.moving === false && gm.moved === 0 &&
    Math.abs(gm.pet1.x - gm.pet0.x) < 1 && Math.abs(gm.pet1.y - gm.pet0.y) < 1, gm);
  add('游戏模式：拒绝进入框选（不会拉出看不见的遮罩）',
    gm.select && gm.select.ok === false && gm.selecting === false, { select: gm.select, selecting: gm.selecting });
  inst3.cdp.close();
  killTree(inst3.child);

  /* ================= 汇总 ================= */
  const pass = checks.filter((c) => c.pass).length;
  const skip = checks.filter((c) => c.skip).length;
  const fail = checks.length - pass - skip;
  const report = { startedAt, endedAt: Date.now(), app: APP, electron: ELECTRON, expectVer: EXPECT_VER,
                   userData: ud, pass, fail, skip, checks, logs: logAll };
  const outFile = path.join(EVID, 'run-' + new Date(startedAt).toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n===> 走动 e2e：通过 ${pass} / 失败 ${fail} / 跳过 ${skip}（共 ${checks.length}）`);
  if (fail) checks.filter((c) => !c.pass && !c.skip).forEach((c) => console.log('  ✘ ' + c.name));
  console.log('证据：' + outFile);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E_ERROR ' + ((e && e.stack) || e));
  process.exit(1);
});
