'use strict';
/* 灵动岛「可拖胶囊 / 手动偏移落盘」在**真实候选包**里的端到端验收。
 *
 *   node tests/island-follow/e2e-drag.cjs --exe dist/桌宠/桌宠.exe --phase after
 *   node tests/island-follow/e2e-drag.cjs --exe <旧包> --phase before   # 预期失败
 *
 * 隔离约定（硬要求）：
 *   · --user-data-dir 指向 _env/userData/drag，绝不碰用户 %APPDATA%\桌宠；
 *   · 预置 island.json 把 msg/music/video 全关 → 不读真实通知、不探媒体；
 *   · 输入用 CDP Input.dispatchMouseEvent（渲染进程级合成事件），不移动系统物理鼠标；
 *   · 只 taskkill 自己 spawn 的那棵进程树。
 *
 * 观测全部来自外部：Browser.getWindowBounds（窗口 DIP 几何）、
 * 岛页面 window.__islandDrag（页面自己收到的事件）、island.json（落盘值）、
 * 桌宠页面量出来的角色矩形（islandRectNow/islandHeadNow）。期望落点由测试按文档几何
 * 独立复算，不调用主进程 setter 造期望。
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
const ENVROOT = path.resolve(REPO, '..', '_env');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
const flag = (n) => process.argv.includes('--' + n);
const EXE = path.resolve(arg('exe', path.join(REPO, 'dist', '桌宠', '桌宠.exe')));
const PORT = Number(arg('port', '9241'));
const PHASE = arg('phase', 'after');
const USERDATA = path.resolve(arg('userdata', path.join(ENVROOT, 'userData', 'drag')));
const OUT = path.resolve(arg('out', path.join(REPO, '..', '_logs', 'island-drag', 'e2e-' + PHASE + '.json')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pend = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { const f = pend.get(m.id); pend.delete(m.id); f(m); }
    });
    ws.addEventListener('error', () => reject(new Error('ws error')));
    ws.addEventListener('open', () => {
      resolve({
        send: (method, params) => new Promise((res) => {
          const i = ++id;
          pend.set(i, (m) => res(m));
          ws.send(JSON.stringify({ id: i, method: method, params: params || {} }));
        }),
        eval: (expr) => new Promise((res) => {
          const i = ++id;
          pend.set(i, (m) => {
            const r = m.result && m.result.result;
            if (m.result && m.result.exceptionDetails) return res({ __error: m.result.exceptionDetails.text });
            res(r && r.value !== undefined ? r.value : null);
          });
          ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
        }),
        close: () => { try { ws.close(); } catch (e) {} },
      });
    });
  });
}

/* ---------------- 几何（与 app/island.js 文档公式一致，独立复算） ---------------- */
const W = 640, TOP_PAD = 8, BALL = 56, CAP_H = 104, GAP = 6;
function zoomOf(rh) { return Math.round(Math.min(1, Math.max(0.5, rh / 430)) * 50) / 50; }
function expected(rect, a, off, caps, wa) {
  const zoom = zoomOf(rect.rh || rect.h);
  const Wz = Math.round(W * zoom);
  const contentH = caps ? CAP_H : BALL;
  const cxScreen = rect.x + a.cx * rect.w;
  const headScreen = rect.y + a.head * rect.h;
  /* 与 app/island.js 一致：先算默认落点并夹到工作区，再叠加手动偏移，最后再夹一次。
     这样「桌宠贴边时默认落点已贴边，偏移仍能把岛往屏内挪」的行为才可复算。 */
  let bx = Math.round(cxScreen - Wz / 2);
  let by = Math.round(headScreen - GAP - (TOP_PAD + contentH) * zoom);
  if (bx < wa.x) bx = wa.x;
  if (bx + Wz > wa.x + wa.width) bx = wa.x + wa.width - Wz;
  if (by < wa.y) by = wa.y;
  let x = Math.round(bx + off.x);
  let y = Math.round(by + off.y);
  if (x < wa.x) x = wa.x;
  if (x + Wz > wa.x + wa.width) x = wa.x + wa.width - Wz;
  if (y < wa.y) y = wa.y;
  return { x, y, zoom, Wz, contentH, bottom: y + (TOP_PAD + contentH) * zoom };
}

