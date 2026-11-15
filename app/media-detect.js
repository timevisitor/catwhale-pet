/* =====================================================================
   本地媒体演出 · 检测与判定核心（纯逻辑，无 Electron / 无 DOM 依赖）
   
   为什么要有这一层：
   - Windows SMTC（GlobalSystemMediaTransportControlsSessionManager）能给出
     title/artist/genres/PlaybackType，但**大量中文音乐 App 根本不注册会话**。
     本机实测网易云音乐正在播放时 SMTC 会话列表为空 —— 只靠 SMTC 会漏掉
     最主要的音乐场景。
   - WASAPI 音频会话（IAudioSessionManager2 + IAudioMeterInformation）能告诉
     我们「哪个进程真的在往默认输出设备送样本、电平多少」，但对 App 内部在放
     什么一无所知。
   两者互补：WASAPI 决定「有没有在放」，SMTC 决定「放的是歌还是视频」。

   本模块只做纯判定，方便用 Node 直接单测（tests/media-show.test.cjs）。
   ===================================================================== */
'use strict';

/* 应用分类表。key 为小写匹配串，命中顺序：先 video 后 music 再浏览器。
   宁可把「认不出来」判成 unknown 而不是瞎猜 —— 猜错会让桌宠演错动作。 */
const VIDEO_APPS = [
  // 影视客户端
  'potplayer', 'vlc', 'mpv', 'mpc-hc', 'mpc-be', 'kmplayer', 'gomplayer',
  'iqiyi', 'qiyi', 'qyclient', 'qyclientd', 'tencentvideo', 'qqlive', 'youku', 'mgtv', 'sohu', 'pptv',
  'netflix', 'disney', 'primevideo', 'hbomax',
  '爱奇艺', '腾讯视频', '优酷', '芒果', '搜狐视频',
  // 本地播放器
  'wmplayer', 'windows media player', 'movies & tv', 'films & tv', 'zune',
  'media player', 'foobar2000_video',
];
const VIDEO_APP_STRONG = [
  'potplayer', 'vlc', 'mpv', 'mpc-hc', 'mpc-be', 'iqiyi', 'qiyi', 'qyclient',
  'tencentvideo', 'qqlive', 'youku', 'mgtv', 'netflix', 'wmplayer', 'kmplayer', 'gomplayer',
];

const MUSIC_APPS = [
  'cloudmusic', 'netease', '网易云', 'music.163',
  'qqmusic', 'qq音乐', 'tencentmusic', 'qqtvmusic',
  'kugou', '酷狗', 'kuwo', '酷我', 'migu', '咪咕',
  'spotify', 'applemusic', 'apple music', 'itunes', 'amazonmusic', 'tidal',
  'deezer', 'soundcloud', 'musicbee', 'aimp', 'foobar2000', 'winamp',
  'youtube music', 'music.youtube',
];

const BROWSER_APPS = ['chrome', 'msedge', 'edge', 'firefox', 'brave', 'opera',
                      'vivaldi', 'safari', '360se', '360chrome', 'qqbrowser', 'quark'];

/* 浏览器里怎么区分听歌还是看片。
   借鉴 web-scrobbler（3k star，专做「这一页是不是在放歌」）的做法：
   它不靠 PlaybackType 猜，而是**按站点声明**——Bilibili 被明确标为 video 站
   （src/connectors/bilibili.ts 头注释：'Since BiliBili is a video site...'），
   只有视频带「音乐」标签时才升级成歌曲。我们的层级照此安排：

   1) 站点身份（窗口标题里的域名/站名）——最硬的证据
   2) 容器扩展名（本地文件）
   3) 元数据：有 artist 才算歌
   4) PlaybackType 只作弱提示（它是播放方自报的，B站会报 Music，不可信）
   5) 兜底：浏览器里有声无元数据 → video

   注：PlaybackType 的语义是 MediaPlaybackType 枚举（Unknown/Music/Video/Image），
   由页面自己经 Media Session API 声明，所以站点谎报/默认值都要考虑。 */
