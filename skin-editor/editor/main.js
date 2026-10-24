// 猫鲸皮肤编辑器 —— 主进程
// 职责：皮肤包读写（%APPDATA%\桌宠\skins）、视频导入转码（ffmpeg → VP9 alpha webm）、启动桌宠。
// 完全独立于桌宠主程序：只通过文件系统与它交换数据（skin.json + active.json + videos/*.webm）。
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
let win = null;

/* ---------------- 路径与配置 ---------------- */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');   // 预览视频要能自动播

const SHOT_ARG = (process.argv.find((a) => a.startsWith('--shot=')) || '').split('=').slice(1).join('=');
if (SHOT_ARG) {
  try { app.setPath('userData', path.join(app.getPath('temp'), 'catwhale-skin-editor-shot')); } catch (e) {}
}
const CONFIG_FILE = path.join(app.getPath('userData'), 'editor-config.json');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}
function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/** 桌宠的 userData：%APPDATA%\桌宠（productName），旧版/英文环境下是 pet-girl */
function detectPetUserData() {
  const base = process.env.APPDATA || path.join(app.getPath('home'), 'AppData', 'Roaming');
  for (const name of ['桌宠', 'pet-girl', 'pet']) {
    const p = path.join(base, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(base, '桌宠');
}

/** 桌宠工程根目录（含素材与 app/），只用于「内置皮肤」只读基线 */
function detectProjectRoot() {
  const cands = [
    path.resolve(__dirname, '..', '..'),            // 仓库布局：<仓库>/skin-editor/editor/ → 仓库根
    path.resolve(app.getAppPath(), '..'),           // 打包后在 resources/app 下
    'H:\\hermes project\\桌宠',
    path.join(app.getPath('home'), 'hermes project', '桌宠'),
  ];
  for (const c of cands) if (fs.existsSync(path.join(c, 'app', 'renderer', 'assets', 'states.json'))) return c;
  return cands[0];
}

function cfg() {
  const c = readJson(CONFIG_FILE, {});
  return {
    petUserData: c.petUserData || detectPetUserData(),
    projectRoot: c.projectRoot || detectProjectRoot(),
  };
}
function skinRoot() { return path.join(cfg().petUserData, 'skins'); }
function activeSlug() {
  const j = readJson(path.join(skinRoot(), 'active.json'), null);
  return (j && typeof j.slug === 'string') ? j.slug : null;
}

/* ---------------- 工具 ---------------- */
function which(exe) {
  const r = spawnSync(IS_WIN ? 'where' : 'which', [exe], { encoding: 'utf8', windowsHide: true });
  if (r && r.status === 0) return (r.stdout || '').split(/\r?\n/)[0].trim();
  return '';
}

function probeVideo(file) {
  const ffprobe = which('ffprobe') || 'ffprobe';
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 8 << 20 });
  if (!r || r.status !== 0) return { ok: false, error: (r && r.stderr || 'ffprobe 调用失败').slice(-500) };
  let j;
  try { j = JSON.parse(r.stdout); } catch (e) { return { ok: false, error: 'ffprobe 输出无法解析' }; }
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  if (!v) return { ok: false, error: '没有视频流' };
  const tag = (v.tags && v.tags.alpha_mode) || '';
  const hasAlpha = /a$/.test(v.pix_fmt || '') || tag === '1';
  const fps = v.avg_frame_rate && v.avg_frame_rate !== '0/0'
    ? evalFrac(v.avg_frame_rate) : (v.r_frame_rate ? evalFrac(v.r_frame_rate) : 0);
  return {
    ok: true,
    width: v.width, height: v.height,
    pixFmt: v.pix_fmt, hasAlpha, alphaMode: tag,
    duration: Number(j.format && j.format.duration) || Number(v.duration) || 0,
    fps: Math.round(fps * 100) / 100,
    codec: v.codec_name,
    hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio'),
    bytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
    file,
  };
}
function evalFrac(f) { const [a, b] = String(f).split('/').map(Number); return b ? a / b : a || 0; }

