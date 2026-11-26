'use strict';
/* 灵动岛「跟随」冒烟/对比测试 —— Electron 主进程侧
 *
 * 目的：用**同一条轨迹**分别跑祖先版（e9a9f77）和 v0.7.1，量化三件事：
 *   · 落点误差：胶囊窗口离「理想位置」有多远（理想位置由页面推上来的真值算，与被测代码无关）
 *   · 更新间隔：两次 setBounds 之间隔多久（跟随的连续性）
 *   · 空闲更新数：角色静止时窗口还在被挪多少次（呼吸该不该推动它）
 *
 * 不会碰用户数据：不读通知中心（hasHubNotify 恒 true，通知探针不会启动）、
 * 不探测媒体、不连网（歌词/信息中枢都返回 null）、userData 走隔离目录。
 *
 * 用法（见 tests/island-follow/run.cjs）：
 *   electron tests/island-follow/main.cjs --web <web目录> --island <island.js> --impl event|legacy --out <json>
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

/* ---------------- 参数 ---------------- */
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const flag = (name) => process.argv.includes('--' + name);

const WEB = path.resolve(arg('web', path.join(__dirname, '..', '..', 'web')));
const ISLAND_JS = path.resolve(arg('island', path.join(__dirname, '..', '..', 'app', 'island.js')));
const IMPL = arg('impl', 'event');
const OUT = arg('out', '');
const LABEL = arg('label', IMPL);
const USERDATA = path.resolve(arg('userdata', path.join(__dirname, '..', '..', '..', '_env', 'userData', 'smoke-' + IMPL)));
const VISIBLE = flag('visible');

app.setPath('userData', USERDATA);
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

/* ---------------- 静态服务（island.html 必须走 http，file:// 下 canvas 会被污染） ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
let port = 0;
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = decodeURIComponent((req.url || '/').split('?')[0]);
      const file = p === '/pet.html' || p === '/pet-preload.js'
        ? path.join(__dirname, p.slice(1))
        : path.join(WEB, p === '/' ? '/index.html' : p);
      if (!file.startsWith(WEB) && !file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('404'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
          'Content-Length': buf.length, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
        res.end(buf);
      });
    });
    srv.listen(0, '127.0.0.1', () => { port = srv.address().port; resolve(); });
  });
}

/* ---------------- 窗口 ---------------- */
let petWin = null, island = null;
let latestTruth = null;
const posLogs = [];
const commits = [];

ipcMain.on('smoke:truth', (_e, t) => { if (t && typeof t === 'object') latestTruth = t; });