const MUSIC_HOSTS = ['music.163', 'y.qq', 'music.youtube', 'spotify', 'kugou', 'kuwo',
                     'migu', 'xiami', 'bandcamp', 'soundcloud', 'deezer', 'tidal',
                     /* 中文站名：窗口标题里出现的是这些，不是 URL 片段 */
                     '网易云音乐', 'qq音乐', '酷狗音乐', '酷我音乐', '咪咕音乐',
                     'youtube music', 'apple music', '汽水音乐', '千千音乐'];
/* 视频站：命中即 video（除非另有音乐区特征）。含中英文站名与域名片段。 */
const VIDEO_HOSTS = ['bilibili', 'youtube', 'youku', 'iqiyi', 'v.qq.com', 'mgtv',
                     'netflix', 'twitch', 'dailymotion', 'douyin', 'ixigua',
                     /* 中文站名 */
                     '哔哩哔哩', '腾讯视频', '爱奇艺', '优酷', '芒果tv', '西瓜视频',
                     '抖音', '快手', 'acfun', 'a站'];
/* 站内的音乐区/音频区（同一站点里要反过来判成 music 的子路径） */
const MUSIC_ZONE = /bilibili\.com\/audio|音频区|音乐区|radio|\/music\b/;
const VIDEO_TITLE_HINTS = [' - 第', '集', '电视剧', '电影', '正片', '花絮', '预告',
                           'episode', 'ep.', 'movie', 'trailer', '直播', '番剧', '动漫'];

/* 常见音乐/视频容器扩展名：SMTC 标题常是文件名 */
const MUSIC_EXT = /\.(mp3|flac|m4a|aac|wav|ogg|opus|wma|ape|dsf|dff)$/i;
const VIDEO_EXT = /\.(mp4|mkv|avi|mov|wmv|flv|webm|ts|m2ts|rmvb|m4v)$/i;

function norm(s) { return String(s == null ? '' : s).toLowerCase(); }

function hitAny(hay, list) {
  for (const k of list) { if (hay.indexOf(k) >= 0) return k; }
  return '';
}

/* 从 SMTC 的 AUMID 里取出可读的应用名。
   Edge 的 AUMID 形如 MSEdge；网易云的是 cloudmusic.exe；PotPlayer 是 PotPlayerMini64.exe。
   实测还会有带发布者/档案段的形式：MSEdge.edgebiliprofile2.Default（Edge 用独立 user-data-dir
   启动时就是这样）。点号后面那段只是包标识，不是应用名，要剥掉，
   否则日志与展示里会冒出「另一个应用」，也让人误判是不是新进程。 */
function appKey(aumid) {
  const s = norm(aumid);
  if (!s) return '';
  let base = s.split(/[\\/]/).pop();
  base = base.replace(/\.exe$/, '');
  /* 只在第一段足够长时截断，避免把 'music.163' 这类合法名字切坏 */
  const dot = base.indexOf('.');
  if (dot >= 3) base = base.slice(0, dot);
  return base;
}

function isBrowser(app) {
  const a = norm(app);
  if (!a) return false;
  return !!hitAny(a, BROWSER_APPS);
}

