'use strict';
/* 动画片段循环的核心行为测试（不需要 Electron / 真视频 / 网络）。
   运行：node --test tests/animation-loop.test.cjs
   只测公开接口（normalize / createPlayer），不镜像内部实现。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const AnimationLoop = require(path.join(__dirname, '..', 'web', 'animation-loop.js'));

function fakeVideo(duration = 4.042, opts) {
  opts = opts || {};
  const listeners = new Map();
  const v = {
    duration: duration,
    _t: 0,
    readyState: opts.readyState != null ? opts.readyState : 4,
    networkState: opts.networkState != null ? opts.networkState : 1,
    paused: true,
    ended: false,
    loop: true,
    playbackRate: 1,
    playCount: 0,
    pauseCount: 0,
    loadCount: 0,
    seekLog: [],
    clearEndedOnSeek: !!opts.clearEndedOnSeek,   // 真实 Chromium：seek 会同步把 ended 清成 false
    ignoreSeek: !!opts.ignoreSeek,               // 模拟资源还不可 seek：赋值被吞掉，currentTime 不变
    play() {
      this.paused = false; this.ended = false; this.playCount++;
      return Promise.resolve();
    },
    pause() { this.paused = true; this.pauseCount++; },
    load() {
      this.loadCount++;
      this.readyState = 0;
      this._t = 0;                               // 真实 load() 会把播放点重置回 0
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      const set = listeners.get(type);
      if (set) set.delete(fn);
    },
    fire(type) {
      const set = listeners.get(type);
      if (set) for (const fn of Array.from(set)) fn({ type: type });
    },
    listenerCount(type) { return listeners.has(type) ? listeners.get(type).size : 0; }
  };
  Object.defineProperty(v, 'currentTime', {
    get() { return this._t; },
    set(t) {
      this.seekLog.push(t);
      if (this.ignoreSeek) return;
      this._t = t;
      if (this.clearEndedOnSeek && this.ended) this.ended = false;
    },
    configurable: true
  });
  return v;
}

function fakeScheduler() {
  let clock = 0, frameId = 0, timerId = 0;
  const frames = new Map();     // id -> {cb, cancelled}
  const timers = new Map();     // id -> {fn, at}
  const host = {
    now: () => clock,
    requestFrame(video, cb) {
      const id = ++frameId;
      frames.set(id, { cb: cb, cancelled: false });
      return { kind: 'fake', id: id };
    },
    cancelFrame(video, token) {
      const it = frames.get(token.id);
      if (it) it.cancelled = true;
      frames.delete(token.id);
    },
    setTimeout(fn, ms) {
      const id = ++timerId;
      timers.set(id, { fn: fn, at: clock + ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  return {
    host,
    advance(ms) { clock += Math.max(0, ms); },
    frameCount() { return frames.size; },
    timerCount() { return timers.size; },
    fireFrame(currentTime) {
      const entry = frames.entries().next();
      assert.equal(entry.done, false, '应当有一个待触发的帧回调');
      const [id, it] = entry.value;
      frames.delete(id);
      assert.equal(it.cancelled, false, '被取消的帧回调不该触发');
      return it.cb;
    },
    fireNextTimer() {
      let best = null;
      for (const [id, it] of timers) if (!best || it.at < best.it.at) best = { id: id, it: it };
      assert.ok(best, '应当有一个待触发的兜底定时器');
      timers.delete(best.id);
      clock = Math.max(clock, best.it.at);
      best.it.fn();
    },
    timerDelays() { return Array.from(timers.values()).map((t) => t.at - clock); }
  };
}

function makePlayer() {
  const sch = fakeScheduler();
  const player = AnimationLoop.createPlayer(sch.host);
  return { sch, player };
}

/* ---------------- 配置规范化 ---------------- */