/** ffmpeg 转码：绿幕/纯色抠像（可选）+ 缩放 + VP9 alpha WebM */
function encodeWebm(opts) {
  return new Promise((resolve) => {
    const ffmpeg = which('ffmpeg') || 'ffmpeg';
    const args = ['-y', '-v', 'error', '-i', opts.src];
    const vf = [];
    // 抠像：源本身没 alpha 时必须给 keyColor（编辑器默认取左上角像素）
    if (opts.keyColor && !opts.sourceHasAlpha) {
      const color = '0x' + String(opts.keyColor).replace(/^#/, '').toUpperCase();   // 前缀必须小写 0x，ffmpeg 不认 0X
      const sim = Number(opts.similarity ?? 0.14).toFixed(3);
      const blend = Number(opts.blend ?? 0.06).toFixed(3);
      vf.push(`colorkey=${color}:${sim}:${blend}`);
      vf.push('despill=type=green');
      vf.push('format=yuva420p');
    }
    if (opts.width) vf.push(`scale=${Math.round(opts.width / 2) * 2}:-2:flags=lanczos`);
    if (vf.length) args.push('-vf', vf.join(','));
    const fps = Number(opts.fps || 24);
    args.push('-r', String(fps));
    if (opts.sourceHasAlpha) args.push('-pix_fmt', 'yuva420p');   // 已带 alpha：只转码
    args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(opts.crf || 30),
      '-row-mt', '1', '-cpu-used', '2', '-auto-alt-ref', '0', '-an', opts.dst);
    const t0 = Date.now();
    const p = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => resolve({ ok: false, error: 'ffmpeg 启动失败：' + e.message }));
    p.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, error: 'ffmpeg 失败(' + code + ')：' + err.slice(-800) });
      const info = probeVideo(opts.dst);
      resolve(Object.assign({ ok: true, ms: Date.now() - t0 }, info));
    });
  });
}

/* ---------------- 内容包围盒（量身高用）----------------
   直接解 VP9 alpha：ffmpeg 一次抽 5 帧 96px 宽的 rgba 原始帧，取每帧 alpha>32 的最上/最下/最左/最右。
   返回的是**相对视频画面**的比例（0~1），渲染端再换算成画布百分比。
   为什么不用 PIL：只为了量 bbox 引入 Pillow 不值得，rawvideo 直接解析更快。 */
