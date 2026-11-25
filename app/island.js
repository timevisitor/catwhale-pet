'use strict';
/**
 * 灵动岛（Electron 版）
 *
 * 与 Tauri 版行为对齐：没有事件时是桌宠头顶的一枚小球，有消息/音乐/视频时展开成胶囊。
 * 与 Rust 版的三处对齐点（都是那边踩过坑的结论）：
 *   ① 窗口尺寸固定 640×150，球↔胶囊的形变全在页面里做（逐帧改窗口尺寸会掉帧）；
 *   ② 位置挂在桌宠头顶，锚点「粘住」不跟逐帧抖动，只跟窗口拖动；
 *   ③ 窗口默认穿透（forward:true），由页面报告光标是否压在形状上，主进程切 setIgnoreMouseEvents。
 *
 * 数据源复用主进程现有对象：
 *   媒体 —— media-show 的 createMediaShow()（SMTC + WASAPI，探测进程本来就有）
 *   消息 —— infohub 的 infohub:note 事件（Windows 通知中心）
 *   歌词 —— 网易云公开接口（按 歌名+歌手 搜 id 再取 LRC）
 */

const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

const W = 640, H = 150;          // 窗口尺寸（DIP）
const TOP_PAD = 8;               // 页面里内容的顶部内边距
const BALL = 56, CAP_H = 104;    // 球 / 胶囊的可见高度
const GAP = 6;                   // 离头顶点
const TICK_MS = 500;
const LEVELS_MAX = 44;
const SILENT_RESET_MS = 4000;
const ANCHOR_JUMP = 0.12;        // 锚点大偏移阈值（相对窗口高度）
const ANCHOR_MISS_NEED = 6;      // 连续多少帧才算真的换了姿态

const DEFAULTS = { enabled: true, msg: true, music: true, video: true, holdMs: 8000 };

/* ---------------- 歌词（网易云公开接口） ---------------- */
function httpGet(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = https.get(url, {
        timeout: timeoutMs || 6000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          Referer: 'https://music.163.com/',
        },
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return fin(null); }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; if (buf.length > 512 * 1024) { try { req.destroy(); } catch (e) {} fin(null); } });
        res.on('end', () => fin(buf));
      });
      req.on('timeout', () => { try { req.destroy(); } catch (e) {} fin(null); });
      req.on('error', () => fin(null));
    } catch (e) { fin(null); }
  });
}