test('缺省配置合法，并补齐 enabled=false', () => {
  const r = AnimationLoop.normalize({ actionId: 'idle', start: 0, end: 2 }, { duration: 4.042 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, { enabled: false, actionId: 'idle', start: 0, end: 2 });
  assert.deepEqual(AnimationLoop.DEFAULTS, { enabled: false, actionId: 'idle', start: 0, end: 2 });
});

test('接受数字字符串（配置文件/输入框来源），保留数值精度', () => {
  const r = AnimationLoop.normalize({ enabled: true, actionId: ' read ', start: '0.25', end: '1.75' },
    { duration: 4.042, actionIds: ['read'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, { enabled: true, actionId: 'read', start: 0.25, end: 1.75 });
});

test('拒绝空 / 非数字 / 反向 / 过短 / 越界 / 空动作 / 未知动作', () => {
  const cases = [
    [{ actionId: 'idle', start: '', end: 2 }, {}, /起点必须是数字/],
    [{ actionId: 'idle', start: 0, end: 'abc' }, {}, /终点必须是数字/],
    [{ actionId: 'idle', start: 0, end: NaN }, {}, /终点必须是数字/],
    [{ actionId: 'idle', start: 0, end: Infinity }, {}, /终点必须是数字/],
    [{ actionId: 'idle', start: -0.5, end: 2 }, {}, /起点不能小于 0/],
    [{ actionId: 'idle', start: 2, end: 2 }, {}, /终点必须大于起点/],
    [{ actionId: 'idle', start: 2.1, end: 2 }, {}, /终点必须大于起点/],
    [{ actionId: 'idle', start: 1.0, end: 1.1 }, {}, /区间太短/],      // 0.1 < 0.2
    [{ actionId: '', start: 0, end: 2 }, {}, /动作不能为空/],
    [{ actionId: 'nope', start: 0, end: 2 }, { actionIds: ['idle', 'read'] }, /动作不可用/],
    [{ enabled: 'yes', actionId: 'idle', start: 0, end: 2 }, {}, /enabled 必须是布尔值/]
  ];
  for (const [raw, opts, re] of cases) {
    const r = AnimationLoop.normalize(raw, opts);
    assert.equal(r.ok, false, '应当拒绝：' + JSON.stringify(raw));
    assert.match(r.error, re);
    assert.equal(r.config, undefined);
  }
});

test('终点超出真实时长时报错，不静默裁剪成 duration', () => {
  const r = AnimationLoop.normalize({ enabled: true, actionId: 'jump_high', start: 0, end: 99 }, { duration: 4.042 });
  assert.equal(r.ok, false);
  assert.match(r.error, /超出视频时长/);
  assert.match(r.error, /4\.042/);
  assert.equal(r.config, undefined);
  // 恰好等于时长是合法的
  const edge = AnimationLoop.normalize({ actionId: 'jump_high', start: 0, end: 4.042 }, { duration: 4.042 });
  assert.equal(edge.ok, true);
});

/* ---------------- 播放器边界 ---------------- */

test('从 start 起播：seek 到片段起点、关掉媒体循环、开始播放', () => {
  const { sch, player } = makePlayer();
  const v = fakeVideo();
  const ok = player.start({ video: v, actionId: 'jump_high', start: 0.5, end: 1.5, duration: 4.042 });
  assert.equal(ok, true);
  assert.equal(v.currentTime, 0.5);
  assert.equal(v.loop, false);
  assert.equal(v.playCount, 1);
  assert.equal(v.paused, false);
  assert.equal(player.isRunning(), true);
  assert.equal(sch.frameCount(), 1);
  assert.equal(sch.timerCount(), 1);
  const info = player.info();
  assert.equal(info.actionId, 'jump_high');
  assert.equal(info.start, 0.5);
  assert.equal(info.end, 1.5);
  player.stop();
});

test('帧回调在 end 之前不回卷，到达 end-容差时回卷到 start 并继续', () => {
  const { sch, player } = makePlayer();
  const v = fakeVideo();
  player.start({ video: v, actionId: 'idle', start: 0.4, end: 1.6, duration: 4.042 });

  v.currentTime = 1.0;
  sch.fireFrame()();
  assert.equal(player.info().wraps, 0, '1.0s 还没到边界');
  assert.equal(sch.frameCount(), 1, '每次判断后都要重新排一帧');

  v.currentTime = 1.6 - AnimationLoop.EPS + 0.001;
  sch.fireFrame()();
  assert.equal(player.info().wraps, 1);
  assert.equal(v.currentTime, 0.4, '回卷必须精确 seek 到 start');
  assert.equal(sch.frameCount(), 1, '回卷后继续排帧，不能断循环');
  player.stop();
});

test('媒体真的 ended 时也能回卷（ended 兜底）', () => {
  const { player } = makePlayer();
  const v = fakeVideo();
  player.start({ video: v, actionId: 'idle', start: 0.3, end: 1.3, duration: 1.3 });
  v.currentTime = 1.3;
  v.paused = true; v.ended = true;
  v.fire('ended');
  assert.equal(player.info().wraps, 1);
  assert.equal(v.currentTime, 0.3);
  assert.equal(v.paused, false, 'ended 后回卷要重新 play');
  assert.equal(player.isRunning(), true);
  player.stop();
});

test('`stop` 会取消所有回调并暂停视频；停止后旧回调不再改状态', () => {
  const { sch, player } = makePlayer();
  const v = fakeVideo();
  player.start({ video: v, actionId: 'idle', start: 0, end: 2, duration: 4.042 });
  const stale = sch.fireFrame();          // 取出来但不执行
  player.stop();
  assert.equal(v.pauseCount, 1);
  assert.equal(sch.frameCount(), 0);
  assert.equal(sch.timerCount(), 0);
  assert.equal(player.isRunning(), false);
  assert.equal(v.listenerCount('ended'), 0, 'stop 要摘掉媒体监听，避免泄漏');
  stale();                                // 取消后即使被误调用也不能回卷
  assert.equal(player.info().wraps, 0);
});

test('重新 start 只保留一个帧回调与一个兜底定时器（不泄漏）', () => {
  const { sch, player } = makePlayer();
  const v = fakeVideo();
  for (let i = 0; i < 5; i++) {
    player.start({ video: v, actionId: 'idle', start: i * 0.1, end: 2, duration: 4.042 });
  }
  assert.equal(sch.frameCount(), 1);
  assert.equal(sch.timerCount(), 1);
  assert.equal(v.listenerCount('ended'), 1, '重复 start 不能叠加监听');
  player.stop();
});

test('没有帧回调时，兜底定时器在边界处回卷；没到边界则重新计时', () => {
  const { sch, player } = makePlayer();
  const v = fakeVideo();
  player.start({ video: v, actionId: 'idle', start: 0.5, end: 1.5, duration: 4.042, rate: 1 });
  v.playbackRate = 1;

  v.currentTime = 0.9;                    // 定时器早触发 → 不 wrap，只重新排
  sch.fireNextTimer();
  assert.equal(player.info().wraps, 0);
  assert.equal(sch.timerCount(), 1);

  v.currentTime = 1.5;                    // 真到边界 → wrap
  sch.fireNextTimer();
  assert.equal(player.info().wraps, 1);
  assert.equal(v.currentTime, 0.5);
  player.stop();
});

test('播放速率影响兜底定时器的等待时间（尊重速度滑块）', () => {
  const { sch, player } = makePlayer();
  const v = fakeVideo();
  v.playbackRate = 2;                     // 2 倍速 → 1 秒片段只需 0.5 秒
  player.start({ video: v, actionId: 'idle', start: 0, end: 1, duration: 4.042 });
  const delay = sch.timerDelays()[0];
  assert.ok(delay > 450 && delay < 700, '2 倍速下等待约 500ms，实际 ' + delay);
  player.stop();
});

test('视频被外部暂停时引擎自挂起，不会在暂停状态下反复回卷', () => {
  const { sch, player } = makePlayer();
  const v = fakeVideo();
  player.start({ video: v, actionId: 'idle', start: 0, end: 2, duration: 4.042 });
  sch.advance(1000);
  v.paused = true;                        // 别的状态/游戏模式抢走了解码
  v.currentTime = 1.99;
  sch.fireNextTimer();
  assert.equal(player.info().wraps, 0);
  assert.equal(player.isRunning(), false);
  assert.equal(player.info().pausedReason, 'video-paused');
  assert.equal(sch.frameCount(), 0);
  assert.equal(sch.timerCount(), 0);
});

test('非法区间直接拒绝起播（start>=end / 非数字）', () => {
  const { sch, player } = makePlayer();
  const v = fakeVideo();
  assert.equal(player.start({ video: v, actionId: 'idle', start: 2, end: 2 }), false);
  assert.equal(player.start({ video: v, actionId: 'idle', start: 'x', end: 2 }), false);
  assert.equal(player.isRunning(), false);
  assert.equal(sch.frameCount(), 0);
  assert.equal(v.playCount, 0);
});

/* ---------------- 按需加载 / 起播 seek 校验（真实打包版从 0 起播的回归） ---------------- */

test('ensureVideoData：已有元数据时绝不 load（load 会把 currentTime 清回 0，片段从 0 起播）', () => {
  const v = fakeVideo();
  v.readyState = 2;
  v.preload = 'metadata';
  v.currentTime = 0.6;

  const reloaded = AnimationLoop.ensureVideoData(v);
  assert.equal(reloaded, false);
  assert.equal(v.loadCount, 0, 'readyState>=1 时 load() 会重置播放点，绝不能调用');
  assert.equal(v.currentTime, 0.6);
  assert.equal(v.preload, 'auto');
});

test('ensureVideoData：完全没有元数据且不在加载中才 load 一次；加载中不重复 load', () => {
  const v = fakeVideo();
  v.readyState = 0; v.networkState = 0; v.preload = 'metadata';
  assert.equal(AnimationLoop.ensureVideoData(v), true);
  assert.equal(v.loadCount, 1);
  assert.equal(v.preload, 'auto');

  v.readyState = 0; v.networkState = 2;          // NETWORK_LOADING：已经在加载
  assert.equal(AnimationLoop.ensureVideoData(v), false);
  assert.equal(v.loadCount, 1);

  v.readyState = 1; v.networkState = 1;          // 已有 metadata
  assert.equal(AnimationLoop.ensureVideoData(v), false);
  assert.equal(v.loadCount, 1);
});

test('元数据晚到：loadedmetadata 时补 seek 到 start，首次实际播放不从 0 开始', () => {
  const { sch, player } = makePlayer();
  const v = fakeVideo(4.042, { readyState: 0, networkState: 2, ignoreSeek: true });
  assert.equal(player.start({ video: v, actionId: 'tail_open', start: 0.6, end: 1.6, duration: 4.042 }), true);
  assert.equal(v.currentTime, 0, 'HAVE_NOTHING 时 seek 不生效（等 metadata）');

  v.readyState = 1; v.ignoreSeek = false;         // 资源加载完成，metadata 到达
  v.fire('loadedmetadata');
  assert.equal(v.currentTime, 0.6, 'metadata 到达必须重新把播放点落到 start');

  v.paused = false; v.currentTime = 0.9;
  sch.fireFrame()();
  assert.equal(player.info().wraps, 0);
  player.stop();
});

test('canplay 时起点 seek 被资源加载吞掉 → 重新落点，不靠帧回调兜底', () => {
  const { player } = makePlayer();
  const v = fakeVideo(4.042, { ignoreSeek: true });
  player.start({ video: v, actionId: 'tail_open', start: 0.6, end: 1.6, duration: 4.042 });
  assert.equal(v.currentTime, 0);

  v.ignoreSeek = false;
  v.fire('canplay');
  assert.equal(v.currentTime, 0.6, 'canplay 必须真的重设 currentTime，不能只 arm');
  player.stop();
});

test('帧回调发现播放头还在片段外 → 补 seek 到 start，不计数回卷', () => {
  const { sch, player } = makePlayer();
  const v = fakeVideo(4.042, { ignoreSeek: true });
  player.start({ video: v, actionId: 'tail_open', start: 0.6, end: 1.6, duration: 4.042 });

  v.ignoreSeek = false;
  v.currentTime = 0.05;                          // 资源真从 0 播起来了
  sch.fireFrame()();
  assert.equal(v.currentTime, 0.6, '必须立刻纠正到片段起点');
  assert.equal(player.info().wraps, 0, '纠正起播点不算回卷');
  player.stop();
});

test('起点 seek 连续无效 → 有限重试后暂停并上报 seek-failed，绝不一直在 0~start 播', () => {
  const { sch, player } = makePlayer();
  const v = fakeVideo(4.042, { ignoreSeek: true });
  let err = null;
  player.start({ video: v, actionId: 'tail_open', start: 0.6, end: 1.6, duration: 4.042,
    onError: (e) => { err = e; } });
  v.paused = false;
  for (let i = 0; i < 10 && sch.frameCount() > 0; i++) sch.fireFrame()();

  assert.equal(player.isRunning(), false);
  assert.equal(player.info().pausedReason, 'seek-failed');
  assert.ok(err && err.reason === 'seek-failed');
  assert.equal(err.start, 0.6);
  assert.equal(player.info().wraps, 0);
  assert.equal(v.paused, true, '上报 seek-failed 后必须真的暂停元素，不能只停调度器');
  assert.ok(v.pauseCount >= 1);
});

test('起播成功但片尾回卷 seek 失效 → 有限次后真正暂停并上报 seek-failed，不每帧空转回卷', () => {
  const { sch, player } = makePlayer();
  const v = fakeVideo();
  let errors = [];
  player.start({ video: v, actionId: 'idle', start: 0.6, end: 1.6, duration: 4.042,
    onError: (e) => { errors.push(e); } });
  v.currentTime = 0.9;                     // 正常播放中，起播落点已确认
  sch.fireFrame()();
  assert.equal(player.info().wraps, 0);

  v.currentTime = 1.6;                     // 到片尾
  v.ignoreSeek = true;                     // 之后所有 seek 被吞（截断/稀疏文件、容器异常）
  for (let i = 0; i < 12 && sch.frameCount() > 0; i++) sch.fireFrame()();

  assert.equal(player.isRunning(), false);
  assert.equal(player.info().pausedReason, 'seek-failed');
  assert.equal(errors.length, 1, '只上报一次，不能每帧刷错误');
  assert.equal(errors[0].reason, 'seek-failed');
  assert.equal(v.paused, true, '回卷重试耗尽必须真正暂停元素，不能留在片尾继续播');
  assert.ok(v.pauseCount >= 1);
  assert.equal(player.info().wraps, 1, '失败重试不算新的回卷');
  const startSeeks = v.seekLog.filter((t) => t === 0.6).length;
  assert.ok(startSeeks <= 1 + AnimationLoop.MAX_START_SEEK_TRIES,
    '落到 start 的 seek 总次数必须受 MAX_START_SEEK_TRIES 限制，实际 ' + startSeeks);
  assert.equal(sch.frameCount(), 0);
  assert.equal(sch.timerCount(), 0);
});

test('回卷 seek 偶发失效后恢复：落点确认才清零重试计数，之后正常回卷', () => {
  const { sch, player } = makePlayer();
  const v = fakeVideo();
  player.start({ video: v, actionId: 'idle', start: 0.6, end: 1.6, duration: 4.042 });
  v.currentTime = 0.9;
  sch.fireFrame()();                       // 起播落点确认
  assert.equal(player.info().wraps, 0);

  v.currentTime = 1.6;
  v.ignoreSeek = true;
  sch.fireFrame()();                       // 回卷 seek 被吞：wraps+1，但落点未确认
  assert.equal(player.info().wraps, 1);
  assert.equal(v.currentTime, 1.6);
  sch.fireFrame()();                       // 帧检查继续补 seek（也不生效）
  assert.equal(player.isRunning(), true, '未到重试上限前应继续尝试，而不是直接停');
  assert.ok(player.info().seekTries >= 2);

  v.ignoreSeek = false;
  v.fire('seeked');                        // seeked：播放头仍在片尾 → 再补一次 seek 到起点
  assert.equal(v.currentTime, 0.6);
  assert.ok(player.info().seekTries >= 3);
  assert.equal(player.info().pausedReason, '');
  v.fire('seeked');                        // 补 seek 真正完成 → 落点确认才清零
  assert.equal(player.info().seekTries, 0, '落点确认后重试计数必须清零');
  assert.equal(player.isRunning(), true);

  v.currentTime = 1.6;                     // 恢复后还能正常回卷，不继承历史失败计数
  sch.fireFrame()();
  assert.equal(player.info().wraps, 2);
  assert.equal(v.currentTime, 0.6);
  assert.equal(v.paused, false);
  assert.equal(player.isRunning(), true);
  player.stop();
});

test('真实片尾：seek 立即清 ended，回卷仍要重新 play（复现旧逻辑 paused&&ended 判断失效）', () => {
  const { player } = makePlayer();
  const v = fakeVideo(1.3, { clearEndedOnSeek: true });
  player.start({ video: v, actionId: 'idle', start: 0.3, end: 1.3, duration: 1.3 });
  assert.equal(v.playCount, 1);

  v.currentTime = 1.3;
  v.paused = true; v.ended = true;
  v.fire('ended');

  assert.equal(v.currentTime, 0.3);
  assert.equal(v.ended, false, '真实 seek 已把 ended 清掉');
  assert.equal(v.paused, false, '回卷后必须继续播放，不能停在起点');
  assert.equal(v.playCount, 2);
  assert.equal(player.info().wraps, 1);
  player.stop();
});

test('stop 后迟到的 canplay / 旧帧回调不会把旧片段播回来，监听已摘除', () => {
  const { sch, player } = makePlayer();
  const a = fakeVideo();
  const b = fakeVideo();
  player.start({ video: a, actionId: 'idle', start: 0.5, end: 1.5, duration: 4.042 });
  const staleFrame = sch.fireFrame();            // 取出旧回调但不执行

  player.stop();
  assert.equal(a.listenerCount('canplay'), 0);
  assert.equal(a.listenerCount('ended'), 0);
  assert.equal(a.pauseCount, 1);

  a.fire('canplay');
  assert.equal(a.paused, true, 'stop 后迟到的 canplay 不能把旧视频再播起来');
  assert.equal(a.playCount, 1);

  player.start({ video: b, actionId: 'tail_open', start: 0.6, end: 1.6, duration: 4.042 });
  staleFrame();                                  // 旧代帧回调误触发
  assert.equal(player.info().actionId, 'tail_open');
  assert.equal(player.info().wraps, 0);
  assert.equal(sch.frameCount(), 1, '新片段仍只有一个帧回调');
  assert.equal(sch.timerCount(), 1);
  player.stop();
});

test('pause（切走）也摘监听：迟到的 canplay 不会恢复旧片段', () => {
  const { sch, player } = makePlayer();
  const v = fakeVideo();
  player.start({ video: v, actionId: 'idle', start: 0.5, end: 1.5, duration: 4.042 });
  player.pause('switch-away');
  assert.equal(v.listenerCount('canplay'), 0);
  assert.equal(sch.frameCount(), 0);
  assert.equal(sch.timerCount(), 0);

  const before = v.playCount;
  v.fire('canplay');
  assert.equal(v.playCount, before);
  assert.equal(player.isRunning(), false);
});
