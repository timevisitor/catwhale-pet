'use strict';
/**
 * 待办 / 专注 / 喝水（reminders）测试
 *
 * 跑法：node tests/infohub/reminders.test.js
 * 只用 node:assert，不依赖 jest/第三方包。
 *
 * 覆盖契约 §4.7 的验收点：
 *   1) 到点只触发一次（同一 occurrence 再 tick 不再弹）
 *   2) 重复待办触发后滚动到下一次（daily → 明天同一时刻）
 *   3) 喝水累计 + 撤销
 *   4) 重启（同 dataDir 重建实例）后状态保持
 * 另外覆盖：weekly 只在指定星期、专注到点提醒、原子写文件存在且是合法 JSON。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const create = require('../../app/infohub/sources/reminders.js');

/* ---------------- 测试脚手架 ---------------- */

const TMP = path.join(__dirname, '.tmp-reminders');
let pass = 0;
let fail = 0;
const cases = [];

function test(name, fn) { cases.push([name, fn]); }

function freshDir() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  return TMP;
}

/** 可变时钟：注入 ctx.now，测试里随意快进 */
/** 只挑待办类提醒（tick 同时可能弹喝水/专注，计数要分类型） */
function todoEmits(list) { return list.filter((e) => e.data && e.data.type === 'todo'); }

function makeCtx(clockRef, dataDir) {
  const emits = [];
  const snaps = [];
  const logs = [];
  const ctx = {
    cfg: () => ({ enabled: true }),
    setCfg: () => {},
    emit: (e) => emits.push(e),
    snapshot: (k, v) => snaps.push({ kind: k, data: v }),
    log: (m) => logs.push(m),
    dataDir: dataDir || TMP,
    appDir: path.join(__dirname, '../../app'),
    paths: {},
    now: () => clockRef.t,
  };
  return { ctx, emits, snaps, logs };
}

/** 2026-11-25 08:59:00 本地时间（周三） */
function baseTime() {
  return new Date(2026, 10, 25, 8, 59, 0, 0).getTime();
}

/* ---------------- 用例 ---------------- */

test('待办：到点只触发一次', () => {
  const dir = freshDir();
  const ref = { t: baseTime() };
  const { ctx, emits } = makeCtx(ref, dir);
  const m = create(ctx);

  const r = m.addTodo({ text: '喝水拉伸', at: '09:00', repeat: 'none' });
  assert.strictEqual(r.ok, true, 'addTodo 应成功：' + JSON.stringify(r));
  assert.strictEqual(r.todo.at, '09:00');
  assert.strictEqual(r.todo.dueAt, new Date(2026, 10, 25, 9, 0, 0, 0).getTime(), '单次待办应排在今天 09:00');

  // 08:59:30 —— 没到点，不弹
  ref.t = new Date(2026, 10, 25, 8, 59, 30).getTime();
  m._tick();
  assert.strictEqual(emits.length, 0, '未到点不应触发');

  // 09:00:05 —— 到点，弹一次
  ref.t = new Date(2026, 10, 25, 9, 0, 5).getTime();
  m._tick();
  assert.strictEqual(emits.length, 1, '到点应触发一次，实际 ' + emits.length);
  const e = emits[0];
  assert.strictEqual(e.kind, 'reminder');
  assert.strictEqual(e.source, 'reminders');
  assert.ok(/喝水拉伸/.test(e.body), 'body 应含待办文本，实际：' + e.body);
  assert.ok(e.key.startsWith('rem:todo:'), 'key 应为 rem:todo:*，实际：' + e.key);

  // 09:00:20 / 09:01 —— 继续 tick 不应重复
  ref.t = new Date(2026, 10, 25, 9, 0, 20).getTime();
  m._tick();
  ref.t = new Date(2026, 10, 25, 9, 1, 0).getTime();
  m._tick();
  assert.strictEqual(emits.length, 1, '同一个 occurrence 只应弹一次，实际 ' + emits.length);

  // 单次待办触发后应为已完成
  const st = m.getState();
  assert.strictEqual(st.todos[0].done, true, '单次待办触发后应标记完成');
  m.stop && m.stop();
});

