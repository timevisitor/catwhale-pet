// 验收宿主：用桌宠真实的 renderer + preload 跑一遍皮肤加载路径，不启动完整 App（避开单实例锁与桌面干扰）。
// 用法：electron.exe _verify/host --skin=<皮肤目录> --out=<报告目录>
// 它复刻 main.js 的静态服务（含 /skin/ 路由）与 skin:get IPC，其余 IPC 返回空桩。
const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const urlmod = require('url');

// 工程根：仓库布局（<仓库>/skin-editor/verify/host → 仓库根）优先，否则退回本机绝对路径
const REPO = (function () {
  const cands = [path.resolve(__dirname, '..', '..', '..'), path.resolve(__dirname, '..', '..'), 'H:/hermes project/桌宠'];
  for (const c of cands) if (fs.existsSync(path.join(c, 'app', 'renderer', 'assets', 'states.json'))) return c;
  return cands[cands.length - 1];
})();
const WEB_ROOT = path.join(REPO, 'app', 'renderer');
const PRELOAD = path.join(REPO, 'app', 'preload.js');
const argOf = (k, d) => {
  const a = process.argv.find((x) => x.startsWith('--' + k + '='));
  return a ? a.split('=').slice(1).join('=') : d;
};
const SKIN_DIR = path.resolve(argOf('skin', '.'));
const OUT = argOf('out', path.join(__dirname, 'out'));
fs.mkdirSync(OUT, { recursive: true });

let win = null, server = null, port = 0;

function readSkin() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(SKIN_DIR, 'skin.json'), 'utf8'));
    return { ok: true, slug: path.basename(SKIN_DIR), name: j.name, actions: j.actions || {} };
  } catch (e) { return { ok: false, error: String(e.message) }; }
}

function startServer() {
  return new Promise((resolve) => {
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
      '.json': 'application/json; charset=utf-8', '.webm': 'video/webm', '.png': 'image/png' };
    server = http.createServer((req, res) => {
      let p = decodeURIComponent(urlmod.parse(req.url).pathname);
      if (p === '/') p = '/index.html';
      let file;
      if (p.startsWith('/skin/')) {
        file = path.join(SKIN_DIR, p.slice('/skin/'.length));
        if (!file.startsWith(SKIN_DIR + path.sep)) { res.writeHead(403); return res.end('403'); }
      } else {
        const rel = p.startsWith('/') ? p.slice(1) : p;
        file = path.join(WEB_ROOT, rel);
        if (!file.startsWith(WEB_ROOT + path.sep) && file !== path.join(WEB_ROOT, 'index.html')) { res.writeHead(403); return res.end('403'); }
      }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('404'); }
        res.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(port); });
  });
}

// 空实现桩：只保证 renderer 初始化不因缺通道而中断
const stub = { ok: true, value: null };
for (const ch of ['pet:cursor', 'everything:search', 'everything:open', 'everything:reveal', 'everything:copy',
  'config:get', 'config:set', 'config:test', 'config:browseRepo', 'config:detect', 'harness:status',
  'harness:chat', 'harness:cancel', 'chat:history', 'chat:clear', 'sysinfo:start', 'sysinfo:stop', 'sysinfo:get',
  'pet:workarea', 'pet:displays', 'pet:setDisplay', 'pet:autostart', 'update:check', 'update:status',
  'env:check', 'env:pickDir', 'env:deployHarness', 'env:deployEverything', 'env:launchEverything', 'env:cancel', 'env:dismiss']) {
  ipcMain.handle(ch, () => stub);
}
ipcMain.handle('skin:get', () => readSkin());
ipcMain.handle('skin:openFolder', () => stub);
ipcMain.on('pet:interactive', () => {});
ipcMain.on('pet:save', () => {});
ipcMain.on('pet:focus', () => {});
ipcMain.on('pet:panel', () => {});

