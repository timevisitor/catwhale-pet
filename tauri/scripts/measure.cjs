// Tauri 版体验指标测量（基线 / 改动后用同一份脚本对比）
// 用法：node measure.cjs <exe 所在目录> [标签]
// 隔离：CATWHALE_CONFIG_DIR + WEBVIEW2_USER_DATA_FOLDER 指到测试目录，不碰用户真实配置。
'use strict';
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const exeDir = path.resolve(process.argv[2]);
const tag = process.argv[3] || 'run';
// 隔离目录默认放在 exe 目录旁边（CATWHALE_BENCH_DIR 可覆盖），只要求 exe 目录里有
// WebView2Loader.dll 与 frontend/assets；不再假设固定的构建根目录。
const WORK = path.resolve(process.env.CATWHALE_BENCH_DIR || path.join(exeDir, 'bench'));
const ISO = path.join(WORK, 'profile-' + tag);
const CFG = path.join(ISO, 'config'), EB = path.join(ISO, 'eb');
// 端口必须与测量构建里 additionalBrowserArgs 的 --remote-debugging-port 一致
const PORT = Number(process.env.CDP_PORT || 9223);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((res) => http.get(url, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res(null); } }); }).on('error', () => res(null)));
}
async function cdp(expr) {
  const list = await getJson(`http://127.0.0.1:${PORT}/json`);
  const t = (list || []).find((x) => /tauri\.localhost/.test(x.url || '') && /catwhale-poc/.test(x.title || ''));
  if (!t) throw new Error('main page target not found: ' + JSON.stringify((list || []).map((x) => x.url)));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const r = await new Promise((res) => {
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) res(m); });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  ws.close();
  if (r.result && r.result.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result && r.result.result ? r.result.result.value : undefined;
}

