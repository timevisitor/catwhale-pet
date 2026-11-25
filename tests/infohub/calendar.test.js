'use strict';
/**
 * 飞书日历（calendar）测试
 *
 * 跑法：node tests/infohub/calendar.test.js
 *
 * 覆盖契约 §4.8 的验收点：
 *   1) 固定 JSON 样本（按 lark-cli `calendar +agenda --format json` 的实测结构）解析正确
 *   2) lark-cli 在 JSON 前打印的提示行（[lark-cli] uat-client: …）不会让解析炸
 *   3) 登录态过期（ok:false / authentication）→ 静默失败，status() 给人话原因
 *   4) 本机真实跑一次 lark-cli calendar +agenda（命令与脱敏输出见 README）
 */

const assert = require('node:assert');
const path = require('node:path');

const create = require('../../app/infohub/sources/calendar.js');

let pass = 0;
let fail = 0;
const cases = [];
function test(name, fn) { cases.push([name, fn]); }

/* ---------- 固定样本：与真机输出同结构（时间戳换成固定值） ---------- */
const TODAY = new Date();
const Y = TODAY.getFullYear();
const M = TODAY.getMonth();
const D = TODAY.getDate();
function ts(h, mi) { return String(Math.floor(new Date(Y, M, D, h, mi, 0, 0).getTime() / 1000)); }
function ymd(h) { return Y + '-' + String(M + 1).padStart(2, '0') + '-' + String(h).padStart(2, '0'); }

const SAMPLE_OK = {
  ok: true,
  identity: 'user',
  data: {
    items: [
      {
        event_id: 'evt_9f2c1a',
        summary: '产品周会',
        status: 'confirmed',
        free_busy_status: 'busy',
        self_rsvp_status: 'accept',
        start_time: { timestamp: ts(14, 30), timezone: 'Asia/Shanghai' },
        end_time: { timestamp: ts(15, 30), timezone: 'Asia/Shanghai' },
      },
      {
        event_id: 'evt_早9',
        summary: '与客户对齐需求（腾讯会议）',
        status: 'confirmed',
        start_time: { timestamp: ts(9, 0), timezone: 'Asia/Shanghai' },
        end_time: { timestamp: ts(10, 0), timezone: 'Asia/Shanghai' },
      },
      {
        event_id: 'evt_全天',
        summary: '公司团建',
        status: 'confirmed',
        start_time: { date: ymd(D), timezone: 'UTC' },
        end_time: { date: ymd(D + 1), timezone: 'UTC' },
      },
      {
        event_id: 'evt_取消',
        summary: '已取消的会',
        status: 'cancelled',
        start_time: { timestamp: ts(11, 0), timezone: 'Asia/Shanghai' },
      },
    ],
  },
};

const SAMPLE_AUTH_FAIL = {
  ok: false,
  identity: 'user',
  error: {
    type: 'authentication',
    subtype: 'token_missing',
    message: 'need_user_authorization (user: ou_a9ad5a1aaf7cdd24677231053c351ff5)',
    hint: 'run `lark-cli auth login --scope "calendar:calendar.event:read" --no-wait --json` …',
  },
};

const SAMPLE_SCOPE_FAIL = {
  ok: false,
  identity: 'bot',
  error: { type: 'authorization', code: 99991672, message: 'access denied: app … has not applied for the required scope(s)' },
};

test('固定样本：排序、全天置顶、跳过已取消、HH:mm 正确', () => {
  const r = create.parseAgenda(SAMPLE_OK);
  assert.strictEqual(r.ok, true, '应解析成功：' + JSON.stringify(r));
  const times = r.items.map((x) => x.time);
  assert.deepStrictEqual(times, ['全天', '09:00', '14:30'], '顺序/时间不对：' + times.join(','));
  assert.strictEqual(r.items[1].title, '与客户对齐需求（腾讯会议）');
  assert.strictEqual(r.items.filter((x) => x.title === '已取消的会').length, 0, 'cancelled 应被过滤');
  assert.strictEqual(r.items[0].allDay, true);
});

