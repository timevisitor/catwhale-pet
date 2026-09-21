// 桌宠桌面版主进程：全屏透明窗口 + 逐像素点击穿透 + 托盘 + Everything 文件搜索
const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, shell, clipboard, globalShortcut, safeStorage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const urlmod = require('url');
const { execFile } = require('child_process');
const { HarnessClient, detectRepo, isRepoDir } = require('./harness-client.js');
const sysinfo = require('./sysinfo.js');   // 详情卡四角标注的实时硬件数据   // 长驻 harness SDK 客户端（流式）

const SOLID = process.argv.includes('--solid');
const BENCH = process.argv.includes('--bench');
const PAGEMARK = process.argv.includes('--pagemark');   // 透明窗口 + 页面实心红：区分"窗口没合成"还是"页面 alpha 没合成"
const PAGEMARK3 = process.argv.includes('--pagemark3'); // 给 #pet 整块上红底：验证"页面元素"能否合成(不依赖 rect 时机)
const PAGEMARK2 = process.argv.includes('--pagemark2'); // 透明窗口 + 在桌宠位置画一个红色 DOM 方块(非视频)
// --fixed=<状态id>：关掉空闲自动切换并把状态钉死（受控基准测量用，避免不同状态的解码量差异污染对比）
const FIXED = (process.argv.find((a) => a.startsWith('--fixed=')) || '').split('=')[1] || '';
// --winsize=WxH：实验用——把窗口缩到桌宠大小，测"全屏透明窗口"的合成开销到底占多少
const WINSIZE = (process.argv.find((a) => a.startsWith('--winsize=')) || '').split('=')[1] || '';
// --autostart=on|off：命令行设置开机自启（等价于托盘里那个勾）
const AUTOSTART = (process.argv.find((a) => a.startsWith('--autostart=')) || '').split('=')[1] || '';
// --searchtest=<query>：跑一次 Everything 搜索并打印 JSON（后端自检）
const SEARCHTEST = (process.argv.find((a) => a.startsWith('--searchtest=')) || '').split('=')[1];
// --detecttest：打印"环境探测"结果（版本 / harness 仓库 / es.exe / node 来源）后退出，供发布验收用
const DETECTTEST = process.argv.includes('--detecttest');
// --repotest=<目录>：检验"浏览…选完目录后的归一化"逻辑（同上，验收用）
const REPOTEST = (() => {
  const a = process.argv.find((x) => x.startsWith('--repotest='));
  return a === undefined ? undefined : a.slice('--repotest='.length);
})();
// --mirrortest：菜单翻面与"抬手镜像"的验收自检（跑完打印 JSON，另存两张裁剪图供像素级比对）
const MIRRORTEST = process.argv.includes('--mirrortest');
const APP_VERSION = (function () { try { return require('./package.json').version || ''; } catch (e) { return ''; } }());
// 唤起文件搜索框的全局热键：按顺序试，注册成功即用（Ctrl+Alt+F 常被显卡/远程工具占用）
const SEARCH_HOTKEYS = ['Control+Alt+F', 'Control+Shift+F', 'Alt+Shift+F', 'Control+Alt+Space', 'Control+Alt+P'];
let searchHotkey = '';
const CHAT_HOTKEYS = ['Control+Alt+D', 'Control+Shift+D', 'Alt+Shift+D', 'Control+Alt+C'];
let chatHotkey = '';
const NOGPU = process.argv.includes('--nogpu');         // 关硬件加速
if (NOGPU) app.disableHardwareAcceleration();   // --solid: 用不透明红底测试窗口是否真的在合成
const WEB_ROOT = path.join(__dirname, 'renderer');       // 网页资源（构建时从 ../web 拷进来）
const STATE_FILE = path.join(app.getPath('userData'), 'pet-state.json');
const CHAT_FILE = path.join(app.getPath('userData'), 'chat-history.json');   // 与 harness 的聊天记录
const ICON_FILE = path.join(__dirname, 'assets', 'tray.png');

let win = null, tray = null, server = null, port = 0;
let quitting = false;

/* ---------- 状态持久化（位置/大小/所在屏幕） ---------- */
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(o) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(o)); } catch (e) {}
}

/* ---------- 多显示器：列出屏幕 / 把桌宠窗口挪到指定屏 ---------- */
function sortedDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().slice()
    .sort((a, b) => (a.bounds.x - b.bounds.x) || (a.bounds.y - b.bounds.y))
    .map((d, i) => ({
      id: d.id,
      index: i + 1,
      primary: d.id === primaryId,
      label: `屏幕 ${i + 1}${d.id === primaryId ? '（主屏）' : ''} ${d.workArea.width}×${d.workArea.height}`,
      bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
      workArea: { x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height },
    }));
}
function currentDisplayId() {
  if (!win || win.isDestroyed()) return null;
  try { return screen.getDisplayMatching(win.getContentBounds()).id; } catch (e) { return null; }
}
function displayWorkAreaById(id) {
  const list = sortedDisplays();
  let d = list.find((x) => x.id === id);
  if (!d) {
    const p = screen.getPrimaryDisplay();
    d = { id: p.id, workArea: p.workArea, label: '主屏' };
  }
  return d;
}
function applyPetBottomRight() {
  if (!win || win.isDestroyed()) return;
  const js = `(()=>{try{
    const w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pet-w')) || petAPI.getSize();
    petAPI.setPos(innerWidth - w - 60, innerHeight - petAPI.getSize() * 0.9667 - 6);
    if (typeof refreshSaoStatus === 'function') refreshSaoStatus();
    return 'ok';
  }catch(e){return String(e)}})()`;
  win.webContents.executeJavaScript(js).catch(() => {});
}
function moveToDisplay(displayId) {
  if (!win || win.isDestroyed()) return { ok: false, error: '窗口不可用' };
  const d = displayWorkAreaById(displayId);
  const wa = d.workArea;
  try {
    win.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const cur = loadState();
  saveState(Object.assign({}, cur, { displayId: d.id }));
  setTimeout(applyPetBottomRight, 80);
  const list = sortedDisplays();
  const item = list.find((x) => x.id === d.id) || { id: d.id, label: '屏幕' };
  return { ok: true, id: item.id, label: item.label, currentId: item.id };
}
function resolveStartupDisplay() {
  const st = loadState();
  if (st.displayId != null && st.displayId !== undefined) {
    const hit = screen.getAllDisplays().find((d) => d.id === st.displayId);
    if (hit) return hit.workArea;
  }
  return screen.getPrimaryDisplay().workArea;
}

/** 给渲染进程发消息（窗口可能已销毁，统一兜一层） */
function send(channel, payload) {
  try { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); } catch (e) {}
}

