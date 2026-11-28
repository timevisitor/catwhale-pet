#!/usr/bin/env node
/**
 * island-hit-test.js — 灵动岛命中层与形变曲线的真机验收
 *
 * 前置：桌宠带调试口启动，例如
 *   ./app/node_modules/electron/dist/electron.exe app \
 *     --user-data-dir="build/_island_ud" --remote-debugging-port=9333
 *
 * 跑法：node tools/island-hit-test.js [--port=9333] [--out=build/island-verify]
 *
 * 覆盖：
 *   一、页面基础：加载完成 / 无脚本错误
 *   二、命中层：__hitDbg 结构、pointerdown 锁命中、拖到窗口外不丢、pointerup 释放
 *   三、形状变化后主动复算（没有 mousemove 也要更新命中）
 *   四、形变曲线：逐帧采样宽度，单调、终点精确、内容滞后于轮廓（有弹簧引擎时）
 *   五、反向中断：展开到一半转收起，位置连续不跳变
 *   六、控制台零报错
 *
 * 退出码：全 PASS 为 0，有 FAIL 为 1。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const CDP_PORT = Number(arg('port', '9333'));
const OUT_DIR = path.resolve(__dirname, '..', arg('out', 'build/island-verify'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
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
  throw new Error('找不到 island.html 的 CDP 靶子；确认桌宠带 --remote-debugging-port=' + CDP_PORT + ' 在跑，且灵动岛已启用');
}

/* 页面里跑的逐帧探针：同时采宽度、圆角、卡片层与内容层不透明度 */
const PROBE = `
window.__probe = { on: false, s: [] };
window.__probeStart = function () {
  window.__probe = { on: true, s: [], t0: performance.now() };
  (function loop() {
    if (!window.__probe.on) return;
    var isl = document.getElementById('isl');
    var r = isl.getBoundingClientRect();
    var cs = getComputedStyle(isl);
    var cEl = isl.querySelector('.content');
    var cOp = cEl ? parseFloat(getComputedStyle(cEl).opacity) : null;
    var cv = isl.querySelector('.content');
    var vis = cv ? getComputedStyle(cv).visibility : '';
    window.__probe.s.push({
      t: Math.round(performance.now() - window.__probe.t0),
      w: +r.width.toFixed(2), h: +r.height.toFixed(2),
      br: parseFloat(cs.borderRadius) || 0,
      op: parseFloat(cs.opacity),
      cOp: cOp, cVis: vis
    });
    requestAnimationFrame(loop);
  })();
};
window.__probeStop = function () { window.__probe.on = false; return window.__probe.s; };
`;