/* 位置核对时 mode 可能在一帧内切换：球/胶囊两种高度各算一次，取较小误差 */
function bestPos(rect, a, off, wa) {
  const idle = expected(rect, a, off, false, wa);
  const caps = expected(rect, a, off, true, wa);
  return { idle, caps };
}

function stats(list) {
  const v = list.filter((x) => x !== null && isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const sum = v.reduce((a, b) => a + b, 0);
  const at = (q) => v[Math.min(v.length - 1, Math.max(0, Math.round((v.length - 1) * q)))];
  return { n: v.length, mean: +(sum / v.length).toFixed(2), p50: at(0.5), p95: at(0.95), max: v[v.length - 1] };
}

/* ---------------- 启动 / 连接 ---------------- */
function prepareUserdata() {
  fs.mkdirSync(USERDATA, { recursive: true });
  try { fs.rmSync(path.join(USERDATA, 'pet-state.json'), { force: true }); } catch (e) {}
  fs.writeFileSync(path.join(USERDATA, 'island.json'), JSON.stringify(
    { enabled: true, msg: false, music: false, video: false, holdMs: 8000 }, null, 2));
  /* 信息中枢也关掉：它的 winnotify 源即使默认关，也不给任何「读真实通知」的机会 */
  fs.writeFileSync(path.join(USERDATA, 'infohub.json'), JSON.stringify({ enabled: false }, null, 2));
}

async function launch() {
  const env = Object.assign({}, process.env, {
    TEMP: path.join(ENVROOT, 'TEMP'), TMP: path.join(ENVROOT, 'TMP'), TMPDIR: path.join(ENVROOT, 'TMP'),
  });
  const child = spawn(EXE, ['--user-data-dir=' + USERDATA, '--remote-debugging-port=' + PORT, '--no-first-run'],
    { env, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  let list = null;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    if (exited !== null) throw new Error('进程启动即退出 code=' + exited + '\n' + (out + err).slice(-1200));
    list = await getJson('http://127.0.0.1:' + PORT + '/json/list');
    if (list && list.some((t) => /index\.html/.test(t.url || ''))) break;
  }
  if (!list) throw new Error('CDP 端口没起来 ' + PORT);
  const petT = list.find((t) => /index\.html/.test(t.url || ''));
  let islT = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const l2 = await getJson('http://127.0.0.1:' + PORT + '/json/list');
    islT = (l2 || []).find((t) => /island\.html/.test(t.url || ''));
    if (islT) break;
  }
  if (!islT) throw new Error('灵动岛窗口没起来（enabled 应为 true）');
  const ver = await getJson('http://127.0.0.1:' + PORT + '/json/version');
  const pet = await connect(petT.webSocketDebuggerUrl);
  const isl = await connect(islT.webSocketDebuggerUrl);
  const browser = await connect(ver.webSocketDebuggerUrl);
  return { child, out: () => out, err: () => err, exited: () => exited, list, petT, islT, pet, isl, browser };
}

async function waitInit(pet) {
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (await pet.eval('!!window.__petInitOK') === true) return true;
  }
  throw new Error('桌宠页 init 超时：' + await pet.eval('window.__petError || ""'));
}

let __winBoundsError = null;
async function winBounds(ctx) {
  const r = await ctx.browser.send('Browser.getWindowForTarget', { targetId: ctx.islT.id });
  if (r && r.result && r.result.bounds) return Object.assign({ src: 'cdp' }, r.result.bounds);
  if (!__winBoundsError) __winBoundsError = JSON.stringify(r && (r.error || r.result || r));
  /* 退回渲染进程自己的窗口几何（screenX/outerWidth 都是 DIP） */
  const s = await ctx.isl.eval('JSON.stringify({left:screenX,top:screenY,width:outerWidth,height:outerHeight})');
  const j = s ? JSON.parse(s) : null;
  return j ? Object.assign({ src: 'page' }, j) : null;
}
function winBoundsError() { return __winBoundsError; }