function videoAlphaBox(file, want = 5) {
  return new Promise((resolve) => {
    const pr = probeVideo(file);
    if (!pr.ok) return resolve({ ok: false, error: pr.error });
    if (!pr.width || !pr.height) return resolve({ ok: false, error: '拿不到视频尺寸' });
    const W = 96, H = Math.max(2, Math.round((W * pr.height) / pr.width));
    const dur = Math.max(0.3, pr.duration || 1);
    const fps = Math.max(0.2, want / dur);
    // VP9 的透明通道是 side data：必须用 libvpx 解码器，ffmpeg 原生的 vp9 解码器不输出 alpha
    const dec = pr.codec === 'vp9' ? ['-c:v', 'libvpx-vp9'] : [];
    const args = ['-v', 'error', ...dec, '-i', file, '-vf', `fps=${fps.toFixed(4)},scale=${W}:${H}`,
      '-frames:v', String(want), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'];
    const p = spawn(which('ffmpeg') || 'ffmpeg', args, { windowsHide: true });
    const bufs = [];
    let done = false;
    p.stdout.on('data', (d) => bufs.push(d));
    p.on('error', (e) => { if (!done) { done = true; resolve({ ok: false, error: 'ffmpeg 启动失败：' + e.message }); } });
    p.on('close', () => {
      if (done) return;
      done = true;
      const buf = Buffer.concat(bufs);
      const frameBytes = W * H * 4;
      const n = Math.floor(buf.length / frameBytes);
      if (!n) return resolve({ ok: false, error: '没抽到帧' });
      const rows = [];
      for (let f = 0; f < n; f++) {
        const base = f * frameBytes;
        let top = -1, bot = -1, left = W, right = -1;
        for (let y = 0; y < H; y++) {
          const rowOff = base + y * W * 4;
          for (let x = 0; x < W; x++) {
            if (buf[rowOff + x * 4 + 3] > 32) {
              if (top < 0) top = y;
              bot = y;
              if (x < left) left = x;
              if (x > right) right = x;
            }
          }
        }
        if (top >= 0) rows.push({ top: top / H, bottom: (bot + 1) / H, left: left / W, right: (right + 1) / W });
      }
      if (!rows.length) return resolve({ ok: false, error: '所有帧都是全透明' });
      const med = (k) => { const a = rows.map((r) => r[k]).sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
      resolve({
        ok: true, frames: rows.length,
        top: med('top'), bottom: med('bottom'), left: med('left'), right: med('right'),
        vw: pr.width, vh: pr.height, duration: pr.duration, file,
      });
    });
  });
}

/* ---------------- 皮肤读写 ---------------- */
function listSkins() {
  const root = skinRoot();
  const out = [];
  if (fs.existsSync(root)) {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const j = readJson(path.join(root, e.name, 'skin.json'), null);
      if (!j) continue;
      out.push({
        slug: e.name, name: j.name || e.name,
        count: Object.keys(j.actions || {}).length,
        updated: j.updated || '',
      });
    }
  }
  const act = activeSlug();
  out.sort((a, b) => (a.slug === act ? -1 : b.slug === act ? 1 : a.name.localeCompare(b.name, 'zh')));
  return { ok: true, skins: out, active: act, root };
}

/** 内置皮肤：只读基线，来自桌宠工程里的 states.json + video 目录 */
function readBuiltin() {
  const root = cfg().projectRoot;
  const base = path.join(root, 'app', 'renderer', 'assets');
  const st = readJson(path.join(base, 'states.json'), null);
  if (!st) return { ok: false, error: '找不到内置素材清单：' + path.join(base, 'states.json') };
  const actions = {};
  for (const id in st) {
    const a = st[id];
    const abs = path.join(base, 'video', a.file || '');
    actions[id] = Object.assign({}, a, { file: a.file, absFile: abs, exists: fs.existsSync(abs) });
  }
  return { ok: true, actions, projectRoot: root };
}

function readSkin(slug) {
  const dir = path.join(skinRoot(), slug);
  const j = readJson(path.join(dir, 'skin.json'), null);
  if (!j) return { ok: false, error: '皮肤不存在：' + dir };
  // 补齐：文件是否真的存在（编辑器里标红）
  const actions = {};
  for (const id in (j.actions || {})) {
    const a = j.actions[id];
    const abs = path.join(dir, a.file || '');
    actions[id] = Object.assign({}, a, { absFile: abs, exists: fs.existsSync(abs) });
    if (!a.duration && fs.existsSync(abs)) {
      const pr = probeVideo(abs);
      if (pr.ok) actions[id].duration = Math.round(pr.duration * 1000) / 1000;
    }
  }
  return { ok: true, slug, name: j.name || slug, actions, dir, updated: j.updated || '' };
}

function saveSkin(slug, skin) {
  if (!/^[A-Za-z0-9_.-]{1,48}$/.test(slug)) return { ok: false, error: '皮肤 id 只能用字母/数字/下划线/短横线' };
  const dir = path.join(skinRoot(), slug);
  fs.mkdirSync(path.join(dir, 'videos'), { recursive: true });
  const actions = {};
  for (const id in (skin.actions || {})) {
    const a = skin.actions[id] || {};
    if (!a.file) continue;
    const clean = { id, name: a.name || id, file: String(a.file).replace(/\\/g, '/'),
      mode: a.mode === 'once' ? 'once' : 'loop', role: a.role || 'lounge',
      scale: num(a.scale, 1), scaleX: num(a.scaleX, 1), scaleY: num(a.scaleY, 1),
      offX: num(a.offX, 0), offY: num(a.offY, 0), rate: num(a.rate, 1),
      duration: num(a.duration, 0), width: num(a.width, 0), height: num(a.height, 0) };
    if (num(a.weight, 0) > 0) clean.weight = num(a.weight, 0);
    if (num(a.react, 0) > 0) clean.react = num(a.react, 0);
    if (a.note) clean.note = String(a.note).slice(0, 200);
    actions[id] = clean;
  }
  const out = { format: 1, id: slug, name: skin.name || slug, updated: new Date().toISOString(), actions };
  writeJsonAtomic(path.join(dir, 'skin.json'), out);
  const s = fs.statSync(path.join(dir, 'skin.json'));
  return { ok: true, path: path.join(dir, 'skin.json'), bytes: s.size, mtimeMs: s.mtimeMs, count: Object.keys(actions).length };
}
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : d; }

