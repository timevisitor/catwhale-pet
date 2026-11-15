/* =====================================================================
   本地媒体演出 · 页面侧（web/media-show.js，UMD）
   
   职责：把主进程推来的 {kind:'video'|'music', playing, info} 变成
        「该演哪个状态 + 演多久 + 现在能不能演」。
   
   为什么单独成文件而不是塞进 index.html：
   - index.html 已经 20 万字符，且内联脚本改完必须抽出来 node --check；
     新逻辑独立成文件能直接被 Node 单测（tests/media-show-page.test.cjs）。
   - 与 emotion.js / director.js 的做法保持一致（同是无 DOM 依赖的 UMD）。
   
   优先级设计（在 resolveState 里只占一档，见 index.html 的 1.45）：
     拖拽 > 固定片段 > 聊天干活 > 表情 > **媒体演出** > Agent 看板 > 面板 > 长任务 > 一次性 > 空闲
   为什么比 Agent 看板高：用户在看视频/听歌是"正在发生的事"，
   而 Agent 看板是后台信息；先把「跟用户同步」演出来更合理。但比聊天/表情低，
   因为那两者是用户直接互动。
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CatwhaleMediaShow = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 状态 id ←→ 媒体类别。素材缺失时由页面按 states[id].__missing 兜底。 */
  const STATE_OF = { video: 'watch_tv', music: 'sing_mic' };

  /* 每个演出状态的保底时长：素材时长读不到时用它（实测两段各 4.0~5.2s） */
  const FALLBACK_MS = 4200;

  /* 主进程没给 info 时的展示文案 */
  const KIND_LABEL = { video: '看视频', music: '听音乐' };

  /* 「偶尔动一下」：一直在看视频不该 24 小时不停重复同一段循环动画。
     策略是「演 N 段 → 歇一会儿 → 再演」，歇的期间回到正常的空闲行为。
     这样长时间看片时桌宠还是活的，而不是一台复读机。 */
  const DEFAULT_PATTERN = {
    cycles: 3,          // 连续演几遍
    restMs: 24000,      // 然后歇多久
    jitterMs: 6000,     // 歇的时长随机抖动，避免像节拍器
  };

  function create(opts) {
    const o = opts || {};
    const pat = Object.assign({}, DEFAULT_PATTERN, o.pattern || {});

    const S = {
      enabled: o.enabled !== false,     // 设置里的总开关
      available: true,                  // 素材是否齐（缺素材时整个功能降级）
      missing: [],                      // 缺了哪些状态
      kind: null,                       // 主进程确认的类别（'video' | 'music' | null）
      playing: false,                   // 主进程认为正在放
      info: null,                       // {app,title,artist,peak,source...}
      paused: false,                    // 页面侧临时压制（拖拽中/游戏模式）
      /* 演出节奏 */
      shown: 0,                         // 本轮已连演几遍
      until: 0,                         // 当前这段演到什么时候
      restedUntil: 0,                   // 休息到什么时候
      /* 统计，给 --diag 和设置面板看 */
      lastStartAt: 0,
      starts: 0,
      lastReason: '',
    };

    function now() { return Date.now(); }

    /* 主进程推来新状态：只记事实，不在这里改状态机 */
    function update(msg) {
      const m = msg || {};
      S.enabled = m.enabled === undefined ? S.enabled : !!m.enabled;
      S.kind = m.kind || null;
      S.playing = !!m.playing && !!m.kind;
      S.info = m.info || null;
      if (!S.playing) { S.shown = 0; S.until = 0; S.restedUntil = 0; }
    }

    /* 素材可用性：页面把 states 里这两个 id 有没有 __missing 告诉它 */
    function setAvailability(map) {
      S.missing = [];
      for (const k in STATE_OF) {
        const id = STATE_OF[k];
        if (!map || !map[id]) S.missing.push(id);
        else if (map[id].missing) S.missing.push(id);
      }
      S.available = S.missing.length === 0;
      return S.available;
    }

    /* 能不能演：开关开 + 素材齐 + 正在放 + 没被压制 + 该演的那个状态存在 */
    function canShow() {
      if (!S.enabled || !S.available || !S.playing || S.paused) return false;
      const id = STATE_OF[S.kind];
      return !!id && S.missing.indexOf(id) < 0;
    }

    /* 当前应当进入哪个状态。返回 '' 表示不介入（交回原有优先级链）。 */
    function stateId() {
      if (!canShow()) return '';
      const id = STATE_OF[S.kind];
      if (S.shown >= pat.cycles && now() < S.restedUntil) return '';
      return id;
    }

    /* 一段演完时由页面调用：累计遍数，够了就进入休息 */
    function onCycleDone() {
      if (!canShow()) return '';
      S.shown++;
      if (S.shown >= pat.cycles) {
        S.restedUntil = now() + pat.restMs + Math.floor(Math.random() * pat.jitterMs);
      }
      return S.shown >= pat.cycles ? 'rest' : 'continue';
    }

    /* 休息结束（由页面 tick 调用）：重置计数，允许再演一轮 */
    function tickRest() {
      if (S.shown >= pat.cycles && now() >= S.restedUntil) { S.shown = 0; return true; }
      return false;
    }

    function noteStart(id) {
      S.lastStartAt = now();
      S.starts++;
      S.lastReason = (S.info && S.info.title) ? (S.info.title + ' ｜ ' + (S.info.app || '')) : (S.info && S.info.app) || '';
      S.until = now() + FALLBACK_MS;
      return id;
    }

    function snapshot() {
      return {
        enabled: S.enabled, available: S.available, missing: S.missing.slice(),
        kind: S.kind, playing: S.playing, paused: S.paused,
        state: stateId(),
        info: S.info,
        shown: S.shown, cycles: pat.cycles,
        resting: S.shown >= pat.cycles && now() < S.restedUntil,
        restLeftMs: Math.max(0, S.restedUntil - now()),
        starts: S.starts, lastStartAt: S.lastStartAt, lastReason: S.lastReason,
        label: S.kind ? (KIND_LABEL[S.kind] || '') : '',
      };
    }

    return {
      update, setAvailability, canShow, stateId, onCycleDone, tickRest, noteStart,
      snapshot,
      setEnabled(v) { S.enabled = !!v; if (!v) { S.shown = 0; } return S.enabled; },
      setPaused(v) { S.paused = !!v; return S.paused; },
      stateOf: (kind) => STATE_OF[kind] || '',
      STATE_OF, KIND_LABEL, DEFAULT_PATTERN,
      _state: S,
    };
  }

  return { create, STATE_OF, KIND_LABEL, DEFAULT_PATTERN };
}));
