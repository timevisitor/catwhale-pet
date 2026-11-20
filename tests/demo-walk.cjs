'use strict';
/**
 * 录制「桌面走动」演示片段（无声）——用**打包好的发布版 exe** 跑真实页面，
 * 通过 CDP 的 Page.startScreencast 抽真实绘制帧，再用 ffmpeg 按帧时间戳编码。
 *
 * 为什么不用系统录屏：这台机器桌面上有个人文件/聊天历史，屏幕录像会带出去。
 * 这里的画面上**只有桌宠自己的页面**：
 *   · 背景用应用自带的「演示背景」棋盘格（#checker，setBg('checker') 同一个类），
 *     铺满视口 → 画面里不可能出现真实桌面像素；
 *   · 交互全部走 CDP Input（真实命中测试/默认行为），不是页面内 .click()；
 *   · 底部字幕是演示注入的 DOM（说明演到哪一步），不改应用代码、不进包。
 *
 * 用法：
 *   node tests/demo-walk.cjs                       # 用 dist/桌宠_发布版/桌宠.exe
 *   DEMO_EXE=<exe> node tests/demo-walk.cjs
 * 产物：
 *   <主题>/演示源-Electron/room-walk-demo.mp4        成片（1920x1080 · 30fps · 无音轨）
 *   <主题>/演示源-Electron/帧/walk-demo-*.png        关键帧
 *   <主题>/演示源-Electron/meta.json                 窗口/EXE/SHA/视口/时间点/每步结果
 *   <主题>/tmp/demo-frames/*.jpg                     原始抽帧（编码后可删）
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const THEME = path.resolve(ROOT, '..');
const EXE = process.env.DEMO_EXE || path.join(ROOT, 'dist', '桌宠_发布版', '桌宠.exe');
const OUT = process.env.DEMO_OUT || path.join(THEME, '演示源-Electron');
const FRAMES = process.env.DEMO_FRAMES || path.join(THEME, 'tmp', 'demo-frames');
const UD = process.env.DEMO_UD || path.join(THEME, 'tmp', 'demo-ud');
const PORT = Number(process.env.DEMO_PORT || 9488);
const W = 1920, H = 1080;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const T = () => +((Date.now() - t0) / 1000).toFixed(2);

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
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    try {
      const list = await httpJson(`http://127.0.0.1:${PORT}/json`);
      const p = list.find((x) => x.type === 'page' && /index\.html/.test(x.url || ''));
      if (p) return p;
    } catch (e) { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error('CDP 页面没出现');
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const handlers = [];
    let seq = 0;
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id); pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message || 'cdp error')); else res(m.result);
        return;
      }
      if (m.method) for (const h of handlers) { try { h(m); } catch (e) {} }
    };
    ws.onerror = () => reject(new Error('WS 错误'));
    ws.onopen = () => resolve({
      on(fn) { handlers.push(fn); },
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
async function evalJs(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r && r.exceptionDetails) throw new Error('页面异常：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r && r.result ? r.result.value : undefined;
}
async function rectOf(cdp, sel) {
  return evalJs(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;
    e.scrollIntoView({block:'center'});
    const r=e.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height,
    visible:!!(r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden')};})()`);
}
async function clickSel(cdp, sel) {
  const r = await rectOf(cdp, sel);
  if (!r || !r.visible) throw new Error('控件不可见：' + sel);
  const x = Math.round(r.x + r.w / 2), y = Math.round(r.y + r.h / 2);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(220);
  return { x, y };
}
async function drag(cdp, a, b, steps) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y, buttons: 0 });
  await sleep(120);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1, buttons: 1 });
  const n = steps || 26;
  for (let i = 1; i <= n; i++) {
    const p = i / n;
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;   // 缓动，看起来像人在拖
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(a.x + (b.x - a.x) * e), y: Math.round(a.y + (b.y - a.y) * e), buttons: 1,
    });
    await sleep(28);
  }
  await sleep(120);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(300);
}

/* ---------------- 录制 ---------------- */
const steps = [];
function mark(name, extra) {
  const s = { t: T(), name, extra: extra === undefined ? null : extra };
  steps.push(s);
  console.log(`[${String(s.t).padStart(6)}s] ${name}${extra === undefined ? '' : ' :: ' + JSON.stringify(extra)}`);
  return s;
}