async function islandGeom(ctx) {
  const b = await winBounds(ctx);
  const mode = await ctx.isl.eval('(document.getElementById("isl")||{getAttribute:()=>"idle"}).getAttribute("data-mode") || "idle"');
  return { b, mode, caps: mode !== 'idle' };
}
async function anchor(ctx) {
  const s = await ctx.pet.eval('JSON.stringify((()=>{const r=islandRectNow();const a=islandHeadNow();return r&&a?{x:r.x,y:r.y,w:r.w,h:r.h,cx:a.cx,head:a.head}:null;})())');
  return s ? JSON.parse(s) : null;
}
async function workArea(ctx) {
  // 主屏工作区（DIP）；岛窗口默认在桌宠所在屏，本机单屏时即唯一工作区
  return JSON.parse(await ctx.pet.eval('JSON.stringify({x:0,y:0,width:screen.availWidth,height:screen.availHeight})'));
}
function readIslandCfg() {
  try { return JSON.parse(fs.readFileSync(path.join(USERDATA, 'island.json'), 'utf8')); } catch (e) { return null; }
}

function mouse(page, type, x, y, buttons) {
  /* 按下/拖动/松开都必须带 left：只给 buttons=1 而 button='none' 时 Chromium
     不生成 mouseup/click，会把拖动卡在“永远不松手”。 */
  const left = type === 'mousePressed' || type === 'mouseReleased' || (type === 'mouseMoved' && buttons === 1);
  return page.send('Input.dispatchMouseEvent', {
    type, x, y, button: left ? 'left' : 'none', buttons: buttons || 0,
    clickCount: type === 'mousePressed' ? 1 : 0, pointerType: 'mouse',
  });
}

/* 注入一次拖动：delta 是希望窗口位移的 DIP。用屏幕坐标法（窗口跟着指针走，
   client 坐标会失真）：先按下，再按「当前窗口几何 + 标定偏移」把指针送到目标屏幕点。 */
/* 等窗口连续 3 次采样位置一致：拖动前必须标定的是「按下那一刻」的窗口几何 */
async function settleBounds(ctx, maxMs) {
  const t0 = Date.now();
  let last = null, same = 0;
  while (Date.now() - t0 < (maxMs || 2500)) {
    const b = await winBounds(ctx);
    if (!b) { await sleep(80); continue; }
    if (last && b.left === last.left && b.top === last.top && b.width === last.width) same++;
    else same = 0;
    last = b;
    if (same >= 2) return b;
    await sleep(120);
  }
  return last;
}

async function dragIsland(ctx, delta, steps) {
  const rec = { delta, steps: steps || 8, sent: [], observed: [] };
  await settleBounds(ctx);
  const g0 = await islandGeom(ctx);
  if (!g0.b) throw new Error('拿不到岛窗口几何');
  const r = JSON.parse(await ctx.isl.eval('JSON.stringify((()=>{const e=document.getElementById("isl");const r=e.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};})())'));
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  /* 先把光标合成到形状内，让页面有机会 islandHit(true)（与真实鼠标进入一致） */
  await mouse(ctx.isl, 'mouseMoved', cx, cy, 0);
  await sleep(120);
  await mouse(ctx.isl, 'mousePressed', cx, cy, 0);
  await sleep(80);
  let d = await ctx.isl.eval('JSON.stringify(window.__islandDrag||null)');
  if (!d || d === 'null') throw new Error('岛页面没有拖动入口（window.__islandDrag 不存在）→ 候选缺可拖胶囊');
  const down = JSON.parse(d).down;
  rec.down = down;
  const bDown = await winBounds(ctx);
  const innerW = await ctx.isl.eval('innerWidth');
  const z = bDown.width / innerW;
  const Kx = down.sx - bDown.left - z * (cx);
  const Ky = down.sy - bDown.top - z * (cy);
  rec.calib = { z, Kx, Ky, innerW, bDown };
  const S0 = { x: down.sx, y: down.sy };
  for (let i = 1; i <= rec.steps; i++) {
    const k = i / rec.steps;
    const S = { x: S0.x + delta.x * k, y: S0.y + delta.y * k };
    const b = await winBounds(ctx);
    const cxp = (S.x - b.left - Kx) / z;
    const cyp = (S.y - b.top - Ky) / z;
    rec.sent.push({ k: k, cx: +cxp.toFixed(2), cy: +cyp.toFixed(2) });
    await mouse(ctx.isl, 'mouseMoved', cxp, cyp, 1);
    await sleep(35);
    const ls = await ctx.isl.eval('JSON.stringify((window.__islandDrag&&window.__islandDrag.lastScreen)||null)');
    if (ls && ls !== 'null') rec.observed.push(JSON.parse(ls));
  }
  const b1 = await winBounds(ctx);
  const last = await ctx.isl.eval('JSON.stringify((window.__islandDrag&&window.__islandDrag.lastScreen)||null)');
  const Sf = last && last !== 'null' ? JSON.parse(last) : S0;
  const cxp = (Sf.sx - b1.left - Kx) / z;
  const cyp = (Sf.sy - b1.top - Ky) / z;
  rec.release = { cx: cxp, cy: cyp, b1, Sf, innerW: b1.width / z };
  await mouse(ctx.isl, 'mouseReleased', cxp, cyp, 0);
  await sleep(250);
  rec.end = await winBounds(ctx);
  rec.log = JSON.parse(await ctx.isl.eval('JSON.stringify(window.__islandDrag||null)') || 'null');
  rec.lastUp = JSON.parse(await ctx.isl.eval('JSON.stringify(window.__islandLastUp||null)') || 'null');
  rec.downCount = await ctx.isl.eval('window.__islandDownCount||0');
  rec.off = (readIslandCfg() || {}).off || null;
  return rec;
}