function parseLrc(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach((line) => {
    const m = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/.exec(line.trim());
    if (!m) return;
    const body = m[3].trim();
    if (!body) return;
    out.push([Number(m[1]) * 60000 + Math.round(Number(m[2]) * 1000), body]);
  });
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

async function fetchLyric(title, artist) {
  const q = encodeURIComponent((title + ' ' + (artist || '')).trim());
  const search = await httpGet('https://music.163.com/api/search/get/web?s=' + q + '&type=1&limit=1');
  if (!search) return null;
  let id = null;
  try {
    const j = JSON.parse(search);
    const songs = j && j.result && j.result.songs;
    if (songs && songs.length) id = songs[0].id;
  } catch (e) { return null; }
  if (!id) return null;
  const lyr = await httpGet('https://music.163.com/api/song/lyric?id=' + id + '&lv=-1&kv=-1&tv=-1');
  if (!lyr) return null;
  try {
    const j = JSON.parse(lyr);
    const text = j && j.lrc && j.lrc.lyric;
    const lines = parseLrc(text);
    return lines.length ? { lines } : null;
  } catch (e) { return null; }
}

function createIsland(deps) {
  const o = deps || {};
  const getUserData = o.getUserData || (() => process.env.APPDATA || '.');
  const log = o.log || (() => {});
  const cfgPath = () => path.join(getUserData(), 'island.json');

  let win = null;
  let timer = null;
  let cfg = readCfg();
  let mode = 'idle';
  let lastMsg = null, msgAt = 0, lastMsgKey = '', msgBaseline = false;
  let levels = [];
  let trackKey = '', elapsedMs = 0, silentMs = SILENT_RESET_MS;
  let progKey = '', progPos = 0, progAt = 0, progLast = -1, progStillMs = 0;
  let anchor = null;               // {cx, head} 归一化到「角色矩形」（0..1）
  let anchorRect = null;           // {sx,sy,rx,ry,rw,rh} 角色矩形（屏幕 DIP）
  let anchorMiss = 0;
  let pinned = false, hiddenUntil = 0;
  const lyricCache = new Map();    // key -> {lines:[[ms,text]]} | null

  /* ---------------- 配置 ---------------- */
  function readCfg() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(getUserData(), 'island.json'), 'utf8'));
      return Object.assign({}, DEFAULTS, j && typeof j === 'object' ? j : {});
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveCfg() {
    try {
      const p = cfgPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, p);
    } catch (e) { log('ISLAND_CFG_ERR ' + e.message); }
  }

  /* ---------------- 锚点（桌宠头顶） ---------------- */
  /* 页面按「第一个不透明格数 ≥ 最宽行 25% 的行」算头顶，避开呆毛；
     这里做粘滞：小偏差一律忽略，只有连续多帧大偏移才重新锚定。 */
  /* 页面送上来的是：角色视频矩形（屏幕 DIP）+ 矩形内归一化锚点（0..1）。
     粘滞只作用在「矩形内归一化锚点」上 —— 桌宠在窗口里移动/拖窗口是角色矩形的变化，
     必须实时跟；而角色呼吸摆尾导致锚点在矩形内抖几像素，要压掉。 */
  function noteAnchor(a) {
    if (!a || !isFinite(a.cx) || !isFinite(a.head)) return;
    const cx = Math.min(1, Math.max(0, a.cx));
    const head = Math.min(1, Math.max(0, a.head));
    const rect = (isFinite(a.sx) && isFinite(a.sy) && isFinite(a.rw) && a.rw > 0)
      ? { sx: a.sx, sy: a.sy, rx: a.rx || 0, ry: a.ry || 0, rw: a.rw, rh: a.rh || 0 }
      : null;
    if (!anchor) { anchor = { cx, head }; anchorRect = rect; anchorMiss = 0; return; }
    const d = Math.max(Math.abs(cx - anchor.cx), Math.abs(head - anchor.head));
    if (d > ANCHOR_JUMP) {
      anchorMiss += 1;
      if (anchorMiss >= ANCHOR_MISS_NEED) { anchor = { cx, head }; anchorMiss = 0; }
    } else {
      anchorMiss = 0;
    }
    if (rect) anchorRect = rect;      // 角色在屏幕上的位置始终用最新值
  }
  function resetAnchor() { anchor = null; anchorRect = null; anchorMiss = 0; }

  /* ---------------- 歌词（网易云公开接口） ---------------- */
  function lyricAt(key, elapsedMs) {
    const hit = lyricCache.get(key);
    if (!hit || !hit.lines) return { cur: '', next: '' };
    let cur = '', next = '';
    for (const [ms, text] of hit.lines) {
      if (ms <= elapsedMs + 200) cur = text;
      else { next = text; break; }
    }
    return { cur, next };
  }

  function ensureLyric(key, title, artist) {
    if (!key || lyricCache.has(key)) return;
    lyricCache.set(key, null);        // 占位，避免并发重复请求
    fetchLyric(title, artist).then((r) => {
      lyricCache.set(key, r);
      if (r) log('ISLAND_LYRIC ok ' + key.slice(0, 40));
    }).catch(() => {});
  }

  /* ---------------- 媒体 ---------------- */
  const FRIENDLY = [
    [/cloudmusic|netease/i, '网易云'], [/qqmusic/i, 'QQ音乐'], [/kugou/i, '酷狗'],
    [/kuwo/i, '酷我'], [/spotify/i, 'Spotify'], [/potplayer/i, 'PotPlayer'],
    [/vlc/i, 'VLC'], [/msedge|chrome|firefox/i, '浏览器'],
  ];
  function friendlyApp(proc) {
    const p = String(proc || '');
    for (const [re, name] of FRIENDLY) if (re.test(p)) return name;
    return p.replace(/\.exe$/i, '');
  }

  function readMedia() {
    let st = null;
    try { st = o.getMediaState ? o.getMediaState() : null; } catch (e) { st = null; }
    const src = st || {};
    const info = src.info || {};
    const kind = src.kind || '';
    const playing = !!src.playing && !!kind;
    const title = String(info.title || '');
    const artist = String(info.artist || '');
    const proc = String(info.proc || info.app || '');
    const peak = Number(info.peak) || 0;
    const pos = (info.pos === undefined || info.pos === null) ? null : Number(info.pos);
    const dur = (info.end === undefined || info.end === null) ? null : Number(info.end);
    return { kind, playing, title, artist, proc, peak, pos, dur };
  }

  function pushLevel(playing, peak) {
    if (playing) {
      levels.push(Math.min(1, Math.max(0, peak)));
      silentMs = peak > 0.004 ? 0 : silentMs + TICK_MS;
    } else {
      levels.push(0);
      silentMs = SILENT_RESET_MS;
    }
    if (levels.length > LEVELS_MAX) levels.splice(0, levels.length - LEVELS_MAX);
  }

  /* 进度：SMTC 的 pos 可能很久才变一次（Edge 甚至一直不动），
     用「最后真实 pos + 流逝时间」算，pos 一变就重新锚定。视频侧已不显示进度条，
     这里只为音乐态的 ≈ 时间。 */
  function progress(key, rawPos, dur, playing) {
    if (rawPos === null || !isFinite(rawPos)) return { pos: null, estimated: false };
    const now = Date.now();
    if (progKey !== key) {
      progKey = key; progPos = rawPos; progAt = now; progLast = rawPos; progStillMs = 0;
    } else if (Math.abs(rawPos - progLast) > 0.3) {
      progPos = rawPos; progAt = now; progLast = rawPos; progStillMs = 0;
    } else {
      progStillMs += TICK_MS;
    }
    let v = progPos + (playing ? (now - progAt) / 1000 : 0);
    if (dur && dur > 0.5 && v > dur) v = dur;
    return { pos: v, estimated: progStillMs > 5000 };
  }

  /* ---------------- 消息 ---------------- */
  /* 由主进程把 infohub:note 事件转进来。启动后第一条只记基线，
     否则一开机就把历史通知当成新消息弹出来（Rust 版踩过的坑）。 */
  function notify(evt) {
    if (!evt || typeof evt !== 'object') return;
    const key = String(evt.key || (evt.data && evt.data.notificationId) || '');
    if (!key || key === lastMsgKey) return;
    lastMsgKey = key;
    if (!msgBaseline) { msgBaseline = true; return; }
    const data = evt.data || {};
    lastMsg = {
      app: friendlyApp(data.app || data.appId || '') || String(data.app || ''),
      title: String(data.chatName || evt.title || ''),
      text: String(evt.body || ''),
      ts: Number(evt.ts) || Date.now(),
      count: 1,
    };
    msgAt = Date.now();
    if (win && !win.isDestroyed()) show();
  }

  /* ---------------- 通知源 ----------------
     复用 infohub/sources/winnotify.js：它已经处理了「读通知中心 / 解析各应用文案 /
     去重 / 首轮只记基线」这些细节。跑一个私有实例，事件直接从 emit 里取，
     这样不依赖用户在信息中枢里是否打开了 winnotify 这一源。 */
  let notifyInst = null, notifyTimer = null;
  function startNotify(delayMs) {
    if (notifyInst || notifyTimer) return;
    /* 启动竞态：startInfoHub 是异步的，此刻它的 winnotify 源可能还在「未就绪」。
       先等几秒再判断，避免和中枢同时各起一个探针。 */
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      if (notifyInst) return;
      if (o.hasHubNotify && o.hasHubNotify()) {
        log('ISLAND_NOTIFY via infohub');     // 中枢已经在读，直接用它的 infohub:note
        return;
      }
      createNotify();
    }, Number.isFinite(delayMs) ? delayMs : 4000);
  }
  function createNotify() {
    try {
      const createSource = require('./infohub/sources/winnotify.js');
      notifyInst = createSource({
        cfg: () => ({ enabled: true, pollMs: 4000 }),
        setCfg: () => {},
        emit: (evt) => { try { notify(evt); } catch (e) {} },
        snapshot: () => {},
        log: (m) => log('ISLAND_NOTIFY ' + m),
        dataDir: getUserData(),
        appDir: __dirname,
        paths: { localAppData: process.env.LOCALAPPDATA, home: require('os').homedir() },
      });
      Promise.resolve(notifyInst.start())
        .then((r) => log('ISLAND_NOTIFY_READY ' + JSON.stringify(r)))
        .catch((e) => log('ISLAND_NOTIFY_ERR ' + (e && e.message)));
    } catch (e) {
      notifyInst = null;
      log('ISLAND_NOTIFY_INIT_ERR ' + (e && e.message));
    }
  }
  function stopNotify() {
    if (notifyTimer) { clearTimeout(notifyTimer); notifyTimer = null; }
    if (!notifyInst) return;
    try { notifyInst.stop(); } catch (e) {}
    notifyInst = null;
  }

  function noteCfg(patch) {
    const p = patch || {};
    if (typeof p.enabled === 'boolean') cfg.enabled = p.enabled;
    if (typeof p.msg === 'boolean') cfg.msg = p.msg;
    if (typeof p.music === 'boolean') cfg.music = p.music;
    if (typeof p.video === 'boolean') cfg.video = p.video;
    if (p.holdMs !== undefined) {
      const n = Number(p.holdMs);
      if (isFinite(n)) cfg.holdMs = Math.min(60000, Math.max(1500, n));
    }
    saveCfg();
    if (cfg.enabled && cfg.msg) startNotify(); else stopNotify();
    if (cfg.enabled) { ensure(); start(); show(); } else { hide(); }
    return Object.assign({ ok: true }, { cfg: Object.assign({}, cfg) });
  }

  /* ---------------- 载荷 ---------------- */
  function buildPayload() {
    const m = readMedia();
    const key = m.title ? (m.title + '|' + m.artist) : '';
    if (key) {
      if (key !== trackKey) { trackKey = key; elapsedMs = 0; }
      else if (silentMs < SILENT_RESET_MS) elapsedMs += TICK_MS;
      ensureLyric(key, m.title, m.artist);
    }
    pushLevel(m.playing, m.peak);
    const lyr = key ? lyricAt(key, elapsedMs) : { cur: '', next: '' };
    const pr = key ? progress(key, m.pos, m.dur, m.playing) : { pos: null, estimated: false };
    const hold = Math.max(1500, cfg.holdMs || 8000);
    const msgFresh = !!cfg.msg && !!lastMsg && (Date.now() - msgAt) < hold;
    const musicOn = !!cfg.music && m.kind === 'music' && !!m.title;
    const videoOn = !!cfg.video && m.kind === 'video' && !!m.title;
    let next = msgFresh ? 'msg' : (videoOn ? 'video' : (musicOn ? 'music' : 'idle'));
    if (pinned && next === 'idle') next = mode || 'idle';
    mode = next;
    return {
      mode: next,
      pinned,
      music: {
        title: m.title, artist: m.artist, app: m.proc,
        appName: friendlyApp(m.proc), levels: levels.slice(),
        pos: pr.pos, dur: m.dur, estimated: pr.estimated,
        lyric: lyr.cur, lyricNext: lyr.next,
        elapsed: elapsedMs / 1000,
      },
      msg: lastMsg,
      video: {
        title: m.kind === 'video' ? m.title : '', appName: friendlyApp(m.proc),
        pos: pr.pos, dur: m.dur, estimated: pr.estimated,
      },
      tailX: lastTailX,
      cfg: Object.assign({}, cfg),
      ts: Date.now(),
    };
  }

  /* ---------------- 窗口 ---------------- */
  function ensure() {
    if (win && !win.isDestroyed()) return win;
    const port = o.getPort ? o.getPort() : 0;
    if (!port) return null;
    win = new BrowserWindow({
      width: W, height: H, show: false, frame: false, transparent: true,
      backgroundColor: '#00000000', hasShadow: false, resizable: false, movable: false,
      skipTaskbar: true, alwaysOnTop: true, focusable: false, fullscreenable: false,
      title: 'island',
      webPreferences: {
        preload: path.join(__dirname, 'island-preload.js'),
        contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: true });
    /* 页面重载（reload / 崩溃恢复）会把 forward 状态丢掉，之后页面再也收不到 mousemove，
       命中上报就断了 —— 表现为窗口永远穿透、点不到。每次加载完都重新声明一次。 */
    const rearm = () => {
      if (!win || win.isDestroyed()) return;
      try { win.setIgnoreMouseEvents(true, { forward: true }); } catch (e) {}
    };
    win.webContents.on('did-finish-load', rearm);
    win.webContents.on('did-navigate', rearm);
    win.loadURL('http://127.0.0.1:' + port + '/island.html');
    win.on('closed', () => { win = null; });
    if (o.onCreated) { try { o.onCreated(win); } catch (e) {} }
    return win;
  }

  function petBounds() {
    const pet = o.getPetWin ? o.getPetWin() : null;
    if (!pet || pet.isDestroyed()) return null;
    if (typeof pet.isVisible === 'function' && !pet.isVisible()) return null;
    try { return pet.getBounds(); } catch (e) { return null; }
  }

  function islandPos() {
    const b = petBounds();
    if (!b) return null;
    const a = anchor || { cx: 0.5, head: 0.22 };
    const contentH = mode === 'idle' ? BALL : CAP_H;
    /* 锚点优先用页面给的「角色矩形（屏幕 DIP）」：
       Electron 版桌宠窗口铺满工作区、角色在窗口里到处走，用窗口归一化会算错位置。 */
    let cxScreen, headScreen;
    if (anchorRect) {
      cxScreen = anchorRect.sx + anchorRect.rx + a.cx * anchorRect.rw;
      headScreen = anchorRect.sy + anchorRect.ry + a.head * anchorRect.rh;
    } else {
      cxScreen = b.x + a.cx * b.width;
      headScreen = b.y + a.head * b.height;
    }
    let x = Math.round(cxScreen - W / 2);
    let y = Math.round(headScreen - GAP - TOP_PAD - contentH);
    const area = screen.getDisplayNearestPoint({ x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) }).workArea;
    if (x < area.x) x = area.x;
    if (x + W > area.x + area.width) x = area.x + area.width - W;
    if (y < area.y) y = area.y;
    /* 角色贴近屏幕边缘时窗口会被夹回来，这时把「尖角」挪到角色正上方，
       不然气泡会指着空气（对话气泡的通行做法）。 */
    const tailX = Math.round(Math.min(W - 26, Math.max(26, cxScreen - x)));
    return { x, y, tailX };
  }

  let lastTailX = W / 2;
  function place(force) {
    if (!win || win.isDestroyed()) return;
    const p = islandPos();
    if (p && isFinite(p.tailX)) lastTailX = p.tailX;
    if (!p) { if (!win.isDestroyed() && win.isVisible()) win.hide(); return; }
    const cur = win.getBounds();
    if (force || Math.abs(cur.x - p.x) >= 6 || Math.abs(cur.y - p.y) >= 6) {
      win.setBounds({ x: p.x, y: p.y, width: W, height: H });
      const after = win.getBounds();
      log('ISLAND_POS ' + JSON.stringify({ want: p, cur, after, anchor, anchorRect }));
    }
  }

  function show() {
    const w = ensure();
    if (!w) return;
    place(true);
    if (!w.isVisible()) w.showInactive();
    w.setAlwaysOnTop(true, 'screen-saver');
  }
  function hide() { if (win && !win.isDestroyed() && win.isVisible()) win.hide(); }

  /* ---------------- 主循环 ---------------- */
  function tick() {
    try {
      if (!cfg.enabled) { hide(); return; }
      const pet = petBounds();
      if (!pet) { hide(); return; }
      const payload = buildPayload();
      const hidden = Date.now() < hiddenUntil;
      if (!hidden || payload.mode !== 'idle') {
        if (hidden && payload.mode !== 'idle') hiddenUntil = 0;
        show();
      } else {
        hide();
      }
      place(false);
      if (win && !win.isDestroyed()) win.webContents.send('island:data', payload);
    } catch (e) {
      log('ISLAND_TICK_ERR ' + (e && e.message));
    }
  }

  function start() {
    if (cfg.enabled && cfg.msg) startNotify();
    if (timer) return;
    timer = setInterval(tick, TICK_MS);
    tick();
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    stopNotify();
    hide();
  }

  /* ---------------- IPC ---------------- */
  const handlers = {
    'island:get': () => ({
      ok: true, cfg: Object.assign({}, cfg), data: { mode, pinned },
    }),
    'island:set': (_e, patch) => noteCfg(patch),
    'island:cmd': (_e, cmd) => {
      const c = String(cmd || '');
      if (c === 'expand') { hiddenUntil = 0; show(); }
      else if (c === 'pin') { pinned = !pinned; hiddenUntil = 0; }
      else if (c === 'dismiss') { pinned = false; hiddenUntil = Date.now() + 60000; hide(); }
      return { ok: true, pinned };
    },
    'island:demo': (_e, what) => {
      const modeArg = String(what || 'msg');
      if (modeArg === 'msg') {
        lastMsg = {
          app: '微信', title: '张三',
          text: '这是灵动岛的预览消息：明天下午三点评审会改到四点。',
          ts: Date.now(), count: 2,
        };
        msgAt = Date.now();
      }
      hiddenUntil = 0;
      show();
      return { ok: true };
    },
    'island:reset': () => { place(true); return { ok: true }; },
    'island:hit': (_e, inside) => {
      if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!inside, { forward: true });
      return { ok: true };
    },
    'island:anchor': (_e, a) => { noteAnchor(a); place(false); return { ok: true }; },
  };
  function bindIpc() {
    Object.keys(handlers).forEach((ch) => {
      try { ipcMain.handle(ch, handlers[ch]); } catch (e) { /* 重复注册忽略 */ }
    });
    /* 主窗口页面用 send 高频喂锚点（不需要回包） */
    try {
      ipcMain.on('island:anchor-raw', (_e, a) => { noteAnchor(a); place(false); });
    } catch (e) {}
  }

  return {
    bindIpc,
    start,
    stop,
    setCfg: (patch) => noteCfg(patch),
    demo: (what) => handlers['island:demo'](null, what),
    resetPos: () => { resetAnchor(); place(true); },
    cfg: () => Object.assign({}, cfg),
    notify,
    noteAnchor,
    resetAnchor,
    win: () => win,
    state: () => ({ mode, pinned, anchor, cfg: Object.assign({}, cfg) }),
  };
}

/* 导出内部工具只为自检（歌词接口/解析），运行时不依赖 */
module.exports = { createIsland, _lyric: { httpGet, parseLrc, fetchLyric } };