function setActive(slug) {
  if (!slug) { // 关掉皮肤 → 回内置
    try { fs.unlinkSync(path.join(skinRoot(), 'active.json')); } catch (e) {}
    return { ok: true, active: null };
  }
  writeJsonAtomic(path.join(skinRoot(), 'active.json'), { slug });
  return { ok: true, active: slug };
}

/* ---------------- 启动桌宠 ---------------- */
function petExe() {
  const root = cfg().projectRoot;
  // 便携版优先（用户日常用的就是它），dev 版只作为后备
  const cands = [
    { p: path.join(root, 'dist', '桌宠', '桌宠.exe'), dev: false },
    { p: path.join(root, 'dist', '桌宠.exe'), dev: false },
    { p: path.join(root, 'app', 'node_modules', 'electron', 'dist', 'electron.exe'), dev: true },
  ];
  for (const c of cands) if (fs.existsSync(c.p)) return { exe: c.p, dev: c.dev };
  return null;
}
function launchPet() {
  const pe = petExe();
  if (!pe) return { ok: false, error: '找不到桌宠可执行文件（既没有 app/node_modules/electron，也没有 dist/桌宠.exe）' };
  const appDir = path.join(cfg().projectRoot, 'app');
  const args = pe.dev ? [appDir] : [];
  try {
    const child = spawn(pe.exe, args, { detached: true, stdio: 'ignore', cwd: pe.dev ? appDir : path.dirname(pe.exe) });
    child.unref();
    return { ok: true, exe: pe.exe, pid: child.pid, dev: pe.dev };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
function petRunning() {
  try {
    const script = "$n=Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -in @('桌宠','electron') }; if ($n) { 'RUNNING' } else { 'STOPPED' }";
    const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    return /RUNNING/.test(r.stdout || '');
  } catch (e) { return false; }
}

/* ---------------- IPC ---------------- */
function handle(ch, fn) { ipcMain.handle(ch, async (e, ...a) => { try { return await fn(...a); } catch (err) { return { ok: false, error: String(err && err.message || err) }; } }); }

handle('app:state', () => {
  const c = cfg();
  return {
    ok: true, skinRoot: skinRoot(), petUserData: c.petUserData, projectRoot: c.projectRoot,
    active: activeSlug(), ffmpeg: !!which('ffmpeg'), ffprobe: !!which('ffprobe'),
    pet: petExe(), petRunning: petRunning(),
  };
});
handle('skins:list', () => listSkins());
handle('skins:read', (slug) => readSkin(slug));
handle('skins:save', (slug, skin) => saveSkin(slug, skin));
handle('skins:apply', (slug) => setActive(slug));
handle('skins:delete', (slug) => {
  const dir = path.join(skinRoot(), slug);
  if (!fs.existsSync(dir)) return { ok: false, error: '不存在' };
  fs.rmSync(dir, { recursive: true, force: true });
  if (activeSlug() === slug) setActive(null);
  return { ok: true };
});
handle('builtin:read', () => readBuiltin());

/** 删除皮肤 videos/ 里没被任何动作引用的 .webm */
handle('skins:clean', (slug, keep) => {
  const dir = path.join(skinRoot(), slug, 'videos');
  if (!fs.existsSync(dir)) return { ok: true, removed: [] };
  const keepSet = new Set((keep || []).map((f) => path.basename(String(f))));
  const removed = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/\.webm$/i.test(f)) continue;
    if (keepSet.has(f)) continue;
    try { fs.unlinkSync(path.join(dir, f)); removed.push(f); } catch (e) {}
  }
  return { ok: true, removed };
});

/** 把内置（或任意已有皮肤）里的一个动作视频复制进目标皮肤 */
handle('builtin:import', (payload) => {
  const { slug, id, srcAbs } = payload || {};
  if (!slug || !id || !srcAbs) return { ok: false, error: '参数不全' };
  if (!fs.existsSync(srcAbs)) return { ok: false, error: '源文件不存在：' + srcAbs };
  const dir = path.join(skinRoot(), slug, 'videos');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, id + '.webm');
  fs.copyFileSync(srcAbs, dst);
  const pr = probeVideo(dst);
  if (!pr.ok) return { ok: false, error: '复制后读不出视频：' + pr.error };
  return { ok: true, file: 'videos/' + id + '.webm', absFile: dst, bytes: fs.statSync(dst).size,
    duration: Math.round(pr.duration * 1000) / 1000, width: pr.width, height: pr.height, hasAlpha: pr.hasAlpha };
});

