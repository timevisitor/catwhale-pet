/* =============================================================================
 * 猫鲸桌宠 · 动画片段循环（animation-loop）
 * -----------------------------------------------------------------------------
 * 把一个动作视频的 [start, end) 当成一段，反复播放：
 *   - 起播从 start 开始（不是从 0）
 *   - 媒体边界用 requestVideoFrameCallback 逐帧判断，rAF + 定时器兜底
 *   - 真到片尾（ended）也能回卷，不依赖 150ms 的 tick / timeupdate
 *   - stop() 会取消所有回调并暂停视频，绝不留下无限 rAF/rVFC
 *
 * 无 DOM、无副作用、调度器可注入 → 同一份代码跑在渲染进程，
 * 也能被 tests/animation-loop.test.cjs 用假视频 + 假时钟验证边界。
 *
 * 浏览器：window.CatwhaleAnimationLoop
 * Node  ：module.exports
 * ============================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CatwhaleAnimationLoop = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 与 app/preload.js 的缺省值保持一致（后端独立存 animation-loop.json） */
  const DEFAULTS = Object.freeze({ enabled: false, actionId: 'idle', start: 0, end: 2 });
  const MIN_LENGTH = 0.2;   // 太短的片段看起来像卡帧，后端也按这条校验
  const EPS = 0.03;         // 边界容差：24fps 一帧 0.042s，留 30ms 提前回卷
  const MAX_START_SEEK_TRIES = 4;   // 起播/回卷落点最多补 seek 几次；再失败就停，绝不从 0 播错区间

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  function toNum(x) {
    if (typeof x === 'number') return isFinite(x) ? x : NaN;
    if (typeof x === 'string' && x.trim() !== '') {
      const n = Number(x);
      return isFinite(n) ? n : NaN;
    }
    return NaN;
  }

  function fmt(n) {
    if (!isNum(n)) return '—';
    return String(Math.round(n * 1000) / 1000);
  }

  /* 规范化/校验配置。非法就返回可读错误，**绝不静默裁剪**。
     opts.duration：视频真实时长（秒）；只有 >0 时才校验上界。
     opts.actionIds：当前可用动作白名单（可选）。 */
  function normalize(raw, opts) {
    opts = opts || {};
    if (!raw || typeof raw !== 'object') {
      return { ok: false, field: 'config', error: '配置必须是对象' };
    }
    const actionId = typeof raw.actionId === 'string' ? raw.actionId.trim() : '';
    if (!actionId) return { ok: false, field: 'actionId', error: '动作不能为空' };
    if (opts.actionIds && opts.actionIds.indexOf(actionId) < 0) {
      return { ok: false, field: 'actionId', error: '动作不可用：' + actionId };
    }
    let enabled = DEFAULTS.enabled;
    if (raw.enabled !== undefined && raw.enabled !== null) {
      if (typeof raw.enabled !== 'boolean') {
        return { ok: false, field: 'enabled', error: 'enabled 必须是布尔值' };
      }
      enabled = raw.enabled;
    }
    const start = toNum(raw.start);
    const end = toNum(raw.end);
    if (!isNum(start)) return { ok: false, field: 'start', error: '起点必须是数字（秒）' };
    if (!isNum(end)) return { ok: false, field: 'end', error: '终点必须是数字（秒）' };
    if (start < 0) return { ok: false, field: 'start', error: '起点不能小于 0 秒' };
    if (end <= start) return { ok: false, field: 'end', error: '终点必须大于起点' };
    if (end - start < MIN_LENGTH - 1e-9) {
      return { ok: false, field: 'end', error: '区间太短：至少 ' + MIN_LENGTH + ' 秒' };
    }
    const duration = toNum(opts.duration);
    if (isNum(duration) && duration > 0 && end > duration + 1e-6) {
      return { ok: false, field: 'end', error: '终点超出视频时长（' + fmt(duration) + ' 秒）' };
    }
    return { ok: true, config: { enabled: enabled, actionId: actionId, start: start, end: end } };
  }

  /* 按需加载：非 eager 状态初始只有元数据，首次要演它（或空闲时段预选到它）时切成 auto。
     只有「还没有任何元数据，且不在加载中」才调用 load()。
     已有 metadata(readyState>=1) 时 load() 会把 currentTime 重置回 0，
     会把刚设好的片段起点吞掉（真实预览从 0 起播的根因之一），这里绝不这么做。 */
  function ensureVideoData(video) {
    if (!video) return false;
    try { if (video.preload !== 'auto') video.preload = 'auto'; } catch (e) {}
    const rs = Number(video.readyState);
    if (isNum(rs) && rs >= 1) return false;            // 已有元数据 → 只提 preload，不重新 load
    const ns = Number(video.networkState);
    if (ns === 2) return false;                        // NETWORK_LOADING：已经在加载，别反复重置
    try { video.load(); return true; } catch (e) { return false; }
  }

  /* 默认调度器：优先 requestVideoFrameCallback（真正按解码帧回调），
     没有就退 rAF；两者都没有（极端环境）返回 null，只靠定时器兜底。 */
  function defaultRequestFrame(video, cb) {
    if (video && typeof video.requestVideoFrameCallback === 'function') {
      return { kind: 'rvfc', id: video.requestVideoFrameCallback(function () { cb(); }) };
    }
    if (typeof requestAnimationFrame === 'function') {
      return { kind: 'raf', id: requestAnimationFrame(function () { cb(); }) };
    }
    return null;
  }
  function defaultCancelFrame(video, token) {
    if (!token) return;
    try {
      if (token.kind === 'rvfc' && video && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(token.id);
      } else if (token.kind === 'raf' && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(token.id);
      }
    } catch (e) { /* 取消失败不影响语义 */ }
  }

  /* 单段循环播放器。同一时刻只持有一个帧回调 + 一个兜底定时器。 */
  function createPlayer(host) {
    host = host || {};
    const now = host.now || function () {
      return (typeof performance !== 'undefined') ? performance.now() : Date.now();
    };
    const setT = host.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    const clearT = host.clearTimeout || function (id) { clearTimeout(id); };
    const requestFrame = host.requestFrame || defaultRequestFrame;
    const cancelFrame = host.cancelFrame || defaultCancelFrame;

    const st = {
      running: false, video: null, actionId: '', start: 0, end: 0, duration: 0,
      wraps: 0, pausedReason: '', lastTrigger: '', startedAt: 0,
      gen: 0, needStartSeek: false, seekTries: 0,
      frame: null, timer: 0, bound: null, onWrap: null, onError: null
    };

    /* 播放头是否真的落在片段内：起播/回卷落点的确认条件。
       只判 t >= start-EPS 会把“seek 被吞、播放头仍停在片尾”误判成已落点，
       于是每帧 wrap 空转；上界必须排除片尾。 */
    function isInSegment(t) {
      return t >= st.start - EPS && t < st.end - EPS;
    }

    const handlers = {
      ended: function () { if (st.running) wrap('ended'); },
      loadedmetadata: function () {
        if (!st.running) return;
        if (st.needStartSeek) seekToStart('loadedmetadata');
        arm();
      },
      canplay: function () {
        if (!st.running) return;
        // 资源刚加载完时，start() 里设的 currentTime 可能被重置；canplay 必须真的补 seek，
        // 不能只 arm() 等帧回调（那会让预览从 0 秒开始播）。
        if (st.needStartSeek) {
          const t = Number(st.video && st.video.currentTime) || 0;
          if (t < st.start - EPS) seekToStart('canplay');
        }
        arm();
      },
      seeked: function () {
        if (!st.running) return;
        if (st.needStartSeek) {
          // seek 完成才知道真实落点：必须落在片段内（不是仍停在片尾）才算确认
          const t = Number(st.video && st.video.currentTime) || 0;
          if (isInSegment(t)) {
            st.needStartSeek = false;
            st.seekTries = 0;                        // 落点确认后才清零
          } else {
            seekToStart('seeked');
            if (!st.running) return;                 // 重试耗尽，已暂停
          }
        }
        arm();
      }
    };

    function bind(video) {
      if (st.bound === video) return;
      unbind();
      st.bound = video;
      try {
        video.addEventListener('ended', handlers.ended);
        video.addEventListener('loadedmetadata', handlers.loadedmetadata);
        video.addEventListener('canplay', handlers.canplay);
        video.addEventListener('seeked', handlers.seeked);
      } catch (e) { /* 假视频/异常对象不应打断播放 */ }
    }
    function unbind() {
      const v = st.bound;
      st.bound = null;
      if (!v) return;
      try {
        v.removeEventListener('ended', handlers.ended);
        v.removeEventListener('loadedmetadata', handlers.loadedmetadata);
        v.removeEventListener('canplay', handlers.canplay);
        v.removeEventListener('seeked', handlers.seeked);
      } catch (e) {}
    }

    function cancelSlots() {
      if (st.frame) { try { cancelFrame(st.video, st.frame); } catch (e) {} st.frame = null; }
      if (st.timer) { try { clearT(st.timer); } catch (e) {} st.timer = 0; }
    }

    function resume() {
      const v = st.video;
      if (!v) return;
      try {
        const p = v.play();
        if (p && p.catch) p.catch(function () {});
      } catch (e) {}
    }

    /* 把播放点落到片段起点。元数据没到 / 重试耗尽都返回 false；
       重试耗尽时先真正暂停元素、再停调度器并上报 seek-failed ——
       宁可不播，也不能一边显示“已暂停”一边从 0 秒/片尾继续播错区间。 */
    function seekToStart(trigger) {
      const v = st.video;
      if (!v || !st.running) return false;
      if ((Number(v.readyState) || 0) < 1) return false;   // HAVE_NOTHING：等 loadedmetadata
      if (st.seekTries >= MAX_START_SEEK_TRIES) {
        st.needStartSeek = false;
        try { v.pause(); } catch (e) {}                   // 关键：pause() 只停调度器，这里必须停元素
        pause('seek-failed');
        if (typeof st.onError === 'function') {
          try {
            st.onError({ reason: 'seek-failed', trigger: trigger, start: st.start,
                         currentTime: Number(v.currentTime) || 0 });
          } catch (e) {}
        }
        return false;
      }
      st.seekTries++;
      try { v.currentTime = st.start; } catch (e) {}
      if (v.paused) resume();
      return true;
    }

    function arm() {
      cancelSlots();
      if (!st.running || !st.video) return;
      const v = st.video;
      const gen = st.gen;
      st.frame = requestFrame(v, function () { onFrame(gen); });
      const rate = Number(v.playbackRate) > 0 ? Number(v.playbackRate) : 1;
      const t = Number(v.currentTime) || 0;
      const remainMs = Math.max(0, (st.end - t)) / rate * 1000;
      // 兜底：帧回调被节流/停掉（窗口最小化、后台）时仍能在边界附近回卷
      st.timer = setT(function () { onTimer(gen); }, Math.max(40, Math.min(5000, remainMs + 80)));
    }

    function onFrame(gen) {
      st.frame = null;
      if (gen !== st.gen || !st.running) return;     // stop/换视频后迟到的旧回调不能改新状态
      check('frame');
    }
    function onTimer(gen) {
      st.timer = 0;
      if (gen !== st.gen || !st.running) return;
      check('timer');
    }

    function check(trigger) {
      const v = st.video;
      if (!v || !st.running) return;
      if (v.paused) {
        if (v.ended) { wrap(trigger); return; }
        // play() 刚发起时的短暂 paused 是正常的，给它 400ms
        if (now() - st.startedAt < 400) { arm(); return; }
        // 被外部暂停（拖拽/游戏模式/别的状态抢走了解码）→ 自挂起，等重新进入
        pause('video-paused');
        return;
      }
      const t = Number(v.currentTime) || 0;
      if (st.needStartSeek) {
        if (!isInSegment(t)) {
          // 真实播放头还在片段外（起播 seek 被资源加载/不可 seek 吞掉、或回卷落点仍在片尾）
          // → 补 seek，不算回卷；重试次数由 seekToStart 统一限制
          seekToStart(trigger);
          if (!st.running) return;                   // 重试耗尽，已暂停
          arm();
          return;
        }
        st.needStartSeek = false;                    // 已经真的在片段区间内
        st.seekTries = 0;                            // 落点确认后才清零
      }
      if (t >= st.end - EPS) { wrap(trigger); return; }
      arm();
    }

    function wrap(trigger) {
      const v = st.video;
      if (!st.running || !v) return;
      // 必须在 seek 之前取状态：真实 Chromium 的 seek 会同步把 ended 清成 false，
      // seek 之后再判断 v.paused && v.ended 永远是 false，片尾回卷就只 seek 不续播。
      const wasPaused = !!v.paused;
      st.needStartSeek = true;
      // 不清空 seekTries：回卷本身也是一次 seek 尝试，只有确认落到片段内（seeked/check）才清零。
      // 否则 seek 被吞时每帧都从头重试、无限空转回卷，既不上报也停不下来。
      st.seekTries++;
      try { v.currentTime = st.start; } catch (e) {}
      if (wasPaused) resume();
      st.wraps++;
      st.lastTrigger = trigger;
      if (typeof st.onWrap === 'function') {
        try { st.onWrap({ wraps: st.wraps, trigger: trigger }); } catch (e) {}
      }
      arm();
    }

    function start(o) {
      o = o || {};
      const v = o.video;
      if (!v) return false;
      const s = toNum(o.start);
      const e = toNum(o.end);
      if (!isNum(s) || !isNum(e) || !(s < e)) return false;
      cancelSlots();
      st.gen++;
      st.running = true;
      st.video = v;
      st.actionId = typeof o.actionId === 'string' ? o.actionId : '';
      st.start = s;
      st.end = e;
      st.duration = isNum(toNum(o.duration)) ? toNum(o.duration) : 0;
      st.wraps = 0;
      st.pausedReason = '';
      st.startedAt = now();
      st.needStartSeek = true;
      st.seekTries = 0;
      st.onWrap = (typeof o.onWrap === 'function') ? o.onWrap : null;
      st.onError = (typeof o.onError === 'function') ? o.onError : null;
      bind(v);
      try { v.loop = false; } catch (err) {}           // 片段边界自己管，别让媒体循环抢先
      try { v.currentTime = s; } catch (err) {}
      resume();
      arm();
      return true;
    }

    function pause(reason) {
      const had = st.running;
      st.gen++;                                        // 让已排队的帧/定时器回调失效
      cancelSlots();
      unbind();                                        // 切走/自挂起后，迟到的 canplay/ended 不许再把旧片段播回来
      st.running = false;
      st.pausedReason = reason || 'paused';
      if (had) st.lastTrigger = 'pause';
    }

    function stop(o) {
      o = o || {};
      const v = st.video;
      st.gen++;
      cancelSlots();
      unbind();
      st.running = false;
      st.pausedReason = 'stopped';
      st.lastTrigger = 'stop';
      if (v && o.pause !== false) { try { v.pause(); } catch (e) {} }
      st.video = null;
      st.onWrap = null;
      st.onError = null;
      return true;
    }

    function info() {
      return {
        running: st.running, actionId: st.actionId, start: st.start, end: st.end,
        duration: st.duration, wraps: st.wraps, pausedReason: st.pausedReason,
        trigger: st.lastTrigger, seekTries: st.seekTries
      };
    }

    return { start: start, pause: pause, stop: stop, info: info, isRunning: function () { return st.running; } };
  }

  return {
    DEFAULTS: DEFAULTS,
    MIN_LENGTH: MIN_LENGTH,
    EPS: EPS,
    MAX_START_SEEK_TRIES: MAX_START_SEEK_TRIES,
    normalize: normalize,
    ensureVideoData: ensureVideoData,
    formatSeconds: fmt,
    createPlayer: createPlayer
  };
});