/** 解析用哪个 node 跑 harness：优先 PATH 里的 node，没有就退回 Electron 自身（当 node 用） */
function resolveNode() {
  try {
    const r = require('node:child_process').spawnSync('node', ['-v'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (r && r.status === 0 && /^v\d+/.test((r.stdout || '').trim())) return 'node';
  } catch (e) {}
  return process.execPath;
}

/* ---------- 本地 http 服务 ----------
   必须走 http 而不是 file://：file:// 下 canvas 会被污染，
   页面就读不到视频的 alpha，逐像素命中/穿透判定会退化成矩形。 */
function startServer() {
  return new Promise((resolve, reject) => {
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
                   '.json': 'application/json; charset=utf-8', '.webm': 'video/webm',
                   '.png': 'image/png', '.ico': 'image/x-icon' };
    server = http.createServer((req, res) => {
      let p = decodeURIComponent(urlmod.parse(req.url).pathname);
      if (p === '/') p = '/index.html';
      const file = path.join(WEB_ROOT, p);
      if (!file.startsWith(WEB_ROOT)) { res.writeHead(403); return res.end('403'); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('404'); }
        res.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
                             'Cache-Control': 'no-store' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(port); });
  });
}

/* ---------- 主窗口 ---------- */
async function createWindow() {
  const wa = resolveStartupDisplay();                   // 优先恢复上次所在屏幕，否则主屏
  const st = loadState();
  const ws = WINSIZE ? WINSIZE.split('x').map(Number) : null;
  win = new BrowserWindow({
    x: ws ? wa.x + 200 : wa.x, y: ws ? wa.y + 200 : wa.y,
    width: ws ? ws[0] : wa.width, height: ws ? ws[1] : wa.height,
    transparent: !SOLID, frame: false, resizable: false, movable: false,
    hasShadow: false, skipTaskbar: true, alwaysOnTop: true, fullscreenable: false,
    backgroundColor: SOLID ? '#ff0000' : '#00000000', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });     // 默认穿透；页面检测到角色才打开交互

  // A new renderer must never inherit a stale full-screen input state.
  win.webContents.on('did-start-loading',()=>{ setMouseInteractive(false, true); setEscGuard(false); });

  // ⚠ did-finish-load 必须在 loadURL 之前注册：await loadURL 返回时它已经触发过了
  win.webContents.once('did-finish-load', () => {
    if (PAGEMARK3) win.webContents.insertCSS('#pet{background:#ff0000 !important}').catch(()=>{});
    if (PAGEMARK2) win.webContents.executeJavaScript(`(()=>{const r=document.getElementById('pet').getBoundingClientRect();const d=document.createElement('div');d.style.cssText='position:fixed;z-index:9999;background:#ff0000;left:'+r.left+'px;top:'+r.top+'px;width:'+r.width+'px;height:'+r.height+'px';document.body.appendChild(d);return 'ok';})()`).catch(()=>{});
    if (PAGEMARK) win.webContents.insertCSS('html,body{background:#ff0000 !important;}').catch(()=>{});
    if (st.x !== undefined && st.y !== undefined) {
      win.webContents.executeJavaScript(`petAPI.setPos(${st.x}, ${st.y})`).catch(() => {});
    }
    setTimeout(() => { if (win && !win.isDestroyed()) win.show(); }, 250);   // 等首帧出来再显示，避免闪一下
  });

  await startServer();
  const q = new URLSearchParams({ bg: 'none', controls: '0', auto: FIXED ? '0' : '1' });
  if (st.size) q.set('size', String(st.size));
  await win.loadURL(`http://127.0.0.1:${port}/index.html?${q.toString()}`);

  if (FIXED) {                                   // 受控测量：钉死状态并周期性重申（自动行为已关）
    const pin = () => { if (win && !win.isDestroyed()) win.webContents.executeJavaScript(`petAPI.setState(${JSON.stringify(FIXED)})`).catch(() => {}); };
    setTimeout(pin, 1200);
    setInterval(pin, 2000);
  }

  win.on('closed', () => { win = null; });

  // --diag：启动后把"页面渲染结果(含alpha)"和窗口几何/页面状态落盘，用于无头验证
  if (BENCH) setTimeout(() => { if (win && !win.isDestroyed()) runBench(win); }, 4000);
  if (process.argv.includes('--diag')) {
    setTimeout(async () => {                       // loadURL 之后页面已就绪，直接延时跑
      if (!win || win.isDestroyed()) return;
      try {
        const st = await win.webContents.executeJavaScript(`JSON.stringify({
          state: cur, pos: petAPI.getPos(), size: petAPI.getSize(),
          inner: [innerWidth, innerHeight], vw: window.petHost ? 'host-ok' : 'no-host',
          videos: [...document.querySelectorAll('#pet video')].map(v => ({
                    f: v.currentSrc.split('/').pop(), rs: v.readyState, w: v.videoWidth, h: v.videoHeight })),
          err: window.__petError || null, initOK: !!window.__petInitOK })`);
        const b = win.getBounds();
        const al = autoLaunchInfo();
        console.log('DIAG_PAGE ' + st);
        console.log('DIAG_AUTOSTART ' + JSON.stringify(al));
        console.log('DIAG_WIN ' + JSON.stringify({ bounds: b, visible: win.isVisible(),
                  alwaysOnTop: win.isAlwaysOnTop(), opacity: win.getOpacity() }));
        require('fs').mkdirSync(path.join(__dirname, 'diag'), { recursive: true });
        require('fs').writeFileSync(path.join(__dirname, 'diag', 'report.json'),
          JSON.stringify({ page: JSON.parse(st), autostart: al, win: { bounds: win.getBounds(), visible: win.isVisible(),
            alwaysOnTop: win.isAlwaysOnTop() }, screen: screen.getPrimaryDisplay().workArea }, null, 2));
        const img = await win.webContents.capturePage();
        const png = img.toPNG();
        require('fs').mkdirSync(path.join(__dirname, 'diag'), { recursive: true });
        const out = path.join(__dirname, 'diag', 'capture.png');
        require('fs').writeFileSync(out, png);
        console.log('DIAG_CAPTURE ' + out + ' ' + img.getSize().width + 'x' + img.getSize().height);
      } catch (e) { console.log('DIAG_ERROR ' + e.message); }
    }, 3500);
  }
  return win;
}

/* ---------- CPU 基准台（--bench）----------
   分阶段测量各进程 CPU%：A 初始 / B 七段视频全解码 / C 只留当前状态 /
   D 再停掉调试FPS循环 / E 窗口隐藏（纯合成开销）。
   目的是把"为什么CPU高"落到具体进程和具体原因上，而不是猜。 ---------- */
async function runBench(win) {
  const fs = require('fs');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code).catch((e) => 'ERR:' + e.message);
  const sample = () => app.getAppMetrics().map((m) => ({
    type: m.type, pid: m.pid, cpu: +((m.cpu && m.cpu.percentCPUUsage) || 0).toFixed(1),
    mem: Math.round((m.memory && m.memory.workingSetSize || 0) / 1024)
  }));
  const pageInfo = () => js(`({
    playing: Array.from(document.querySelectorAll('#pet video')).filter(v=>!v.paused).length,
    total: document.querySelectorAll('#pet video').length,
    active: (document.querySelector('#pet video.active')||{currentSrc:''}).currentSrc.split('/').pop(),
    fpsHook: !!(window.__petDebug && window.__petDebug.fpsRunning && window.__petDebug.fpsRunning()),
    decoded: Array.from(document.querySelectorAll('#pet video')).map(v=>({
      f:(v.currentSrc||'').split('/').pop(), paused:v.paused,
      n: v.webkitDecodedFrameCount || 0, w: v.videoWidth, h: v.videoHeight }))
  })`);
  const phases = [];
  async function phase(name, prep, ms) {
    if (prep) await js(prep);
    await sleep(700);
    sample();                                    // Electron 首次调用返回 0，先丢弃
    const a0 = await pageInfo();
    const t0 = Date.now();
    await sleep(ms || 8000);
    const t1 = Date.now();
    const a1 = await pageInfo();
    // 解码帧数增量 → 每个视频真实解码了几帧/秒（不受系统负载噪声影响）
    const secs = (t1 - t0) / 1000;
    const dec = a1.decoded.map((v, i) => ({
      f: v.f, w: v.w, h: v.h, paused: v.paused,
      fps: +(((v.n - (a0.decoded[i] ? a0.decoded[i].n : v.n)) / secs).toFixed(1))
    })).filter((v) => v.fps > 0.2);
    phases.push({ name, startedAt: t0, endedAt: t1, seconds: +secs.toFixed(1), cpu: sample(), info: a1,
                  decoding: dec, decodeFramesTotal: dec.reduce((s, v) => s + v.fps, 0) });
  }
  try {
    if (process.argv.includes('--benchlite')) {
      await phase('STEADY_稳态（只测当前状态）', null, 12000);
    } else {
    await phase('A_初始（只有待机在解码）', null);
    await phase('B_七段视频同时在解码（长时间使用后的样子）',
      `(()=>{document.querySelectorAll('#pet video').forEach(v=>{v.play().catch(()=>{})}); return 1})()`);
    await phase('C_只让当前状态解码（改后应达到的水平）',
      `(()=>{let n=0;document.querySelectorAll('#pet video').forEach(v=>{if(!v.classList.contains('active')&&!v.paused){v.pause();n++}}); return 'paused:'+n})()`);
    await phase('D_再停掉调试用FPS循环',
      `(()=>{if(window.__petDebug&&window.__petDebug.stopFps){window.__petDebug.stopFps();return 'stopped'} return 'no-hook'})()`);
    win.hide();
    await phase('E_窗口隐藏（只剩解码，无合成）', null, 6000);
    win.show();
    }
  } catch (e) {
    console.log('BENCH_ERROR ' + e.message);
  }
  const dir = path.join(__dirname, 'diag');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bench.json'), JSON.stringify({ when: new Date().toISOString(), phases }, null, 2));
  for (const p of phases) {
    const tot = p.cpu.reduce((a, b) => a + b.cpu, 0);
    console.log(`BENCH | ${p.name} | 播放 ${p.info.playing}/${p.info.total} | 合计 ${tot.toFixed(1)}% | ` +
      p.cpu.map((c) => `${c.type}:${c.cpu}%/${c.mem}MB`).join(' '));
  }
  console.log('BENCH_DONE ' + path.join(dir, 'bench.json'));
}

/* ---------- 开机自启（托盘开关，默认关） ----------
   便携版的 exe 路径会被用户搬到别处；path 必须指向"当前正在运行的 exe"，
   否则自启项会在下次开机指向一个已经不存在/被移走的路径。 */
function autoLaunchInfo() {
  const exe = process.execPath;
  const tempRun = /\\Temp\\|\\7z|\\AppData\\Local\\Temp/i.test(exe);   // 自解压到临时目录运行时不要设自启
  try {
    const s = app.getLoginItemSettings({ path: exe });
    return { exe, on: !!s.openAtLogin, blocked: tempRun };
  } catch (e) {
    return { exe, on: false, blocked: tempRun };
  }
}
function setAutoLaunch(on) {
  const info = autoLaunchInfo();
  if (on && info.blocked) return false;            // 从临时目录跑起来时拒绝写自启
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, path: info.exe, args: [] });
    return true;
  } catch (e) { return false; }
}

/* ---------- Everything 文件搜索 ----------
   用 voidtools 官方命令行 es.exe 走 IPC 查询，**不改用户 Everything 的任何配置**。
   三个必须处理的现实问题：
   1) **输出是 GBK**（实测中文路径按 utf-8 解会炸），必须用 TextDecoder('gbk') 解码；
      Node/Electron 自带 full-icu，原生支持。
   2) **Everything 1.5 便携 alpha 版**的 IPC 窗口类带后缀 `EVERYTHING_TASKBAR_NOTIFICATION_(1.5a)`，
      而 es.exe 默认只找不带后缀的老窗口 → 报 "Error 8: IPC window not found"。
      所以先探测实例名（''=普通安装版 / '1.5a' / '1.5' / '1.4'），探测结果记进状态文件，
      下次启动直接用，不再重复试。
   3) es.exe 失败时**仍然打印到 stdout**（如 "Error 8: ..."）且退出码为 0，必须按内容判错。
*/
const ES_INSTANCES = ['', '1.5a', '1.5', '1.4'];
let esInstance = undefined;                     // undefined=还没探测；''=默认实例

function esPath() {
  const cands = [
    path.join(__dirname, 'assets', 'es.exe'),                       // 随程序附带
    path.join(process.env.LOCALAPPDATA || '', 'Everything', 'es.exe'),
    'C:\\Program Files\\Everything\\es.exe',
    'C:\\Program Files (x86)\\Everything\\es.exe'
  ];
  return cands.find((p) => { try { return p && fs.existsSync(p); } catch (e) { return false; } }) || '';
}

