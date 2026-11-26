'use strict';
/* 真实候选包内启动 + 真实链路跟随实测（CDP 驱动，不模拟内部函数）。
 *
 *   node tests/island-follow/e2e-real.cjs                    # 默认 dist/桌宠/桌宠.exe
 *   node tests/island-follow/e2e-real.cjs --bootonly         # 只验证「包能起来、两个窗口都在」
 *   node tests/island-follow/e2e-real.cjs --exe <exe路径> --port 9231
 *
 * 做法：
 *   1. 用隔离的 --user-data-dir 启动候选包（不碰用户 %APPDATA%\桌宠）；
 *      预置 island.json 关掉消息源 —— 绝不读用户的真实通知中心；
 *   2. 通过 --remote-debugging-port 连桌面宠页与灵动岛页两个 target；
 *   3. 在桌面宠页里用 rAF 调真实的 place()（拖动松手前的 pointermove 走的就是它）
 *      走一段 500px/s 的轨迹，同时按 20ms 采样：
 *        真值 = islandRectNow() + islandHeadNow()（两者都是量测，不参与调度）
 *        落点 = 灵动岛窗口自身的 screenX/screenY
 *      按几何公式算理想落点，统计误差 / 更新间隔 / 静止期更新数；
 *   4. 打完收工，taskkill 自己的进程树（只杀本进程 spawned 的那棵）。
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
const PORT = Number(arg('port', '9231'));
const USERDATA = path.resolve(arg('userdata', path.join(ENVROOT, 'userData', 'e2e')));
const OUT = path.resolve(arg('out', path.join(REPO, '..', '_logs', 'island-follow', 'e2e.json')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}

/* 极简 CDP 客户端（Node 22 自带 WebSocket） */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pend = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { const f = pend.get(m.id); pend.delete(m.id); f(m); }
    });
    ws.addEventListener('error', (e) => reject(new Error('ws error')));
    ws.addEventListener('open', () => {
      resolve({
        eval: (expr) => new Promise((res) => {
          const i = ++id;
          pend.set(i, (m) => {
            const r = m.result && m.result.result;
            res(r && r.value !== undefined ? r.value : null);
          });
          ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
        }),
        close: () => { try { ws.close(); } catch (e) {} },
      });
    });
  });
}

/* 理想落点（与 app/island.js 的 islandPos 同一套几何；用真值算，不读被测状态） */
const W = 640, TOP_PAD = 8, BALL = 56, CAP_H = 104, GAP = 6;
function ideal(r, a, wa, caps) {
  const zoom = Math.round(Math.min(1, Math.max(0.5, r.h / 430)) * 50) / 50;
  const Wz = Math.round(W * zoom);
  const contentH = caps ? CAP_H : BALL;
  let x = Math.round(r.x + a.cx * r.w - Wz / 2);
  let y = Math.round(r.y + a.head * r.h - GAP - (TOP_PAD + contentH) * zoom);
  if (x < wa.x) x = wa.x;
  if (x + Wz > wa.x + wa.width) x = wa.x + wa.width - Wz;
  if (y < wa.y) y = wa.y;
  return { x, y, zoom };
}