/* ---------- 单个会话 → 动作类别 ---------- */
function classifySession(sess) {
  /* 返回 'video' | 'music' | 'unknown'
     判定顺序是本模块的核心，改动前先看 tests/media-show.test.cjs 的用例。 */
  if (!sess) return 'unknown';
  const app = appKey(sess.app);
  const rawApp = norm(sess.app);
  const title = norm(sess.title);
  const artist = String(sess.artist == null ? '' : sess.artist).trim();
  const genres = Array.isArray(sess.genres) ? sess.genres.map(norm) : [];
  const pbType = norm(sess.pbTypeProps || sess.pbType || '');

  // 1) 明确的容器扩展名优先（用户直接双击文件，最可信）
  if (VIDEO_EXT.test(title)) return 'video';
  if (MUSIC_EXT.test(title)) return 'music';

  // 2) 强视频 App
  if (hitAny(rawApp, VIDEO_APP_STRONG)) return 'video';

  // 3) 音乐 App（含网易云等不注册 SMTC 的，走 WASAPI 分支时 app 名同样是这个）
  if (hitAny(rawApp, MUSIC_APPS)) return 'music';

  // 4) 浏览器：站点身份 → 元数据 → PlaybackType 弱提示
  if (isBrowser(rawApp)) {
    /* 窗口标题（站点名/页面名）是这里最硬的信号，必须排在 pbType 之前。
       实测反例：Edge 播 B 站视频，SMTC 报 PlaybackType=Music 且 artist 为空
       （标题是纯中文视频名，不含 bilibili 字样），只看 pbType 就判成音乐了。 */
    const win = norm(sess.win || sess.windowTitle || '');
    const siteHay = (win + ' ' + title);
    if (siteHay.trim()) {
      /* 音乐区优先于视频站：B 站音乐区（bilibili.com/audio）同时含 bilibili 与音乐区特征，
         先判视频站就会把听歌演成看电视。 */
      if (MUSIC_ZONE.test(siteHay)) return 'music';
      if (hitAny(siteHay, MUSIC_HOSTS)) return 'music';
      if (hitAny(siteHay, VIDEO_HOSTS)) return 'video';
    }
    /* 艺术家是「真的在放歌」的强证据（音乐站都会给），排在 pbType 之前 */
    if (artist) return 'music';
    if (VIDEO_EXT.test(title)) return 'video';
    if (MUSIC_EXT.test(title)) return 'music';
    if (hitAny(title, VIDEO_TITLE_HINTS)) return 'video';
    /* PlaybackType 只作弱提示：Video 可信度高（没人会把手放歌谎报成视频），
       Music 不可信（B 站视频实测就报 Music），所以 Music 不单独定案。 */
    if (pbType === 'video') return 'video';
    if (genres.some((g) => g.indexOf('video') >= 0 || g.indexOf('movie') >= 0)) return 'video';
    return 'video';   // 兜底当看片：浏览器里有声但无元数据，绝大多数是在看视频
  }

  // 5) 其余影视客户端
  if (hitAny(rawApp, VIDEO_APPS)) return 'video';

  // 6) 有艺术家信息 → 音乐；有 genre 但没艺术家也可能是播客/音乐
  if (artist) return 'music';
  if (pbType === 'music') return 'music';
  if (pbType === 'video') return 'video';
  if (genres.length) {
    if (genres.some((g) => g.indexOf('video') >= 0 || g.indexOf('movie') >= 0)) return 'video';
    return 'music';
  }
  return 'unknown';
}

/* ---------- 合并 SMTC + WASAPI → 当前演出 ---------- */
/* 规则（每条都有实测依据）：
   1. WASAPI 里有电平（> 阈值）的进程才算「真的在放」；SMTC 说 Playing 但没声
      （静音播放/被系统独占）不算 —— 否则桌宠会对着一片安静演出。
   2. SMTC 有对应会话 → 采信它的分类，标题/艺术家一起带出来。
   3. SMTC 没会话但 WASAPI 有 → 说明是不注册 SMTC 的 App（实测网易云），
      用进程名分类；分类不出来给 'unknown'，**不演**（宁可不演也别演错）。
   4. 桌宠自己要排除：它自己的视频是 muted 的，正常不会有音频会话，
      但仍显式排除自身进程名/pid，避免将来解开音轨后自触发。
*/
const PEAK_MIN = 0.004;      // 实测静音底噪 <0.001，正常播放 0.1~0.3
const PEAK_IDLE_MS = 2500;   // 电平跌破阈值后多久算「停了」（防间奏/静音段抖断）
const SELF_PROCS = ['electron', '桌宠', 'catwhale-pet'];

