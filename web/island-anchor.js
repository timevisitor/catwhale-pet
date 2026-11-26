/* 灵动岛锚点上报器（渲染进程侧，v0.7.1 事件驱动版）
 *
 * 为什么要有这个文件：胶囊/球挂在「角色头顶」上，而 Electron 版桌宠窗口铺满整个
 * 工作区、角色是在窗口里被 place() 挪来挪去的 —— 只有渲染进程知道角色此刻在哪。
 * v0.7.0 是「700ms 定时 + 500ms 节流」把锚点推给主进程，主进程再按 6 DIP 门槛
 * setBounds：走动时胶囊落后一整拍、还一跳 6px，观感就是「不丝滑」。
 *
 * 这一版的约定（每一条都有 tests/island-anchor.test.cjs 断言）：
 *   ① 事件驱动：由角色移动 / 动作切换触发（poke），不再由定时器推着走；
 *   ② 按帧合并：同一帧里 poke 多少次都只合成**一次**上报（latest-only）；
 *   ③ 只在变化时发：矩形变化 < 0.5 DIP、锚点变化 < 2% 一律不发 —— 静止时零上报；
 *   ④ 廉价/昂贵分开：每帧只取 rect（getBoundingClientRect），逐像素头顶识别
 *      只在「动作状态换了 / 距上次到 1.2s / 强制」时做一次；
 *   ⑤ 呼吸和真移动分开：锚点在矩形内的微小漂移（呼吸、摆尾）沿用旧值，
 *      动作状态切换才允许整块刷新（pause 时带 pose:true 让主进程立刻采纳）。
 *
 * 用法：
 *   const rep = CatwhaleIslandAnchor.create({
 *     rect() -> {x,y,w,h} | null      // 屏幕 DIP，角色的可见矩形
 *     head(key) -> {cx,head} | null   // 角色矩形内归一化锚点（贵的那个）
 *     key() -> string                 // 动作状态 id（换了就重算 head）
 *     send(payload)                   // 送主进程
 *     now()、raf(cb)                  // 可注入，便于 node 侧单测
 *   });
 *   rep.poke();            // 角色动了 / 状态变了
 *   rep.poke({force:true}); // 强制下一帧发一次（换皮肤、镜像、首帧）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CatwhaleIslandAnchor = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const EPS_RECT = 0.5;        // 屏幕 DIP：窗口坐标是整数，半像素以下不算移动
  const EPS_ANCHOR = 0.02;     // 角色矩形内归一化（430px 高时约 8.6px）＝呼吸/摆尾的量级
  const HEAD_MIN_MS = 1200;    // 逐像素头顶识别的最短间隔
  const DEFAULT_HEAD = { cx: 0.5, head: 0.22 };

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  function create(env) {
    const e = env || {};
    const now = typeof e.now === 'function' ? e.now : () => Date.now();
    const raf = typeof e.raf === 'function'
      ? e.raf
      : (cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(() => cb(now()), 16));
    const keyOf = typeof e.key === 'function' ? e.key : () => '';

    let queued = false;
    let forceNext = false;
    let disposed = false;
    let head = null, headKey = '', headAt = 0;
    let last = null;                       // 上次真正发出去的那一份
    const stats = { flushes: 0, sends: 0, headScans: 0, dropped: 0, idleFlushes: 0, lastSendAt: 0, maxGapMs: 0 };

    function scanHead(key) {
      stats.headScans += 1;
      let r = null;
      try { r = typeof e.head === 'function' ? e.head(key) : null; } catch (err) { r = null; }
      if (r && isFinite(r.cx) && isFinite(r.head)) head = { cx: clamp01(r.cx), head: clamp01(r.head) };
      headKey = key;
      headAt = now();
      return head;
    }

    function flush() {
      queued = false;
      stats.flushes += 1;
      if (disposed) return;
      let r = null;
      try { r = typeof e.rect === 'function' ? e.rect() : null; } catch (err) { r = null; }
      /* 角色还没起来（视频没解出首帧 / 皮肤热重载中）：这一帧直接跳过，不往上塞垃圾 */
      if (!r || !(r.w > 0) || !(r.h > 0)) { stats.dropped += 1; return; }

      const key = String(keyOf() || '');
      const force = forceNext;
      forceNext = false;
      const stateChanged = key !== headKey;
      if (force || !head || stateChanged || (now() - headAt) >= HEAD_MIN_MS) scanHead(key);

      const a = head || DEFAULT_HEAD;
      let cx = a.cx, hd = a.head;
      if (last) {
        /* 呼吸/摆尾：锚点抖这么点就沿用上次的值，窗口别跟着一起呼吸 */
        if (Math.abs(cx - last.cx) < EPS_ANCHOR) cx = last.cx;
        if (Math.abs(hd - last.head) < EPS_ANCHOR) hd = last.head;
      }

      if (!force && last
          && Math.abs(last.sx - r.x) < EPS_RECT && Math.abs(last.sy - r.y) < EPS_RECT
          && Math.abs(last.rw - r.w) < EPS_RECT && Math.abs(last.rh - r.h) < EPS_RECT
          && Math.abs(last.cx - cx) < 1e-9 && Math.abs(last.head - hd) < 1e-9) {
        stats.idleFlushes += 1;            // 什么都没变：不发。静止时 0 上报就是这么来的
        return;
      }

      const t = now();
      if (stats.lastSendAt && t - stats.lastSendAt > stats.maxGapMs) stats.maxGapMs = t - stats.lastSendAt;
      stats.lastSendAt = t;
      stats.sends += 1;
      last = { sx: r.x, sy: r.y, rw: r.w, rh: r.h, cx: cx, head: hd, t: t };
      try {
        e.send({
          cx: cx, head: hd,
          sx: r.x, sy: r.y, rx: 0, ry: 0, rw: r.w, rh: r.h,
          pose: !!(force || stateChanged),
          /* 这一份 cx/head 到底是量出来的还是兜底值：没量到时主进程要沿用上次存的相对锚点，
             别用 0.5/0.22 把「重启后回到原位」冲掉。 */
          meas: !!head,
        });
      } catch (err) { /* 宿主还没接上：丢掉这一帧，下一帧再说 */ }
    }

    function poke(opts) {
      if (disposed) return;
      if (opts && opts.force) forceNext = true;
      if (queued) return;                  // 同一帧里的后续 poke 并进已排队的那次
      queued = true;
      raf(flush);
    }

    return {
      poke: poke,
      flush: flush,                        // 测试/自检用：立刻结算一次
      reset: function () { disposed = false; queued = false; forceNext = false; head = null; headKey = ''; headAt = 0; last = null; },
      dispose: function () { disposed = true; },
      lastPayload: function () { return last ? Object.assign({}, last) : null; },
      stats: function () { return Object.assign({}, stats, { pending: queued, headKey: headKey }); },
      consts: { EPS_RECT: EPS_RECT, EPS_ANCHOR: EPS_ANCHOR, HEAD_MIN_MS: HEAD_MIN_MS, DEFAULT_HEAD: DEFAULT_HEAD },
    };
  }

  return { create: create, EPS_RECT: EPS_RECT, EPS_ANCHOR: EPS_ANCHOR, HEAD_MIN_MS: HEAD_MIN_MS, DEFAULT_HEAD: DEFAULT_HEAD };
});