/* ---------------- 主流程 ---------------- */
( async () => {
  const t0 = Date.now();
  const result = { phase: PHASE, exe: EXE, userdata: USERDATA, startedAt: new Date().toISOString(), isolation: { islandMsg: false, infohubEnabled: false, input: 'CDP Input.dispatchMouseEvent (合成事件，不动系统鼠标)' }, checks: [], failures: [], launches: [] };
  const fail = (name, msg, extra) => { result.failures.push({ name, msg, extra: extra || null }); };
  const check = (name, ok, detail) => {
    result.checks.push({ name, ok: !!ok, detail });
    if (!ok) fail(name, 'check failed', detail);
  };
  if (!fs.existsSync(EXE)) { console.error('候选包不存在：' + EXE); process.exit(2); }
  prepareUserdata();
  let ctx = null;
  try {
    /* ============ 第一次启动 ============ */
    ctx = await launch();
    result.launches.push({ boot: 'first', bootMs: Date.now() - t0 });
    await waitInit(ctx.pet);
    await sleep(1200);
    const wa = await workArea(ctx);
    result.workArea = wa;

    let a0 = await anchor(ctx);
    let g0 = await islandGeom(ctx);
    result.initial = { anchor: a0, bounds: g0.b, mode: g0.mode, cfg: readIslandCfg() };
    result.winBoundsError = winBoundsError();
    /* 早期空闲：刚启动、还没拖动过，验证内容轮询不会推着窗口走 */
    await sleep(1000);
    const ie0 = await winBounds(ctx);
    const ieS = [];
    for (let i = 0; i < 20; i++) { ieS.push(await winBounds(ctx)); await sleep(120); }
    const distinct = (arr) => [...new Set(arr.map((b) => b.left + ',' + b.top))].length;
    const rangeX = Math.max(...ieS.map((b) => b.left)) - Math.min(...ieS.map((b) => b.left));
    const rangeY = Math.max(...ieS.map((b) => b.top)) - Math.min(...ieS.map((b) => b.top));
    result.idleEarly = { from: ie0, samples: ieS.length, distinct: distinct(ieS), rangeX, rangeY };
    check('启动稳定：早期空闲最多 1 次模式/头顶修正', distinct(ieS) <= 2 && rangeX === 0 && rangeY <= 40, result.idleEarly);
    check('初始位置≈默认锚点（无偏移）', !!a0 && !!g0.b &&
      Math.max(Math.abs(g0.b.left - expected(a0, a0, { x: 0, y: 0 }, g0.caps, wa).x),
        Math.abs(g0.b.top - expected(a0, a0, { x: 0, y: 0 }, g0.caps, wa).y)) <= 14,
      { want: a0 ? expected(a0, a0, { x: 0, y: 0 }, g0.caps, wa) : null, got: g0.b });

    /* ============ 拖动 #1：+120,+70 ============ */
    const drag1 = await dragIsland(ctx, { x: -120, y: 70 }, 8);
    result.drag1 = drag1;
    const off1 = drag1.off || { x: 0, y: 0 };
    check('拖动1 落盘 off≈(-120,70)', Math.max(Math.abs(off1.x + 120), Math.abs(off1.y - 70)) <= 4, off1);
    /* 水平位移必须准；纵向会被「头顶重采样 / 球↔胶囊」合法地修正，改用最终落点复核 */
    check('拖动1 水平位移≈-120', Math.abs((drag1.end.left - g0.b.left) + 120) <= 5,
      { from: g0.b.left, to: drag1.end.left });
    const aA1 = await anchor(ctx);
    const gA1 = await islandGeom(ctx);
    const cA1 = aA1 ? bestPos(aA1, aA1, off1, wa) : null;
    const bA1 = cA1 ? [cA1.idle, cA1.caps].sort((p, q) =>
      Math.max(Math.abs(gA1.b.left - p.x), Math.abs(gA1.b.top - p.y)) -
      Math.max(Math.abs(gA1.b.left - q.x), Math.abs(gA1.b.top - q.y)))[0] : null;
    check('拖动1 最终位置=默认+off', !!bA1 &&
      Math.max(Math.abs(gA1.b.left - bA1.x), Math.abs(gA1.b.top - bA1.y)) <= 10,
      { want: bA1, got: gA1.b, off: off1 });

    /* ============ 拖动 #2：另一个落点 -60,-30 ============ */
    const drag2 = await dragIsland(ctx, { x: 60, y: -30 }, 6);
    result.drag2 = drag2;
    const off2 = drag2.off || { x: 0, y: 0 };
    check('拖动2 落盘 off≈(-60,40)', Math.max(Math.abs(off2.x + 60), Math.abs(off2.y - 40)) <= 5, off2);

    /* ============ 空闲不搬窗 ============ */
    await sleep(600);
    const idleBefore = await winBounds(ctx);
    const cfgBeforeIdle = JSON.stringify(readIslandCfg());
    const idleSamples = [];
    for (let i = 0; i < 20; i++) { idleSamples.push(await winBounds(ctx)); await sleep(120); }
    const moved = idleSamples.filter((b) => b.left !== idleBefore.left || b.top !== idleBefore.top).length;
    const idleDistinct = [...new Set(idleSamples.map((b) => b.left + ',' + b.top))].length;
    const idleRangeX = Math.max(...idleSamples.map((b) => b.left)) - Math.min(...idleSamples.map((b) => b.left));
    const idleRangeY = Math.max(...idleSamples.map((b) => b.top)) - Math.min(...idleSamples.map((b) => b.top));
    result.idle = { samples: idleSamples.length, moved, distinct: idleDistinct, rangeX: idleRangeX, rangeY: idleRangeY,
      cfgStable: JSON.stringify(readIslandCfg()) === cfgBeforeIdle };
    check('后期空闲无周期搬窗（≤2 个落点、幅度≤12DIP）', idleDistinct <= 2 && idleRangeX <= 12 && idleRangeY <= 12, result.idle);
    check('空闲不写 island.json', JSON.stringify(readIslandCfg()) === cfgBeforeIdle, null);

    /* ============ 拖岛后拖宠：岛保持同偏移跟随 ============ */
    const prePet = { pos: JSON.parse(await ctx.pet.eval('JSON.stringify(petAPI.getPos())')), anchor: await anchor(ctx) };
    /* 找角色身上一个不透明点（避免点在透明区） */
    const hit = JSON.parse(await ctx.pet.eval(`JSON.stringify((()=>{
      const r=document.getElementById('pet').getBoundingClientRect();
      for(let gy=0.25;gy<=0.75;gy+=0.1)for(let gx=0.3;gx<=0.7;gx+=0.1){
        if(petAPI.__hit(gx,gy)) return {cx:r.left+gx*r.width, cy:r.top+gy*r.height, gx, gy};
      }
      return null;})())`));
    let petDrag = { method: 'pointer', ok: false, hit };
    if (hit) {
      await mouse(ctx.pet, 'mouseMoved', hit.cx, hit.cy, 0);
      await sleep(60);
      await mouse(ctx.pet, 'mousePressed', hit.cx, hit.cy, 0);
      await sleep(60);
      for (let i = 1; i <= 6; i++) { await mouse(ctx.pet, 'mouseMoved', hit.cx + i * 13, hit.cy, 1); await sleep(30); }
      petDrag.dragging = JSON.parse(await ctx.pet.eval('JSON.stringify(petAPI.getMode())')).dragging;
      await mouse(ctx.pet, 'mouseReleased', hit.cx + 78, hit.cy, 0);
      await sleep(500);
    }
    const postPos = JSON.parse(await ctx.pet.eval('JSON.stringify(petAPI.getPos())'));
    petDrag.before = prePet.pos; petDrag.after = postPos;
    if (!(Math.abs(postPos.x - prePet.pos.x) > 30)) {
      /* 指针事件在合成输入下没吃住时，退回「拖动唯一的位移出口」place()，并在结果里注明 */
      petDrag.method = 'place-fallback';
      await ctx.pet.eval(`place(parseFloat(pet.style.left)+80, parseFloat(pet.style.top), false)`);
      await sleep(500);
      petDrag.after = JSON.parse(await ctx.pet.eval('JSON.stringify(petAPI.getPos())'));
    }
    petDrag.ok = Math.abs(petDrag.after.x - prePet.pos.x) > 30;
    const aPet = await anchor(ctx);
    const gPet = await islandGeom(ctx);
    const offNow = (readIslandCfg() || {}).off || { x: 0, y: 0 };
    const cands = aPet ? bestPos(aPet, aPet, offNow, wa) : null;
    const best = cands ? [cands.idle, cands.caps].sort((p, q) =>
      Math.max(Math.abs(gPet.b.left - p.x), Math.abs(gPet.b.top - p.y)) -
      Math.max(Math.abs(gPet.b.left - q.x), Math.abs(gPet.b.top - q.y)))[0] : null;
    petDrag.anchor = aPet; petDrag.bounds = gPet.b; petDrag.want = cands; petDrag.off = offNow;
    result.petDrag = petDrag;
    check('拖宠成功（指针注入或 place 出口）', petDrag.ok, { method: petDrag.method, before: prePet.pos, after: petDrag.after });
    /* x 必须精确跟着新锚点；y 允许 ±40：islandHeadNow() 是逐像素即时重采样，
       与主进程「上一帧上报的 head」本来就可能差一行（这就是事件驱动跟随的正常量） */
    check('拖宠后岛按同一偏移跟随（x 精确，y 受头顶重采样±40）',
      !!best && Math.abs(gPet.b.left - best.x) <= 8 && Math.abs(gPet.b.top - best.y) <= 40,
      { want: best, got: gPet.b, off: offNow });

    /* ============ 短点击仍可用（展开态点一下 → pin 切换，且不搬窗） ============ */
    await ctx.isl.eval('window.petHost.islandInvoke("island_demo",{cmd:"msg"})');
    let capsMode = 'idle';
    for (let i = 0; i < 20; i++) { await sleep(150); capsMode = await ctx.isl.eval('(document.getElementById("isl")||{getAttribute:()=>"idle"}).getAttribute("data-mode")||"idle"'); if (capsMode !== 'idle') break; }
    const clip0 = await winBounds(ctx);
    const pinned0 = await ctx.isl.eval('document.getElementById("isl").classList.contains("pinned")');
    const cnt0 = JSON.parse(await ctx.isl.eval('JSON.stringify({clicks:window.__islandClickCount||0,singles:window.__islandSingleCount||0})'));
    const r2 = JSON.parse(await ctx.isl.eval('JSON.stringify((()=>{const e=document.getElementById("isl");const r=e.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};})())'));
    const c2 = { x: r2.x + r2.w / 2, y: r2.y + r2.h / 2 };
    await mouse(ctx.isl, 'mouseMoved', c2.x, c2.y, 0);
    await sleep(80);
    await mouse(ctx.isl, 'mousePressed', c2.x, c2.y, 0);
    await sleep(60);
    await mouse(ctx.isl, 'mouseReleased', c2.x, c2.y, 0);
    await sleep(700);
    const pinned1 = await ctx.isl.eval('document.getElementById("isl").classList.contains("pinned")');
    const clip1 = await winBounds(ctx);
    const clickDbg = JSON.parse(await ctx.isl.eval('JSON.stringify({clicks:window.__islandClickCount||0,singles:window.__islandSingleCount||0,cls:document.getElementById("isl").className})'));
    const clicked = clickDbg.singles > cnt0.singles && clickDbg.clicks > cnt0.clicks;
    result.shortClick = { mode: capsMode, pinnedBefore: pinned0, pinnedAfter: pinned1, before: clip0, after: clip1, clickDbg,
      clicked, moved: clip1.left !== clip0.left || clip1.top !== clip0.top };
    check('短点击被识别（singleClick 触发）', clicked, result.shortClick);
    if (capsMode !== 'idle') check('胶囊态短点击 → pin 切换', pinned0 !== pinned1, result.shortClick);
    check('短点击不搬窗（x 不动；y 只允许头顶重采样修正）',
      clip1.left === clip0.left && Math.abs(clip1.top - clip0.top) <= 40, { before: clip0, after: clip1 });

    /* ============ 不同缩放（桌宠 340 → 240，岛 zoom 0.8 → 0.56） ============ */
    const beforeSize = JSON.parse(await ctx.pet.eval('JSON.stringify({size:petAPI.getSize()})'));
    const gz0 = await islandGeom(ctx);
    await ctx.pet.eval('petAPI.setSize(240)');
    await sleep(800);
    const aZ = await anchor(ctx);
    const gz = await islandGeom(ctx);
    const offZ = (readIslandCfg() || {}).off || { x: 0, y: 0 };
    const wantZ = aZ ? expected(aZ, aZ, offZ, gz.caps, wa) : null;
    result.zoom = { beforeSize: beforeSize.size, widthBefore: gz0.b.width, widthAfter: gz.b.width, zoom: wantZ ? wantZ.zoom : null,
      anchor: aZ, bounds: gz.b, want: wantZ, off: offZ };
    check('缩放后窗口宽度按 zoom 变化', wantZ && Math.abs(gz.b.width - wantZ.Wz) <= 2, result.zoom);
    check('缩放后仍按 off 落位', !!wantZ && Math.max(Math.abs(gz.b.left - wantZ.x), Math.abs(gz.b.top - wantZ.y)) <= 10, { want: wantZ, got: gz.b });
    await ctx.pet.eval('petAPI.setSize(340)');
    await sleep(700);

    /* ============ 贴边只夹取显示、不回写偏移 ============ */
    const offPreEdge = (readIslandCfg() || {}).off || { x: 0, y: 0 };
    const edge = await dragIsland(ctx, { x: 4000, y: 0 }, 6);
    const offEdge = (readIslandCfg() || {}).off || { x: 0, y: 0 };
    const bEdge = edge.end;
    /* 岛被夹到「离目标最近的那块显示器」的右缘：用岛页面自己的 screen.avail* 复算 */
    const sc = JSON.parse(await ctx.isl.eval('JSON.stringify({left:screen.availLeft||0,top:screen.availTop||0,width:screen.availWidth,height:screen.availHeight})'));
    const clampX = sc.left + sc.width - bEdge.width;
    result.edge = { offBefore: offPreEdge, offAfter: offEdge, bounds: bEdge, clampX, screen: sc, wa };
    check('贴右缘窗口被夹取', Math.abs(bEdge.left - clampX) <= 3, { left: bEdge.left, clampX });
    check('夹取不回写偏移（off 保留用户意图）',
      Math.abs(offEdge.x - (offPreEdge.x + 4000)) <= 8, { want: offPreEdge.x + 4000, got: offEdge.x });
    /* 拖回一个正常落点，给重启验收留一个非零偏移 */
    const backDelta = { x: 100 - offEdge.x, y: 60 - offEdge.y };
    const back = await dragIsland(ctx, backDelta, 8);
    result.dragBack = back;
    const offFinal = (readIslandCfg() || {}).off || { x: 0, y: 0 };
    result.finalOff = offFinal;
    check('拖回后 off≈(100,60)', Math.max(Math.abs(offFinal.x - 100), Math.abs(offFinal.y - 60)) <= 5, offFinal);

    ctx.pet.close(); ctx.isl.close(); ctx.browser.close();
    spawnSync('taskkill', ['/PID', String(ctx.child.pid), '/T', '/F'], { stdio: 'ignore' });
    ctx = null;
    await sleep(800);

    /* ============ 重启还原 ============ */
    const t2 = Date.now();
    ctx = await launch();
    result.launches.push({ boot: 'restart', bootMs: Date.now() - t2 });
    await waitInit(ctx.pet);
    await sleep(1500);
    const wa2 = await workArea(ctx);
    const aR = await anchor(ctx);
    const gR = await islandGeom(ctx);
    const offR = (readIslandCfg() || {}).off || { x: 0, y: 0 };
    const wantR = aR ? expected(aR, aR, offR, gR.caps, wa2) : null;
    result.restart = { anchor: aR, bounds: gR.b, off: offR, want: wantR };
    check('重启后 off 仍在 island.json', Math.abs(offR.x - 100) <= 5 && Math.abs(offR.y - 60) <= 5, offR);
    check('重启后按 off 还原位置', !!wantR &&
      Math.max(Math.abs(gR.b.left - wantR.x), Math.abs(gR.b.top - wantR.y)) <= 10,
      { want: wantR, got: gR.b });

    /* 重启后短点击仍可用 */
    await ctx.isl.eval('window.petHost.islandInvoke("island_demo",{cmd:"msg"})');
    for (let i = 0; i < 20; i++) { await sleep(150); if ((await ctx.isl.eval('(document.getElementById("isl")||{getAttribute:()=>"idle"}).getAttribute("data-mode")||"idle"')) !== 'idle') break; }
    const p0 = await ctx.isl.eval('document.getElementById("isl").classList.contains("pinned")');
    const rc0 = JSON.parse(await ctx.isl.eval('JSON.stringify({clicks:window.__islandClickCount||0,singles:window.__islandSingleCount||0})'));
    const rr = JSON.parse(await ctx.isl.eval('JSON.stringify((()=>{const e=document.getElementById("isl");const r=e.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};})())'));
    const cc = { x: rr.x + rr.w / 2, y: rr.y + rr.h / 2 };
    await mouse(ctx.isl, 'mouseMoved', cc.x, cc.y, 0); await sleep(80);
    await mouse(ctx.isl, 'mousePressed', cc.x, cc.y, 0); await sleep(60);
    await mouse(ctx.isl, 'mouseReleased', cc.x, cc.y, 0); await sleep(700);
    const p1 = await ctx.isl.eval('document.getElementById("isl").classList.contains("pinned")');
    const rc1 = JSON.parse(await ctx.isl.eval('JSON.stringify({clicks:window.__islandClickCount||0,singles:window.__islandSingleCount||0})'));
    result.restartClick = { pinnedBefore: p0, pinnedAfter: p1, clicks: [rc0.clicks, rc1.clicks], singles: [rc0.singles, rc1.singles] };
    check('重启后短点击仍可用', rc1.singles > rc0.singles && rc1.clicks > rc0.clicks, result.restartClick);
    if (p0 !== p1) result.restartClick.pinToggled = true;

    result.elapsedMs = Date.now() - t0;
    result.ok = result.failures.length === 0;
    console.log('DRAG_E2E_RESULT ' + JSON.stringify({ ok: result.ok, phase: PHASE, failures: result.failures, checks: result.checks.map((c) => (c.ok ? 'PASS ' : 'FAIL ') + c.name) }));
  } catch (e) {
    result.error = String((e && e.message) || e);
    result.ok = false;
    if (result.checks.length && !result.failures.length) result.failures.push({ name: 'exception', msg: result.error });
    console.log('DRAG_E2E_FAIL ' + JSON.stringify({ phase: PHASE, error: result.error, stderr: ctx ? (ctx.err() || '').slice(-800) : '' }));
  } finally {
    try { if (ctx) { ctx.pet.close(); ctx.isl.close(); ctx.browser.close(); spawnSync('taskkill', ['/PID', String(ctx.child.pid), '/T', '/F'], { stdio: 'ignore' }); } } catch (e) {}
    try {
      const dir = path.dirname(OUT);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
      console.log('DRAG_E2E_OUT ' + OUT);
    } catch (e) {}
    process.exitCode = result.ok ? 0 : 1;
  }
})();