test('待办：重复（每天）触发后滚到下次', () => {
  const dir = freshDir();
  const ref = { t: baseTime() };
  const { ctx, emits } = makeCtx(ref, dir);
  const m = create(ctx);

  m.addTodo({ text: '吃维生素', at: '09:00', repeat: 'daily' });
  ref.t = new Date(2026, 10, 25, 9, 0, 3).getTime();
  m._tick();
  assert.strictEqual(emits.length, 1, '每天待办今天应弹一次');
  let st = m.getState();
  assert.strictEqual(st.todos[0].done, false, '重复待办不应被标完成');
  const tomorrow = new Date(2026, 10, 26, 9, 0, 0, 0).getTime();
  assert.strictEqual(st.todos[0].dueAt, tomorrow, '应滚到明天 09:00，实际 ' + new Date(st.todos[0].dueAt).toString());
  assert.ok(/明天/.test(st.todos[0].dueText), 'dueText 应提示明天，实际：' + st.todos[0].dueText);

  // 今天再 tick 不弹
  ref.t = new Date(2026, 10, 25, 15, 0, 0).getTime();
  m._tick();
  assert.strictEqual(todoEmits(emits).length, 1, '滚到明天后今天不应再弹');

  // 明天 09:00 再弹一次，并滚到后天
  ref.t = new Date(2026, 10, 26, 9, 0, 10).getTime();
  m._tick();
  assert.strictEqual(todoEmits(emits).length, 2, '第二天应再弹一次');
  st = m.getState();
  assert.strictEqual(st.todos[0].dueAt, new Date(2026, 10, 27, 9, 0, 0, 0).getTime(), '应再滚到后天');
});

test('待办：每周指定日只在指定星期触发', () => {
  const dir = freshDir();
  const ref = { t: baseTime() };                       // 2026-11-25 周三
  const { ctx, emits } = makeCtx(ref, dir);
  const m = create(ctx);

  // 只在周一、周三 09:00
  m.addTodo({ text: '周报', at: '09:00', repeat: 'weekly', weekdays: [1, 3] });
  ref.t = new Date(2026, 10, 25, 9, 0, 2).getTime();
  m._tick();
  assert.strictEqual(emits.length, 1, '周三是允许的日子，应弹');
  // 下一次应是下周一（11-30）
  const st = m.getState();
  assert.strictEqual(st.todos[0].dueAt, new Date(2026, 10, 30, 9, 0, 0, 0).getTime(),
    '应跳到下周一 11-30，实际 ' + new Date(st.todos[0].dueAt).toString());
});

test('喝水：累计与撤销', () => {
  const dir = freshDir();
  const ref = { t: baseTime() };
  const { ctx } = makeCtx(ref, dir);
  const m = create(ctx);

  assert.strictEqual(m.waterAdd(250).ok, true);
  ref.t += 1000;
  assert.strictEqual(m.waterAdd().ok, true, '不传 ml 应默认一杯（250）');
  let st = m.getState();
  assert.strictEqual(st.water.totalMl, 500, '累计应为 500，实际 ' + st.water.totalMl);
  assert.strictEqual(st.water.cups, 2);
  assert.strictEqual(st.water.percent, 25, '500/2000 → 25%');

  const u = m.waterUndo();
  assert.strictEqual(u.ok, true);
  assert.strictEqual(u.removed, 250, '撤销应移除最后一杯 250');
  st = m.getState();
  assert.strictEqual(st.water.totalMl, 250, '撤销后应为 250，实际 ' + st.water.totalMl);
  assert.strictEqual(st.water.cups, 1);

  m.waterUndo();
  assert.strictEqual(m.getState().water.totalMl, 0, '两杯都撤销后应为 0');
  const empty = m.waterUndo();
  assert.strictEqual(empty.ok, false, '没记录时撤销应返回 ok:false');

  // 目标达成后不再提醒
  ref.t = new Date(2026, 10, 25, 10, 0, 0).getTime();
  m.waterAdd(2000);
  const emits = [];
  ctx.emit = (e) => emits.push(e);
  ref.t += 2 * 60 * 60 * 1000;
  m._tick();
  assert.strictEqual(emits.filter((x) => /水/.test(x.title)).length, 0, '喝够目标后不应再提醒');
});