/** 复制整套皮肤（含视频） */
handle('skins:duplicate', (fromSlug, toSlug, name) => {
  if (!/^[A-Za-z0-9_.-]{1,48}$/.test(toSlug || '')) return { ok: false, error: '皮肤 id 只能用字母/数字/下划线/短横线' };
  const from = path.join(skinRoot(), fromSlug), to = path.join(skinRoot(), toSlug);
  const j = readJson(path.join(from, 'skin.json'), null);
  if (!j) return { ok: false, error: '源皮肤不存在' };
  if (fs.existsSync(to)) return { ok: false, error: '目标皮肤已存在' };
  fs.cpSync(from, to, { recursive: true });
  const out = Object.assign({}, j, { id: toSlug, name: name || (j.name + ' 副本'), updated: new Date().toISOString() });
  writeJsonAtomic(path.join(to, 'skin.json'), out);
  return { ok: true, slug: toSlug };
});
handle('video:probe', (file) => probeVideo(file));
handle('video:bbox', (file) => videoAlphaBox(file));
handle('video:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择动作视频', multiSelections: true, properties: ['openFile', 'multiSelections'],
    filters: [{ name: '视频', extensions: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'gif'] }],
  });
  return { ok: !r.canceled, files: r.filePaths || [] };
});
handle('video:import', async (payload) => {
  const { slug, id, src, opts } = payload || {};
  if (!slug || !id || !src) return { ok: false, error: '参数不全' };
  if (!fs.existsSync(src)) return { ok: false, error: '源文件不存在：' + src };
  const dir = path.join(skinRoot(), slug);
  fs.mkdirSync(path.join(dir, 'videos'), { recursive: true });
  const dst = path.join(dir, 'videos', id + '.webm');
  const pr = probeVideo(src);
  if (!pr.ok) return { ok: false, error: '读不了源视频：' + pr.error };
  // 目标宽度：默认按源宽，但上限 900（桌宠画布宽）
  const width = Math.min(Number(opts && opts.width) || pr.width, 1200);
  const r = await encodeWebm({
    src, dst, width,
    fps: (opts && opts.fps) || 24,
    keyColor: (opts && opts.keyColor) || null,
    similarity: opts && opts.similarity, blend: opts && opts.blend,
    sourceHasAlpha: pr.hasAlpha, crf: (opts && opts.crf) || 30,
  });
  if (!r.ok) return r;
  let size = 0;
  try { size = fs.statSync(dst).size; } catch (e) {}
  return { ok: true, file: 'videos/' + id + '.webm', absFile: dst, bytes: size,
    duration: Math.round(r.duration * 1000) / 1000, width: r.width, height: r.height,
    hasAlpha: r.hasAlpha, srcProbe: pr, ms: r.ms };
});
handle('video:corner', (file) => {
  // 取源视频左上角像素颜色作为默认抠像色
  return new Promise((resolve) => {
    const ffmpeg = which('ffmpeg') || 'ffmpeg';
    const pr = spawn(ffmpeg, ['-v', 'error', '-ss', '0.2', '-i', file, '-frames:v', '1',
      '-vf', 'crop=8:8:0:0,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { windowsHide: true });
    const bufs = [];
    pr.stdout.on('data', (d) => bufs.push(d));
    pr.on('error', () => resolve({ ok: false }));
    pr.on('close', (code) => {
      const b = Buffer.concat(bufs);
      if (code !== 0 || b.length < 3) return resolve({ ok: false });
      const hex = '#' + [b[0], b[1], b[2]].map((x) => x.toString(16).padStart(2, '0')).join('');
      resolve({ ok: true, color: hex, rgb: [b[0], b[1], b[2]] });
    });
  });
});
handle('pet:launch', () => launchPet());
handle('pet:running', () => ({ ok: true, running: petRunning() }));
handle('shell:open', (p) => { try { shell.openPath(p); return { ok: true }; } catch (e) { return { ok: false, error: String(e.message || e) }; } });
handle('shell:reveal', (p) => { try { shell.showItemInFolder(p); return { ok: true }; } catch (e) { return { ok: false, error: String(e.message || e) }; } });

/* ---------------- 窗口 ---------------- */
/** --shot=<png>：启动后截图并退出（无头自检用） */
const SHOT = SHOT_ARG;

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 940, minHeight: 600,
    title: '猫鲸皮肤编辑器',
    backgroundColor: '#12151b',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('console-message', (e, level, msg, line, src) => {
    console.log('PAGE[' + level + '] ' + msg + (src ? ' @' + String(src).split(/[\/]/).pop() + ':' + line : ''));
  });
  if (process.argv.includes('--uitest')) { runUiTest(); }
  if (SHOT) {
    const shotSel = (process.argv.find((a) => a.startsWith('--shot-sel=')) || '').split('=').slice(1).join('=');
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (shotSel) {   // 截图前先点开指定动作，用来验证参考线跟着动作走
          try {
            await win.webContents.executeJavaScript(`(function(){var t=${JSON.stringify(shotSel)};var li=[...document.querySelectorAll('#actionList li')].find(function(l){return (l.querySelector('.nm')||{}).textContent===t});if(li)li.click();return !!li})()`);
            await new Promise((r) => setTimeout(r, 3200));   // 等视频首帧解码出来再截图
          } catch (e) {}
        }
        try {
          const info = await win.webContents.executeJavaScript(`JSON.stringify({
            title: document.title,
            skins: [...document.querySelectorAll('#skinSel option')].map(o => o.value),
            sel: document.getElementById('selTitle').textContent,
            log: document.getElementById('log').textContent,
            actions: [...document.querySelectorAll('#actionList li .nm')].map(e => e.textContent),
            pv: (function(){ var v=document.getElementById('pv'); return v ? {
                 src:(v.currentSrc||'').split('/').pop(), rs:v.readyState, w:v.videoWidth, h:v.videoHeight,
                 paused:v.paused, t:v.currentTime, err:v.error?v.error.code:null,
                 box:(function(){var r=document.getElementById('petBox').getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]})(),
                 vrect:(function(){var r=v.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]})(),
                 tf:v.style.transform } : null; })(),
            lines: [...document.querySelectorAll('.refline,.baseline')].map(e => ({id:e.id, top:e.style.top, disp:e.style.display, txt:(e.querySelector('.lbl')||{}).textContent}))
          })`);
          console.log('SHOT_STATE ' + info);
          let img = null, lastErr = null;
          for (let i = 0; i < 4 && !img; i++) {          // 切换动作后偶发 UnknownVizError，重试几次
            try { img = await win.webContents.capturePage(); }
            catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 500)); }
          }
          if (!img) throw lastErr || new Error('capturePage 失败');
          fs.writeFileSync(SHOT, img.toPNG());
          console.log('SHOT_SAVED ' + SHOT + ' ' + img.getSize().width + 'x' + img.getSize().height);
        } catch (e) { console.log('SHOT_FAIL ' + e.message); }
        app.quit();
      }, 3500);
    });
  }
  win.on('closed', () => { win = null; });
}