async function boot() {
  const wa = screen.getPrimaryDisplay().workArea;
  const px = Math.max(wa.x + 60, wa.x + 300);
  const py = Math.max(wa.y + 40, wa.y + 80);
  petWin = new BrowserWindow({
    x: px, y: py, width: 900, height: 700, frame: false, transparent: true,
    resizable: false, movable: false, skipTaskbar: true, hasShadow: false,
    backgroundColor: '#00000000', show: true, focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'pet-preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  if (!VISIBLE) try { petWin.setOpacity(0); } catch (e) {}
  await petWin.loadURL('http://127.0.0.1:' + port + '/pet.html?impl=' + IMPL);

  /* 被测的灵动岛模块：主进程侧代码原样加载（祖先版 / v0.7.1 由 --island 指定） */
  delete require.cache[require.resolve(ISLAND_JS)];
  const { createIsland } = require(ISLAND_JS);
  island = createIsland({
    getUserData: () => USERDATA,
    log: (m) => {
      if (m.startsWith('ISLAND_POS')) posLogs.push(Date.now());
      if (m.startsWith('ISLAND_ANCHOR_COMMIT')) commits.push(m);
    },
    getPort: () => port,
    getPetWin: () => petWin,
    getMediaState: () => null,
    /* 恒 true：绝不在冒烟里起 winnotify 探针（那会读用户的真实通知中心） */
    hasHubNotify: () => true,
    getInfo: () => null,
    onCreated: (w) => { if (!VISIBLE) { try { w.setOpacity(0); } catch (e) {} } },
  });
  island.bindIpc();
  island.setCfg({ enabled: true, msg: false, music: false, video: false, holdMs: 8000 });
  island.start();
}

/* ---------------- 理想落点（按 v0.7.0/v0.7.1 共用的几何公式，用真值算） ---------------- */
const W = 640, H = 150, TOP_PAD = 8, BALL = 56, GAP = 6;
function idealPos(t, wa) {
  const zoomRaw = Math.min(1, Math.max(0.5, t.rh / 430));
  const zoom = Math.round(zoomRaw * 50) / 50;
  const Wz = Math.round(W * zoom);
  const cxScreen = t.sx + t.cx * t.rw;
  const headScreen = t.sy + t.head * t.rh;
  let x = Math.round(cxScreen - Wz / 2);
  let y = Math.round(headScreen - GAP - (TOP_PAD + BALL) * zoom);
  if (x < wa.x) x = wa.x;
  if (x + Wz > wa.x + wa.width) x = wa.x + wa.width - Wz;
  if (y < wa.y) y = wa.y;
  return { x, y, zoom };
}

/* ---------------- 采样 ---------------- */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function measure() {
  const wa = screen.getPrimaryDisplay().workArea;
  const samples = [];
  const t0 = Date.now();
  const done = t0 + 13500;         // 1.5s 预热之后的 6.5s 运动（慢走 / 快拖 / 走下来）+ 5.5s 静止
  while (Date.now() < done) {
    const b = island.win() && !island.win().isDestroyed() ? island.win().getBounds()
      : { x: NaN, y: NaN, width: 0, height: 0 };
    const vis = !!(island.win() && !island.win().isDestroyed() && island.win().isVisible());
    const t = latestTruth;
    let err = null, ideal = null;
    if (t) { ideal = idealPos(t, wa); err = Math.max(Math.abs(b.x - ideal.x), Math.abs(b.y - ideal.y)); }
    samples.push({ at: Date.now() - t0, x: b.x, y: b.y, w: b.width, h: b.height, vis: vis,
      idealX: ideal ? ideal.x : null, idealY: ideal ? ideal.y : null,
      err: err, state: t ? t.state : '', truthX: t ? Math.round(t.sx) : null });
    await sleep(20);
  }
  const page = await petWin.webContents.executeJavaScript('window.smokeSends()').catch(() => null);
  const state = island.state();
  return { samples, page, state, posLogs: posLogs.length, logs: posLogs.slice(), t0Wall: t0, commits };
}

/* ---------------- 统计 ---------------- */
function stats(list) {
  const v = list.filter((x) => x !== null && isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const sum = v.reduce((a, b) => a + b, 0);
  const at = (q) => v[Math.min(v.length - 1, Math.max(0, Math.round((v.length - 1) * q)))];
  return { n: v.length, mean: +(sum / v.length).toFixed(2), p50: at(0.5), p95: at(0.95), max: v[v.length - 1] };
}

function analyze(raw) {
  const s = raw.samples.filter((x) => x.state);          // 有真值之后才算
  const motion = s.filter((x) => x.state !== 'idle');
  const idleAll = s.filter((x) => x.state === 'idle');
  const idle = idleAll.filter((x) => x.at > (motion.length ? motion[motion.length - 1].at + 800 : 0));
  /* 落位次数/间隔用 ISLAND_POS 日志的时间戳算 —— 采样只有 20ms 粒度，
     而真实跟随是每帧 16.7ms，靠采样数出来的间隔会被粒度卡死在 20/40ms。 */
  const logs = raw.logs || [];
  const runStart = s.length ? s[0].at : 0;
  const relLogs = logs.map((a) => a - raw.t0Wall);
  const motionEndAt = motion.length ? motion[motion.length - 1].at : 0;
  const idleStartAt = idle.length ? idle[0].at : Infinity;
  const motionLogs = relLogs.filter((a) => a >= runStart && a <= motionEndAt);
  const idleLogs = relLogs.filter((a) => a >= idleStartAt);
  const motionGaps = [];
  for (let i = 1; i < motionLogs.length; i++) motionGaps.push(motionLogs[i] - motionLogs[i - 1]);
  const motionUpdates = motionLogs.length;
  const idleUpdates = idleLogs.length;
  const changes = [];
  for (let i = 1; i < s.length; i++) if (s[i].x !== s[i - 1].x || s[i].y !== s[i - 1].y) changes.push(s[i].at);
  /* 真实坐标变化（区别于「原地重复 setBounds」：祖先版每 500ms 的 show() 里 place(true) 会刷一条） */
  const idleMoves = changes.filter((a) => idle.length && a >= idle[0].at).length;
  const motionMoves = changes.filter((a) => motion.length && a <= motionEndAt).length;
  const lastMotionAt = motion.length ? motion[motion.length - 1].at : 0;
  const recover = (() => {
    const after = s.filter((x) => x.at >= lastMotionAt);
    const hit = after.find((x) => x.err !== null && x.err <= 1);
    return hit ? hit.at - lastMotionAt : null;
  })();
  const idleX = idle.map((x) => x.x).filter((v) => isFinite(v));
  const idleRange = idleX.length ? Math.max(...idleX) - Math.min(...idleX) : null;
  const idleY = idle.map((x) => x.y).filter((v) => isFinite(v));
  const idleYRange = idleY.length ? Math.max(...idleY) - Math.min(...idleY) : null;
  /* 「亮起来的瞬间就已经在正确位置」：可见样本里第一个的误差必须 ≤1 DIP，
     否则就是「先在屏幕中央闪一下再跳过去」（v0.7.0 的表现）。 */
  const firstShown = s.find((x) => x.vis);
  return {
    label: LABEL, impl: IMPL, island: ISLAND_JS, web: WEB,
    samples: s.length, motionSamples: motion.length, idleSamples: idle.length,
    errMotion: stats(motion.map((x) => x.err)),
    errByPhase: {
      walk_right: stats(s.filter((x) => x.state === 'walk_right').map((x) => x.err)),
      grabbed: stats(s.filter((x) => x.state === 'grabbed').map((x) => x.err)),
      walk_down: stats(s.filter((x) => x.state === 'walk_down').map((x) => x.err)),
    },
    errIdle: stats(idle.map((x) => x.err)),
    errOver2px: motion.filter((x) => x.err !== null && x.err > 2).length,
    errOver6px: motion.filter((x) => x.err !== null && x.err > 6).length,
    motionUpdates: motionUpdates,
    motionMoves: motionMoves,
    updateGapMs: stats(motionGaps),
    idleUpdates: idleUpdates,
    idleMoves: idleMoves,
    idleXRange: idleRange,
    idleYRange: idleYRange,
    idleJitter: Math.max(idleRange || 0, idleYRange || 0),
    firstShownAt: firstShown ? firstShown.at : null,
    firstShownErr: firstShown ? firstShown.err : null,
    shownSamples: s.filter((x) => x.vis).length,
    recoveryMs: recover,
    anchorSends: raw.page ? raw.page.total : null,
    anchorSendStats: raw.page ? raw.page.stats : null,
    islandState: raw.state ? { mode: raw.state.mode, anchor: raw.state.anchor, zoom: raw.state.zoom } : null,
    posLogs: raw.posLogs,
    runDurationMs: raw.samples.length ? raw.samples[raw.samples.length - 1].at : null,
  };
}

/* ---------------- 主流程 ---------------- */
app.whenReady().then(async () => {
  try {
    fs.mkdirSync(USERDATA, { recursive: true });
    await serve();
    await boot();
    /* 启动窗口期（首帧上报到达之前）也要看着：这段如果「可见且不在头顶」，就是那种一秒钟的乱跳 */
    const wa0 = screen.getPrimaryDisplay().workArea;
    const bootSamples = [];
    const tBoot = Date.now();
    while (Date.now() - tBoot < 1500) {
      const w = island.win && island.win() && !island.win().isDestroyed() ? island.win() : null;
      const vis = !!(w && w.isVisible());
      const b = w ? w.getBounds() : { x: NaN, y: NaN };
      const t = latestTruth;
      const err = t ? Math.max(Math.abs(b.x - idealPos(t, wa0).x), Math.abs(b.y - idealPos(t, wa0).y)) : null;
      bootSamples.push({ at: Date.now() - tBoot, vis, err });
      await sleep(20);
    }
    const bootFirstVis = bootSamples.find((x) => x.vis);
    const bootVisibleWrong = bootSamples.filter((x) => x.vis && x.err !== null && x.err > 20).length;
    petWin.webContents.send('smoke:run');
    const raw = await measure();
    raw.boot = { samples: bootSamples.length, firstVisibleAt: bootFirstVis ? bootFirstVis.at : null,
      firstVisibleErr: bootFirstVis ? bootFirstVis.err : null, visibleButWrong: bootVisibleWrong };
    const out = analyze(raw);
    out.boot = raw.boot;
    if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify({ result: out, raw: raw.samples }, null, 1)); }
    console.log('SMOKE_RESULT ' + JSON.stringify(out));
  } catch (e) {
    console.error('SMOKE_ERROR ' + (e && e.stack || e));
    try { if (OUT) fs.writeFileSync(OUT, JSON.stringify({ error: String(e && e.message || e) })); } catch (e2) {}
  } finally {
    setTimeout(() => app.exit(0), 200);
  }
});
