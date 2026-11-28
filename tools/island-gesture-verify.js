#!/usr/bin/env node
/**
 * island-gesture-verify.js — 灵动岛手势集的真机验收（CDP 合成 pointer 序列）
 *
 * 前置：桌宠带调试口启动，**独立 user-data-dir 与独立端口**（别占 9333）：
 *   ./app/node_modules/electron/dist/electron.exe app \
 *     --user-data-dir="build/_gesture_ud" --remote-debugging-port=9334
 *
 * 跑法：node tools/island-gesture-verify.js [--port=9334] [--out=build/gesture-verify]
 * 退出码：全 PASS = 0，有 FAIL = 1，连不上 = 2
 *
 * 五个场景（任务书第四节第 4 条）：
 *   ① 慢拖 80px 松手  → 发生切换（activityIndex 变化；位移判据）
 *   ② 快甩 20px       → 发生切换（|vx| > 0.35；速度判据单独起作用）
 *   ③ 慢拖 10px       → 不切换、弹簧回原位（--drag-x 归 0）
 *   ④ 上拖 40px       → 隐藏（dismiss 通道，主进程 hidden=true）
 *   ⑤ 队列 ≤1 张横拖  → activityIndex 不变、--drag-x 归 0、单击仍能走通
 *
 * 每个场景都把 getBoundingClientRect() / __islandMotion() 的真实采样写进证据 JSON，
 * 不是只打印「通过」。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const CDP_PORT = Number(arg('port', '9334'));
const OUT_DIR = path.resolve(__dirname, '..', arg('out', 'build/gesture-verify'));

let pass = 0, fail = 0;
const failures = [];
const scenes = {};          // 场景名 → 证据对象
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name + (extra !== undefined ? '  ' + brief(extra) : '')); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (extra !== undefined ? '  ' + brief(extra) : '')); }
}
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 260 ? s.slice(0, 260) + '…' : s;
}
/* 信息行：记录「不以成败论」的现场状态。验收机上可能有外部活动源（Hermes 的 Agent 看板
   不受 island cfg 控制），那种东西不该进 PASS/FAIL，但必须留在证据里。 */