app.whenReady().then(async () => {
  const skin = readSkin();
  const report = { skinOk: !!(skin && skin.ok), skinName: skin && skin.name, skinActionCount: skin && skin.actions ? Object.keys(skin.actions).length : 0 };
  win = new BrowserWindow({
    show: false, width: 700, height: 900, transparent: true, frame: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await startServer();
  win.webContents.on('console-message', (e, level, msg) => {
    if (String(msg).includes('Electron Security Warning')) return;
    console.log('PAGE[' + level + '] ' + msg);
  });
  await win.loadURL(`http://127.0.0.1:${port}/index.html?bg=none&controls=0&auto=0&size=340`);
  await new Promise((r) => setTimeout(r, 3500));      // 等视频元数据与首帧

  try {
    const js = `JSON.stringify({
      initOK: !!window.__petInitOK,
      err: window.__petError || null,
      videos: [...document.querySelectorAll('#pet video')].map(function(v){ return {
        src: (v.currentSrc||'').replace('http://127.0.0.1:${port}',''),
        rs: v.readyState, w: v.videoWidth, h: v.videoHeight,
        tf: v.style.transform, active: v.classList.contains('active')
      }; }),
      petW: document.getElementById('pet').getBoundingClientRect().width,
      petH: document.getElementById('pet').getBoundingClientRect().height
    })`;
    const out = JSON.parse(await win.webContents.executeJavaScript(js));
    Object.assign(report, out);
    // transform 期望值核对：期望值由 skin.json 独立算出（不读页面内部变量）
    const fails = [];
    const acts = (skin && skin.actions) || {};
    const byFile = {};
    for (const id in acts) byFile['/skin/' + acts[id].file] = acts[id];
    for (const v of out.videos) {
      if (!v.src.startsWith('/skin/')) { fails.push((v.src || '(空)') + ': src 未走 /skin/'); continue; }
      if (v.rs < 2) fails.push(v.src + ': readyState=' + v.rs + ' 未就绪');
      const a = byFile[v.src];
      if (!a) { fails.push(v.src + ': 皮肤里找不到对应动作'); continue; }
      const s0 = a.scale == null ? 1 : a.scale;
      const sx = s0 * (a.scaleX == null ? 1 : a.scaleX), sy = s0 * (a.scaleY == null ? 1 : a.scaleY);
      const ox = a.offX || 0, oy = a.offY || 0;
      // 数值比对（浏览器会把 translate 序列化成 "3%, 0%"、把 0.99 收成 0.99），不逐字符比
      const pick = (re) => { const m = String(v.tf).match(re); return m ? parseFloat(m[1]) : null; };
      const gotTx = pick(/translate\(\s*(-?[\d.]+)%/) || 0;
      const gotTy = pick(/,\s*(-?[\d.]+)%\)/) || 0;
      const gotSx = pick(/scaleX\(\s*(-?[\d.]+)\s*\)/);
      const gotSy = pick(/scaleY\(\s*(-?[\d.]+)\s*\)/);
      const near = (x, y) => Math.abs(x - y) < 0.02;
      if (!near(gotTx, ox)) fails.push(a.id + ': translateX 期望 ' + ox + '% 实得 ' + gotTx + '%');
      if (!near(gotTy, oy)) fails.push(a.id + ': translateY 期望 ' + oy + '% 实得 ' + gotTy + '%');
      if (gotSx == null || !near(gotSx, sx)) fails.push(a.id + ': scaleX 期望 ' + sx + ' 实得 ' + gotSx);
      if (gotSy == null || !near(gotSy, sy)) fails.push(a.id + ': scaleY 期望 ' + sy + ' 实得 ' + gotSy);
      if (!v.w || !v.h) fails.push(a.id + ': 视频尺寸为 0');
    }
    if (!out.initOK) fails.push('页面 init 未完成');
    if (!Object.keys(byFile).length) fails.push('皮肤里没有动作');
    if (!out.videos.length) fails.push('页面里没有 video 元素');
    if (out.videos.filter((v) => v.active).length !== 1) fails.push('active 视频数量异常：' + out.videos.filter((v) => v.active).length);
    report.transformFails = fails;
    report.ok = fails.length === 0;
  } catch (e) {
    report.ok = false; report.error = String(e && e.message || e);
  }

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'stage.png'), img.toPNG());
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('HOST_REPORT ' + JSON.stringify({ ok: report.ok, skin: report.skinName, n: report.skinActionCount,
    cur: report.cur, fails: report.transformFails, videos: (report.videos || []).length }));
  app.quit();
});