const PAGE = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const v0 = activeVideo();
  out.page = { now: Math.round(performance.now()), dpr: devicePixelRatio, inner: [innerWidth, innerHeight], screen: [screenX, screenY],
    playing: { paused: v0.paused, t: +v0.currentTime.toFixed(2), rs: v0.readyState, src: (v0.currentSrc || '').split('/').pop() } };
  // 空闲视频的实际出帧率
  out.idleFps = await new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) v0.requestVideoFrameCallback(f); else res(n); }; v0.requestVideoFrameCallback(f); });
  // 动作切换：从调用 play() 到新视频出第一帧
  async function sw(id) {
    const before = vidIdx; const t0 = performance.now();
    play(id, { force: true });
    const nxt = vids[1 - before];
    return await new Promise((res) => { let done = false;
      const to = setTimeout(() => { if (!done) { done = true; res({ ms: Math.round(performance.now() - t0), timeout: true }); } }, 4000);
      nxt.requestVideoFrameCallback(() => { if (!done) { done = true; clearTimeout(to); res({ ms: Math.round(performance.now() - t0), ok: nxt.readyState >= 2 }); } }); });
  }
  out.switch = {};
  const ids = ['tail_open', 'read', 'eat', 'emo_wave'];
  for (const id of ids) { out.switch[id + ' (首次)'] = (await sw(id)).ms; await wait(250); out.switch['回到 idle'] = (await sw('idle')).ms; await wait(250); }
  const back2 = [];
  for (const id of ids) { out.switch[id + ' (再次)'] = (await sw(id)).ms; await wait(250); back2.push((await sw('idle')).ms); await wait(250); }
  out.switch['回到 idle (第二轮均值)'] = Math.round(back2.reduce((s, x) => s + x, 0) / back2.length);
  // 命中网格采样成本（drawImage + getImageData）
  { const ts = []; for (let i = 0; i < 6; i++) { const t0 = performance.now(); sampleHitGrid(); ts.push(+(performance.now() - t0).toFixed(1)); await wait(70); } out.hitGridMs = ts; }
  // 走动节拍：窗口每两次位移的间隔与步长
  out.walk = await (async () => {
    const T = window.__TAURI__; let r;
    // 先离开活动范围边缘（否则「向右走」立刻被夹住，量不到节拍）
    try { await T.core.invoke('walk_command', { text: '向左走 700 像素' }); } catch (e) {}
    await wait(6500);
    try { r = await T.core.invoke('walk_command', { text: '向右走 600 像素' }); } catch (e) { return 'invoke-failed: ' + e; }
    const samples = []; let last = null; const t0 = performance.now();
    await new Promise((res) => { const f = () => { const x = screenX, y = screenY, t = performance.now(); if (x !== last) { samples.push([Math.round(t - t0), x, y]); last = x; } if (t - t0 < 3500) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    try { await T.core.invoke('walk_stop'); } catch (e) {}
    const iv = [], dx = []; for (let i = 1; i < samples.length; i++) { iv.push(samples[i][0] - samples[i - 1][0]); dx.push(samples[i][1] - samples[i - 1][1]); }
    const avg = (a) => a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(1) : null; const mn = (a) => a.length ? Math.min(...a) : null; const mx = (a) => a.length ? Math.max(...a) : null;
    const dur = samples.length > 1 ? samples[samples.length - 1][0] - samples[0][0] : 0; const dist = samples.length > 1 ? samples[samples.length - 1][1] - samples[0][1] : 0;
    return { cmd: r, moves: samples.length, durMs: dur, distPx: dist, pxPerSec: dur ? +(dist / (dur / 1000)).toFixed(1) : null,
      intervalMs: { avg: avg(iv), min: mn(iv), max: mx(iv) }, stepPx: { avg: avg(dx), min: mn(dx), max: mx(dx) }, first: samples.slice(0, 10) };
  })();
  return out;
})()`;

function treeCpuSeconds(rootPid) {
  const csv = execFileSync('wmic', ['process', 'get', 'ProcessId,ParentProcessId,Name,UserModeTime,KernelModeTime', '/format:csv'], { encoding: 'utf8' });
  const rows = csv.trim().split(/\r?\n/).slice(1).map((l) => l.split(',')).filter((c) => c.length >= 6);
  const kids = new Map(); const info = new Map();
  for (const c of rows) { const pid = +c[1], ppid = +c[2]; info.set(pid, { name: c[3], cpu: (Number(c[4]) || 0) + (Number(c[5]) || 0) }); if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid); }
  let cpu = 0, n = 0; const stack = [rootPid];
  while (stack.length) { const p = stack.pop(); const i = info.get(p); if (!i) continue; n++; cpu += i.cpu; for (const k of kids.get(p) || []) stack.push(k); }
  return { sec: cpu / 1e7, procs: n };
}

(async () => {
  fs.mkdirSync(CFG, { recursive: true }); fs.mkdirSync(EB, { recursive: true });
  const child = spawn(path.join(exeDir, 'catwhale-poc.exe'), [], {
    cwd: exeDir, stdio: 'ignore',
    env: Object.assign({}, process.env, {
      CATWHALE_CONFIG_DIR: CFG,
      WEBVIEW2_USER_DATA_FOLDER: EB,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT,
    }),
  });
  const t0 = Date.now();
  let ready = null;
  for (let i = 0; i < 300; i++) {                                   // 最多等 15s
    await sleep(50);
    try { const ok = await cdp('!!(window.__petReady && activeVideo && activeVideo() && activeVideo().readyState >= 2)'); if (ok) { ready = Date.now() - t0; break; } } catch (e) {}
  }
  if (ready === null) { console.log(JSON.stringify({ tag, error: 'page never became ready' })); child.kill(); process.exit(2); }
  const boot = await cdp('({ perfNow: Math.round(performance.now()), inner: [innerWidth, innerHeight], dpr: devicePixelRatio, screen: [screenX, screenY] })');
  await sleep(1500);                                                 // 让首帧、布局、命中网格都稳定下来
  let result;
  try { result = await cdp(PAGE); } catch (e) { result = { error: String(e && e.message || e) }; }
  console.log(JSON.stringify(Object.assign({ tag, exe: path.basename(exeDir), launchToVideoReadyMs: ready, boot }, result)));
  child.kill();
})().catch((e) => { console.error(e); process.exit(1); });