function stats(list) {
  const v = list.filter((x) => x !== null && isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const sum = v.reduce((a, b) => a + b, 0);
  const at = (q) => v[Math.min(v.length - 1, Math.max(0, Math.round((v.length - 1) * q)))];
  return { n: v.length, mean: +(sum / v.length).toFixed(2), p50: at(0.5), p95: at(0.95), max: v[v.length - 1] };
}

(async () => {
  if (!fs.existsSync(EXE)) { console.error('候选包不存在：' + EXE); process.exit(2); }
  fs.mkdirSync(USERDATA, { recursive: true });
  /* 每次从「桌宠默认落点（右下角）」开始：位置存档留着会让两次运行的轨迹不可比 */
  try { fs.rmSync(path.join(USERDATA, 'pet-state.json'), { force: true }); } catch (e) {}
  /* 关掉消息源：这一条是硬要求 —— 冒烟绝不能读用户的真实通知 */
  const cfgPath = path.join(USERDATA, 'island.json');
  if (!fs.existsSync(cfgPath)) {
    fs.writeFileSync(cfgPath, JSON.stringify({ enabled: true, msg: false, music: false, video: false, holdMs: 8000 }, null, 2));
  }
  const env = Object.assign({}, process.env, {
    TEMP: path.join(ENVROOT, 'TEMP'), TMP: path.join(ENVROOT, 'TMP'), TMPDIR: path.join(ENVROOT, 'TMP'),
  });
  const args = ['--user-data-dir=' + USERDATA, '--remote-debugging-port=' + PORT, '--no-first-run'];
  const t0 = Date.now();
  const child = spawn(EXE, args, { env, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  let exited = null;
  child.on('exit', (code) => { exited = code; });

  const result = { exe: EXE, userdata: USERDATA, port: PORT, bootMs: null, targets: [], windows: null };
  try {
    /* 等 target 出现 */
    let list = null;
    for (let i = 0; i < 120; i++) {
      await sleep(250);
      if (exited !== null) throw new Error('进程启动即退出 code=' + exited + '\n' + (out + err).slice(-1500));
      list = await getJson('http://127.0.0.1:' + PORT + '/json/list');
      if (list && list.some((t) => /index\.html/.test(t.url || ''))) break;
    }
    if (!list) throw new Error('CDP 端口没起来（' + PORT + '）');
    result.bootMs = Date.now() - t0;
    result.targets = list.map((t) => ({ title: t.title, url: String(t.url || '').replace(/^http:\/\/127\.0\.0\.1:\d+/, '') }));

    const petT = list.find((t) => /index\.html/.test(t.url || ''));
    if (!petT) throw new Error('没找到桌宠页 target');
    const pet = await connect(petT.webSocketDebuggerUrl);

    /* 等页面 init 完成 */
    let ok = false;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      const v = await pet.eval('!!window.__petInitOK');
      if (v === true) { ok = true; break; }
    }
    result.pageInitOK = ok;
    if (!ok) throw new Error('桌宠页 init 没完成：__petError=' + await pet.eval('window.__petError || ""'));

    /* 等灵动岛窗口（cfg.enabled 默认开） */
    let islT = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const l2 = await getJson('http://127.0.0.1:' + PORT + '/json/list');
      islT = (l2 || []).find((t) => /island\.html/.test(t.url || ''));
      if (islT) break;
    }
    if (!islT) throw new Error('灵动岛窗口没起来（cfg.enabled 应为 true）');
    const isl = await connect(islT.webSocketDebuggerUrl);

    result.windows = { pet: await pet.eval('JSON.stringify({x:screenX,y:screenY,w:innerWidth,h:innerHeight,dpr:devicePixelRatio})'),
      island: await isl.eval('JSON.stringify({x:screenX,y:screenY,w:innerWidth,h:innerHeight,dpr:devicePixelRatio})') };

    if (flag('bootonly')) {
      console.log('E2E_BOOT_OK ' + JSON.stringify(result));
      return;
    }

    const wa = JSON.parse(await pet.eval('JSON.stringify({x:0,y:0,width:screen.availWidth,height:screen.availHeight})'));
    const samples = [];
    /* 先空看 1.5s（拖动之前）：岛应该在启动时就已落在头顶，而不是先在屏幕中央闪一下 */
    const pre = [];
    const preEnd = Date.now() + 1500;
    while (Date.now() < preEnd) {
      const [tr, ip] = await Promise.all([
        pet.eval('JSON.stringify((()=>{const r=islandRectNow();const a=islandHeadNow();return r&&a?{x:r.x,y:r.y,w:r.w,h:r.h,cx:a.cx,head:a.head}:null;})())'),
        isl.eval('JSON.stringify({x:screenX,y:screenY,mode:(document.getElementById("isl")||{getAttribute:()=>""}).getAttribute("data-mode")})'),
      ]);
      const t = tr ? JSON.parse(tr) : null, p = ip ? JSON.parse(ip) : null;
      if (t && p) {
        const id = ideal(t, { cx: t.cx, head: t.head }, wa, !!p.mode && p.mode !== 'idle');
        pre.push({ ix: p.x, iy: p.y, err: Math.max(Math.abs(p.x - id.x), Math.abs(p.y - id.y)) });
      }
      await sleep(20);
    }
    /* 只能测位置、测不到窗口可见性（CDP 的 visibilityState 对从未显示的窗口仍是 visible）：
       这段的含义是「首帧上报到达前，窗口停在 Electron 给的默认居中位置」。
       「这时候用户看不看得见」由 tests/island-follow/main.cjs 用真实的 isVisible() 判定。 */
    result.bootPos = { samples: pre.length, err: stats(pre.map((x) => x.err)),
      atDefaultCenter: pre.filter((x) => Math.abs(x.ix - 960) < 8 && Math.abs(x.iy - 621) < 8).length };

    /* 开始驱动：rAF 里调真实 place()，500px/s 向左 + 上下摆动，共 3s（= 一次快速拖动）。
       向左是因为桌宠默认停在右下角，往右会直接出屏被夹到边 —— 那就只剩「贴边不动」可测了。 */
    const started = await pet.eval(`(() => {
      const x0 = parseFloat(pet.style.left) || 0, y0 = parseFloat(pet.style.top) || 0;
      const T = performance.now();
      window.__e2e = { n: 0, done: false, t0: T };
      const step = (ts) => {
        const el = ts - T;
        if (el > 3000) { window.__e2e.done = true; return; }
        const k = el / 3000;
        place(x0 - 500 * k, y0 - 90 * Math.sin(k * Math.PI));
        window.__e2e.n++;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      return true;
    })()`);
    result.driveStarted = started === true;
    const sampleT0 = Date.now();
    while (Date.now() - sampleT0 < 7000) {                 // 3s 拖动 + 4s 静止观察
      const [tr, ip] = await Promise.all([
        pet.eval('JSON.stringify((()=>{const r=islandRectNow();const a=islandHeadNow();return r&&a?{x:r.x,y:r.y,w:r.w,h:r.h,cx:a.cx,head:a.head}:null;})())'),
        isl.eval('JSON.stringify({x:screenX,y:screenY,mode:(document.getElementById("isl")||{getAttribute:()=>""}).getAttribute("data-mode"),vis:document.visibilityState})'),
      ]);
      const t = tr ? JSON.parse(tr) : null;
      const p = ip ? JSON.parse(ip) : null;
      if (t && p) {
        /* 胶囊/球的可见高度不同（56 / 104），用岛页面自己报的 data-mode 判，别猜 */
        const caps = !!p.mode && p.mode !== 'idle';
        const id = ideal(t, { cx: t.cx, head: t.head }, wa, caps);
        samples.push({ at: Date.now() - sampleT0, ix: p.x, iy: p.y, mode: p.mode, vis: p.vis,
          err: Math.max(Math.abs(p.x - id.x), Math.abs(p.y - id.y)) });
      }
      await sleep(20);
    }
    const shown = samples.filter((s) => s.vis !== 'hidden');
    const moving = shown.filter((s) => s.at <= 3000);
    const idle = shown.filter((s) => s.at > 3800);
    let idleUpdates = 0;
    for (let i = 1; i < idle.length; i++) if (idle[i].ix !== idle[i - 1].ix || idle[i].iy !== idle[i - 1].iy) idleUpdates++;
    result.metrics = {
      samples: samples.length,
      driveFrames: await pet.eval('window.__e2e && window.__e2e.n'),
      errMoving: stats(moving.map((s) => s.err)),
      errIdle: stats(idle.map((s) => s.err)),
      errOver2pxMoving: moving.filter((s) => s.err > 2).length,
      errOver6pxMoving: moving.filter((s) => s.err > 6).length,
      idleUpdates: idleUpdates,
      idleSamples: idle.length,
      anchorStats: await pet.eval('JSON.stringify(window.__islandAnchorStats ? window.__islandAnchorStats() : null)'),
    };
    result.alive = exited === null;
    console.log('E2E_RESULT ' + JSON.stringify(result));
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ result, samples }, null, 1));
  } catch (e) {
    result.error = String((e && e.message) || e);
    result.stderrTail = (out + err).slice(-1200);
    console.log('E2E_FAIL ' + JSON.stringify(result));
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  } finally {
    /* 只杀自己起的那棵进程树 */
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
  }
})();
