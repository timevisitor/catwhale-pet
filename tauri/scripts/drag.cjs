// 拖动测量：隔离启动 → 取角色窗口矩形 → 真实鼠标恒速拖动并采样（dragprobe.py）→ 退出
// 用法：node drag.cjs <exe 目录> [标签]
'use strict';
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const exeDir = path.resolve(process.argv[2]);
const tag = process.argv[3] || 'drag';
const WORK = path.resolve(process.env.CATWHALE_BENCH_DIR || path.join(exeDir, 'bench'));
const ISO = path.join(WORK, 'profile-' + tag);
const CFG = path.join(ISO, 'config'), EB = path.join(ISO, 'eb');
// 与测量构建里 additionalBrowserArgs 的调试口一致（CDP_PORT 可覆盖）
const PORT = Number(process.env.CDP_PORT || 9223);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res) => http.get(url, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res(null); } }); }).on('error', () => res(null)));
async function cdp(expr) {
  const list = await getJson(`http://127.0.0.1:${PORT}/json`);
  const t = (list || []).find((x) => /tauri\.localhost/.test(x.url || '') && /catwhale-poc/.test(x.title || ''));
  if (!t) throw new Error('target not found');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const r = await new Promise((res) => { ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) res(m); }); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
  ws.close();
  return r.result && r.result.result ? r.result.result.value : undefined;
}

(async () => {
  fs.mkdirSync(CFG, { recursive: true }); fs.mkdirSync(EB, { recursive: true });
  const child = spawn(path.join(exeDir, 'catwhale-poc.exe'), [], { cwd: exeDir, stdio: 'ignore',
    env: Object.assign({}, process.env, { CATWHALE_CONFIG_DIR: CFG, WEBVIEW2_USER_DATA_FOLDER: EB, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT }) });
  let rect = null;
  for (let i = 0; i < 300; i++) {
    await sleep(50);
    try { const ok = await cdp('!!(window.__petReady && activeVideo && activeVideo() && activeVideo().readyState >= 2)'); if (ok) break; } catch (e) {}
  }
  await sleep(1200);
  try { console.error('DISPLAYS ' + JSON.stringify(await cdp("window.__TAURI__.core.invoke('list_displays')"))); } catch (e) {}
  rect = await cdp('({ x: screenX, y: screenY, w: outerWidth, h: outerHeight, dpr: devicePixelRatio })');
  const sf = rect.dpr;
  // 角色在窗口里居中、脚在底边：取躯干中下部（视频主体所在处）作为抓取点
  // 页面的 screenX/Y 是逻辑像素（DPI 虚拟化后），换算到物理屏幕坐标要整体乘缩放系数
  const toPhys = (lx, ly) => [Math.round(lx * sf), Math.round(ly * sf)];
  const results = [];
  for (const dir of [1, -1, 1, -1]) {
    // 每次都从当前窗口位置重新取抓取点（上一轮拖动后窗口已经挪了）
    rect = await cdp('({ x: screenX, y: screenY, w: outerWidth, h: outerHeight, dpr: devicePixelRatio })');
    const [px, py] = toPhys(rect.x + rect.w / 2, rect.y + rect.h * 0.62);
    let out;
    try { out = JSON.parse(execFileSync('python', [path.join(ROOT, 'dragprobe.py'), String(px), String(py), String(dir)], { encoding: 'utf8' }).trim().split('\n').pop()); }
    catch (e) { out = { error: String(e.message || e).slice(0, 200) }; }
    results.push(out);
    await sleep(1600);
  }
  console.log(JSON.stringify({ tag, exe: path.basename(exeDir), dpr: sf, runs: results }));
  child.kill();
})().catch((e) => { console.error(e); process.exit(1); });