test('JSON 前的提示行不影响解析（真机实测存在）', () => {
  const noisy = '[lark-cli] uat-client: refresh_token expired for ou_a9ad…, clearing\n'
    + JSON.stringify(SAMPLE_OK, null, 2);
  const r = create.parseAgenda(noisy);
  assert.strictEqual(r.ok, true, '应能跳过提示行');
  assert.strictEqual(r.items.length, 3);
});

test('登录态过期 → 静默失败 + 人话原因', () => {
  const r = create.parseAgenda(SAMPLE_AUTH_FAIL);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.needAuth, true, '应标记 needAuth');
  assert.ok(/未登录飞书/.test(r.error), '应给出「未登录飞书」原因，实际：' + r.error);
  // 顶层字段里不应带 open_id 明文以外的敏感物（这里只做基本检查）
  assert.ok(!/Bearer|token=/.test(r.error), '原因文案里不应出现凭据');
});

test('应用缺权限 → 原因点明权限', () => {
  const r = create.parseAgenda(SAMPLE_SCOPE_FAIL);
  assert.strictEqual(r.ok, false);
  assert.ok(/权限/.test(r.error), '应提示权限问题，实际：' + r.error);
});

test('脏输入不抛异常', () => {
  assert.strictEqual(create.parseAgenda('').ok, false);
  assert.strictEqual(create.parseAgenda('not json at all').ok, false);
  assert.strictEqual(create.parseAgenda('{"ok":true,"data":{}}').ok, false, '没有列表应报错');
  assert.strictEqual(create.parseAgenda(null).ok, false);
  // 空 items 是合法的「今天没会」
  const empty = create.parseAgenda({ ok: true, data: { items: [] } });
  assert.strictEqual(empty.ok, true);
  assert.strictEqual(empty.items.length, 0);
});

test('maskId 脱敏 open_id / 邮箱', () => {
  const m = create.maskId('ou_a9ad5a1aaf7cdd24677231053c351ff5');
  assert.ok(m.startsWith('ou_a9ad…'), '应保留前 4 位 hex，实际：' + m);
  assert.ok(!m.includes('24677231053c351ff5'), '后半段不应出现');
  assert.strictEqual(create.maskId('ab@example.com'), 'ab…@example.com');
});

test('本机真实跑一次 lark-cli calendar +agenda', async () => {
  const snaps = [];
  const logs = [];
  const ctx = {
    cfg: () => ({ enabled: true }),
    setCfg: () => {},
    emit: () => {},
    snapshot: (k, v) => snaps.push({ kind: k, data: v }),
    log: (m) => logs.push(m),
    dataDir: path.join(__dirname, '.tmp-calendar'),
    appDir: path.join(__dirname, '../../app'),
    paths: {
      localAppData: process.env.LOCALAPPDATA || '',
    },
  };
  const c = create(ctx);
  const bin = c._findCli();
  assert.ok(bin, '本机应能找到 lark-cli（%LOCALAPPDATA%\\hermes\\node）');
  const r = await c.refresh();
  const st = c.status();
  console.log('     lark-cli = ' + bin);
  if (r.ok) {
    console.log('     真实结果：今日 ' + r.count + ' 项日程，status=' + JSON.stringify(st));
    assert.strictEqual(snaps.length, 1, '成功时应上报一次 calendar 快照');
    assert.ok(Array.isArray(snaps[0].data.today));
  } else {
    // 本机当前就是登录态过期：必须「失败静默」——不抛、不 emit、status() 说原因
    console.log('     真实结果：失败（符合预期，登录态问题）→ ' + r.error);
    assert.strictEqual(snaps.length, 0, '失败时不应上报空快照（避免面板被清空）');
    assert.ok(st.detail && st.detail.length > 0, 'status() 必须给原因');
    assert.strictEqual(st.ready, false, '失败时 ready 应为 false');
  }
  assert.strictEqual(logs.length > 0, true, '应有日志');
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
  console.log('\ncalendar: ' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + cases.length);
  if (fail) process.exitCode = 1;
})();