function instanceArgs(name) {
  return name ? ['-instance', name] : [];
}

function runEs(args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const es = esPath();
    if (!es) return resolve({ ok: false, error: 'es.exe 未找到', stdout: '' });
    execFile(es, args, { windowsHide: true, encoding: 'buffer', timeout: timeoutMs,
                         maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const dec = (b) => {
          if (!b) return '';
          try { return new TextDecoder('gbk').decode(b); } catch (e) { return Buffer.from(b).toString('utf8'); }
        };
        // 实测（Everything 未运行时）：es.exe 退出码 8、错误写 **stderr**、stdout 只剩 39 字节的 CSV 表头
        // —— 只按 stdout 判错会把"Everything 没开"误报成"查询成功、没有结果"。所以两边都收。
        const errOut = dec(stderr);
        if (err && !stdout) {
          const msg = err.killed ? '查询超时' : (errOut.trim() || err.message || 'es.exe 执行失败');
          return resolve({ ok: false, error: msg, stdout: '', stderr: errOut });
        }
        resolve({ ok: true, stdout: dec(stdout), stderr: errOut, code: err ? (err.code || 1) : 0 });
      });
  });
}

/* CSV：es.exe 对含空格/逗号的路径会加引号，引号内用 "" 转义（标准 CSV） */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { inQ = false; } }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function detectEsInstance(force) {
  if (esInstance !== undefined && !force) return esInstance;
  const cands = [];
  const saved = loadState().esInstance;
  if (typeof saved === 'string') cands.push(saved);
  for (const c of ES_INSTANCES) if (!cands.includes(c)) cands.push(c);
  for (const c of cands) {
    const r = await runEs(instanceArgs(c).concat(['-n', '1', '*']), 6000);
    if (r.ok && r.stdout.trim() && !/^Error\s/i.test(r.stdout.trim())) {
      esInstance = c;
      saveState(Object.assign(loadState(), { esInstance: c }));
      return c;
    }
  }
  esInstance = '';
  return '';
}

async function searchEverything(query, limit) {
  const q = String(query == null ? '' : query).replace(/[\r\n\t\0]/g, ' ').trim();
  const n = Math.max(1, Math.min(200, parseInt(limit, 10) || 30));
  if (!q) return { ok: true, results: [], instance: esInstance || '', empty: true };
  if (!esPath()) return { ok: false, error: 'NO_ES', results: [] };
  const inst = await detectEsInstance();
  const args = instanceArgs(inst).concat([
    '-csv', '-full-path-and-name', '-extension', '-size', '-date-modified',
    '-date-format', '1', '-size-format', '0', '-n', String(n), q
  ]);
  const r = await runEs(args, 10000);
  if (!r.ok) return { ok: false, error: r.error, results: [] };
  const lines = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  // 错误可能出现在 stdout（历史行为）**或** stderr（实测 Everything 未运行时就在 stderr）
  const errLine = lines.find((l) => /^Error\s+\d+/i.test(l))
               || String(r.stderr || '').split('\n').map((s) => s.trim()).find((l) => /^Error\s+\d+/i.test(l))
               || '';
  if (errLine) {
    const friendly = /IPC window not found|not running/i.test(errLine)
      ? '未检测到 Everything（请先启动 Everything 后重试）' : errLine;
    return { ok: false, error: friendly, detail: errLine, instance: inst, results: [] };
  }
  // 有错误退出码但连错误行都没给（stdout 只有表头）→ 同样按"没连上"处理，别谎报"没有结果"
  if (r.code && r.code !== 0 && lines.length <= 1) {
    return { ok: false, error: '未检测到 Everything（请先启动 Everything 后重试）',
             detail: 'exit=' + r.code, instance: inst, results: [] };
  }
  const rows = parseCsv(r.stdout).filter((c) => c.length >= 2);
  const results = rows.slice(1).map((c) => {
    const p = c[0];
    return { path: p, name: p.split(/[\\/]/).pop() || p, ext: c[1] || '',
             size: parseInt(c[2], 10) || 0, mtime: c[3] || '' };
  }).filter((v) => v.path);
  return { ok: true, instance: inst, results, total: results.length };
}

/* ---------- 设置（DeepSeek API / 网址 / Harness 路径）----------
   - key **只存本机**，默认用 Electron safeStorage（Windows 上是 DPAPI，按当前用户加密）加密后落盘；
     取不到加密能力时退化为明文并在界面上明确提示。
   - 运行时通过**环境变量**拿到 key 与网址（harness 的凭据优先级：继承环境 > $DSH_HOME/.credentials.yaml），
     所以既不需要改用户 harness 配置，也不会把 key 写进任何随包分发的文件。 */
const CFG_FILE = path.join(app.getPath('userData'), 'settings.json');
const CFG_DEFAULTS = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: '', provider: '' },
  harness: { repo: '', profile: 'headless', cwd: '', maxTokens: 8192 },
};