(async () => {
  if (!fs.existsSync(EXE)) throw new Error('找不到 exe：' + EXE);
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(OUT, '帧'), { recursive: true });
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  fs.rmSync(UD, { recursive: true, force: true });
  fs.mkdirSync(UD, { recursive: true });
  fs.writeFileSync(path.join(UD, 'dock.json'), JSON.stringify({ enabled: false }), 'utf8');
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify({ envNoAsk: true }), 'utf8');
  const exeSha = crypto.createHash('sha256').update(fs.readFileSync(EXE)).digest('hex');

  const logFile = path.join(FRAMES, 'app.log');
  const logFd = fs.openSync(logFile, 'w');
  const child = spawn(EXE, ['--remote-debugging-port=' + PORT, '--user-data-dir=' + UD,
                            '--winsize=' + W + 'x' + H], { stdio: ['ignore', logFd, logFd] });

  const page = await waitPage(30000);
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  const ready = await (async () => {
    const s = Date.now();
    while (Date.now() - s < 30000) {
      if (await evalJs(cdp, 'window.__petInitOK === true').catch(() => false)) return true;
      await sleep(300);
    }
    return false;
  })();
  if (!ready) throw new Error('页面没初始化完（__petInitOK）');

  /* 取景：① 演示棋盘格铺满视口（应用自带的「演示背景」）② 底部字幕条 */
  const view = await evalJs(cdp, `(()=>{
    document.getElementById('checker').classList.add('show');
    document.documentElement.style.background='#2a2e38';
    document.body.style.background='#2a2e38';
    const cap=document.createElement('div');
    cap.id='__demoCap';
    cap.style.cssText='position:fixed;left:40px;bottom:34px;z-index:99999;max-width:1100px;'+
      'padding:12px 20px;border-radius:12px;background:rgba(12,14,20,.78);color:#e9edf5;'+
      'font:500 26px/1.45 "Microsoft YaHei","Segoe UI",sans-serif;letter-spacing:.5px;'+
      'border-left:4px solid #6ad0ff;box-shadow:0 8px 26px rgba(0,0,0,.35);pointer-events:none;opacity:0;transition:opacity .25s';
    document.body.appendChild(cap);
    const ttl=document.createElement('div');
    ttl.id='__demoTtl';
    ttl.style.cssText='position:fixed;left:40px;top:34px;z-index:99999;color:#cfd8e6;'+
      'font:600 22px/1.3 "Microsoft YaHei","Segoe UI",sans-serif;background:rgba(12,14,20,.6);'+
      'padding:8px 14px;border-radius:10px;pointer-events:none';
    ttl.textContent='猫鲸桌宠 · 桌面走动 · v0.7.0 Electron 发布包';
    document.body.appendChild(ttl);
    return { iw:innerWidth, ih:innerHeight, dpr:devicePixelRatio,
             checker:document.getElementById('checker').classList.contains('show'),
             pet:petAPI.walk.info().pet, box:petAPI.walk.info().box };
  })()`);
  console.log('视口', view);

  const caption = async (t) => {
    await evalJs(cdp, `(()=>{const c=document.getElementById('__demoCap');
      c.textContent=${JSON.stringify(t)};c.style.opacity='1';return 1;})()`);
  };

  /* 抽帧：Page.startScreencast（按绘制推送真帧），每帧落盘并回 ACK */
  let frameNo = 0;
  const stamp = [];
  cdp.on((m) => {
    if (m.method !== 'Page.screencastFrame') return;
    const { data, sessionId, metadata } = m.params;
    const n = ++frameNo;
    fs.writeFile(`${FRAMES}/${String(n).padStart(5, '0')}.jpg`, Buffer.from(data, 'base64'), () => {});
    stamp.push({ n, ts: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  mark('录制开始');

  /* ---------- 时间线 ---------- */
  await caption('① 设置 → 🚶 桌面走动：鼠标框选它能走的范围');
  await sleep(1800);
  await evalJs(cdp, 'petAPI.openSettings(); true');
  mark('打开设置面板');
  await sleep(900);
  const walkBox = await evalJs(cdp, `(()=>{const e=document.getElementById('walkSelectBtn');
    if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect();
    return {x:r.left,y:r.top,w:r.width,h:r.height};})()`);
  mark('设置面板滚到走动区', walkBox);
  await sleep(1200);
  await clickSel(cdp, '#walkSelectBtn');
  mark('点「框选走动范围」，遮罩铺满窗口');
  await sleep(700);
  await drag(cdp, { x: 300, y: 330 }, { x: 1520, y: 860 });
  mark('拖出范围（左上 300,330 → 右下 1520,860）');
  await sleep(500);
  const rectInfo = await evalJs(cdp, `(document.getElementById('walkRectInfo')||{}).textContent || ''`);
  mark('范围已写入', rectInfo);
  await sleep(900);

  await caption('② 聊天里直接说「向左走 300 像素」——本地执行，不走模型');
  await evalJs(cdp, 'petAPI.openChat(); true');
  mark('打开聊天面板');
  await sleep(800);
  const say = async (text) => {
    await clickSel(cdp, '#cinput');
    await cdp.send('Input.insertText', { text });
    await sleep(260);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  };
  await say('向左走 300 像素');
  mark('发送「向左走 300 像素」');
  await sleep(2800);
  const afterLeft = await evalJs(cdp, `(()=>{const a=[...document.querySelectorAll('#cmsg .assistant')];
    return {reply:a.length?a[a.length-1].textContent:'', pet:petAPI.walk.info().pet, facing:petAPI.walk.info().facing};})()`);
  mark('左走完成', afterLeft);
  await sleep(700);
  await caption('③ 反过来：「往右走 200 像素」，到边会如实说只走了多少');
  await say('往右走 200 像素');
  mark('发送「往右走 200 像素」');
  await sleep(2400);
  const afterRight = await evalJs(cdp, `(()=>{const a=[...document.querySelectorAll('#cmsg .assistant')];
    return {reply:a.length?a[a.length-1].textContent:'', pet:petAPI.walk.info().pet, facing:petAPI.walk.info().facing};})()`);
  mark('右走完成', afterRight);
  await sleep(700);

  await caption('④ 打开巡游：只在框选范围内随机溜达，到边不越界');
  await evalJs(cdp, 'petAPI.openSettings(); true');
  await sleep(700);
  await evalJs(cdp, `(()=>{const e=document.getElementById('walkCruise'); e.scrollIntoView({block:'center'}); return 1;})()`);
  await sleep(500);
  await clickSel(cdp, '#walkCruise');
  mark('勾上巡游', await evalJs(cdp, 'petAPI.walk.info().cfg'));
  await sleep(900);
  /* 巡游在设置/聊天打开时会让路：关掉面板，等空闲窗口过去（IDLE_HOLD_MS = 12s）它才会自己动 */
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  mark('关掉面板（Esc）');
  await caption('关掉设置后先安静 12 秒（不刚操作完就抢动作），然后自己在框内挑点溜达');
  await sleep(2500);
  const cru = [];
  for (let i = 0; i < 26; i++) {
    await sleep(600);
    cru.push(await evalJs(cdp, `(()=>{const i=petAPI.walk.info();return {x:Math.round(i.pet.x),y:Math.round(i.pet.y),mv:i.moving,st:i.state,f:i.facing};})()`));
  }
  mark('巡游取样', cru);
  await evalJs(cdp, 'petAPI.openChat(); true');
  await sleep(500);
  await caption('「停下」——命令会停住并顺手暂停巡游');
  await say('停下');
  mark('发送「停下」');
  await sleep(2000);
  mark('巡游已停', await evalJs(cdp, 'petAPI.walk.info().cfg'));

  await caption('⑤ 两个方向各有一段真素材（576×960 · 1.33s/步幅 · 循环无缝）');
  await say('往右走 260 像素');
  await sleep(2600);
  await say('向左走');
  await sleep(2400);
  mark('双方向再次演示完毕');
  await caption('v0.7.0 · Electron 锁定发布包 · 无声演示（背景为应用自带演示棋盘格，非真实桌面）');
  await sleep(1800);

  await cdp.send('Page.stopScreencast');
  await sleep(400);
  mark('录制结束', { frames: frameNo });

  cdp.close();
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch (e) {}

  /* 等最后几帧落盘 */
  await sleep(1200);

  /* ---------- 按帧时间戳编码 ---------- */
  const listPath = path.join(FRAMES, 'list.txt');
  const lines = [];
  const files = stamp.filter((s) => fs.existsSync(path.join(FRAMES, String(s.n).padStart(5, '0') + '.jpg')));
  for (let i = 0; i < files.length; i++) {
    const cur = files[i], nxt = files[i + 1];
    const dur = nxt ? Math.max(0.008, nxt.ts - cur.ts) : 0.4;
    lines.push(`file '${String(cur.n).padStart(5, '0')}.jpg'`);
    lines.push(`duration ${dur.toFixed(4)}`);
  }
  if (files.length) {
    lines.push(`file '${String(files[files.length - 1].n).padStart(5, '0')}.jpg'`);
  }
  fs.writeFileSync(listPath, lines.join('\n'), 'utf8');

  const mp4 = path.join(OUT, 'room-walk-demo.mp4');
  const ff = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-vf', `scale=${W}:${H}:flags=lanczos,fps=30,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart', '-an', mp4],
    { cwd: FRAMES, encoding: 'buffer' });
  if (ff.status !== 0) throw new Error('ffmpeg 编码失败：' + (ff.stderr || '').toString().slice(0, 800));

  /* ---------- 关键帧（对应时间线节点） ---------- */
  const dur = files.length ? files[files.length - 1].ts - files[0].ts : 0;
  const keys = steps.filter((s) => /框选|范围已写入|右走完成|左走完成|勾上巡游|双方向|录制结束/.test(s.name));
  const pick = (tSec) => {
    const target = files.length ? files[0].ts + tSec : 0;
    let best = files[0], bd = 1e9;
    for (const f of files) { const d = Math.abs(f.ts - target); if (d < bd) { bd = d; best = f; } }
    return best ? path.join(FRAMES, String(best.n).padStart(5, '0') + '.jpg') : null;
  };
  const saved = [];
  for (const k of keys) {
    const src = pick(k.t);
    if (!src) continue;
    const dst = path.join(OUT, '帧', 'walk-demo-' + k.t.toFixed(1).replace('.', 's') + '.png');
    const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-frames:v', '1', dst], { encoding: 'buffer' });
    if (r.status === 0) saved.push(path.basename(dst));
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    artifact: { exe: EXE, exeSha256: exeSha, exeBytes: fs.statSync(EXE).size,
                zip: path.join(ROOT, 'dist', '桌宠_发布版.zip'), appVersion: '0.7.0' },
    capture: { method: 'CDP Page.startScreencast（页面真实绘制帧）+ ffmpeg 按时间戳编码',
               width: W, height: H, fps: 30, audio: 'none（无声）',
               viewport: view, background: '应用自带「演示背景」棋盘格（#checker），铺满视口，画面不含真实桌面',
               captions: '演示注入的 DOM 字幕（#__demoCap / #__demoTtl），未改应用代码' },
    video: { file: mp4, bytes: fs.statSync(mp4).size, framesCaptured: files.length,
             capturedSpanSec: +dur.toFixed(2) },
    keyframes: saved,
    timeline: steps,
  };
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  console.log('\n== 演示片段 ==');
  console.log('mp4 :', mp4, (meta.video.bytes / 1048576).toFixed(1) + ' MB', '抽帧', files.length, '帧 /', dur.toFixed(1) + 's');
  console.log('关键帧:', saved.length, '张');
  console.log('meta:', path.join(OUT, 'meta.json'));
})().catch((e) => { console.error('录制失败：', e && e.message); process.exit(1); });