function info(name, extra) {
  console.log('INFO  ' + name + (extra !== undefined ? '  ' + brief(extra) : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTarget() {
  for (let i = 0; i < 24; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && /island\.html/.test(t.url));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch { /* 调试口刚起时偶尔连不上 */ }
    await sleep(500);
  }
  throw new Error('找不到 island.html 靶子；确认桌宠带 --remote-debugging-port=' + CDP_PORT + ' 在跑');
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const target = await cdpTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params && msg.params.exceptionDetails;
      /* 带上行号与调用栈：只记一句「Uncaught」等于没记，查不动 */
      const desc = (d && (d.exception && (d.exception.description || d.exception.value))) || '';
      const where = d && d.url ? ' @' + d.url + ':' + d.lineNumber + ':' + d.columnNumber : '';
      const frames = (d && d.stackTrace && d.stackTrace.callFrames || []).slice(0, 3)
        .map((f) => (f.functionName || '?') + ':' + f.lineNumber).join(' < ');
      errors.push('exception: ' + ((d && d.text) || 'unknown') + ' | ' + String(desc).slice(0, 200) + where + (frames ? ' | ' + frames : ''));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params && msg.params.type === 'error') {
      errors.push('console.error: ' + (msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
    }
    if (msg.method === 'Log.entryAdded' && msg.params && msg.params.entry) {
      const en = msg.params.entry;
      if (en.level === 'error') errors.push('log.error: ' + en.text + (en.url ? ' @' + en.url : ''));
    }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  async function ev(expr, awaitPromise = false) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise, userGesture: true });
    if (r.result && r.result.exceptionDetails) {
      return { __error: r.result.exceptionDetails.text || (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description) };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  const state = () => ev('window.__islandState ? window.__islandState() : null');
  const islandGet = () => ev("window.petHost.islandInvoke('island_get', {})", true);
  const call = (name, cmd) => ev(`(function(){ try { return window.petHost.islandInvoke('${name}', {cmd:${JSON.stringify(cmd)}}); } catch(e){ return 'throw:'+e.message; } })()`, true);
  /* preload 只把 payload.cmd / .patch / .mode 取出来当第一个实参，所以 patch 必须塞进 cmd：
     直接传 {msg:false} 会被吞成 undefined（踩过，会让「关掉消息源」静默不生效）。 */
  const setCfg = (patchObj) => ev(`(function(){ try { return window.petHost.islandInvoke('island_set', {cmd:${JSON.stringify(patchObj)}}); } catch(e){ return 'throw:'+e.message; } })()`, true);

  const mouse = (type, x, y, buttons) => send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y), button: 'left', buttons, clickCount: 1,
  });

  /* 快甩：按下 → 停 50ms（模拟人手指先停住）→ 三个事件连着发、不逐个等回包。
     逐个 await 会把每一段拖到 10ms 以上，速度就被算成慢拖 —— 第一版就是这么
     测出 vx≈-0.3 的假阴性（判据本身没问题，是造事件的方式不真实）。 */
  async function flick(dxTotal) {
    const s0 = await state();
    const cx = s0.rect[0] + s0.rect[2] / 2;
    const cy = s0.rect[1] + s0.rect[3] / 2;
    await mouse('mousePressed', cx, cy, 1);
    await sleep(25);                      // 手指停顿 25ms 再甩：速度窗口（≥8ms）里只有「按下→抬手」
    const burst = [
      mouse('mouseMoved', cx + dxTotal / 2, cy, 1),
      mouse('mouseMoved', cx + dxTotal, cy, 1),
      mouse('mouseReleased', cx + dxTotal, cy, 0),
    ];
    await Promise.all(burst);
    await sleep(40);
    const afterUp = await state();
    await sleep(700);
    const settled = await state();
    return { from: s0, center: [cx, cy], afterUp, settled, kind: 'flick' };
  }

  /**
   * 一次拖拽：offsets 是相对按下点的位移序列，gaps 是每步之后的等待。
   * sampleEach=false 时不在每个 move 之后采样 —— 采样本身要几个 ms，会拖慢速度。
   */
  async function drag(offsets, gaps, sampleEach, shotAfterStep) {
    const s0 = await state();
    const cx = s0.rect[0] + s0.rect[2] / 2;
    const cy = s0.rect[1] + s0.rect[3] / 2;
    const trace = [];
    await mouse('mousePressed', cx, cy, 1);
    await sleep(50);                      // 真实用户按下也会有几十毫秒的停留
    trace.push({ step: 'down', at: Date.now(), st: await state() });
    for (let i = 0; i < offsets.length; i++) {
      await mouse('mouseMoved', cx + offsets[i][0], cy + offsets[i][1], 1);
      if (gaps[i]) await sleep(gaps[i]);
      if (sampleEach) trace.push({ step: 'move' + (i + 1), off: offsets[i], at: Date.now(), st: await state() });
      if (shotAfterStep && i + 1 === shotAfterStep) await capture('shot-01-drag-mid.png');
    }
    const last = offsets[offsets.length - 1] || [0, 0];
    const beforeUp = await state();
    const tUp = Date.now();
    await mouse('mouseReleased', cx + last[0], cy + last[1], 0);
    await sleep(40);
    const afterUp = await state();
    const tAfter = Date.now();
    await sleep(700);                     // 等切换落定 / drag 弹簧回位
    const settled = await state();
    return { from: s0, center: [cx, cy], trace, beforeUp, afterUp, settled, tUp, tAfter };
  }

  async function capture(file) {
    try {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      if (shot && shot.result && shot.result.data) {
        fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(shot.result.data, 'base64'));
        console.log('INFO  截图 → ' + file);
        return true;
      }
    } catch (e) { console.log('WARN  截图失败 ' + file + ': ' + e.message); }
    return false;
  }

  function save(name, obj) {
    const f = path.join(OUT_DIR, name);
    fs.writeFileSync(f, JSON.stringify(obj, null, 1));
    console.log('INFO  证据 → ' + path.relative(path.resolve(__dirname, '..'), f));
  }

  /* ---------- 0. 页面基础 ---------- */
  ok('页面就绪（__islandReady）', (await ev('window.__islandReady === true')) === true);
  ok('手势判定层已加载（window.IslandGesture.create）',
    (await ev('typeof window.IslandGesture === "object" && typeof window.IslandGesture.create === "function"')) === true);
  const st0 = await state();
  ok('__islandState() 可读（rect / motion / drag 变量）',
    !!st0 && Array.isArray(st0.rect) && !!st0.motion && typeof st0.dragX === 'number', st0 && st0.rect);

  /* ---------- 队列准备：消息 + Agent → activityCount >= 2 ---------- */
  const demo = await call('island_demo', 'activities');
  console.log('INFO  demo(activities) → ' + JSON.stringify(demo));
  await sleep(900);
  const pre = await state();
  ok('活动队列已建立（activityCount >= 2）', pre.activityCount >= 2,
    { count: pre.activityCount, index: pre.activityIndex, kind: pre.activityKind, mode: pre.mode });

  /* ---------- ① 慢拖 80px ---------- */
  {
    const r = await drag([[-10, 0], [-20, 0], [-30, 0], [-40, 0], [-50, 0], [-60, 0], [-70, 0], [-80, 0]],
      [75, 75, 75, 75, 75, 75, 75, 0], true, 5);   // 第 5 步截一张「拖到一半」的现场
    const g = r.afterUp.lastGesture || {};
    const mid = r.trace[4] ? r.trace[4].st : null;
    ok('① 松手判成 swipe-left（位移 80 ≥ 40，慢速）',
      g.type === 'swipe-left', { type: g.type, dx: g.dx, vx: g.vx });
    ok('① 慢拖速度确实低于速度阈值（证明走的是位移判据）',
      Math.abs(g.vx) < 0.35, { vx: g.vx });
    ok('① 拖动中岛真的跟着走了（--drag-x < -20）',
      !!mid && mid.dragX < -20, mid && { dragX: mid.dragX, dragFade: mid.dragFade, rect: mid.rect });
    ok('① 卡面拖到一半时被淡出（--drag-fade < 1）',
      !!mid && mid.dragFade < 1, mid && mid.dragFade);
    ok('① 发生切换（activityIndex 变了）',
      r.settled.activityIndex !== pre.activityIndex,
      { before: pre.activityIndex, after: r.settled.activityIndex, kind: r.settled.activityKind, mode: r.settled.mode });
    ok('① 切换后画面跟到新活动（mode == activityKind）',
      r.settled.mode === r.settled.activityKind, { mode: r.settled.mode, kind: r.settled.activityKind });
    ok('① 松手后 --drag-x 归 0（偏移是临时量，没写进弹簧目标）',
      Math.abs(r.settled.dragX) < 0.5, { dragX: r.settled.dragX });
    await capture('shot-01-after-switch.png');
    scenes['01-slow-drag-80'] = r;
    save('ev-01-slow-drag-80.json', r);
  }

  /* ---------- ② 快甩 20px（速度判据） ---------- */
  {
    const idxBefore = (await state()).activityIndex;
    const r = await flick(-20);
    const g = r.afterUp.lastGesture || {};
    ok('② 快甩判成 swipe-left（|dx|=20 < 40，只有速度判据能解释）',
      g.type === 'swipe-left' && Math.abs(g.dx) === 20, { type: g.type, dx: g.dx, vx: g.vx });
    ok('② 实测 |vx| > 0.35（速度判据真的在起作用）', Math.abs(g.vx) > 0.35, { vx: g.vx });
    ok('② 发生切换（activityIndex 变了）', r.settled.activityIndex !== idxBefore,
      { before: idxBefore, after: r.settled.activityIndex, kind: r.settled.activityKind });
    ok('② 松手后 --drag-x 归 0', Math.abs(r.settled.dragX) < 0.5, { dragX: r.settled.dragX });
    scenes['02-flick-20'] = r;
    save('ev-02-flick-20.json', r);
  }

  /* ---------- ③ 慢拖 10px（不切换，弹簧回位） ---------- */
  {
    const idxBefore = (await state()).activityIndex;
    const r = await drag([[-5, 0], [-10, 0]], [120, 0], true);
    const g = r.afterUp.lastGesture || {};
    ok('③ 慢拖 10px 判成 none（不切换）', g.type === 'none', { type: g.type, dx: g.dx, vx: g.vx });
    ok('③ activityIndex 没变', r.settled.activityIndex === idxBefore,
      { before: idxBefore, after: r.settled.activityIndex });
    const mid = r.trace[2] ? r.trace[2].st : null;
    ok('③ 拖动中确实有偏移（--drag-x ≈ -10，不是没跟上）',
      !!mid && Math.abs(mid.dragX + 10) < 3, mid && { dragX: mid.dragX, rect: mid.rect });
    ok('③ 落定后 --drag-x 精确归 0（弹簧回原位）',
      Math.abs(r.settled.dragX) < 0.05 && Math.abs(r.settled.dragY) < 0.05,
      { dragX: r.settled.dragX, dragY: r.settled.dragY });
    ok('③ 岛回到原位置（rect.left 与拖拽前一致）',
      Math.abs(r.settled.rect[0] - r.from.rect[0]) < 1.5,
      { before: r.from.rect, after: r.settled.rect });
    scenes['03-slow-10'] = r;
    save('ev-03-slow-10.json', r);
  }

  /* ---------- ④ 上拖 40px → 隐藏 ---------- */
  {
    /* 先把「有内容」的来源全关掉，让岛回到 idle：dismiss 的 60s 隐藏只在 idle 时保持
       （这是既有 tick 的行为，双击 dismiss 也一样；另见实施报告的已知限制）。
       改的是本次测试的独立 user-data-dir，不碰用户配置。 */
    await setCfg({ msg: false, music: false, video: false });
    await call('island_demo', 'clear');
    await sleep(1200);
    /* 冻结主进程 tick：验收机上的 Agent 看板不受 cfg 控制，解冻状态下拖拽那 300ms 里
       可能就把一张 agent 卡塞进队列，判据会被搅浑。freeze 只停推送，不影响 hidden。 */
    await call('island_cmd', 'freeze');
    await sleep(200);
    const idle = await state();
    info('④ 上拖前的现场（不当作判据：外部活动源不受 cfg 控制）',
      { mode: idle.mode, count: idle.activityCount, index: idle.activityIndex, rect: idle.rect });

    const r = await drag([[0, -20], [0, -40]], [80, 0], true);
    const g = r.afterUp.lastGesture || {};
    ok('④ 上拖 40px 判成 up-hide', g.type === 'up-hide', { type: g.type, dx: g.dx, dy: g.dy });
    const mid = r.trace[2] ? r.trace[2].st : null;
    ok('④ 拖动中岛跟着上移（--drag-y ≈ -40）',
      !!mid && mid.dragY < -30, mid && { dragY: mid.dragY, rect: mid.rect });
    await sleep(700);
    const gs = await islandGet();
    ok('④ 主进程确认已隐藏（island:get → hidden=true）',
      !!gs && !!gs.data && gs.data.hidden === true, gs && gs.data);
    r.hiddenState = gs && gs.data;
    scenes['04-up-hide'] = r;
    save('ev-04-up-hide.json', r);

    /* 复原：下一场景要把岛叫回来，验证完也把配置还原 */
    await call('island_cmd', 'expand');
    await call('island_cmd', 'unfreeze');
    await setCfg({ msg: true, music: true, video: true });
    await sleep(900);
    const shown = await state();
    ok('④ 隐藏后能被重新叫回来（expand → 页面仍存活）',
      shown.ready === true, { mode: shown.mode, ready: shown.ready });
  }

  /* ---------- ④b 有活动卡在显示时，上拖也必须真的隐藏住 ---------- */
  {
    await call('island_demo', 'activities');
    await sleep(950);
    const live = await state();
    ok('④b 前置：又有一张活动卡在显示（count ≥ 2）', live.activityCount >= 2 && live.mode !== 'idle',
      { mode: live.mode, count: live.activityCount });

    const r = await drag([[0, -20], [0, -40]], [80, 0], false);
    const g = r.afterUp.lastGesture || {};
    ok('④b 有卡时上拖仍判成 up-hide', g.type === 'up-hide', { type: g.type, dy: g.dy });
    await sleep(1300);      /* 跨过至少两个 500ms tick：原来这里会被自己顶回来 */
    const gs = await islandGet();
    ok('④b 隐藏保持住了（1.3s 后 hidden 仍为 true，没被「同一张还新鲜的卡」顶回来）',
      !!gs && !!gs.data && gs.data.hidden === true, gs && gs.data);
    await capture('shot-04b-hidden-with-card.png');
    await call('island_cmd', 'expand');
    await sleep(700);
  }

  /* ---------- ⑤ 队列 ≤1 张时横拖必须 inert ---------- */
  {
    await call('island_demo', 'clear');
    await sleep(600);
    /* 必须先冻结再清空：解冻状态下 clear 之后到 freeze 之间只要跨过一个 500ms tick，
       外部活动（Agent 看板）就被塞回队列了 —— 「队列 ≤1 时必须 inert」永远测不到。
       freeze 只停推送，island:demo 直接改队列，仍然有效。 */
    await call('island_cmd', 'freeze');
    await call('island_demo', 'clear');
    await sleep(200);
    const before = await state();
    ok('⑤ 起点确实是空队列（freeze 之后复核）', before.activityCount === 0,
      { count: before.activityCount, index: before.activityIndex, steps: before.steps });

    const r = await drag([[-20, 0], [-40, 0], [-60, 0], [-80, 0]], [75, 75, 75, 0], true);
    const g = r.afterUp.lastGesture || {};
    ok('⑤ 手势本身仍被识别（swipe-left），但页面必须 inert', g.type === 'swipe-left',
      { type: g.type, dx: g.dx });
    /* inert 的真判据是「页面有没有发起切换请求」，不是 activityIndex 的数值 ——
       队列内容本身会随时间变（外部活动进出），index 变化不能归因于手势。 */
    ok('⑤ 页面没有发起切换请求（steps 不变 = 真 inert）',
      r.settled.steps === before.steps,
      { before: before.steps, after: r.settled.steps });
    info('⑤ 队列读数', { beforeIndex: before.activityIndex, afterIndex: r.settled.activityIndex });
    ok('⑤ --drag-x 归 0（不做假回弹动画，直接就位）',
      Math.abs(r.settled.dragX) < 0.05, { dragX: r.settled.dragX });
    scenes['05-inert'] = r;
    save('ev-05-inert.json', r);

    /* 单击不能被手势吞掉：一次干净的 tap 必须走到 singleClick */
    await sleep(520);                     // 等 click 压制窗口（400ms）过期
    const t0 = await state();
    const cx = t0.rect[0] + t0.rect[2] / 2, cy = t0.rect[1] + t0.rect[3] / 2;
    await mouse('mousePressed', cx, cy, 1);
    await sleep(40);
    await mouse('mouseReleased', cx, cy, 0);
    await sleep(400);
    const t1 = await state();
    ok('⑤ tap 判成 tap（没有位移）', (t1.lastGesture || {}).type === 'tap', t1.lastGesture);
    ok('⑤ 单击真的走通了（click 计数 +1，没被手势吞掉）', t1.clicks > t0.clicks,
      { before: t0.clicks, after: t1.clicks, taps: t1.taps });
    scenes['05b-tap'] = { before: t0, after: t1 };
    await call('island_cmd', 'unfreeze');
    /* ⑤b 的单击会触发展开/收起，response 0.34s 的弹簧要落定得等到 ~1.2s；
       ⑥ 断言的就是「落定后静止」，等短了会把正常动画读成「目标跑偏」。 */
    await sleep(1500);
  }

  /* ---------- ⑥ 稳定性：拖拽不会让弹簧目标跑掉 ---------- */
  {
    /* 等到真的落定再判：载荷随时可能改目标（外部活动进出、队列淘汰），
       固定 sleep 会把「正常收敛中」误判成「目标跑偏」。 */
    let s = await state();
    for (let i = 0; i < 20; i++) {
      const mm = s && s.motion;
      if (mm && mm.w && mm.w.settled && mm.h.settled && mm.p.settled && mm.x.settled) break;
      await sleep(150);
      s = await state();
    }
    const m = s.motion || {};
    ok('⑥ 全部弹簧已落定（settled=true，静止时不再排帧）',
      !!m.w && m.w.settled === true && m.h.settled === true && m.p.settled === true && m.x.settled === true,
      m && { w: m.w && m.w.settled, h: m.h && m.h.settled, p: m.p && m.p.settled, x: m.x && m.x.settled });
    ok('⑥ 胶囊/球尺寸没被拖拽改过（w 精确等于目标）',
      !!m.w && Math.abs(m.w.value - m.w.target) < 1e-6,
      m && { value: m.w && m.w.value, target: m.w && m.w.target });
  }

  /* ---------- ⑦ 页面无 JS 异常 ---------- */
  await sleep(300);
  ok('⑦ 全程无 JS 异常 / console.error / log.error', errors.length === 0, errors.slice(0, 5));

  const summary = {
    at: new Date().toISOString(),
    port: CDP_PORT,
    pass, fail, failures,
    errors,
    scenes: Object.keys(scenes),
  };
  save('ev-summary.json', summary);

  /* 截图留档（隐藏的窗口截不到内容就是黑的，这里只做记录不判断） */
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot && shot.result && shot.result.data) {
      fs.writeFileSync(path.join(OUT_DIR, 'shot-after-gestures.png'), Buffer.from(shot.result.data, 'base64'));
      console.log('INFO  截图 → ' + path.join(OUT_DIR, 'shot-after-gestures.png'));
    }
  } catch (e) { console.log('WARN  截图失败: ' + e.message); }

  console.log('\n========== ' + pass + ' passed, ' + fail + ' failed ==========');
  if (fail) console.log('失败项: ' + failures.join(' | '));
  ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('FATAL ' + (e && e.stack || e));
  process.exit(2);
});