function loadCfgRaw() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch (e) { return {}; }
}
function loadCfg() {
  const raw = loadCfgRaw();
  return {
    deepseek: Object.assign({}, CFG_DEFAULTS.deepseek, raw.deepseek || {}),
    harness: Object.assign({}, CFG_DEFAULTS.harness, raw.harness || {}),
    _keyEnc: (raw.deepseek && raw.deepseek.apiKeyEnc) || '',
    _keyPlain: (raw.deepseek && raw.deepseek.apiKey) || '',
  };
}
function apiKeyPlain() {
  const c = loadCfg();
  if (c._keyPlain) return c._keyPlain;                     // 退化模式（明文）
  if (!c._keyEnc) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(c._keyEnc, 'base64'));
  } catch (e) { console.log('KEY_DECRYPT_FAIL ' + e.message); }
  return '';
}
function saveCfg(patch) {
  const cur = loadCfgRaw();
  const next = Object.assign({}, cur);
  next.deepseek = Object.assign({}, CFG_DEFAULTS.deepseek, cur.deepseek || {});
  next.harness = Object.assign({}, CFG_DEFAULTS.harness, cur.harness || {});
  if (patch && patch.deepseek) Object.assign(next.deepseek, patch.deepseek);
  if (patch && patch.harness) Object.assign(next.harness, patch.harness);
  if (patch && typeof patch.apiKey === 'string') {
    const v = patch.apiKey.trim();
    delete next.deepseek.apiKeyEnc; delete next.deepseek.apiKey;
    if (v) {
      let enc = false;
      try {
        if (safeStorage.isEncryptionAvailable()) { next.deepseek.apiKeyEnc = safeStorage.encryptString(v).toString('base64'); enc = true; }
      } catch (e) { console.log('KEY_ENCRYPT_FAIL ' + e.message); }
      if (!enc) next.deepseek.apiKey = v;                  // 退化：明文（界面会提示）
    }
  }
  try { fs.writeFileSync(CFG_FILE, JSON.stringify(next, null, 2)); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}

ipcMain.handle('config:get', () => {
  const c = loadCfg();
  const key = apiKeyPlain();
  return {
    ok: true,
    version: APP_VERSION,
    deepseek: {
      baseUrl: c.deepseek.baseUrl || CFG_DEFAULTS.deepseek.baseUrl,
      model: c.deepseek.model || '', provider: c.deepseek.provider || '',
      keySet: !!key, keyTail: key ? key.slice(-4) : '',
      encrypted: !c._keyPlain && !!c._keyEnc && safeStorage.isEncryptionAvailable(),
    },
    harness: { repo: c.harness.repo || '', detected: detectRepo(), profile: c.harness.profile || 'headless',
               cwd: c.harness.cwd || '', maxTokens: c.harness.maxTokens || 8192 },
    everything: { esExe: fs.existsSync(esPath()), instance: (loadState().esInstance || '') },
  };
});

/** 用户点"浏览…"选了一个目录 → 归一到真正的仓库根（容错：多一层/少一层/选得太深） */
function resolvePickedRepo(p) {
  if (!p) return '';
  const j = (...a) => path.join(...a.filter(Boolean));
  const up1 = path.dirname(p), up2 = path.dirname(up1), up3 = path.dirname(up2);
  const tries = [p, j(p, 'src'), j(p, 'deepseek-harness'), j(p, 'deepseek-harness', 'src'),
                 up1, j(up1, 'src'), up2, j(up2, 'src'), up3];
  for (const t of tries) if (isRepoDir(t)) return t;
  return '';
}
ipcMain.handle('config:browseRepo', async () => {
  const cur = loadCfg().harness.repo || detectRepo() || app.getPath('home');
  const opts = {
    title: '选择 DeepSeek Harness 仓库根目录（含 apps\\cli\\src\\bin.ts 的那一层）',
    defaultPath: cur,
    properties: ['openDirectory'],
    buttonLabel: '用这个目录',
  };
  let r = null;
  try {
    r = (win && !win.isDestroyed()) ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  if (!r || r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
  const picked = r.filePaths[0];
  const root = resolvePickedRepo(picked);
  return { ok: true, picked, path: root || picked, valid: !!root };
});
ipcMain.handle('config:detect', () => {
  const p = detectRepo(true);                      // force：重新扫一遍（不吃缓存）
  return { ok: true, path: p, valid: isRepoDir(p) };
});
ipcMain.handle('config:set', (_e, patch) => {
  const r = saveCfg(patch || {});
  if (r.ok && harness) { harness.kill(); harness = null; }   // 设置变了 → 下次发消息按新设置重启运行时
  return Object.assign(r, { restarted: true });
});
ipcMain.handle('config:test', async () => {
  try {
    if (harness) { harness.kill(); harness = null; }
    const h = ensureHarness();
    const t0 = Date.now();
    const seen = { text: '', err: '' };
    let done = null;
    const waitTurn = new Promise((r2) => { done = r2; });
    h.onEvent = ((orig) => (evt) => {
      try {
        if (evt.kind === 'delta') seen.text += evt.text || '';
        else if (evt.kind === 'message' && evt.text) seen.text = evt.text;
        else if (evt.kind === 'turnEnd') { if (evt.reason && evt.reason.kind === 'error') seen.err = (evt.reason.error && evt.reason.error.message) || 'error'; if (done) done(); }
      } catch (e) {}
      return orig(evt);
    })(h.onEvent);
    await h.prompt('只回答两个字：正常');
    await Promise.race([waitTurn, new Promise((r2) => setTimeout(r2, 120000))]);
    return { ok: !seen.err, text: seen.text, error: seen.err, ms: Date.now() - t0, model: h.model, sessionId: h.sessionId };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

/* ---------- DeepSeek Harness 聊天（长驻 SDK JSON-RPC 客户端）----------
   见 app/harness-client.js 的注释：harness 自带对外协议（packages/sdk），
   挂上 dsh-sdk-jsonrpc-server 后，桌宠就是一个真正的 harness 客户端：
   流式文本增量、工具调用、会话标题、token 计量、running/idle 状态，全都能拿到。

   与旧做法（每条消息起一个 `dsh --profile headless "<任务>"`）的区别：
     · 运行时只启动一次（冷启动 ~7s），之后每条消息省掉启动开销
     · 能看到过程（流式/工具）而不是只等最终答案
     · 同一进程内是**真正的 harness 会话**，多轮记忆由 harness 自己管
   session id 与进程绑定，所以每次启动用新 id；跨重启的上下文用
   "首次发言内联最近几轮" + harness 自己的持久记忆 兜住。 */

let harness = null;                       // 长驻客户端单例
let harnessBootedAt = 0;
let harnessHistorySeeded = false;         // 本次运行时是否已经内联过历史
let harnessTurnText = '';                 // 本条消息累积的助手文本（流式）
let harnessTurnUser = '';                 // 本条消息的用户原文（落盘用）
let harnessTurnT0 = 0;                    // 本轮开始时间

function harnessLog(line) { console.log(line); }

function ensureHarness() {
  if (harness && harness.alive) return harness;
  const st = loadState();
  const cfg = loadCfg();
  const patch = path.join(__dirname, 'harness-sdk', 'pet-sdk.patch.yml');   // 随 app 一起打包
  harness = new HarnessClient({
    repo: cfg.harness.repo || st.harnessRepo || detectRepo(),
    profile: cfg.harness.profile || st.harnessProfile || 'headless',
    patch: st.harnessPatch || patch,
    cwd: cfg.harness.cwd || st.harnessCwd || cfg.harness.repo || detectRepo(),
    provider: cfg.deepseek.provider || st.harnessProvider || undefined,
    model: cfg.deepseek.model || st.harnessModel || undefined,
    maxTokens: cfg.harness.maxTokens || 8192,
    envExtras: (() => {
      const env = {};
      const k = apiKeyPlain();
      if (k) env.DEEPSEEK_API_KEY = k;                       // 用户自己的 key，只在本机、只走环境变量
      if (cfg.deepseek.baseUrl) env.DEEPSEEK_BASE_URL = cfg.deepseek.baseUrl;
      return env;
    })(),
    nodeExe: resolveNode(),
    log: harnessLog,
    onStatus: (state, info) => {
      if (state === 'idle' && !harnessBootedAt) harnessBootedAt = Date.now();
      send('harness:status', { state, info: info || {}, sessionId: harness && harness.sessionId,
                               provider: harness && harness.provider, model: harness && harness.model,
                               bootMs: harnessBootedAt ? Date.now() - harnessBootedAt : 0 });
    },
    onEvent: (evt) => {
      // 主进程侧也累积一份：turn 结束时把这一轮写进 chat-history.json（流式模式下只有这里知道最终文本）
      try {
        if (evt.kind === 'delta') harnessTurnText += evt.text || '';
        else if (evt.kind === 'message' && evt.text) harnessTurnText = evt.text;
        else if (evt.kind === 'turnEnd') {
          const reason = evt.reason || {};
          if (reason.kind !== 'error' && (harnessTurnText || harnessTurnUser)) {
            appendChat(harnessTurnUser, harnessTurnText, { sessionId: harness && harness.sessionId, ms: Date.now() - (harnessTurnT0 || Date.now()) });
          }
          harnessTurnText = ''; harnessTurnUser = '';
        }
      } catch (e) { console.log('HARNESS_LOG_ERR ' + e.message); }
      send('harness:event', evt);
    },
  });
  return harness;
}

/** 本次运行时的第一条消息：把最近的对话内联进去，让新会话有个"热身"上下文 */
function seedHistoryIfNeeded(prompt) {
  if (harnessHistorySeeded) return prompt;
  harnessHistorySeeded = true;
  const hist = loadChatHistory();
  const recent = hist.slice(-6).filter((m) => m && m.text);
  if (!recent.length) return prompt;
  const lines = recent.map((m) => (m.role === 'user' ? '用户：' : '助手：') + String(m.text).slice(0, 500));
  return '【以下是之前几轮的对话记录，仅供理解上下文；不要重复执行其中已经完成的请求】\n' +
         lines.join('\n') + '\n\n【现在请回答这条新消息】\n' + prompt;
}

ipcMain.handle('harness:chat', async (_e, payload) => {
  const prompt = (payload && payload.prompt) || '';
  const t0 = Date.now();
  try {
    const h = ensureHarness();
    harnessTurnUser = prompt; harnessTurnText = ''; harnessTurnT0 = Date.now();
    const text = seedHistoryIfNeeded(prompt);
    await h.prompt(text);                       // 立即返回回执；回复走事件流
    return { ok: true, streaming: true, ms: Date.now() - t0, sessionId: h.sessionId };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle('harness:cancel', () => {
  if (!harness) return { ok: false, error: '当前没有在跑的 harness' };
  harness.kill();
  return { ok: true };
});

ipcMain.handle('harness:status', () => {
  const st = loadState();
  return {
    alive: !!(harness && harness.alive), ready: !!(harness && harness.ready),
    sessionId: harness && harness.sessionId, provider: (harness && harness.provider) || st.harnessProvider,
    model: (harness && harness.model) || st.harnessModel,
    repo: st.harnessRepo || detectRepo(),
    profile: st.harnessProfile || 'headless',
    bootMs: harnessBootedAt ? Date.now() - harnessBootedAt : 0,
    dead: (harness && harness.deadReason) || null,
  };
});

function loadChatHistory() {
  try {
    const d = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
    return Array.isArray(d) ? d.slice(-200) : [];
  } catch (e) { return []; }
}
function saveChatHistory(list) {
  try { fs.writeFileSync(CHAT_FILE, JSON.stringify((list || []).slice(-200))); } catch (e) {}
}
function appendChat(userText, assistantText, meta) {
  const list = loadChatHistory();
  list.push({ role: 'user', text: String(userText || ''), at: Date.now() });
  if (assistantText) list.push({ role: 'assistant', text: String(assistantText), at: Date.now(), ms: meta && meta.ms });
  saveChatHistory(list);
  return list;
}

/* ---------- 托盘 ---------- */
let sendToPage = () => {};
function buildTrayMenu() {
  const al = autoLaunchInfo();
  const hk = searchHotkey ? '  ' + searchHotkey.replace('Control', 'Ctrl').replace('Space', '空格') : '';
  const chatHk = chatHotkey ? '  ' + chatHotkey.replace('Control', 'Ctrl') : '';
  return Menu.buildFromTemplate([
    { label: '💬 和 DeepSeek 聊天…' + chatHk, click: () => sendToPage('petAPI.openChat()') },
    { label: '⚙ 设置（DeepSeek API / 网址）…', click: () => sendToPage('petAPI.openSettings()') },
    { label: '🔍 文件搜索…' + hk, click: () => sendToPage('petAPI.openSearch()') },
    { type: 'separator' },
    { label: '显示/隐藏控制面板', click: () => sendToPage('petAPI.togglePanel()') },
    { label: '回待机', click: () => sendToPage('petAPI.setState("idle")') },
    { label: '回到底部右侧', click: () => sendToPage('petAPI.setPos(innerWidth - parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--pet-w")) - 60, innerHeight - petAPI.getSize() * 0.9667 - 6)') },
    { label: '所在屏幕', submenu: (() => {
        let list = [];
        try { list = sortedDisplays(); } catch (e) { list = []; }
        const curId = currentDisplayId();
        if (!list.length) return [{ label: '（正在读取显示器…）', enabled: false }];
        return list.map((d) => ({
          label: d.label,
          type: 'checkbox',
          checked: d.id === curId,
          click: () => {
            const r = moveToDisplay(d.id);
            if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu());
            if (r && r.ok) sendToPage(`typeof toast==='function' && toast('已切换到 ${d.label.replace(/'/g, "\\'")}')`);
          }
        }));
      })() },
    { label: '大小', submenu: [
      { label: '小 (240)', click: () => sendToPage('petAPI.setSize(240)') },
      { label: '中 (340)', click: () => sendToPage('petAPI.setSize(340)') },
      { label: '大 (460)', click: () => sendToPage('petAPI.setSize(460)') },
      { label: '超大 (620)', click: () => sendToPage('petAPI.setSize(620)') }
    ] },
    { type: 'separator' },
    { label: '开机自启' + (al.blocked ? '（当前从临时目录运行，不可用）' : ''), type: 'checkbox',
      checked: al.on, enabled: !al.blocked,
      click: (mi) => { if (!setAutoLaunch(mi.checked)) mi.checked = false; } },
    { label: '重新加载界面', click: () => { if (win) win.webContents.reload(); } },
    { label: '退出桌宠', click: () => { quitting = true; app.quit(); } }
  ]);
}

function buildTray() {
  let img = nativeImage.createFromPath(ICON_FILE);
  if (img.isEmpty()) img = nativeImage.createEmpty();
  tray = new Tray(img.resize({ width: 32, height: 32 }));
  tray.setToolTip('DeepSeek-猫鲸');
  sendToPage = (js) => { if (win && !win.isDestroyed()) win.webContents.executeJavaScript(js).catch(() => {}); };
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => sendToPage('petAPI.openSearch()'));   // 双击托盘=搜索，比面板更常用
  // 显示器插拔/分辨率变化后，刷新「所在屏幕」子菜单
  const rebuild = () => { try { if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu()); } catch (e) {} };
  try {
    screen.on('display-added', rebuild);
    screen.on('display-removed', rebuild);
    screen.on('display-metrics-changed', rebuild);
  } catch (e) {}
}


/* ---------- 文件搜索相关 IPC ---------- */
ipcMain.handle('everything:search', (_e, payload) => {
  const { query = '', limit = 30 } = payload || {};
  return searchEverything(query, limit);
});
ipcMain.handle('everything:open', async (_e, p) => {
  if (typeof p !== 'string' || !p) return { ok: false, error: '无效路径' };
  const err = await shell.openPath(p);
  if (err) return { ok: false, error: err };
  console.log('OPEN ' + p);
  return { ok: true };
});
ipcMain.handle('everything:reveal', (_e, p) => {
  if (typeof p !== 'string' || !p) return { ok: false, error: '无效路径' };
  shell.showItemInFolder(p);
  console.log('REVEAL ' + p);
  return { ok: true };
});
ipcMain.handle('everything:copy', (_e, t) => {
  clipboard.writeText(String(t == null ? '' : t));
  return { ok: true };
});
/* ---------- 聊天 IPC（DeepSeek Harness） ---------- */

ipcMain.handle('chat:history', () => loadChatHistory());
ipcMain.handle('chat:clear', () => { saveChatHistory([]); return { ok: true }; });

/* 详情卡实时硬件数据（菜单打开时开始采样，关闭后缓存一分钟后自动收进程） */
ipcMain.handle('sysinfo:start', () => { console.log('SYSINFO_IPC_START'); sysinfo.start((d) => send('sysinfo', d), (l) => console.log(l)); return { ok: true }; });
ipcMain.handle('sysinfo:stop', () => { sysinfo.stop(); return { ok: true }; });
ipcMain.handle('sysinfo:get', () => sysinfo.latest() || sysinfo.sample());

/* SAO 菜单需要：当前屏工作区（不含任务栏）/ 退出 / 开机自启查询与设置 */
ipcMain.handle('pet:workarea', () => {
  try {
    /* 选窗口所在屏，并把工作区转换为渲染器的窗口内坐标。
       光标所在屏、显示器的全局原点都不能直接用于网页 CSS 定位。 */
    if (!win || win.isDestroyed()) return null;
    const bounds = win.getContentBounds();
    const d = screen.getDisplayMatching(bounds);
    const left = Math.max(bounds.x, d.workArea.x), top = Math.max(bounds.y, d.workArea.y);
    const right = Math.min(bounds.x + bounds.width, d.workArea.x + d.workArea.width);
    const bottom = Math.min(bounds.y + bounds.height, d.workArea.y + d.workArea.height);
    return { x: left - bounds.x, y: top - bounds.y,
      width: Math.max(0, right - left), height: Math.max(0, bottom - top),
      displayId: d.id };
  } catch (e) { return null; }
});
/* 多屏：列出所有显示器 + 切换桌宠所在屏幕 */
ipcMain.handle('pet:displays', () => {
  try {
    return { ok: true, displays: sortedDisplays(), currentId: currentDisplayId() };
  } catch (e) { return { ok: false, displays: [], currentId: null, error: e.message }; }
});
ipcMain.handle('pet:setDisplay', (_e, id) => {
  try { return moveToDisplay(id); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.on('pet:quit', () => { quitting = true; app.quit(); });
ipcMain.handle('pet:autostart', (_e, on) => {
  if (on === null || on === undefined) { const i = autoLaunchInfo(); return { on: i.on, blocked: i.blocked }; }
  const ok = setAutoLaunch(!!on);
  const i = autoLaunchInfo();
  return { on: i.on, blocked: i.blocked, applied: ok };
});

/* 面板（搜索/聊天）打开期间的全局 Esc 兜底：
   窗口是全屏透明+点击穿透，用户点一下桌面就会失焦，页面收不到 keydown → Esc 关不掉面板。
   面板打开时临时注册全局 Escape（关闭即注销），保证"随时可以按 Esc 退出"。 */
let escGuard = false;
function setEscGuard(on) {
  on = !!on;
  if (on === escGuard) return;
  escGuard = on;
  try {
    if (on) globalShortcut.register('Escape', () => { if (win && !win.isDestroyed()) win.webContents.send('pet:esc'); });
    else globalShortcut.unregister('Escape');
  } catch (e) { console.log('ESC_GUARD_ERROR ' + e.message); }
  console.log('ESC_GUARD ' + on);
}
ipcMain.on('pet:panel', (_e, open) => setEscGuard(open));

/* 搜索框需要键盘输入 → 打开时让窗口可交互并抢焦点，关闭时把焦点还回去 */
/* 页面 → 主进程：点击穿透开关。**这是全屏透明窗不吞鼠标的关键**
   （它曾在我改代码时被误删，症状是"打开面板后同屏所有窗口都点不动"）*/
let lastInteractive = null;
function setMouseInteractive(on, force = false){
  if (!win || win.isDestroyed()) return;
  on=!!on;
  if(!force && lastInteractive===on)return;
  win.setIgnoreMouseEvents(!on, { forward: true });
  lastInteractive=on;
}
ipcMain.on('pet:interactive', (_e, on) => setMouseInteractive(on));

// Cursor sampling is independent of forwarded mouse events. After reload Windows
// may no longer forward moves to the new renderer while the window is click-through.
ipcMain.handle('pet:cursor', () => {
  if(!win || win.isDestroyed())return null;
  const point=screen.getCursorScreenPoint(), bounds=win.getContentBounds();
  const zoom=win.webContents.getZoomFactor()||1;
  return {x:(point.x-bounds.x)/zoom, y:(point.y-bounds.y)/zoom,
    inside:point.x>=bounds.x && point.y>=bounds.y && point.x<bounds.x+bounds.width && point.y<bounds.y+bounds.height};
});

/* 页面 → 主进程：保存位置/大小（**合并**进已有状态，别覆盖掉 harness 配置等字段） */
ipcMain.on('pet:save', (_e, s) => {
  if (!s || typeof s.x !== 'number') return;
  const cur = loadState();
  saveState(Object.assign({}, cur, { x: s.x, y: s.y, size: s.size }));
});

ipcMain.on('pet:focus', (_e, on) => {
  if (!win || win.isDestroyed()) return;
  /* 只抢键盘焦点，**绝不碰鼠标穿透**：原来这里写了 setIgnoreMouseEvents(false)，
     一开面板就把整个全屏窗口变成鼠标黑洞，同屏其它窗口全点不动（用户实测 2026-09-19）。*/
  if (on) win.focus();
  else setTimeout(() => { if (win && !win.isDestroyed()) win.blur(); }, 60);
});

/* ---------- 生命周期 ---------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) win.show(); });
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');  // 防止被判定"被遮挡"后停止渲染
  app.whenReady().then(async () => {
    await createWindow();
    buildTray();
    if (AUTOSTART) {                                   // --autostart=on|off：命令行设置（托盘里也有开关）
      const want = ['on', '1', 'true', 'yes'].includes(AUTOSTART.toLowerCase());
      const applied = setAutoLaunch(want);
      const info = autoLaunchInfo();
      console.log('AUTOSTART_SET ' + JSON.stringify({ requested: AUTOSTART, applied, info }));
    }
    // 唤起文件搜索框的全局热键：按候选顺序试，第一个注册成功的就用（都已占用则只留托盘/菜单入口）
    for (const hk of SEARCH_HOTKEYS) {
      try {
        if (globalShortcut.register(hk, () => {
          if (win && !win.isDestroyed()) win.webContents.send('pet:open-search');
        })) { searchHotkey = hk; break; }
      } catch (e) { /* 试下一个 */ }
    }
    console.log('HOTKEY ' + (searchHotkey || '(无可用，已退化为托盘入口)'));
    for (const hk of CHAT_HOTKEYS) {
      try {
        if (globalShortcut.register(hk, () => { if (win && !win.isDestroyed()) win.webContents.send('pet:open-chat'); })) { chatHotkey = hk; break; }
      } catch (e) { /* 试下一个 */ }
    }
    console.log('CHAT_HOTKEY ' + (chatHotkey || '(无可用)'));
    if (tray) tray.setContextMenu(buildTrayMenu());     // 菜单里显示实际热键
    // --searchtest=<query>：命令行跑一次搜索并打印 JSON（后端自检用）
    if (SEARCHTEST !== undefined) {
      setTimeout(async () => {
        const r = await searchEverything(SEARCHTEST, 5);
        console.log('SEARCHTEST ' + JSON.stringify(r));
        if (process.argv.includes('--exit-after-test')) { quitting = true; app.quit(); }
      }, 800);
    }
    // --detecttest：打印环境探测结果（发布验收用：harness 仓库 / es.exe / node 来源）
    if (DETECTTEST) {
      setTimeout(async () => {
        const repo = detectRepo(true);
        const es = esPath();
        const inst = await detectEsInstance(true);
        const nx = resolveNode();
        console.log('DETECTTEST ' + JSON.stringify({
          version: APP_VERSION,
          repo, repoOk: isRepoDir(repo),
          repoFromEnv: !!(process.env.DSH_HARNESS_REPO || process.env.DSH_HARNESS_SRC),
          esExe: es, esExeOk: !!es && fs.existsSync(es), esInstance: inst,
          node: nx, nodeIsElectron: nx === process.execPath,
          nodeVersion: process.versions.node, electron: process.versions.electron,
          userData: app.getPath('userData'),
        }));
        if (process.argv.includes('--exit-after-test')) { quitting = true; app.quit(); }
      }, 800);
    }
    // --repotest=<目录>：检验"浏览…"选目录后的归一化（发布验收用）
    if (REPOTEST !== undefined) {
      const root = resolvePickedRepo(REPOTEST);
      console.log('REPOTEST ' + JSON.stringify({ picked: REPOTEST, path: root || REPOTEST, valid: !!root }));
      if (process.argv.includes('--exit-after-test')) { quitting = true; app.quit(); }
    }
    // --mirrortest：菜单翻到右侧时，抬手动画应水平镜像（且绕站姿中轴翻、角色不位移、命中不错位）
    if (MIRRORTEST) {
      setTimeout(async () => {
        const checks = [];
        const shots = [];
        const chk = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail }); };
        const wc = win && win.webContents;
        const ev = (expr) => wc.executeJavaScript(expr, true);
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const rectOf = (sel) => ev(`(()=>{const b=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
          return {x:b.left,y:b.top,w:b.width,h:b.height,right:b.right,bottom:b.bottom};})()`);
        const crop = async (name, rect, pad, petRect) => {
          const x = Math.max(0, Math.round(rect.x - pad)), y = Math.max(0, Math.round(rect.y - pad));
          const width = Math.round(rect.w + pad * 2), height = Math.round(rect.h + pad * 2);
          const img = await wc.capturePage({ x, y, width, height });
          const file = path.join(app.getPath('temp'), name);
          fs.writeFileSync(file, img.toPNG());
          const size = img.getSize();
          shots.push({ name, file, crop: { x, y, width, height }, img: size, pet: petRect || null, pad });
          return size;
        };
        const parseMatrix = (t) => {
          const m = /matrix\(([^)]+)\)/.exec(t || '');
          if (!m) return null;
          const v = m[1].split(',').map((s) => parseFloat(s));
          return { a: v[0], b: v[1], c: v[2], d: v[3], e: v[4], f: v[5] };
        };
        try {
          await ev('new Promise(r=>{ if(window.__petInitOK) r(true); else addEventListener("load",()=>setTimeout(()=>r(!!window.__petInitOK),500)); })');
          await ev('petAPI.closeMenu()');
          await sleep(250);

          // ---- A）桌宠贴左边缘 → 左边放不下 → 菜单应翻到右侧、动画应镜像 ----
          await ev('petAPI.setPos(6, 300); petAPI.openMenu(); true');
          await sleep(800);
          const petA = await rectOf('#pet'), menuA = await rectOf('#sao');
          const msA = await ev('petAPI.__mirrorState()');
          chk('A 菜单在桌宠右侧', menuA.x >= petA.right - 1, { menuLeft: Math.round(menuA.x), petRight: Math.round(petA.right) });
          chk('A 动画已镜像', msA.on === true && msA.cls === true, { on: msA.on, cls: msA.cls });
          const mxA = parseMatrix(msA.video && msA.video.computed);
          const originXA = parseFloat((msA.video && msA.video.computedOrigin) || '0');
          const W = msA.video ? msA.video.rect.w : 0;
          chk('A 镜像矩阵：x 轴翻转、绕站姿中轴、无额外平移',
              !!mxA && mxA.a < 0 && Math.abs(mxA.e) <= 0.5 && Math.abs(originXA - msA.axis * W) <= 1.5,
              { a: mxA && mxA.a, e: mxA && mxA.e, originX: originXA, expectOriginX: msA.axis * W, videoW: W,
                petW: msA.petRect && msA.petRect.w, cssW: msA.video && msA.video.cssW, optSize: msA.optSize });
          chk('A 抬手指向右', msA.tip.xNorm > 0.5 && msA.tip.dir === 1, { tipXNorm: +msA.tip.xNorm.toFixed(4), dir: msA.tip.dir });

          // ---- C）命中测试一致性：镜像后 hitTest(px) 必须等于"未镜像画面在 2a-px 处的 alpha" ----
          const hitRes = await ev(`(()=>{
            const N = 26, bad = [], sampled = [];
            let solid = 0, holes = 0;
            for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
              const px = (i + 0.5) / N, py = (j + 0.5) / N;
              const raw = petAPI.__rawAlpha(2 * ${msA.axis} - px, py);
              const raw2 = petAPI.__rawAlpha(px, py);
              if (raw === null) continue;
              const expect = raw > 24, got = petAPI.__hit(px, py);
              if (expect !== got) bad.push({ px: +px.toFixed(3), py: +py.toFixed(3), expect, got });
              if (expect) solid++; else holes++;
              sampled.push(raw2 > 24 ? 1 : 0);
            }
            return { bad, solid, holes, total: sampled.length };
          })()`);
          chk('C 命中与镜像画面一致（像素级）', hitRes.bad.length === 0,
              { mismatches: hitRes.bad.slice(0, 6), count: hitRes.bad.length });
          chk('C 对照样本既含实心也含透明（不是空图假通过）', hitRes.solid > 20 && hitRes.holes > 20,
              { solid: hitRes.solid, holes: hitRes.holes, total: hitRes.total });

          // ---- E）像素级：同一冻结帧，开/关镜像两次截图（交给外部脚本比对翻面等价性）----
          await ev('petAPI.__freezeFrame(1.0)');
          await sleep(400);
          await crop('mirror-on.png', petA, 8, petA);
          await ev('petAPI.__forceMirror(false)');
          await sleep(300);
          await crop('mirror-off.png', petA, 8, petA);
          await ev('petAPI.__forceMirror(true)');
          await sleep(300);
          await crop('mirror-on2.png', petA, 8, petA);          // 复现性：与第一张应几乎一致
          await crop('mirror-off-shift.png', { x: petA.x + 40, y: petA.y, w: petA.w, h: petA.h }, 8, petA);   // 负例对照
          chk('E 已产出比对图（on / off / on2 / 负例）', shots.length >= 4, { files: shots.map((s) => s.name) });

          // ---- B）桌宠贴右边缘 → 菜单翻到左侧、动画不镜像 ----
          await ev('petAPI.closeMenu()'); await sleep(250);
          await ev(`petAPI.setPos(innerWidth - document.getElementById('pet').getBoundingClientRect().width - 6, 300); petAPI.openMenu(); true`);
          await sleep(800);
          const petB = await rectOf('#pet'), menuB = await rectOf('#sao');
          const msB = await ev('petAPI.__mirrorState()');
          chk('B 菜单在桌宠左侧', menuB.right <= petB.x + 1, { menuRight: Math.round(menuB.right), petLeft: Math.round(petB.x) });
          chk('B 动画未镜像', msB.on === false && msB.cls === false, { on: msB.on, cls: msB.cls });
          const mxB = parseMatrix(msB.video && msB.video.computed);
          chk('B 变换回到未镜像（x 轴正）', !!mxB && mxB.a > 0, { a: mxB && mxB.a });
          chk('B 抬手指向左', msB.tip.xNorm < 0.5 && msB.tip.dir === -1, { tipXNorm: +msB.tip.xNorm.toFixed(4), dir: msB.tip.dir });

          // ---- D）关菜单后镜像复位 ----
          await ev('petAPI.closeMenu()'); await sleep(400);
          const msD = await ev('petAPI.__mirrorState()');
          const mxD = parseMatrix(msD.video && msD.video.computed);
          chk('D 关菜单后镜像复位', msD.on === false && msD.cls === false && !!mxD && mxD.a > 0,
              { on: msD.on, cls: msD.cls, a: mxD && mxD.a });

          const failed = checks.filter((c) => !c.ok);
          console.log('MIRRORTEST ' + JSON.stringify({
            ok: failed.length === 0, passed: checks.length - failed.length, total: checks.length,
            checks, shots, axis: msA.axis, verdict: failed.length ? 'FAIL' : 'PASS',
          }));
        } catch (e) {
          console.log('MIRRORTEST ' + JSON.stringify({ ok: false, error: (e && e.message) || String(e) }));
        }
        if (process.argv.includes('--exit-after-test')) { quitting = true; app.quit(); }
      }, 1200);
    }
    // --chattest=<消息>：命令行跑一次 harness 聊天（后端自检）
    const chatTest = (process.argv.find((a) => a.startsWith('--chattest=')) || '').split('=')[1];
    if (chatTest !== undefined) {
      setTimeout(async () => {
        const h = ensureHarness();
        const seen = { text: '', tools: [], err: '', reason: null };
        let done = null;
        const waitTurn = new Promise((res2) => { done = res2; });
        h.onEvent = ((orig) => (evt) => {
          try {
            if (evt.kind === 'delta') seen.text += evt.text || '';
            else if (evt.kind === 'message' && evt.text) seen.text = evt.text;
            else if (evt.kind === 'toolCall') seen.tools.push(evt.name + ' ' + String(evt.args || '').slice(0, 80));
            else if (evt.kind === 'turnEnd') { seen.reason = evt.reason; if (done) done(); }
          } catch (e) {}
          return orig(evt);
        })(h.onEvent);
        const t0 = Date.now();
        const r = await h.prompt(chatTest).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: e.message }));
        await Promise.race([waitTurn, new Promise((res2) => setTimeout(res2, 240000))]);
        const r2 = Object.assign({}, r, { text: seen.text, tools: seen.tools,
          err: (seen.reason && seen.reason.kind === 'error') ? ((seen.reason.error && seen.reason.error.message) || 'error') : '',
          reason: seen.reason && seen.reason.kind, sessionId: h.sessionId, ms: Date.now() - t0 });
        console.log('CHATTEST ' + JSON.stringify(r2));
        if (process.argv.includes('--exit-after-test')) { quitting = true; app.quit(); }
      }, 800);
    }
    // --settest：设置是否真的通到 harness（故意用错误网址，看请求是否打到它）
    if (process.argv.includes('--settest')) {
      setTimeout(async () => {
        const show = (r) => (r && r.ok) ? ('OK 回复="' + String(r.text || '').slice(0, 30) + '"') : ('FAIL ' + ((r && r.error) || ''));
        // A：填错误网址 + 占位 key → 必须失败，且错误里出现该网址（证明环境变量注入生效）
        saveCfg({ apiKey: 'SELFTEST-NOT-A-REAL-KEY', deepseek: { baseUrl: 'https://selftest.invalid' } });
        if (harness) { harness.kill(); harness = null; }
        const a = await ipcMain._invokeHandlers ? null : null;
        const ra = await (async () => { try { const h = ensureHarness(); let done = null;
          const waitTurn = new Promise((r2) => { done = r2; }); const seen = { t: '', e: '' };
          h.onEvent = ((o) => (ev) => { try { if (ev.kind === 'delta') seen.t += ev.text || '';
            else if (ev.kind === 'turnEnd') { if (ev.reason && ev.reason.kind === 'error') seen.e = (ev.reason.error && ev.reason.error.message) || 'error'; if (done) done(); } } catch (e) {} return o(ev); })(h.onEvent);
          await h.prompt('只回答两个字：正常');
          await Promise.race([waitTurn, new Promise((r2) => setTimeout(r2, 60000))]);
          return { ok: !seen.e, text: seen.t, error: seen.e };
        } catch (e) { return { ok: false, error: e.message }; } })();
        console.log('SETTEST_A ' + JSON.stringify(ra));
        // B：清掉假 key、网址回默认 → 必须成功（证明清除生效、且不干扰用户自有凭据）
        saveCfg({ apiKey: '', deepseek: { baseUrl: 'https://api.deepseek.com' } });
        if (harness) { harness.kill(); harness = null; }
        const rb = await (async () => { try { const h = ensureHarness(); let done = null;
          const waitTurn = new Promise((r2) => { done = r2; }); const seen = { t: '', e: '' };
          h.onEvent = ((o) => (ev) => { try { if (ev.kind === 'delta') seen.t += ev.text || '';
            else if (ev.kind === 'turnEnd') { if (ev.reason && ev.reason.kind === 'error') seen.e = (ev.reason.error && ev.reason.error.message) || 'error'; if (done) done(); } } catch (e) {} return o(ev); })(h.onEvent);
          await h.prompt('只回答两个字：正常');
          await Promise.race([waitTurn, new Promise((r2) => setTimeout(r2, 60000))]);
          return { ok: !seen.e, text: seen.t, error: seen.e };
        } catch (e) { return { ok: false, error: e.message }; } })();
        console.log('SETTEST_B ' + JSON.stringify(rb));
        console.log('SETTEST_CFG ' + JSON.stringify(loadCfg().deepseek));
        if (process.argv.includes('--exit-after-test')) setTimeout(() => { quitting = true; app.quit(); }, 500);
      }, 2500);
    }

    // --shot=chat,search,settings,panel,menu：打开指定面板并截图（皮肤视觉自查用）
    const shotArg = (process.argv.find((a) => a.startsWith('--shot=')) || '').split('=')[1];
    if (shotArg) {
      setTimeout(async () => {
        try {
          const want = String(shotArg).split(',').map((x) => x.trim()).filter(Boolean);
          await win.webContents.executeJavaScript(`(() => {
            ${want.includes('panel') ? 'petAPI.togglePanel();' : ''}
            ${want.includes('menu') ? 'petAPI.openMenu();' : ''}
            ${want.includes('chat') ? 'petAPI.openChat();' : ''}
            ${want.includes('search') ? 'petAPI.openSearch();' : ''}
            ${want.includes('settings') ? 'petAPI.openSettings();' : ''}
            return true;
          })()`);
          await new Promise((r) => setTimeout(r, want.includes('chat') || want.includes('settings') ? 1400 : (want.includes('menu') ? 7000 : 700)));
          const png = await win.webContents.capturePage();
          const dir = path.join(__dirname, 'diag');
          require('fs').mkdirSync(dir, { recursive: true });
          const out = path.join(dir, 'shot-' + want.join('_') + '.png');
          require('fs').writeFileSync(out, png.toPNG());
          console.log('SHOT ' + out + ' ' + JSON.stringify(png.getSize()));
          // 顺手报出可见面板/角色的实际位置，便于精确裁剪验收
          const rects = await win.webContents.executeJavaScript(
            "Object.fromEntries(['panel','menu','search','chat','settings','pet','sao','saoCard','saoCats','saoList','saoSub'].map((id)=>{const e=document.getElementById(id);if(!e)return null;const s=getComputedStyle(e);if(s.display==='none'||e.classList.contains('hidden'))return null;const r=e.getBoundingClientRect();return [id,[r.left|0,r.top|0,r.right|0,r.bottom|0]];}).filter(Boolean))");
          console.log('SHOT_RECTS ' + JSON.stringify(rects));
        } catch (e) { console.log('SHOT_ERR ' + e.message); }
        if (process.argv.includes('--exit-after-test')) setTimeout(() => { quitting = true; app.quit(); }, 600);
      }, 2500);
    }

    // --eattest：新空闲动作"吃米饭"专项自检（状态存在 / 真的 2x / 播完回待机 / 菜单入口在）
    if (process.argv.includes('--eattest')) {
      setTimeout(async () => {
        try {
          const r = await win.webContents.executeJavaScript(`(async () => {
            const wait = (ms)=> new Promise(r=> setTimeout(r, ms));
            const st = states.eat || null;
            const before = cur;
            petAPI.react('eat');                       // 与空闲阶梯同一条一次性动作路径
            await wait(300);
            const vid = [...document.querySelectorAll('#pet video')].find((v)=> v.classList.contains('active'));
            const during = { cur, rate: vid ? vid.playbackRate : null,
                             src: vid ? vid.currentSrc.split('/').pop() : null,
                             duration: st ? st.duration : null, mode: st ? st.mode : null, role: st ? st.role : null };
            await wait(Math.round(((st ? st.duration : 4) * 1000) / (st && st.rate ? st.rate : 1)) + 900);
            const after = cur;
            petAPI.openMenu(); petAPI.saoSelectCat('interact'); await wait(400);
            const rows = [...document.querySelectorAll('#saoSub .row')].map((b)=> b.textContent.trim());
            petAPI.closeMenu();
            const idleActs = Object.keys(states).filter((id)=> states[id] && states[id].role === 'idle_act');
            return { hasEat: !!st, before, during, after, menuRows: rows, idleActs };
          })()`);
          console.log('EATTEST ' + JSON.stringify(r));
        } catch (e) { console.log('EATTEST_ERR ' + e.message); }
        if (process.argv.includes('--exit-after-test')) setTimeout(() => { quitting = true; app.quit(); }, 600);
      }, 2500);
    }

    // --menutest：开 SAO 菜单 → 等实时数据到位 → 打印四角标注与几何（自检）
    if (process.argv.includes('--menutest')) {
      setTimeout(async () => {
        try {
          await win.webContents.executeJavaScript('petAPI.openMenu()');
          await new Promise((r) => setTimeout(r, 6500));
          const r = await win.webContents.executeJavaScript(`(() => {
            const m = petAPI.saoMetrics();
            const box = (id) => { const e = document.getElementById(id); if (!e) return null;
              const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
            const pet = document.getElementById('pet').getBoundingClientRect();
            return { open: SAO.open, cat: SAO.cat, mirror: SAO.mirror,
                     marks: m.marks, metrics: m.metrics,
                     rects: { sao: box('sao'), card: box('saoCard'), cats: box('saoCats'), list: box('saoList'), sub: box('saoSub'),
                              pet: [Math.round(pet.left), Math.round(pet.top), Math.round(pet.width), Math.round(pet.height)] },
                     rows: [...document.querySelectorAll('#saoList .row')].map((b)=> b.textContent.trim() + (b.classList.contains('on')?' ★':'')),
                     subRows: [...document.querySelectorAll('#saoSub .row')].map((b)=> b.textContent.trim()) };
          })()`);
          console.log('MENUTEST ' + JSON.stringify(r));
        } catch (e) { console.log('MENUTEST_ERR ' + e.message); }
        if (process.argv.includes('--exit-after-test')) setTimeout(() => { quitting = true; app.quit(); }, 800);
      }, 2500);
    }

    // --setuitest：在真渲染器里打开设置面板，读回字段与几何（UI 自检）
    if (process.argv.includes('--setuitest')) {
      setTimeout(async () => {
        try {
          const r = await win.webContents.executeJavaScript(`(async () => {
            petAPI.openSettings();
            await new Promise((r2) => setTimeout(r2, 900));
            const el = document.getElementById('settings').getBoundingClientRect();
            const pet = document.getElementById('pet').getBoundingClientRect();
            const g = (id) => document.getElementById(id) ? document.getElementById(id).value : null;
            const t = (id) => document.getElementById(id) ? document.getElementById(id).textContent : null;
            return { visible: document.getElementById('settings').classList.contains('show'),
                     open: SET.open, state: (typeof cur !== 'undefined') ? cur : null,
                     fields: { base: g('setBase'), model: g('setModel'), repo: g('setRepo'), keyType: document.getElementById('setKey').type },
                     hints: { key: t('setKeyHint'), repo: t('setRepoHint'), everything: t('setEverything'), status: t('setStatus') },
                     geom: { panel: [el.left|0, el.top|0, el.right|0, el.bottom|0], pet: [pet.left|0, pet.top|0, pet.right|0, pet.bottom|0],
                             intersects: !(el.right <= pet.left || el.left >= pet.right || el.bottom <= pet.top || el.top >= pet.bottom),
                             side: el.right <= pet.left ? 'left' : (el.left >= pet.right ? 'right' : 'overlap') } };
          })()`);
          console.log('SETUITEST ' + JSON.stringify(r));
        } catch (e) { console.log('SETUITEST_ERR ' + e.message); }
        if (process.argv.includes('--exit-after-test')) setTimeout(() => { quitting = true; app.quit(); }, 400);
      }, 2500);
    }

    // --clicktest=<blank|pet|panel>：点击穿透回归（用户实测过"开面板后同屏窗口全点不动"）
    //   开聊天面板 → 把合成鼠标移到指定位置 → 打印该点的命中结果，然后保持运行，
    //   外部再用 GetWindowLongPtr(WS_EX_TRANSPARENT) 独立复核窗口到底吞不吞鼠标。
    const clickTest = (process.argv.find((a) => a.startsWith('--clicktest=')) || '').split('=')[1];
    if (clickTest) {
      setTimeout(async () => {
        const js = `(() => {
          petAPI.openChat();
          return new Promise((res) => setTimeout(() => {
            const pet  = document.getElementById('pet').getBoundingClientRect();
            const panel= document.getElementById('chat').getBoundingClientRect();
            const at = (${JSON.stringify((process.argv.find((a) => a.startsWith('--clickat=')) || '').split('=')[1] || '')});
            const map = {
              blank: { x: 40, y: 40 },
              pet:   { x: pet.left + pet.width / 2, y: pet.top + pet.height * 0.55 },
              panel: { x: panel.left + panel.width / 2, y: panel.top + 30 },
              custom: (() => { const p = String(at).split(','); return { x: parseFloat(p[0]), y: parseFloat(p[1]) }; })()
            };
            const pt = map['${clickTest}'] || map.blank;
            window.dispatchEvent(new MouseEvent('mousemove', { clientX: pt.x, clientY: pt.y, bubbles: true }));
            setTimeout(() => {
              res({ where: '${clickTest}', point: pt, pet: [pet.left|0, pet.top|0, pet.right|0, pet.bottom|0],
                    hit: uiHitAt(pt.x, pt.y), inter: hostBridge && hostBridge.lastInter ? hostBridge.lastInter() : null,
                    chatOpen: C.open, visible: document.visibilityState });
            }, 500);
          }, 500));
        })()`;
        try {
          const r = await win.webContents.executeJavaScript(js);
          console.log('CLICKTEST ' + JSON.stringify(r));
          // 之后每秒汇报一次"页面认为的交互态"，供外部用真光标移动来验收
          setInterval(async () => {
            try {
              const s = await win.webContents.executeJavaScript(
                "({ inter: (hostBridge && hostBridge.lastInter) ? hostBridge.lastInter() : null, pos: (hostBridge && hostBridge.lastPos) ? hostBridge.lastPos() : null, chatOpen: (typeof C!=='undefined') ? C.open : null })");
              console.log('HITSTATE ' + JSON.stringify(s));
            } catch (e) {}
          }, 1000);
        } catch (e) { console.log('CLICKTEST_ERR ' + e.message); }
      }, 2500);
    }

    // --chatui=<消息>：在真实渲染器里走完整聊天链路（开面板→输入→发送→等真回复）
    const chatUi = (process.argv.find((a) => a.startsWith('--chatui=')) || '').split('=')[1];
    if (chatUi !== undefined) {
      const waitMs = parseInt((process.argv.find((a) => a.startsWith('--chatwait=')) || '=45000').split('=')[1], 10) || 45000;
      setTimeout(async () => {
        try {
          const out = await win.webContents.executeJavaScript(`(async ()=>{
            const log = [];
            petAPI.openChat();
            const inp = document.getElementById('cinput');
            inp.value = ${JSON.stringify(chatUi)};
            inp.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true }));
            const t0 = performance.now();
            const wait = (ms)=> new Promise(r=> setTimeout(r, ms));
            const cancelAfter = ${parseInt((process.argv.find((a) => a.startsWith('--chatcancel=')) || '=0').split('=')[1], 10) || 0};
            if (cancelAfter) { await wait(cancelAfter); document.getElementById('cCancel').click(); }
            while (performance.now() - t0 < ${waitMs}) {
              const st = petAPI.chatState();
              if (!st.busy && st.msgs > 0) break;
              await wait(500);
            }
            const rows = [...document.querySelectorAll('#cmsg .cline, #cmsg .thinking')].map((el)=>({
              cls: el.className, text: el.textContent.slice(0, 220) }));
            const pr = document.getElementById('chat').getBoundingClientRect();
            const rr = document.getElementById('pet').getBoundingClientRect();
            return JSON.stringify({
              visible: document.getElementById('chat').classList.contains('show'),
              state: petAPI.getMode(),
              elapsedMs: Math.round(performance.now() - t0),
              rows,
              geom: { intersects: !(pr.right <= rr.left || pr.left >= rr.right || pr.bottom <= rr.top || pr.top >= rr.bottom),
                      side: pr.right <= rr.left ? 'left' : (pr.left >= rr.right ? 'right' : 'x-overlap'),
                      panel: [Math.round(pr.left),Math.round(pr.top),Math.round(pr.right),Math.round(pr.bottom)],
                      pet: [Math.round(rr.left),Math.round(rr.top),Math.round(rr.right),Math.round(rr.bottom)] }
            });
          })()`);
          console.log('CHATUI ' + out);
        } catch (e) { console.log('CHATUI_ERROR ' + e.message); }
        if (process.argv.includes('--exit-after-test')) { quitting = true; app.quit(); }
      }, 2500);
    }
    // --searchui=<query>：在真实渲染器里打开搜索面板并灌入查询，读回渲染结果（UI 自检）
    const uiQ = (process.argv.find((a) => a.startsWith('--searchui=')) || '').split('=')[1];
    if (uiQ !== undefined) {
      setTimeout(async () => {
        try {
          const out = await win.webContents.executeJavaScript(`(async ()=>{
            const rectOf = ()=>{ const r = document.getElementById('pet').getBoundingClientRect();
              return [Math.round(r.left),Math.round(r.top),Math.round(r.right),Math.round(r.bottom)]; };
            const trace = { t0_pet: rectOf(), t0_panel: (()=>{const q=document.getElementById('search').getBoundingClientRect(); return [Math.round(q.left),Math.round(q.top)];})() };
            petAPI.openSearch();
            const inp = document.getElementById('sinput');
            inp.value = ${JSON.stringify(uiQ)};
            inp.dispatchEvent(new Event('input', { bubbles:true }));
            await new Promise((r)=> setTimeout(r, 1600));
            trace.t1600_pet = rectOf();
            trace.t1600_panel = (()=>{const q=document.getElementById('search').getBoundingClientRect(); return [Math.round(q.left),Math.round(q.top)];})();
            trace.style = {left: document.getElementById('search').style.left, top: document.getElementById('search').style.top};
            const pr = document.getElementById('search').getBoundingClientRect();
            const rr = document.getElementById('pet').getBoundingClientRect();
            const intersects = !(pr.right <= rr.left || pr.left >= rr.right || pr.bottom <= rr.top || pr.top >= rr.bottom);
            return JSON.stringify({
              panelOpen: document.getElementById('search').classList.contains('show'),
              state: petAPI.getMode(),
              trace,
              geom: {
                panel: [Math.round(pr.left), Math.round(pr.top), Math.round(pr.right), Math.round(pr.bottom)],
                pet: [Math.round(rr.left), Math.round(rr.top), Math.round(rr.right), Math.round(rr.bottom)],
                side: pr.right <= rr.left ? 'left' : (pr.left >= rr.right ? 'right' : 'x-overlap'),
                gaps: { leftOfPet: Math.round(rr.left - pr.right), abovePet: Math.round(rr.top - pr.bottom) },
                intersects: intersects
              },
              rows: petAPI.searchRows().slice(0, 6),
              rowCount: petAPI.searchRows().length,
              highlighted: document.querySelector('#slist .srow.sel') ? document.querySelector('#slist .srow.sel .sname').textContent : null,
              countText: document.getElementById('scount').textContent,
              msg: document.querySelector('#slist .smsg') ? document.querySelector('#slist .smsg').textContent.slice(0,160) : null
            });
          })()`);
          console.log('SEARCHUI ' + out);
          // 顺便把面板渲染结果（带 alpha）落盘，供目视检查排版
          try {
            const img = await win.webContents.capturePage();
            fs.mkdirSync(path.join(__dirname, 'diag'), { recursive: true });
            fs.writeFileSync(path.join(__dirname, 'diag', 'search-ui.png'), img.toPNG());
            console.log('SEARCHUI_CAPTURE ' + path.join(__dirname, 'diag', 'search-ui.png'));
          } catch (e) { console.log('SEARCHUI_CAPTURE_ERROR ' + e.message); }
        } catch (e) { console.log('SEARCHUI_ERROR ' + e.message); }
        if (process.argv.includes('--exit-after-test')) { quitting = true; app.quit(); }
      }, 2500);
    }
  });
  app.on('window-all-closed', () => { if (quitting || process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => { quitting = true; try { sysinfo.dispose(); } catch (e) {} if (harness) { try { harness.shutdown(); } catch (e) {} harness = null; } });
  app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) {} });
}