/* ---------------- UI 流程自检（--uitest，有窗口）----------------
   用真实点击驱动界面：新建皮肤（复制内置）→ 选中动作改缩放 → 保存 → 应用到桌宠 → 截图取证 */
function runUiTest() {
  const OUT = path.join(__dirname, '..', '_verify', 'out');
  fs.mkdirSync(OUT, { recursive: true });
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'ui-' + name + '.png'), img.toPNG());
  };
  const ev = (code) => win.webContents.executeJavaScript(code);
  const waitFor = async (js, ms, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 15000)) {
      if (await ev('(function(){try{return !!(' + js + ')}catch(e){return false}})()')) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('等待超时：' + label);
  };
  win.webContents.once('did-finish-load', async () => {
    const rep = { steps: [], ok: true };
    const step = (n, o) => { rep.steps.push(Object.assign({ step: n }, o)); console.log('UITEST ' + n + ' ' + JSON.stringify(o)); if (o && o.ok === false) rep.ok = false; };
    try {
      await new Promise((r) => setTimeout(r, 1200));
      // 1 新建皮肤（完整复制内置）
      const slug = 'uitest_skin';
      fs.rmSync(path.join(skinRoot(), slug), { recursive: true, force: true });
      await ev(`document.getElementById('btnNew').click(); true`);
      await ev(`(function(){var n=document.getElementById('newName');n.value='UI测试皮肤';n.dispatchEvent(new Event('input'));
        var s=document.getElementById('newSlug');s.value='${slug}';document.getElementById('newBase').value='full';
        document.getElementById('newOk').click();return true})()`);
      await waitFor(`[...document.querySelectorAll('#skinSel option')].some(function(o){return o.value==='${slug}'})`, 60000, '皮肤出现在下拉里');
      await waitFor(`document.querySelectorAll('#actionList li .nm').length >= 10`, 20000, '动作列表出现');
      const listInfo = JSON.parse(await ev(`JSON.stringify({
        n: document.querySelectorAll('#actionList li').length,
        names: [...document.querySelectorAll('#actionList li .nm')].map(e=>e.textContent),
        sel: document.getElementById('selTitle').textContent,
        skins: [...document.querySelectorAll('#skinSel option')].map(o=>o.value)
      })`));
      step('new-skin', { ok: listInfo.n >= 10 && listInfo.skins.includes(slug), count: listInfo.n, sel: listInfo.sel, skins: listInfo.skins });
      await shot('1-new');

      // 2 选中一个非核心动作（空闲随机类），改缩放与位移
      const picked = JSON.parse(await ev(`(function(){
        var lis=[...document.querySelectorAll('#actionList li')];
        var idx=lis.findIndex(function(li){return (li.querySelector('.meta')||{}).textContent && li.querySelector('.meta').textContent.indexOf('空闲')>=0});
        if(idx<0) idx=1;
        lis[idx].click();
        return JSON.stringify({idx:idx, title:document.getElementById('selTitle').textContent})
      })()`));
      await new Promise((r) => setTimeout(r, 400));
      const changed = JSON.parse(await ev(`(function(){
        var r=document.getElementById('fScale'); if(!r) return JSON.stringify({ok:false,err:'没有缩放控件'});
        r.value='1.25'; r.dispatchEvent(new Event('input'));
        var ox=document.getElementById('fOffX'); if(ox){ox.value='4'; ox.dispatchEvent(new Event('input'));}
        return JSON.stringify({ok:true, scale:document.getElementById('fScaleN').value, offX:document.getElementById('fOffXN')?document.getElementById('fOffXN').value:null,
          preview: document.getElementById('pv').style.transform})
      })()`));
      step('edit-transform', { ok: changed.ok, title: picked.title, scale: changed.scale, offX: changed.offX, preview: changed.preview });
      await shot('2-edit');

      // 3 保存 + 应用到桌宠
      await ev(`document.getElementById('btnSave').click(); true`);
      await new Promise((r) => setTimeout(r, 1200));
      const saved = readSkin(slug);
      const act = saved.ok ? Object.values(saved.actions).find((a) => Math.abs((a.scale || 1) - 1.25) < 1e-6) : null;
      step('save', { ok: saved.ok && !!act, skinPath: path.join(skinRoot(), slug, 'skin.json'), savedCount: Object.keys(saved.actions || {}).length, foundScaled: act ? act.id + ' scale=' + act.scale + ' offX=' + act.offX : null });
      await ev(`document.getElementById('btnApply').click(); true`);
      await new Promise((r) => setTimeout(r, 800));
      step('apply', { ok: activeSlug() === slug, active: activeSlug() });
      await shot('3-applied');

      // 4 校验磁盘产物
      const dir = path.join(skinRoot(), slug);
      const files = fs.readdirSync(path.join(dir, 'videos')).filter((f) => f.endsWith('.webm'));
      const sizes = files.map((f) => fs.statSync(path.join(dir, 'videos', f)).size);
      step('files', { ok: files.length >= 10 && sizes.every((n) => n > 100000), videos: files.length, minBytes: Math.min.apply(null, sizes), totalMB: Math.round(sizes.reduce((a, b) => a + b, 0) / 1048576) });
    } catch (e) {
      rep.ok = false;
      step('error', { ok: false, error: String(e && e.message || e) });
      try { await shot('error'); } catch (x) {}
    }
    fs.writeFileSync(path.join(OUT, 'uitest.json'), JSON.stringify(rep, null, 2), 'utf8');
    console.log('UITEST_DONE ' + JSON.stringify({ ok: rep.ok, steps: rep.steps.length }));
    app.quit();
  });
}