test('喝水：到间隔会提醒，且同一槽不重复', () => {
  const dir = freshDir();
  const ref = { t: new Date(2026, 10, 25, 9, 30, 0).getTime() };
  const { ctx, emits } = makeCtx(ref, dir);
  const m = create(ctx);

  m.waterAdd(250);                                     // 09:30 记一杯，nextAt=10:30
  ref.t = new Date(2026, 10, 25, 10, 0, 0).getTime();
  m._tick();
  assert.strictEqual(emits.length, 0, '未到 60 分钟不应提醒');

  ref.t = new Date(2026, 10, 25, 10, 30, 5).getTime();
  m._tick();
  assert.strictEqual(emits.length, 1, '到 60 分钟应提醒一次');
  assert.ok(/喝水/.test(emits[0].title), 'title 应为喝水提醒，实际：' + emits[0].title);

  ref.t = new Date(2026, 10, 25, 10, 31, 0).getTime();
  m._tick();
  assert.strictEqual(emits.length, 1, '同一间隔内不应重复提醒');
});

test('专注：到点提醒一次', () => {
  const dir = freshDir();
  const ref = { t: baseTime() };
  const { ctx, emits } = makeCtx(ref, dir);
  const m = create(ctx);

  const r = m.focusStart(25);
  assert.strictEqual(r.ok, true);
  let st = m.getState();
  assert.strictEqual(st.focus.active, true);
  assert.strictEqual(st.focus.minutes, 25);
  assert.strictEqual(st.focus.leftSec, 25 * 60, '剩余秒数应为 1500，实际 ' + st.focus.leftSec);

  ref.t = new Date(2026, 10, 25, 9, 23, 0).getTime();
  m._tick();
  assert.strictEqual(emits.length, 0, '未到点不应提醒');

  ref.t = new Date(2026, 10, 25, 9, 24, 1).getTime();
  m._tick();
  assert.strictEqual(emits.length, 1, '到点应提醒一次');
  assert.ok(/专注/.test(emits[0].title));
  ref.t += 5000;
  m._tick();
  assert.strictEqual(emits.length, 1, '不应重复提醒');
  assert.strictEqual(m.getState().focus.active, false);

  // 手动中止
  m.focusStart(10);
  ref.t += 60 * 1000;
  const s = m.focusStop();
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.usedMin, 1, '中止时应报已用 1 分钟，实际 ' + s.usedMin);
  assert.strictEqual(m.getState().focus.active, false);
});