function isSelfProc(proc, selfPid) {
  const p = norm(proc);
  if (!p) return false;
  return SELF_PROCS.indexOf(p) >= 0;
}

function pickWasapi(wasapiList, selfPid) {
  const out = [];
  for (const w of (wasapiList || [])) {
    if (!w || !w.proc) continue;
    if (isSelfProc(w.proc, selfPid)) continue;
    if (w.pid && selfPid && Number(w.pid) === Number(selfPid)) continue;
    const peak = Number(w.peak || 0);
    if (w.state !== 'Active' && peak < PEAK_MIN) continue;
    out.push({ proc: w.proc, pid: w.pid, peak, active: peak >= PEAK_MIN,
               win: String(w.win == null ? '' : w.win) });
  }
  return out;
}

/* 主判定：给一次采样（smtc 数组 + wasapi 数组），返回演出意图
   -> { kind:'video'|'music'|null, playing:bool, source, app, title, artist, peak, confidence } */
function decide(sample, opts) {
  const o = opts || {};
  const smtc = (sample && Array.isArray(sample.smtc)) ? sample.smtc : [];
  const wasapi = pickWasapi(sample && sample.wasapi, o.selfPid);

  const loud = wasapi.filter((w) => w.active).sort((a, b) => b.peak - a.peak);
  const quiet = wasapi.filter((w) => !w.active);

  // 1) SMTC 里状态为 Playing 且对应进程有电平 → 最可信
  const playingSmtc = smtc.filter((s) => norm(s.status) === 'playing');

  /* SMTC 的 app 名（AUMID/进程名）与 WASAPI 进程名不是一回事：
     Edge 在 SMTC 里是 'MSEdge'，在 WASAPI 里是 'msedge'；都要能对上。 */
  function sesMatchesWasapi(s, w) {
    const a = appKey(s.app);
    const p = norm(w.proc);
    if (!a || !p) return false;
    return a === p || a.indexOf(p) >= 0 || p.indexOf(a) >= 0;
  }

  if (loud.length) {
    for (const s of playingSmtc) {
      const w = loud.find((x) => sesMatchesWasapi(s, x));
      if (w) {
        /* 把 WASAPI 侧的窗口标题并进会话再分类：SMTC 给的 pbType 对浏览器不可靠
           （实测 Edge 播 B 站视频报 Music），窗口标题里的站点名才是硬证据。 */
        const kind = classifySession(Object.assign({}, s, { win: w.win || '' }));
        if (kind !== 'unknown') {
          return {
            playing: true, kind,
            source: 'smtc', app: s.app || w.proc, proc: w.proc, pid: w.pid,
            title: s.title || '', artist: s.artist || '', album: s.album || '',
            pbType: s.pbTypeProps || s.pbType || '',
            peak: w.peak, confidence: 'high',
          };
        }
        // 有会话但分类不出来 → 走下面的兜底，别直接放弃
      }
    }

    // 2) 没有匹配的 SMTC 会话 → 用进程名 + 窗口标题分类（网易云等实测不注册 SMTC）
    for (const w of loud) {
      const kind = classifySession({ app: w.proc, title: '', artist: '', genres: [], win: w.win || '' });
      if (kind !== 'unknown') {
        // 若 SMTC 里有同名但非 Playing 的会话，仍带出标题做展示（不改变分类）
        const loose = smtc.find((s) => sesMatchesWasapi(s, w));
        return {
          playing: true, kind, source: 'wasapi',
          app: w.proc, proc: w.proc, pid: w.pid,
          title: (loose && loose.title) || '', artist: (loose && loose.artist) || '',
          album: (loose && loose.album) || '',
          peak: w.peak, confidence: loose ? 'medium' : 'medium',
        };
      }
    }

    // 3) 有声但完全不认识 → unknown（不演）
    return {
      playing: true, kind: null, source: 'wasapi', app: loud[0].proc, proc: loud[0].proc,
      pid: loud[0].pid, title: '', artist: '', peak: loud[0].peak, confidence: 'low',
    };
  }

  return { playing: false, kind: null, source: '', app: '', proc: '', title: '', artist: '',
           peak: 0, confidence: 'none' };
}

