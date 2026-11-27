'use strict';
/* =============================================================================
 * 媒体探测子进程的生命周期（app/media-show.js）
 * -----------------------------------------------------------------------------
 * 不起真的 PowerShell：把 child_process.spawn 换成假进程（EventEmitter），
 * 只验证「谁该活、谁该重启、启动参数是什么」。
 *
 * 钉住的三个回归点（v0.7.2 修复）：
 *   1. 游戏模式 suspend() 后，被杀进程的 exit **不得**把探测重新拉起来
 *      （旧代码只看 cfg.enabled，1 秒后 PowerShell 就又回来了）；
 *   2. 换采样节奏（stopProbe → startProbe）后，旧进程迟到的 exit 不得清掉新进程、
 *      也不得再起一个（旧代码会变成双探测）；
 *   3. 真正的意外退出仍然按退避重启（这条是原有能力，不能被修没了）。
 *
 * 运行：node --test tests/media-show-probe.test.cjs
 * ============================================================================= */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const cp = require('node:child_process');

const MOD = path.join(__dirname, '..', 'app', 'media-show.js');
const realSpawn = cp.spawn;
const realExists = require('node:fs').existsSync;

/* 假进程：只实现 media-show.js 用到的那些面 */
function fakeChild(args) {
  const c = new EventEmitter();
  c.args = args;
  c.killed = false;
  c.kill = () => { c.killed = true; return true; };
  c.stdout = new EventEmitter();
  c.stdout.setEncoding = () => {};
  c.stderr = new EventEmitter();
  c.stderr.setEncoding = () => {};
  return c;
}

/* 每个用例一份全新的模块实例 + 自己的 spawn 记录 */
function fresh() {
  const spawned = [];
  cp.spawn = (exe, args) => { const c = fakeChild(args); spawned.push(c); return c; };
  delete require.cache[require.resolve(MOD)];
  const { createMediaShow } = require(MOD);
  const events = [];
  const ms = createMediaShow({ pollMs: 2000, slowMs: 2500 });
  ms.setEmitter((ch, payload) => events.push({ ch, payload }));
  return { ms, spawned, events };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 退避从 1000ms 起、首次翻倍到 2000ms：等过这个时间才能断言「没有重启」 */
const RESTART_WAIT = 2300;
const argValue = (args, flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };

test('启动参数：-IntervalMs 取 pollMs，slowMs>0 时追加 -SlowMs，=0 时不追加（兼容旧行为）', () => {
  let f = fresh();
  f.ms.apply({ enabled: true, pollMs: 600, slowMs: 2500 });
  assert.equal(f.spawned.length, 1);
  assert.equal(argValue(f.spawned[0].args, '-IntervalMs'), '600');
  assert.equal(argValue(f.spawned[0].args, '-SlowMs'), '2500');
  assert.equal(f.ms.get().slowMs, 2500);
  assert.equal(f.ms.get().running, true);

  f = fresh();
  f.ms.apply({ enabled: true, pollMs: 600, slowMs: 0 });
  assert.equal(f.spawned.length, 1);
  assert.equal(f.spawned[0].args.includes('-SlowMs'), false);
  assert.equal(f.ms.get().slowMs, 0);
});

test('suspend（游戏模式）：被杀进程的 exit 不得把探测重新拉起来', async () => {
  const f = fresh();
  f.ms.apply({ enabled: true });
  assert.equal(f.spawned.length, 1);
  f.ms.suspend('gamemode');
  assert.equal(f.ms.get().running, false);
  assert.equal(f.spawned[0].killed, true);
  f.spawned[0].emit('exit', 1, 'SIGTERM');       // kill 是异步的：exit 在 stopProbe 之后才到
  await sleep(RESTART_WAIT);                              // 退避 1000ms：旧代码会在这里起第二个
  assert.equal(f.spawned.length, 1, '游戏模式期间不应重启探测');
  assert.equal(f.ms.get().running, false);
  assert.equal(f.ms.get().restarts, 0);
  f.ms.resume();
  assert.equal(f.spawned.length, 2, 'resume 后应按开关重新拉起');
});

test('关闭开关：exit 后不重启', async () => {
  const f = fresh();
  f.ms.apply({ enabled: true });
  f.ms.apply({ enabled: false });
  f.spawned[0].emit('exit', 1, 'SIGTERM');
  await sleep(RESTART_WAIT);
  assert.equal(f.spawned.length, 1);
});

test('换采样节奏：只重启一次、带新间隔；旧进程迟到的 exit 不清状态也不再起', async () => {
  const f = fresh();
  f.ms.apply({ enabled: true, pollMs: 2000 });
  assert.equal(argValue(f.spawned[0].args, '-IntervalMs'), '2000');
  f.ms.apply({ enabled: true, pollMs: 600 });     // 灵动岛：进程已在跑，只改 cfg 不生效 → 必须换进程
  assert.equal(f.spawned.length, 2, '换节奏应重启探测');
  assert.equal(argValue(f.spawned[1].args, '-IntervalMs'), '600');
  assert.equal(f.ms.get().running, true);
  f.spawned[0].emit('exit', 1, 'SIGTERM');       // 旧进程迟到的 exit
  await sleep(RESTART_WAIT);
  assert.equal(f.spawned.length, 2, '不得出现双探测');
  assert.equal(f.ms.get().running, true, '新进程的登记不能被旧进程的 exit 清掉');
  assert.equal(f.ms.get().restarts, 0, '换节奏是有意重启，不算故障重启');
});

test('节奏没变时不重启（避免无谓地换进程）', () => {
  const f = fresh();
  f.ms.apply({ enabled: true, pollMs: 600, slowMs: 2500 });
  f.ms.apply({ enabled: true, pollMs: 600, slowMs: 2500 });
  f.ms.apply({ enabled: true });
  assert.equal(f.spawned.length, 1);
});

test('意外退出：开关仍开 → 按退避重启', async () => {
  const f = fresh();
  f.ms.apply({ enabled: true });
  f.spawned[0].emit('exit', 3, null);             // 脚本自己崩了
  assert.equal(f.ms.get().running, false);
  await sleep(RESTART_WAIT);
  assert.equal(f.spawned.length, 2, '应自动重启');
  assert.equal(f.ms.get().running, true);
  assert.equal(f.ms.get().restarts, 1);
});

test.after(() => { cp.spawn = realSpawn; });