/* ---------------- 量身高（--bbox=<视频>，无窗口）---------------- */
const BBOX_ARG = (process.argv.find((a) => a.startsWith('--bbox=')) || '').split('=').slice(1).join('=');
if (BBOX_ARG) {
  app.whenReady().then(async () => {
    for (const f of BBOX_ARG.split('|')) {
      const r = await videoAlphaBox(f);
      console.log('BBOX ' + JSON.stringify(r));
    }
    app.quit();
  });
}

/* ---------------- 自检（--selftest，无窗口）----------------
   验证：建皮肤 → 复制内置 → 保存读回 → 转码带 alpha 的 webm → 写 active.json */
if (process.argv.includes('--selftest')) {
  app.whenReady().then(async () => {
    const out = { steps: [], ok: true };
    const step = (name, obj) => { out.steps.push(Object.assign({ name }, obj)); console.log('SELFTEST ' + name + ' ' + JSON.stringify(obj)); if (obj && obj.ok === false) out.ok = false; };
    const slug = 'selftest_skin';
    const dir = path.join(skinRoot(), slug);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      step('paths', { ok: true, skinRoot: skinRoot(), projectRoot: cfg().projectRoot, ffmpeg: !!which('ffmpeg') });

      saveSkin(slug, { name: '自检皮肤', actions: {} });
      const base = readBuiltin();
      let copied = 0;
      for (const id in base.actions) {
        const a = base.actions[id];
        if (!a.exists) continue;
        const dst = path.join(dir, 'videos', id + '.webm');
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(a.absFile, dst);
        copied++;
      }
      const actions = {};
      for (const id in base.actions) {
        const a = base.actions[id];
        if (!a.exists) continue;
        actions[id] = Object.assign({}, a, { file: 'videos/' + id + '.webm' });
        delete actions[id].absFile; delete actions[id].exists;
      }
      const sv = saveSkin(slug, { name: '自检皮肤', actions });
      step('save', sv);
      const rd = readSkin(slug);
      step('read-back', { ok: rd.ok, count: Object.keys(rd.actions).length, copied, missing: Object.values(rd.actions).filter((x) => !x.exists).map((x) => x.id) });

      // 转码：拿素材里一个绿幕 mp4 试 alpha
      const srcMp4 = path.join(cfg().projectRoot, '素材', '待机.mp4');
      if (fs.existsSync(srcMp4)) {
        const pr = probeVideo(srcMp4);
        const enc = await encodeWebm({ src: srcMp4, dst: path.join(dir, 'videos', 'act_1.webm'), width: 480, fps: 24, keyColor: '#00ff00', similarity: 0.14, sourceHasAlpha: false, crf: 32 });
        step('encode', { ok: !!enc.ok, error: enc.error || null, in: { w: pr.width, h: pr.height, pix: pr.pixFmt }, out: { w: enc.width, h: enc.height, alpha: enc.hasAlpha, pix: enc.pixFmt, dur: enc.duration, ms: enc.ms, bytes: enc.bytes } });
      } else step('encode', { ok: false, error: '缺少素材 mp4' });

      const act = setActive(slug);
      step('active', { ok: act.ok, active: activeSlug() });
      const st = { ok: out.ok, steps: out.steps };
      console.log('SELFTEST_DONE ' + JSON.stringify(st));
    } catch (e) {
      console.log('SELFTEST_ERROR ' + (e && e.stack || e));
    }
    app.quit();
  });
} else if (!BBOX_ARG && !SHOT && !app.requestSingleInstanceLock()) app.quit();   // 自检/量身高模式不参与单实例锁
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  if (BBOX_ARG) { /* --bbox 模式不建窗 */ }
  else app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => app.quit());
}