(async () => {
  const target = await cdpTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params && msg.params.exceptionDetails;
      consoleErrors.push((d && (d.text || (d.exception && d.exception.description))) || 'unknown');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params && msg.params.type === 'error') {
      consoleErrors.push((msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
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
  await send('Page.enable');

  /* 冻结主进程 500ms 推送，否则手工 render 会被实时数据冲掉。
     注意 preload 的 islandInvoke 只把 object 当 payload，传裸字符串会被吞成 undefined。 */
  const frozen = await ev(`(function(){ try { return window.petHost.islandInvoke('island_cmd',{cmd:'freeze'}); } catch(e){ return 'throw:'+e.message; } })()`, true);
  ok('主进程推送已冻结（freeze 生效）', frozen && frozen.ok === true, frozen);
  await sleep(300);
  await ev(PROBE);

  /* ---------- 一、页面基础 ---------- */
  ok('页面已就绪（__islandReady）', (await ev('window.__islandReady === true')) === true);
  ok('岛主体存在', (await ev('!!document.getElementById("isl")')) === true);
  const hasMotion = await ev('typeof window.IslandMotion === "object" && window.IslandMotion !== null');
  console.log('INFO  弹簧引擎 IslandMotion 已加载: ' + hasMotion);

  /* ---------- 二、命中层 ---------- */
  const dbgStruct = await ev(`(function(){
    document.dispatchEvent(new MouseEvent('mousemove', {clientX: 320, clientY: 40, bubbles: true}));
    var d = window.__hitDbg;
    if (!d) return 'no-dbg';
    var keys = ['x','y','rect','inside','sent','hold'];
    for (var i=0;i<keys.length;i++) if (!(keys[i] in d)) return 'missing:' + keys[i];
    return Array.isArray(d.rect) && d.rect.length === 4 ? 'ok' : 'bad-rect';
  })()`);
  ok('__hitDbg 结构完整', dbgStruct === 'ok', dbgStruct);

  const rehitFn = await ev('typeof window.__islandRehit === "function"');
  ok('导出 __islandRehit 供形状变化后复算', rehitFn === true);

  /* 用真实 CDP 输入模拟：按下 → 拖到窗口外 → 释放 */
  const box = await ev(`(function(){ var r = document.getElementById('isl').getBoundingClientRect();
    return {x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height}; })()`);
  ok('取到岛主体的屏幕坐标', box && isFinite(box.x) && box.w > 0, box);

  const press = async (x, y, type, buttons) => send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y), button: 'left', buttons, clickCount: 1,
  });

  await press(box.x, box.y, 'mousePressed', 1);
  await sleep(120);
  const holdDuring = await ev('window.__hitDbg && window.__hitDbg.hold');
  ok('pointerdown 后命中被锁定（hold>0）', Number(holdDuring) > 0, holdDuring);
  const insideDuring = await ev('window.__hitDbg && window.__hitDbg.inside');
  ok('锁定期间命中恒为 true', insideDuring === true, insideDuring);

  /* 拖到窗口外（窗口 640×150，这里给一个明显在外面的坐标） */
  await press(1180, 900, 'mouseMoved', 1);
  await sleep(120);
  const holdOutside = await ev('window.__hitDbg && window.__hitDbg.hold');
  ok('拖出窗口后 hold 仍未释放（pointer capture 生效）', Number(holdOutside) > 0, holdOutside);

  await press(1180, 900, 'mouseReleased', 0);
  await sleep(200);
  const holdAfter = await ev('window.__hitDbg && window.__hitDbg.hold');
  ok('pointerup 后 hold 归零', Number(holdAfter) === 0, holdAfter);
  const insideAfter = await ev('window.__hitDbg && window.__hitDbg.inside');
  ok('释放点在形状外 → 命中回到 false（不把 true 冻住）', insideAfter === false, insideAfter);

  /* ---------- 三、形状变化后主动复算 ---------- */
  const rehitSafe = await ev(`(function(){
    try { window.__islandRehit(); return 'ok'; } catch (e) { return 'throw:' + e.message; }
  })()`);
  ok('__islandRehit 调用不抛错', rehitSafe === 'ok', rehitSafe);

  /* 球态下光标停在原地，切到胶囊态后命中应被重新计算 */
  const shapeChange = await ev(`(function(){
    window.applyIsland({ mode: 'idle' });
    return new Promise(function (res) {
      setTimeout(function () {
        var before = window.__hitDbg && window.__hitDbg.rect ? window.__hitDbg.rect[2] : 0;
        window.applyIsland({ mode: 'music', music: { title: 'T', artist: 'A', appName: 'X', pos: 1, dur: 2 } });
        setTimeout(function () {
          var after = window.__hitDbg && window.__hitDbg.rect ? window.__hitDbg.rect[2] : 0;
          res({ before: +Number(before).toFixed(1), after: +Number(after).toFixed(1) });
        }, 520);
      }, 420);
    });
  })()`, true);
  ok('形状变化后 __hitDbg 的 rect 跟着更新（无需 mousemove）',
    shapeChange && shapeChange.after > shapeChange.before + 20, shapeChange);

  /* ---------- 四、形变曲线逐帧采样 ---------- */
  async function sampleSequence(fromMode, toMode, label) {
    await ev(`(function(){ window.applyIsland({ mode: '${fromMode}' }); return 1; })()`);
    await sleep(600);
    await ev('window.__probeStart()');
    await ev(`(function(){ window.applyIsland({ mode: '${toMode}'${
      toMode === 'music' ? ", music: { title: 'T', artist: 'A', appName: 'X', pos: 1, dur: 2 }" : ''
    } }); return 1; })()`);
    await sleep(700);
    const s = await ev('window.__probeStop()');
    console.log(`INFO  ${label}: 采样 ${Array.isArray(s) ? s.length : 0} 帧`);
    return Array.isArray(s) ? s : [];
  }

  const grow = await sampleSequence('idle', 'music', '球→胶囊');
  if (grow.length >= 8) {
    const ws_ = grow.map((x) => x.w);
    const target = ws_[ws_.length - 1];
    let monotonic = true;
    for (let i = 1; i < ws_.length; i++) if (ws_[i] < ws_[i - 1] - 0.6) { monotonic = false; break; }
    ok('展开宽度单调不减（无回退抖动）', monotonic, { seq: ws_.map((v) => +v.toFixed(1)) });
    ok('展开终点宽度正确（≈600）', Math.abs(target - 600) < 2, target);
    const dupFrames = ws_.filter((v, i) => i > 0 && Math.abs(v - ws_[i - 1]) < 0.05).length;
    ok('形变有中间帧（不是瞬变）', dupFrames < ws_.length * 0.85, { dupFrames, total: ws_.length });
    const settled = grow.slice(-3).every((x) => Math.abs(x.w - target) < 0.6);
    ok('最后 3 帧已落定', settled, grow.slice(-3).map((x) => x.w));

    /* 内容滞后于容器：宽度过半时，内容不透明度不应已经接近 1 */
    const halfIdx = ws_.findIndex((v) => v > (56 + target) / 2);
    if (halfIdx > 0) {
      const cOpHalf = grow[halfIdx].cOp;
      ok('容器过半时内容尚未全亮（容器先于内容）', cOpHalf === null || cOpHalf < 0.98, { w: ws_[halfIdx], cOp: cOpHalf });
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'curve-expand.json'), JSON.stringify(grow, null, 1));

    /* 几何必须完整落在窗口内：滚动/夹紧算错的直接后果是右侧内容被推出视口（真踩过）。 */
    const geo = await ev(`(function(){
      var r = document.getElementById('isl').getBoundingClientRect();
      var side = document.querySelector('#p-music .side');
      var sr = side ? side.getBoundingClientRect() : null;
      return { l:+r.left.toFixed(1), r:+r.right.toFixed(1), w:+r.width.toFixed(1),
               iw: window.innerWidth, sideR: sr ? +sr.right.toFixed(1) : null,
               sideVis: sr ? (sr.width > 0 && sr.right <= window.innerWidth) : null };
    })()`);
    ok('胶囊完整落在窗口内（左不越界、右不超出）',
      geo && geo.l >= -0.5 && geo.r <= geo.iw + 0.5, geo);
    ok('右侧标签（网易云/时间）没被推出视口',
      geo && geo.sideVis !== false && geo.sideR !== null, geo);
  } else {
    ok('展开曲线采样到足够帧数', false, grow.length);
  }

  const shrink = await sampleSequence('music', 'idle', '胶囊→球');
  if (shrink.length >= 8) {
    const ws2 = shrink.map((x) => x.w);
    let mono2 = true;
    for (let i = 1; i < ws2.length; i++) if (ws2[i] > ws2[i - 1] + 0.6) { mono2 = false; break; }
    ok('收起宽度单调不增', mono2, { seq: ws2.map((v) => +v.toFixed(1)) });
    ok('收起终点宽度正确（≈56）', Math.abs(ws2[ws2.length - 1] - 56) < 2, ws2[ws2.length - 1]);
    fs.writeFileSync(path.join(OUT_DIR, 'curve-collapse.json'), JSON.stringify(shrink, null, 1));
  }

  /* ---------- 五、反向中断连续性 ---------- */
  const reverse = await ev(`(function(){
    return new Promise(function (res) {
      window.applyIsland({ mode: 'idle' });
      setTimeout(function () {
        window.__probeStart();
        window.applyIsland({ mode: 'music', music: { title:'T', artist:'A', appName:'X', pos:1, dur:2 } });
        setTimeout(function () {
          window.applyIsland({ mode: 'idle' });
          setTimeout(function () { res(window.__probeStop()); }, 500);
        }, 150);          // 展开到一半就反向
      }, 420);
    });
  })()`, true);
  if (Array.isArray(reverse) && reverse.length >= 8) {
    const ws3 = reverse.map((x) => x.w);
    const peak = Math.max(...ws3);
    let maxJump = 0;
    for (let i = 1; i < ws3.length; i++) maxJump = Math.max(maxJump, Math.abs(ws3[i] - ws3[i - 1]));
    /* 阈值依据：正常展开在 60fps 下实测最大单帧位移 74.8px（56→130.8），
       所以「连续」的判据是单帧不超过最大速度的 1.5 倍，而不是某个绝对小值。 */
    ok('反向中断时位置连续（单帧跳变 < 110px）', maxJump < 110, { maxJump: +maxJump.toFixed(1), peak: +peak.toFixed(1) });
    ok('反向确实发生了（先涨后落）', peak > 62 && ws3[ws3.length - 1] < peak - 10, { peak: +peak.toFixed(1), end: +ws3[ws3.length - 1].toFixed(1) });
    fs.writeFileSync(path.join(OUT_DIR, 'curve-reverse.json'), JSON.stringify(reverse, null, 1));
  } else {
    ok('反向中断采样到足够帧数', false, reverse && reverse.length);
  }

  /* ---------- 六、控制台 ---------- */
  await sleep(200);
  ok('页面无脚本错误 / console.error', consoleErrors.length === 0, consoleErrors.slice(0, 4));

  /* 截图 */
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (shot && shot.result && shot.result.data) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, 'island-shot.png'), Buffer.from(shot.result.data, 'base64'));
      console.log('INFO  截图 → ' + path.join(OUT_DIR, 'island-shot.png'));
    }
  } catch (e) { console.log('WARN  截图失败: ' + e.message); }

  /* 恢复推送 */
  await ev(`(function(){ try { return window.petHost.islandInvoke('island_cmd',{cmd:'unfreeze'}); } catch(e){ return 'throw:'+e.message; } })()`, true);

  console.log('\n========== ' + pass + ' passed, ' + fail + ' failed ==========');
  if (fail) console.log('失败项: ' + failures.join(' | '));
  ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('FATAL ' + (e && e.stack || e));
  process.exit(2);
});