/* ---------- 去抖：把逐次采样收敛成「持续在放 X」 ---------- */
/* 为什么需要：进度条拖动、切歌、缓冲、视频暂停都会让电平瞬时归零或抖动；
   桌宠如果跟着闪，观感很差。规则：
   - 同样的 kind 持续 START_MS 才算「开始演」
   - 停止后要 STOP_MS 才真的收（SMTC 的暂停是立刻可见的，但 WASAPI 电平
     有几百毫秒拖尾，实测约 0.3~0.8s）
   - kind 变化（音乐切视频）按「新开始」处理，不必等原先的停止 */
function createSmoother(cfg) {
  const c = Object.assign({ startMs: 1200, stopMs: 2500 }, cfg || {});
  let cur = null;          // 当前确认的 kind
  let candKind = null;     // 候选 kind
  let candSince = 0;
  let lastLoudAt = 0;
  let lastInfo = null;

  return {
    /* 返回 { kind, changed, phase:'start'|'stop'|'same'|'', info } */
    push(decision, nowMs) {
      /* 注意：不能用 `Number(nowMs) || Date.now()` —— 时间戳 0 是合法值（单测用 0 起算），
         会被 falsy 判断吞成 Date.now()，导致整个去抖序列错乱。 */
      const t = (nowMs === undefined || nowMs === null || Number.isNaN(Number(nowMs)))
        ? Date.now() : Number(nowMs);
      const d = decision || {};
      const kind = d.playing ? d.kind : null;

      if (kind) {
        lastLoudAt = t;
        lastInfo = d;
      }

      // 明确停止
      if (!kind) {
        if (cur) {
          if (t - lastLoudAt >= c.stopMs) {
            const was = cur;
            cur = null; candKind = null; candSince = 0;
            return { kind: null, prev: was, changed: true, phase: 'stop', info: lastInfo };
          }
          return { kind: cur, changed: false, phase: 'same', info: lastInfo };
        }
        candKind = null; candSince = 0;
        return { kind: null, changed: false, phase: '', info: null };
      }

      if (kind === cur) {
        candKind = null; candSince = 0;
        return { kind: cur, changed: false, phase: 'same', info: d };
      }

      // 候选：与当前不同（或当前为空）
      if (kind !== candKind) { candKind = kind; candSince = t; }
      const need = cur ? Math.min(c.startMs, 600) : c.startMs;   // 切换类别可以快一点
      if (t - candSince >= need) {
        const prev = cur;
        cur = kind; candKind = null; candSince = 0;
        return { kind: cur, prev, changed: true, phase: 'start', info: d };
      }
      return { kind: cur, changed: false, phase: '', info: d };
    },
    current() { return cur; },
    reset() { cur = null; candKind = null; candSince = 0; lastLoudAt = 0; lastInfo = null; },
    /* 用于「本次采样是否还听得见」：让上层判断要不要继续演 */
    lastLoudAge(nowMs) { return lastLoudAt ? (Number(nowMs) || Date.now()) - lastLoudAt : Infinity; },
  };
}

module.exports = {
  VIDEO_APPS, VIDEO_APP_STRONG, MUSIC_APPS, BROWSER_APPS,
  MUSIC_HOSTS, VIDEO_HOSTS, VIDEO_TITLE_HINTS, MUSIC_EXT, VIDEO_EXT,
  PEAK_MIN, PEAK_IDLE_MS,
  appKey, isBrowser, classifySession, decide, pickWasapi, createSmoother, norm,
};
