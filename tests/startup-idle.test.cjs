'use strict';
/* 启动空闲窗口调度的回归测试（配套 main.js 的 scheduleStartupIdleTasks）
 *
 * 背景：更新检查原来固定 `setTimeout(…, 5000)`、聊天运行时预热 `setTimeout(prewarmNode, 4000)`，
 * 正好落在启动最忙的几秒里，各会造成一次主线程停顿（实测 29～37ms / 10～17ms，负载高时合计 ~100ms）。
 * 现在两者都排进「窗口显示 + 页面首帧就绪」之后的空闲窗口，延时 ≥15s。
 *
 * 这里把 main.js 里的四个函数连同比常量抽进 vm，用假定时器验证：
 *   1. 页面没就绪时不跑任务，只轮询；
 *   2. 就绪后必须等满 STARTUP_IDLE_DELAY_MS 才跑，且只跑一次；
 *   3. 页面迟迟不就绪时，到 STARTUP_IDLE_PAGE_WAIT_MS 兜底照排；
 *   4. 窗口已销毁就不再排；cancel 之后不再补跑；
 *   5. 源码里不再有当年那两个固定 4s / 5s 的调用点（防止回归）。
 *
 * 运行：node --test tests/startup-idle.test.cjs */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');

function grabFn(name) {
  const head = SRC.indexOf('function ' + name + '(');
  assert.ok(head >= 0, 'main.js 里找不到函数 ' + name);
  let i = SRC.indexOf('{', head), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(head, i + 1);
  }
  throw new Error('函数 ' + name + ' 花括号不配平');
}

function grabConst(name) {
  const m = new RegExp('const ' + name + '\\s*=\\s*([0-9]+)').exec(SRC);
  assert.ok(m, 'main.js 里找不到常量 ' + name);
  return Number(m[1]);
}

const DELAY = grabConst('STARTUP_IDLE_DELAY_MS');
const PAGE_WAIT = grabConst('STARTUP_IDLE_PAGE_WAIT_MS');

/** 假时钟 + 假定时器：tick(ms) 推进时间并按到期顺序跑回调 */
function makeClock() {
  let now = 0, seq = 0;
  const list = new Map();
  const clock = {
    get now() { return now; },
    setTimeout(fn, ms) { const id = ++seq; list.set(id, { at: now + (ms || 0), fn }); return id; },
    clearTimeout(id) { list.delete(id); },
    pending() { return list.size; },
    tick(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of list) if (t.at <= target && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        list.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = target;
    },
  };
  return clock;
}

function makeCtx(opts = {}) {
  const clock = makeClock();
  const calls = { prewarm: 0, update: 0, page: 0, logs: [] };
  const win = opts.noWin ? null : {
    isDestroyed: () => !!opts.destroyed,
    webContents: {
      executeJavaScript: () => {
        calls.page++;
        return Promise.resolve(!!opts.ready);
      },
    },
  };
  const ctx = {
    console: { log: (s) => calls.logs.push(String(s)) },
    Promise, Date: { now: () => clock.now },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    win, moduleT0: 0,
    prewarmNode: () => { calls.prewarm++; },
    runUpdateCheck: () => { calls.update++; return Promise.resolve({ ok: true }); },
    STARTUP_IDLE_DELAY_MS: DELAY,
    STARTUP_IDLE_PAGE_WAIT_MS: PAGE_WAIT,
    startupIdleTimer: null,
    startupIdleDone: false,
  };
  vm.createContext(ctx);
  vm.runInContext([
    grabFn('pageFirstPaintReady'),
    grabFn('runStartupIdleTasks'),
    grabFn('scheduleStartupIdleTasks'),
    grabFn('cancelStartupIdleTasks'),
  ].join('\n'), ctx);
  return { ctx, clock, calls };
}

/** 让 vm 里的 Promise 续体跑完（同一 isolate，共享微任务队列） */
const flush = () => new Promise((r) => setImmediate(r));

test('页面未就绪：只轮询，不跑任务', async () => {
  const { ctx, clock, calls } = makeCtx({ ready: false });
  vm.runInContext('scheduleStartupIdleTasks()', ctx);
  await flush();
  clock.tick(1000);
  await flush();
  assert.equal(calls.prewarm, 0, '页面没就绪不能预热');
  assert.equal(calls.update, 0, '页面没就绪不能查更新');
  assert.ok(calls.page >= 2, '应该在轮询页面状态，实际 ' + calls.page);
  assert.ok(clock.pending() >= 1, '应该还挂着下一次轮询');
});

test('页面就绪后必须等满 >=15s 才跑，且只跑一次', async () => {
  assert.ok(DELAY >= 15000, '启动空闲延时必须 ≥15s，当前 ' + DELAY);
  const { ctx, clock, calls } = makeCtx({ ready: true });
  vm.runInContext('scheduleStartupIdleTasks()', ctx);
  await flush();
  clock.tick(DELAY - 1);
  await flush();
  assert.equal(calls.update, 0, '还没到 ' + DELAY + 'ms 就跑了更新检查');
  assert.equal(calls.prewarm, 0);
  clock.tick(1);
  await flush();
  assert.equal(calls.update, 1, '到点应恰好跑一次更新检查');
  assert.equal(calls.prewarm, 1, '到点应恰好预热一次');
  clock.tick(60000);
  await flush();
  assert.equal(calls.update, 1, '不能重复跑');
  assert.ok(calls.logs.some((l) => l.startsWith('STARTUP_IDLE_ARMED')), '应留 ARM 日志');
  assert.ok(calls.logs.some((l) => l.startsWith('STARTUP_IDLE_RUN')), '应留 RUN 日志');
});

test('页面一直不就绪：到兜底上限也照排', async () => {
  const { ctx, clock, calls } = makeCtx({ ready: false });
  vm.runInContext('scheduleStartupIdleTasks()', ctx);
  await flush();
  clock.tick(PAGE_WAIT);
  await flush();
  assert.ok(calls.page >= 2, '兜底前应该在轮询');
  clock.tick(DELAY);
  await flush();
  assert.equal(calls.update, 1, '兜底到点后应排上并在延时后跑');
});

test('窗口已销毁 / 取消后不再排也不再补跑', async () => {
  const a = makeCtx({ destroyed: true });
  vm.runInContext('scheduleStartupIdleTasks()', a.ctx);
  await flush();
  a.clock.tick(60000);
  await flush();
  assert.equal(a.calls.update, 0, '窗口销毁后不该跑');
  assert.equal(a.clock.pending(), 0, '窗口销毁后不该继续轮询');

  const b = makeCtx({ ready: true });
  vm.runInContext('scheduleStartupIdleTasks()', b.ctx);
  await flush();
  vm.runInContext('cancelStartupIdleTasks()', b.ctx);   // 模拟 before-quit
  b.clock.tick(60000);
  await flush();
  assert.equal(b.calls.update, 0, '取消后不该补跑');
  assert.equal(b.clock.pending(), 0);
});

test('源码里不再有启动即跑的固定 4s / 5s 后台任务', () => {
  assert.ok(!/setTimeout\(prewarmNode,\s*4000\)/.test(SRC), '旧的 prewarmNode@4000ms 还在');
  assert.ok(!/runUpdateCheck\(true\)\.catch\(\(\) => \{\}\)\s*\},\s*5000\)/.test(SRC),
    '旧的更新检查@5000ms 还在');
  assert.ok(/scheduleStartupIdleTasks\(\);/.test(SRC), '启动流程里应调用 scheduleStartupIdleTasks()');
});
