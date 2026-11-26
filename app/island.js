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
const TICK_MS = 500;             // **内容**推送周期（波形/歌词/进度）；不负责定位
const LEVELS_MAX = 44;
const SILENT_RESET_MS = 4000;
/* 落位门槛（DIP）。窗口坐标是整数，所以 1 就是最小可见步进：
   锚点驱动（角色在动）用 1，逐帧跟；只有非定位路径（例如重置）才用 6 的粗门槛。 */
const TOL_MOVE = 1;
const TOL_COARSE = 6;
const ANCHOR_EPS = 0.03;         // 角色矩形内归一化：小于这个量级视为呼吸/摆尾，不动

const DEFAULTS = { enabled: true, msg: true, music: true, video: true, holdMs: 8000 };

/* 手动偏移的归一化：屏幕 DIP，保留两位小数。非法值一律当作「没有偏移」。 */
function readOff(v) {
  if (!v || typeof v !== 'object') return { x: 0, y: 0 };
  const x = Number(v.x), y = Number(v.y);
  if (!isFinite(x) || !isFinite(y)) return { x: 0, y: 0 };
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
}

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
  /* 手动偏移（屏幕 DIP，相对「锚点默认落点」）。用户把球/胶囊拖到哪儿，就一直挂在
     头顶的同一相对位置；与 anchor 是两件事：
       anchor  = 头顶在角色矩形里的位置（页面量出来的，跟着动作换姿）
       off     = 用户手调的整体位移（只在拖动松手时写盘，贴边只夹显示、不回写）
     重启后从 island.json 的 off 还原，不会因为重新量头顶而漂走。 */
  let off = readOff(cfg.off);
  /* 拖动状态机：startOff + 屏幕指针位移 = 新偏移。用屏幕坐标而不是 client 坐标 ——
     拖动过程中窗口本身在跟着指针移动，client 坐标相对窗口几乎不变，算不出位移。 */
  let drag = null;                 // {ox,oy,sx,sy,px,py,win} ; ox/oy=起始偏移
  let lastHit = false;
  /* 重启恢复：拖动松手时渲染进程会把「角色局部锚点」写进 island.json（anchor 字段）。
     首次上报若还没量到头顶（meas:false，视频没解出首帧），就用它起手 —— 见 noteAnchor。 */
  let pinned = false, hiddenUntil = 0;
  /* 胶囊跟着桌宠大小缩放：桌宠缩到 200px 时胶囊还按 640 宽画，看着就是「小人戴大帽子」。
     用 anchorRect 的角色高度比上基准高度算倍率，靠 webContents.setZoomFactor 整体缩放
     （页面里的 CSS 像素空间不变，字号/圆角/波形一起等比缩，不用改样式）。 */
  const REF_H = 430;      // 基准：默认大小下角色矩形高度（CSS px）—— 调大则默认胶囊更小
  let zoom = 1;
  /* Agent 看板快照 / 信息中枢摘要：这两块原来各有一个贴在角色旁边的小窗，
     和胶囊抢同一片屏幕 —— 现在统一并进胶囊，页面里那两个浮层关掉。 */
  let agentSnap = null, agentAt = 0, infoOpen = false;
  /* 自动截图/自检时用：冻结若干毫秒，期间不再把实时状态推给页面，
     这样页面里手工 render 的状态不会被 500ms 一次的推送冲掉。 */
  let frozenUntil = 0;
  const lyricCache = new Map();    // key -> {lines:[[ms,text]]} | null

  /* ---------------- Agent 看板 ---------------- */
  const AGENT_BUSY = { working: '正在干活', speaking: '正在说话', waiting_user: '等你确认' };
  function noteAgent(snap) {
    if (!snap || typeof snap !== 'object') return;
    agentSnap = snap;
    agentAt = Date.now();
  }
  function agentView() {
    if (!agentSnap) return null;
    const list = Array.isArray(agentSnap.sessions) ? agentSnap.sessions : [];
    const rank = (st) => (st === 'waiting_user' ? 3 : st === 'working' ? 2 : st === 'speaking' ? 2 : 0);
    let pick = null, best = 0;
    for (const it of list) {
      const r = rank(it.state);
      if (r > best) { best = r; pick = it; }
    }
    let fresh = false;
    if (!pick) {
      /* 刚干完的给一次露脸机会（12 秒内），别让「完成」一闪而过 */
      const done = list.filter((it) => it.state === 'done' || it.state === 'error')
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      if (done && Date.now() - Number(done.updatedAt || 0) < 12000) { pick = done; fresh = true; }
    }
    if (!pick) return null;
    const name = pick.agent === 'claude-code' ? 'Claude Code'
      : pick.agent === 'codex' ? 'Codex' : String(pick.agent || 'Agent');
    const state = String(pick.state || '');
    const label = AGENT_BUSY[state] || (state === 'done' ? '完成了' : state === 'error' ? '出错了' : '闲置');
    const detail = String(pick.title || pick.lastText || pick.detail || '').replace(/\s+/g, ' ').slice(0, 120);
    return {
      agent: name, state: state, label: label, detail: detail,
      busy: !!AGENT_BUSY[state], fresh: fresh,
      count: list.length, at: Number(pick.updatedAt) || agentAt,
    };
  }

  /* ---------------- 信息中枢摘要 ---------------- */
  function infoView() {
    let info = null;
    try { info = o.getInfo ? o.getInfo() : null; } catch (e) { info = null; }
    return info && typeof info === 'object' ? info : null;
  }

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
     这里只做最后一道过滤。
     注意：v0.7.0 的「连续 6 帧大偏移才采纳」是 700ms 轮询时代的补丁 ——
     事件驱动下渲染进程只在真变化时才发，永远攒不满 6 帧，会把真实换姿全部丢掉，
     所以改成「pose 直接采纳 / 呼吸量级忽略 / 其余立即采纳」。 */
  /* 页面送上来的是：角色视频矩形（屏幕 DIP）+ 矩形内归一化锚点（0..1）。
     粘滞只作用在「矩形内归一化锚点」上 —— 角色矩形是位置，必须实时跟；
     呼吸摆尾导致锚点在矩形内抖几像素，压掉。 */
  function noteAnchor(a) {
    if (!a || !isFinite(a.cx) || !isFinite(a.head)) return;
    const cx = Math.min(1, Math.max(0, a.cx));
    const head = Math.min(1, Math.max(0, a.head));
    const rect = (isFinite(a.sx) && isFinite(a.sy) && isFinite(a.rw) && a.rw > 0)
      ? { sx: a.sx, sy: a.sy, rx: a.rx || 0, ry: a.ry || 0, rw: a.rw, rh: a.rh || 0 }
      : null;
    /* meas=false：这一份 cx/head 是兜底值（视频还没解出首帧、逐像素量不到头顶）。
       位置照跟，锚点别动 —— 否则重启后会先用 0.5/0.22 把上次松手存下的相对位置冲掉。 */
    const measured = a.meas !== false;
    if (!anchor) {
      anchor = (measured || !cfg.anchor)
        ? { cx, head }
        : { cx: cfg.anchor.cx, head: cfg.anchor.head };
      anchorRect = rect;
      return;
    }
    if (!measured) { if (rect) anchorRect = rect; return; }
    if (a.pose) {
      anchor = { cx, head };                       // 动作换了：头顶整块重算过，直接采纳
    } else {
      const d = Math.max(Math.abs(cx - anchor.cx), Math.abs(head - anchor.head));
      if (d > ANCHOR_EPS) anchor = { cx, head };   // 能发出来就是真变化
    }
    if (rect) anchorRect = rect;                   // 角色在屏幕上的位置始终用最新值
  }
  /* 托盘「回到桌宠头顶」：只丢「矩形内归一化锚点」，角色矩形留着 ——
     这样下一次 place() 立刻按默认锚点落位，不会先隐藏一下再冒出来。 */
  function resetAnchor() { anchor = null; }

  /* latest-only：渲染进程一帧最多发一次，主进程这边也只在下一轮事件循环落位一次。
     极端情况（连续多帧 / 重排）只保留最后一个锚点，不排队把 setBounds 堆成山。 */
  let pendAnchor = null, pendQueued = false;
  function queueAnchor(a) {
    if (!a || typeof a !== 'object') return;
    pendAnchor = a;
    if (pendQueued) return;
    pendQueued = true;
    setImmediate(() => {
      pendQueued = false;
      const x = pendAnchor; pendAnchor = null;
      if (!x) return;
      noteAnchor(x);
      place(false, TOL_MOVE);
    });
  }

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
    const av = agentView();
    const agentOn = !!av && !!av.busy;
    const info = infoView();
    let next = msgFresh ? 'msg'
      : agentOn ? 'agent'
        : videoOn ? 'video'
          : musicOn ? 'music'
            : (infoOpen ? 'info' : 'idle');
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
      agent: av,
      info: info,
      video: {
        title: m.kind === 'video' ? m.title : '', appName: friendlyApp(m.proc),
        pos: pr.pos, dur: m.dur, estimated: pr.estimated,
      },
      badge: (info && (info.unread || info.todoOpen)) || 0,
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

  function wantZoom() {
    if (!anchorRect || !(anchorRect.rh > 0)) return 1;
    const raw = anchorRect.rh / REF_H;
    const z = Math.min(1, Math.max(0.5, raw));
    return Math.round(z * 50) / 50;      // 量化到 0.02，避免每帧都在改
  }
  function applyZoom() {
    if (!win || win.isDestroyed()) return;
    const z = wantZoom();
    if (Math.abs(z - zoom) < 0.015) return;
    zoom = z;
    try { win.webContents.setZoomFactor(z); } catch (e) {}
    const b = win.getBounds();
    const w = Math.round(W * z), h = Math.round(H * z);
    if (Math.abs(b.width - w) > 1 || Math.abs(b.height - h) > 1) win.setBounds({ x: b.x, y: b.y, width: w, height: h });
    log('ISLAND_ZOOM ' + JSON.stringify({ rh: anchorRect && anchorRect.rh, zoom }));
  }

  /* 默认落点（off = 0）：球/胶囊底边中点贴在头顶上方 GAP 处，水平与头顶中点对齐。
     球↔胶囊切换时只改可见高度，底边保持不动（胶囊向上长），所以同一个 off 在收起/
     展开后都不会漂。返回的 x/y 已经过「离岛最近的显示器工作区」夹取 —— 夹取只影响
     显示位置，绝不回写 off。 */
  function defaultPos() {
    const b = petBounds();
    if (!b) return null;
    /* 必须有「角色矩形（屏幕 DIP）」才能落位：
       Electron 版桌宠窗口铺满整个工作区，用窗口归一化算出来的位置是「工作区 22% 高处」，
       和角色头顶没有关系（v0.7.0 靠 700ms 轮询掩盖了这一点）。事件驱动下第一次 place()
       就会带上矩形，拿不到就宁可先不显示，也不把球摆到屏幕中间。 */
    if (!anchorRect || !(anchorRect.rw > 0)) return null;
    const a = anchor || { cx: 0.5, head: 0.22 };
    const contentH = mode === 'idle' ? BALL : CAP_H;
    const cxScreen = anchorRect.sx + anchorRect.rx + a.cx * anchorRect.rw;
    const headScreen = anchorRect.sy + anchorRect.ry + a.head * anchorRect.rh;
    const Wz = Math.round(W * zoom);
    let x = Math.round(cxScreen - Wz / 2);
    let y = Math.round(headScreen - GAP - (TOP_PAD + contentH) * zoom);
    /* 夹取目标用「岛自己的落点」找最近的显示器，而不是桌宠所在的那块 ——
       这样岛可以摆到副屏上，桌宠还在主屏。 */
    const area = screen.getDisplayNearestPoint({
      x: x + Math.round(Wz / 2),
      y: y + Math.round((TOP_PAD + contentH) * zoom / 2),
    }).workArea;
    if (x < area.x) x = area.x;
    if (x + Wz > area.x + area.width) x = area.x + area.width - Wz;
    if (y < area.y) y = area.y;
    /* 角色贴近屏幕边缘时窗口会被夹回来，这时把「尖角」挪到角色正上方，
       不然气泡会指着空气（对话气泡的通行做法）。 */
    const tailX = Math.round(Math.min(W - 26, Math.max(26, (cxScreen - x) / zoom)));
    return { x, y, tailX, cxScreen, headScreen, Wz, contentH };
  }

  /* 最终落点 = 默认落点 + 手动偏移。off 是逻辑像素（DIP），不随缩放变化：
     桌宠变大变小时，岛仍挂在同一次拖动后的相对位置。 */
  function islandPos() {
    const d = defaultPos();
    if (!d) return null;
    /* 偏移加完再夹一次：用户可能拖到屏幕外，显示上夹回工作区，但 off 本身不动。 */
    const Wz = d.Wz;
    let x = Math.round(d.x + off.x);
    let y = Math.round(d.y + off.y);
    const area = screen.getDisplayNearestPoint({
      x: x + Math.round(Wz / 2),
      y: y + Math.round((TOP_PAD + d.contentH) * zoom / 2),
    }).workArea;
    if (x < area.x) x = area.x;
    if (x + Wz > area.x + area.width) x = area.x + area.width - Wz;
    if (y < area.y) y = area.y;
    const tailX = Math.round(Math.min(W - 26, Math.max(26, (d.cxScreen - x) / zoom)));
    return { x, y, tailX, off: { x: off.x, y: off.y }, clamped: (x !== Math.round(d.x + off.x) || y !== Math.round(d.y + off.y)) };
  }

  /* ---------------- 拖动（球/胶囊） ----------------
     页面在指针位移超过 4 CSS px 后才判定为拖动（单击/双击不被吃掉），
     进入拖动时把按下瞬间的屏幕坐标发来；之后每个 mousemove 发当前屏幕坐标。
     主进程自己 setBounds（不用系统拖拽），松手才把 off 落盘。 */
  function dragStart(pt) {
    if (!pt || !isFinite(pt.sx) || !isFinite(pt.sy)) return { ok: false, error: 'bad-point' };
    const w = ensure();
    if (!w) return { ok: false, error: 'no-window' };
    drag = { ox: off.x, oy: off.y, sx: Number(pt.sx), sy: Number(pt.sy), px: Number(pt.sx), py: Number(pt.sy) };
    lastHit = true;
    try { w.setIgnoreMouseEvents(false); } catch (e) {}
    log('ISLAND_DRAG_START ' + JSON.stringify({ sx: drag.sx, sy: drag.sy, off: { x: off.x, y: off.y } }));
    return { ok: true };
  }

  function dragTo(pt) {
    if (!drag) return { ok: false };
    if (pt && isFinite(pt.sx) && isFinite(pt.sy)) { drag.px = Number(pt.sx); drag.py = Number(pt.sy); }
    off = { x: drag.ox + (drag.px - drag.sx), y: drag.oy + (drag.py - drag.sy) };
    const w = win;
    if (w && !w.isDestroyed()) {
      applyZoom();
      const p = islandPos();
      if (p) {
        lastTailX = p.tailX;
        const Wz = Math.round(W * zoom), Hz = Math.round(H * zoom);
        const cur = w.getBounds();
        if (cur.x !== p.x || cur.y !== p.y || Math.abs(cur.width - Wz) > 1 || Math.abs(cur.height - Hz) > 1) {
          w.setBounds({ x: p.x, y: p.y, width: Wz, height: Hz });
        }
      }
    }
    return { ok: true, off: { x: off.x, y: off.y } };
  }

  function dragEnd(pt) {
    if (!drag) return { ok: false };
    if (pt && isFinite(pt.sx) && isFinite(pt.sy)) { drag.px = Number(pt.sx); drag.py = Number(pt.sy); }
    off = { x: drag.ox + (drag.px - drag.sx), y: drag.oy + (drag.py - drag.sy) };
    drag = null;
    /* 松手才写：把「整体偏移」写进 island.json。贴边被夹回的那部分不回写 ——
       off 是用户意图（可能暂时在屏幕外），移动桌宠/换屏后还能回到原相对位置。 */
    cfg.off = readOff(off);
    saveCfg();
    log('ISLAND_OFFSET_COMMIT ' + JSON.stringify(cfg.off));
    /* 松手再按最终偏移落一次位：确保最后一次 mousemove 丢失/被夹取时窗口仍在正确位置 */
    place(true);
    /* 松手这一刻指针可能已经不在形状上：按最后已知命中恢复穿透。 */
    if (win && !win.isDestroyed()) { try { win.setIgnoreMouseEvents(!lastHit, { forward: true }); } catch (e) {} }
    return { ok: true, off: Object.assign({}, cfg.off) };
  }

  let lastTailX = W / 2;
  function place(force, tol) {
    if (!win || win.isDestroyed()) return false;
    /* 先定倍率再算位置：缩放会改窗口宽度，islandPos 里的水平居中依赖它 */
    applyZoom();
    const p = islandPos();
    if (p && isFinite(p.tailX)) lastTailX = p.tailX;
    if (!p) { if (!win.isDestroyed() && win.isVisible()) win.hide(); return false; }
    const cur = win.getBounds();
    const Wz = Math.round(W * zoom), Hz = Math.round(H * zoom);
    /* tol：锚点驱动的落位用 1 DIP（逐帧跟），其它路径用 6 DIP（避免无谓的 setBounds） */
    const t = Math.max(1, Number.isFinite(tol) ? tol : TOL_COARSE);
    if (force || Math.abs(cur.x - p.x) >= t || Math.abs(cur.y - p.y) >= t
        || Math.abs(cur.width - Wz) > 1 || Math.abs(cur.height - Hz) > 1) {
      win.setBounds({ x: p.x, y: p.y, width: Wz, height: Hz });
      const after = win.getBounds();
      log('ISLAND_POS ' + JSON.stringify({ want: p, cur, after, anchor, anchorRect }));
    }
    return true;               // true = 有落点（是否真的 setBounds 由门槛决定）
  }

  function show() {
    const w = ensure();
    if (!w) return;
    if (!place(true)) return;  // 角色矩形还没到：先不亮，免得球摆到工作区中间
    if (!w.isVisible()) w.showInactive();
    w.setAlwaysOnTop(true, 'screen-saver');
  }
  function hide() { if (win && !win.isDestroyed() && win.isVisible()) win.hide(); }

  /* ---------------- 主循环 ----------------
     节奏：内容（波形/歌词/进度/消息）还是 500ms 一推；**定位不在这里** ——
     它由渲染进程的锚点事件驱动（queueAnchor → place(TOL_MOVE)）。
     这里只在两种「几何真的变了」的场合补一次落位：第一次显示、球↔胶囊高度变了。
     这样即使内容停更，胶囊也不会掉帧式地每 500ms 被拽一下。 */
  function tick() {
    if (Date.now() < frozenUntil) return;
    try {
      if (!cfg.enabled) { hide(); return; }
      const pet = petBounds();
      if (!pet) { hide(); return; }
      const modeBefore = mode;
      const payload = buildPayload();
      const hidden = Date.now() < hiddenUntil;
      if (!hidden || payload.mode !== 'idle') {
        if (hidden && payload.mode !== 'idle') hiddenUntil = 0;
        const w = ensure();
        if (!w) return;
        if (!w.isVisible()) {
          /* 先摆好再亮：place() 返回 false = 角色矩形还没到（页面刚起、视频没解出首帧），
             这时候 showInactive 会把球亮在「窗口默认的屏幕正中」—— 正是要避免的那种一秒钟乱跳。 */
          if (place(true)) {
            w.showInactive();
            w.setAlwaysOnTop(true, 'screen-saver');
          }
        } else if (payload.mode !== modeBefore || Math.abs(wantZoom() - zoom) > 0.014) {
          place(true);                                   // 球↔胶囊：可见高度不同，纵向必须重算
        }
        w.webContents.send('island:data', payload);
      } else {
        hide();
      }
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
      /* 页面用 islandInvoke('island_cmd', 'pin') 传字符串，也有地方传 {cmd:'pin'} —— 两种都认 */
      const c = typeof cmd === 'string' ? cmd : String((cmd && cmd.cmd) || '');
      if (c === 'expand') { hiddenUntil = 0; show(); }
      else if (c === 'pin') { pinned = !pinned; hiddenUntil = 0; }
      else if (c === 'dismiss') { pinned = false; hiddenUntil = Date.now() + 60000; hide(); }
      /* 截图/自检：冻结推送，页面里手工 render 的状态才不会被 500ms 一次的实时数据冲掉 */
      else if (c === 'freeze') { frozenUntil = Date.now() + 120000; hiddenUntil = 0; show(); }
      else if (c === 'unfreeze') { frozenUntil = 0; }
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
      lastHit = !!inside;
      /* 拖动中不改穿透：拖到形状边缘时命中会瞬间变 false，若此时把窗口切回穿透，
         后续 mousemove/mouseup 可能直接丢掉，拖动会「半路断掉」。 */
      if (!drag && win && !win.isDestroyed()) win.setIgnoreMouseEvents(!inside, { forward: true });
      return { ok: true };
    },
    'island:drag-start': (_e, pt) => dragStart(pt),
    'island:drag-end': (_e, pt) => dragEnd(pt),
    'island:anchor': (_e, a) => { queueAnchor(a); return { ok: true }; },
    /* 拖动松手才存：把「角色局部锚点」写进 island.json，重启后先按它落位 */
    'island:anchor-commit': (_e, a) => {
      if (!a || !isFinite(a.cx) || !isFinite(a.head)) return { ok: false };
      const round3 = (v) => Math.round(Math.min(1, Math.max(0, Number(v))) * 1000) / 1000;
      cfg.anchor = { cx: round3(a.cx), head: round3(a.head) };
      saveCfg();
      log('ISLAND_ANCHOR_COMMIT ' + JSON.stringify(cfg.anchor));
      return { ok: true, anchor: Object.assign({}, cfg.anchor) };
    },
  };
  function bindIpc() {
    Object.keys(handlers).forEach((ch) => {
      try { ipcMain.handle(ch, handlers[ch]); } catch (e) { /* 重复注册忽略 */ }
    });
    /* 主窗口页面用 send 高频喂锚点（不需要回包）。
       事件驱动后这里只做 latest-only 合并：同一轮事件循环里来多少帧都只落位一次。 */
    try {
      ipcMain.on('island:anchor-raw', (_e, a) => { queueAnchor(a); });
      /* 拖动中的 mousemove 用 send（不回包），避免 60Hz 的 invoke 排队 */
      ipcMain.on('island:drag-move', (_e, pt) => { dragTo(pt); });
    } catch (e) {}
  }

  return {
    bindIpc,
    start,
    stop,
    setCfg: (patch) => noteCfg(patch),
    demo: (what) => handlers['island:demo'](null, what),
    /* 「回到桌宠头顶」= 同时清掉手动偏移（用户表达「摆回默认」） */
    resetPos: () => {
      resetAnchor();
      off = { x: 0, y: 0 };
      if (cfg.off) { delete cfg.off; saveCfg(); }
      place(true);
    },
    cfg: () => Object.assign({}, cfg),
    notify,
    noteAgent,
    noteAnchor,
    resetAnchor,
    queueAnchor,                      // 自检/冒烟用：直接喂一个锚点，走和 IPC 同一条路
    place: (force, tol) => place(force, tol),
    win: () => win,
    state: () => ({ mode, pinned, anchor, anchorRect, zoom, off: { x: off.x, y: off.y }, dragging: !!drag, cfg: Object.assign({}, cfg) }),
  };
}

/* 导出内部工具只为自检（歌词接口/解析），运行时不依赖 */
module.exports = { createIsland, _lyric: { httpGet, parseLrc, fetchLyric } };