test('持久化：重启后状态保持（原子写落盘）', () => {
  const dir = freshDir();
  const ref = { t: baseTime() };
  const a = makeCtx(ref, dir);
  const m1 = create(a.ctx);

  m1.addTodo({ text: '交周报', at: '18:00', repeat: 'daily' });
  m1.waterAdd(300);
  m1.waterAdd(200);
  const before = m1.getState();
  assert.strictEqual(before.water.totalMl, 500);

  // 文件必须真实存在且是合法 JSON，且没有残留 .tmp
  const file = path.join(dir, 'infohub-reminders.json');
  assert.ok(fs.existsSync(file), '数据文件应存在：' + file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(raw.todos.length, 1);
  assert.strictEqual(raw.todos[0].text, '交周报');
  assert.ok(!fs.existsSync(file + '.tmp'), '.tmp 不应残留（rename 应已完成）');

  // 新实例（模拟重启）
  const b = makeCtx(ref, dir);
  const m2 = create(b.ctx);
  const after = m2.getState();
  assert.strictEqual(after.todos.length, 1, '重启后待办应还在');
  assert.strictEqual(after.todos[0].text, '交周报');
  assert.strictEqual(after.todos[0].repeat, 'daily');
  assert.strictEqual(after.todos[0].dueAt, before.todos[0].dueAt, '重启后 dueAt 应保持');
  assert.strictEqual(after.water.totalMl, 500, '重启后喝水累计应保持');

  // 重启后同一 occurrence 不应补弹历史提醒（lastFiredKey 持久化）
  const c = makeCtx(ref, dir);
  const m3 = create(c.ctx);
  ref.t = new Date(2026, 10, 25, 18, 0, 30).getTime();
  m3._tick();
  assert.strictEqual(todoEmits(c.emits).length, 1, '18:00 应正常弹一次');
});

test('持久化：文件损坏能自愈', () => {
  const dir = freshDir();
  const file = path.join(dir, 'infohub-reminders.json');
  fs.writeFileSync(file, '{这不是 JSON', 'utf8');
  const ref = { t: baseTime() };
  const { ctx, logs } = makeCtx(ref, dir);
  const m = create(ctx);
  assert.strictEqual(m.getState().todos.length, 0, '损坏文件应回落到空状态');
  const backups = fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'));
  assert.strictEqual(backups.length, 1, '应把坏文件备份成 .corrupt-*，实际：' + backups.join(','));
  assert.ok(logs.some((l) => l.includes('损坏')), '应记一条损坏日志');
});

test('参数校验：非法时间/空文本被拒绝', () => {
  const dir = freshDir();
  const ref = { t: baseTime() };
  const { ctx } = makeCtx(ref, dir);
  const m = create(ctx);
  assert.strictEqual(m.addTodo({ text: '', at: '09:00' }).ok, false);
  assert.strictEqual(m.addTodo({ text: 'x', at: '25:99' }).ok, false);
  assert.strictEqual(m.addTodo({ text: 'x', at: '9:5' }).ok, false);
  assert.strictEqual(m.addTodo({ text: 'ok', at: '9:05' }).ok, true, 'H:mm 应被接受并归一成 09:05');
  assert.strictEqual(m.getState().todos[0].at, '09:05');
  assert.strictEqual(m.removeTodo('不存在').ok, false);
});

test('接口完整性：契约要求的额外 API 都在实例上', () => {
  const dir = freshDir();
  const ref = { t: baseTime() };
  const { ctx } = makeCtx(ref, dir);
  const m = create(ctx);
  for (const k of ['addTodo', 'removeTodo', 'toggleTodo', 'focusStart', 'focusStop',
    'waterAdd', 'waterUndo', 'getState', 'start', 'stop', 'status', 'refresh']) {
    assert.strictEqual(typeof m[k], 'function', '缺少方法 ' + k);
  }
  assert.strictEqual(m.name, 'reminders');
  assert.strictEqual(typeof m.defaults, 'object');
  // toggleTodo：完成/取消完成
  const r = m.addTodo({ text: 'toggle 我', at: '12:00', repeat: 'daily' });
  const id = r.todo.id;
  assert.strictEqual(m.toggleTodo(id).state.todos[0].done, true, 'toggle 应标完成');
  const back = m.toggleTodo(id).state.todos[0];
  assert.strictEqual(back.done, false, '再 toggle 应恢复未完成');
  assert.ok(back.dueAt > ref.t, '恢复后应重新排到未来');
});

/* ---------------- 执行 ---------------- */

(async () => {
  for (const [name, fn] of cases) {
    try {
      await fn();
      pass++;
      console.log('  ✓ ' + name);
    } catch (e) {
      fail++;
      console.log('  ✗ ' + name + '\n     ' + (e && e.message));
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\nreminders: ' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + cases.length);
  if (fail) process.exitCode = 1;
})();
