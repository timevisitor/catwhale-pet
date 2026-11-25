'use strict';
/**
 * balance.js 验收测试（零依赖，node 自带 assert）
 * 运行：node tests/infohub/balance.test.js
 *
 * 覆盖：
 *   1. deepseek 适配器：真实返回形态解析、Bearer 头、金额与币种
 *   2. puretokens 适配器：total_available + status.quota_per_unit 换算、key 仅内存补 sk- 前缀
 *   3. openai_billing 适配器：解析成功 + 失败静默（404 不抛）
 *   4. 脱敏 api_key 不可用、keyEnv 缺失时的错误收敛
 *   5. 15s 超时机制（测试里用 timeoutMs 覆盖成 300ms，不真等 15s）
 *   6. 阈值告警：只弹一次，同账户 6 小时内不重复
 *   7. snapshot 结构与「快照里没有密钥」
 *   8. config.yaml 正则可抽 provider / base_url / key_env，且不带出 api_key
 *   9. start/stop 与定时器清理
 */
const assert = require('node:assert');
const http = require('node:http');
const create = require('../../app/infohub/sources/balance.js');

/* ---------------- 断言跑分器 ---------------- */

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name);
    console.log('    ' + String((e && e.message) || e).split('\n').join('\n    '));
  }
}

/* ---------------- 本地假服务 ---------------- */

const seen = { dsAuth: '', ptAuth: '', statusAuth: '', slowHits: 0 };
const BASE = { value: '' };

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  const auth = req.headers.authorization || '';

  if (p === '/user/balance') {
    seen.dsAuth = auth;
    return json(res, 200, {
      is_available: true,
      balance_infos: [{
        currency: 'CNY', total_balance: '173.33', granted_balance: '58.04', topped_up_balance: '115.29',
      }],
    });
  }
  if (p === '/api/product/console/api-keys/usage') {
    seen.ptAuth = auth;
    return json(res, 200, {
      code: true,
      data: {
        name: 'Fake Key', total_available: 2500000, total_granted: 5000000, total_used: 2500000,
        unlimited_quota: false, money: { remaining: 5, used: 5, total: 10, currency: 'USD' },
      },
      message: 'ok',
    });
  }
  if (p === '/api/product/console/status') {
    seen.statusAuth = auth;
    return json(res, 200, { success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD' } });
  }
  // status 挂掉的分支：验证 money.remaining 兜底
  if (p === '/nostatus/api/product/console/status') return json(res, 500, { error: 'boom' });
  if (p === '/nostatus/api/product/console/api-keys/usage') {
    return json(res, 200, { code: true, data: { total_available: -99999999, unlimited_quota: true, money: { remaining: -64.551836, currency: 'USD' } } });
  }
  // openai_billing：base_url 里的 /v1 会被剥掉
  if (p === '/dashboard/billing/credit_grants') {
    return json(res, 200, { object: 'credit_summary', total_granted: 20, total_used: 5, total_available: 15 });
  }
  if (p === '/v1/dashboard/billing/credit_grants') {
    return json(res, 200, { object: 'credit_summary', total_granted: 20, total_used: 5 });
  }
  if (p === '/deny/user/balance') return json(res, 401, { error: { message: 'invalid api key' } });
  if (p === '/low/user/balance') {
    return json(res, 200, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '0.42' }] });
  }
  if (p === '/slow/user/balance') { seen.slowHits++; return; /* 故意不响应，测超时 */ }
  json(res, 404, { error: 'not found' });
});

/* ---------------- 假宿主上下文 ---------------- */

function makeCtx(cfg, paths) {
  const events = [];
  const snaps = [];
  const ctx = {
    cfg: () => cfg,
    setCfg: (patch) => Object.assign(cfg, patch),
    emit: (e) => events.push(e),
    snapshot: (kind, data) => snaps.push({ kind, data }),
    log: () => {},
    dataDir: '',            // 不落盘，保证测试不留痕
    appDir: '',
    paths: paths || {},
    hasFeature: () => false,
  };
  ctx.events = events;
  ctx.snaps = snaps;
  return ctx;
}

/* ---------------- 用例 ---------------- */

(async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  BASE.value = 'http://127.0.0.1:' + server.address().port;
  console.log('假服务就绪：' + BASE.value + '\n');

  process.env.TEST_DS_KEY = 'sk-test-deepseek-0000000000';
  process.env.TEST_PT_KEY = 'pt-test-key-000000000000000000';

  // 屏蔽本机真实环境变量，保证「从 config.yaml 抽取」的断言与本机密钥无关
  const realEnv = {};
  for (const name of ['DEEPSEEK_API_KEY', 'PURE_TOKENS_API_KEY', 'OPENAI_API_KEY']) {
    realEnv[name] = process.env[name];
    delete process.env[name];
  }

  console.log('[1] 适配器解析（本地假 http 服务）');

  await test('deepseek：解析 total_balance=173.33 / CNY，Bearer 头正确', async () => {
    const cfg = {
      enabled: true, warnBelow: 1, timeoutMs: 3000,
      accounts: [{ id: 'ds', label: 'DeepSeek', type: 'deepseek', base_url: BASE.value, keyEnv: 'TEST_DS_KEY' }],
    };
    const ctx = makeCtx(cfg);
    const src = create(ctx);
    const r = await src.refresh();
    const it = r.items[0];
    assert.equal(it.ok, true, '应成功：' + JSON.stringify(it));
    assert.equal(it.amount, 173.33);
    assert.equal(it.currency, 'CNY');
    assert.equal(seen.dsAuth, 'Bearer sk-test-deepseek-0000000000');
    assert.equal(ctx.snaps.length, 1);
    assert.equal(ctx.snaps[0].kind, 'balance');
    assert.equal(typeof ctx.snaps[0].data.updatedAt, 'number');
  });

  await test('deepseek：base_url 带 /v1 时也能打到 /user/balance（多余前缀被剥）', async () => {
    const cfg = {
      enabled: true, timeoutMs: 3000,
      accounts: [{ id: 'ds2', label: 'DS', type: 'deepseek', base_url: BASE.value + '/v1', keyEnv: 'TEST_DS_KEY' }],
    };
    const r = await create(makeCtx(cfg)).refresh();
    assert.equal(r.items[0].ok, true);
    assert.equal(r.items[0].amount, 173.33);
  });

  await test('deepseek：多币种优先 CNY；数字字符串也能转', async () => {
    const p = create.parseDeepseek({
      is_available: true,
      balance_infos: [
        { currency: 'USD', total_balance: '12.50' },
        { currency: 'CNY', total_balance: '88.80', topped_up_balance: '80.80', granted_balance: '8.00' },
      ],
    });
    assert.equal(p.ok, true);
    assert.equal(p.amount, 88.8);
    assert.equal(p.currency, 'CNY');
    assert.ok(/充值/.test(p.detail), 'detail 应含充值信息：' + p.detail);
  });

  await test('deepseek：返回体异常时给出 ok:false 而不是抛错', async () => {
    assert.equal(create.parseDeepseek({}).ok, false);
    assert.equal(create.parseDeepseek(null).ok, false);
    assert.equal(create.parseDeepseek({ balance_infos: [{ currency: 'CNY', total_balance: 'much' }] }).ok, false);
  });

  await test('puretokens：total_available/status.quota_per_unit 换算，key 无 sk- 时仅内存补前缀', async () => {
    const cfg = {
      enabled: true, timeoutMs: 3000,
      accounts: [{ id: 'pt', label: 'Pure Tokens', type: 'puretokens', base_url: BASE.value, key: 'abc-no-sk-prefix-0000000000' }],
    };
    const ctx = makeCtx(cfg);
    const src = create(ctx);
    const r = await src.refresh();
    const it = r.items[0];
    assert.equal(it.ok, true, '应成功：' + JSON.stringify(it));
    assert.equal(it.amount, 5, '2500000 / 500000 应为 5');
    assert.equal(it.currency, 'USD');
    assert.equal(seen.ptAuth, 'Bearer sk-abc-no-sk-prefix-0000000000');
    assert.equal(seen.statusAuth, '', 'status 接口不允许带 key');
    // 内存补前缀，不许改配置
    assert.equal(cfg.accounts[0].key, 'abc-no-sk-prefix-0000000000');
  });

  await test('puretokens：unlimited_quota 时不按负账面报警（warnable=false）', async () => {
    const p = create.parsePuretokensUsage(
      { code: true, data: { total_available: -32275918, unlimited_quota: true, money: { remaining: -64.551836, currency: 'USD' } } },
      { success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD' } },
    );
    assert.equal(p.ok, true);
    assert.equal(p.warnable, false);
    assert.ok(Math.abs(p.amount - (-64.551836)) < 1e-6, '换算应等于 money.remaining，实际 ' + p.amount);
    assert.ok(/不限额度/.test(p.detail));
  });

  await test('puretokens：status 挂了用 money.remaining 兜底，不整体失败', async () => {
    const cfg = {
      enabled: true, timeoutMs: 3000,
      accounts: [{ id: 'pt2', label: 'PT2', type: 'puretokens', base_url: BASE.value + '/nostatus', keyEnv: 'TEST_PT_KEY' }],
    };
    const r = await create(makeCtx(cfg)).refresh();
    const it = r.items[0];
    assert.equal(it.ok, true, JSON.stringify(it));
    assert.equal(it.currency, 'USD');
    assert.ok(Math.abs(it.amount - (-64.551836)) < 1e-6);
    assert.equal(it.warnable, false); // unlimited_quota 分支不报警
  });

  await test('openai_billing：解析 total_available', async () => {
    const cfg = {
      enabled: true, timeoutMs: 3000,
      accounts: [{ id: 'oa', label: 'OpenAI', type: 'openai_billing', base_url: BASE.value + '/v1', keyEnv: 'TEST_DS_KEY' }],
    };
    const r = await create(makeCtx(cfg)).refresh();
    assert.equal(r.items[0].ok, true, JSON.stringify(r.items[0]));
    assert.equal(r.items[0].amount, 15);
    assert.equal(r.items[0].currency, 'USD');
  });

  await test('openai_billing：接口 404 时静默失败（ok:false，不抛、不弹窗）', async () => {
    const cfg = {
      enabled: true, timeoutMs: 3000,
      accounts: [{ id: 'oa2', label: 'OpenAI', type: 'openai_billing', base_url: BASE.value + '/empty', keyEnv: 'TEST_DS_KEY' }],
    };
    const ctx = makeCtx(cfg);
    const r = await create(ctx).refresh();
    assert.equal(r.items[0].ok, false);
    assert.ok(/404|接口/.test(r.items[0].error), r.items[0].error);
    assert.equal(ctx.events.length, 0);
  });

  console.log('\n[2] 错误收敛与超时');

  await test('401 → ok:false 且错误信息是中文鉴权原因', async () => {
    const cfg = {
      enabled: true, timeoutMs: 3000,
      accounts: [{ id: 'bad', label: 'Bad', type: 'deepseek', base_url: BASE.value + '/deny', keyEnv: 'TEST_DS_KEY' }],
    };
    const r = await create(makeCtx(cfg)).refresh();
    assert.equal(r.items[0].ok, false);
    assert.ok(/鉴权/.test(r.items[0].error), r.items[0].error);
  });

  await test('请求超时（timeoutMs=300）→ ok:false 含「超时」，不挂死', async () => {
    const t0 = Date.now();
    const cfg = {
      enabled: true, timeoutMs: 300,
      accounts: [{ id: 'slow', label: 'Slow', type: 'deepseek', base_url: BASE.value + '/slow', keyEnv: 'TEST_DS_KEY' }],
    };
    const r = await create(makeCtx(cfg)).refresh();
    const cost = Date.now() - t0;
    assert.equal(r.items[0].ok, false);
    assert.ok(/超时/.test(r.items[0].detail), r.items[0].detail);
    assert.ok(cost < 3000, '应在超时后立刻返回，实际耗时 ' + cost + 'ms');
    assert.equal(seen.slowHits, 1);
  });

  await test('没有任何密钥 → ok:false「未配置密钥」，不抛', async () => {
    const cfg = {
      enabled: true,
      accounts: [{ id: 'nokey', label: '无密钥', type: 'deepseek', base_url: BASE.value, keyEnv: 'NOT_EXIST_ENV_XYZ' }],
    };
    const r = await create(makeCtx(cfg)).refresh();
    assert.equal(r.items[0].ok, false);
    assert.ok(/未配置密钥/.test(r.items[0].detail), r.items[0].detail);
    assert.ok(/NOT_EXIST_ENV_XYZ/.test(r.items[0].error), r.items[0].error);
  });

  await test('脱敏 api_key（sk-abc…xyz）视为不可用', () => {
    assert.equal(create.isUsableKey('sk-abc…xyz'), false);
    assert.equal(create.isUsableKey('sk-abc...xyz'), false);
    assert.equal(create.isUsableKey('«redacted:sk-…»'), false);
    assert.equal(create.isUsableKey('***'), false);
    assert.equal(create.isUsableKey('local'), false);
    assert.equal(create.isUsableKey('sk-0123456789abcdef0123456789abcdef'), true);
  });

  console.log('\n[3] 阈值告警');

  await test('低于 warnBelow → 弹 1 条 warn；重复刷新不再弹（6 小时去重）', async () => {
    const cfg = {
      enabled: true, warnBelow: 1, timeoutMs: 3000,
      accounts: [
        { id: 'low1', label: '低额度A', type: 'deepseek', base_url: BASE.value + '/low', keyEnv: 'TEST_DS_KEY' },
        { id: 'ds', label: '正常账户', type: 'deepseek', base_url: BASE.value, keyEnv: 'TEST_DS_KEY' },
      ],
    };
    const ctx = makeCtx(cfg);
    const src = create(ctx);
    await src.refresh();
    assert.equal(ctx.events.length, 1, '应只有 low1 报警，实际 ' + ctx.events.length);
    const ev = ctx.events[0];
    assert.equal(ev.kind, 'balance');
    assert.equal(ev.level, 'warn');
    assert.equal(ev.source, 'balance');
    assert.equal(ev.key, 'balance:warn:low1');
    assert.equal(ev.data.id, 'low1');
    assert.ok(/低额度A/.test(ev.title), ev.title);
    assert.ok(/0\.42/.test(ev.body), ev.body);

    await src.refresh();
    await src.refresh();
    assert.equal(ctx.events.length, 1, '6 小时内同账户只弹一次，实际 ' + ctx.events.length);
  });

  await test('另一个账户也低 → 追加一条（按账户独立冷却）', async () => {
    const cfg = {
      enabled: true, warnBelow: 1, timeoutMs: 3000,
      accounts: [{ id: 'low2', label: '低额度B', type: 'deepseek', base_url: BASE.value + '/low', keyEnv: 'TEST_DS_KEY' }],
    };
    const ctx = makeCtx(cfg);
    const src = create(ctx);
    await src.refresh();
    assert.equal(ctx.events.length, 1);
    assert.equal(ctx.events[0].data.id, 'low2');
  });

  await test('阈值以上不弹；warnBelow 可配', async () => {
    const cfg = {
      enabled: true, warnBelow: 500, timeoutMs: 3000,
      accounts: [{ id: 'ds', label: 'DS', type: 'deepseek', base_url: BASE.value, keyEnv: 'TEST_DS_KEY' }],
    };
    const ctx = makeCtx(cfg);
    await create(ctx).refresh();
    assert.equal(ctx.events.length, 1, '173.33 < 500 应报警');
    assert.equal(ctx.events[0].data.warnBelow, 500);
  });

  console.log('\n[4] 快照与密钥卫生');

  await test('snapshot 结构正确且不含任何密钥明文', async () => {
    const cfg = {
      enabled: true, timeoutMs: 3000,
      accounts: [
        { id: 'ds', label: 'DeepSeek', type: 'deepseek', base_url: BASE.value, keyEnv: 'TEST_DS_KEY' },
        { id: 'pt', label: 'Pure', type: 'puretokens', base_url: BASE.value, key: 'abc-no-sk-prefix-0000000000' },
      ],
    };
    const ctx = makeCtx(cfg);
    await create(ctx).refresh();
    const snap = ctx.snaps[0];
    assert.equal(snap.kind, 'balance');
    assert.equal(snap.data.items.length, 2);
    for (const it of snap.data.items) {
      for (const f of ['id', 'label', 'type', 'ok', 'amount', 'currency', 'detail']) {
        assert.ok(f in it, '快照项缺字段 ' + f);
      }
    }
    const raw = JSON.stringify(snap);
    assert.ok(!raw.includes('sk-test-deepseek'), '快照泄漏了密钥');
    assert.ok(!raw.includes('abc-no-sk-prefix'), '快照泄漏了密钥');
    assert.ok(!/Bearer/.test(raw), '快照泄漏了授权头');
  });

  await test('日志里不出现密钥明文', async () => {
    const logs = [];
    const cfg = {
      enabled: true, timeoutMs: 3000,
      accounts: [{ id: 'ds', label: 'DS', type: 'deepseek', base_url: BASE.value, keyEnv: 'TEST_DS_KEY' }],
    };
    const ctx = makeCtx(cfg);
    ctx.log = (m) => logs.push(String(m));
    await create(ctx).refresh();
    const all = logs.join('\n');
    assert.ok(all.length > 0, '应有日志');
    assert.ok(!all.includes('sk-test-deepseek-0000000000'), '日志泄漏密钥：' + all);
    assert.ok(/sk-t…\(27\)/.test(all), '应只出现前 4 位+长度：' + all);
  });

  console.log('\n[5] config.yaml 尽力抽取');

  await test('抽 provider / base_url / key_env，且不带出 api_key', () => {
    const sample = [
      'model:',
      '  provider: custom:puretokens-switch-chat',
      'providers:',
      '  xiaomi:',
      '    name: Xiaomi MiMo',
      '    models:',
      '      mimo-v2.6-pro: {}',
      '  deepseek-official:',
      '    name: DeepSeek 官方',
      '    base_url: https://api.deepseek.com',
      '    key_env: DEEPSEEK_API_KEY',
      '    api_key: sk-abc…xyz',
      '  puretokens-claude:',
      '    name: Pure Tokens (Claude / Max)',
      '    base_url: https://api.puretokensx.com',
      '    api_key: 29GxLFnrliSRPN3TGuoXP1eoDdgzryL9yKe3vl3Xop30IFut',
      '    models:',
      '      claude-opus-5-5: {}',
      '  puretokens-switch-chat:',
      '    name: Pure Tokens (Switch)',
      '    base_url: https://api.puretokensx.com/v1',
      '    api_key: Q3phGmBybjGEE0QFjX5MwOypkUtR3WrJFQucuBWApUOQ67Ji',
      'fallback_providers:',
      '- provider: scnet',
    ].join('\n');
    const accs = create.extractAccounts(sample);
    const ids = accs.map((a) => a.id);
    assert.deepEqual(ids.sort(), ['deepseek-official', 'puretokens-claude'].sort(), '实际：' + ids.join(','));
    const ds = accs.find((a) => a.id === 'deepseek-official');
    assert.equal(ds.type, 'deepseek');
    assert.equal(ds.base_url, 'https://api.deepseek.com');
    assert.equal(ds.keyEnv, 'DEEPSEEK_API_KEY');
    const pt = accs.find((a) => a.id === 'puretokens-claude');
    assert.equal(pt.type, 'puretokens');
    assert.equal(pt.base_url, 'https://console.puretokensx.com', 'puretokens 必须打到 console 域');
    assert.equal(pt.keyEnv, 'PURE_TOKENS_API_KEY', '没有 key_env 时回落到类型默认环境变量');
    // 绝不许把 api_key 搬进账户配置
    const raw = JSON.stringify(accs);
    assert.ok(!raw.includes('29GxLFnrliSRPN'), '抽取结果带出了明文 api_key');
    assert.ok(!raw.includes('Q3phGmBybjGEE0QF'), '抽取结果带出了明文 api_key');
    assert.ok(!/api_key|sk-/.test(raw), '抽取结果不该出现 api_key 字段：' + raw);
  });

  await test('没有 providers 段 / 文本为空 → 返回空数组不报错', () => {
    assert.deepEqual(create.extractAccounts(''), []);
    assert.deepEqual(create.extractAccounts('model:\n  provider: x\n'), []);
  });

  await test('bootstrapFromHermes：写回 setCfg，第二次不重复抽', async () => {
    const os = require('node:os');
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(os.tmpdir(), 'balance-test-' + process.pid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.yaml'), [
      'providers:',
      '  deepseek:',
      '    name: DeepSeek',
      '    base_url: https://api.deepseek.com',
      '    key_env: DEEPSEEK_API_KEY',
    ].join('\n'), 'utf8');

    const cfg = { enabled: false, accounts: [] };
    const ctx = makeCtx(cfg, { hermesHome: dir });
    const src = create(ctx);
    const r1 = src.bootstrapFromHermes();
    assert.equal(r1.added, 1, JSON.stringify(r1));
    assert.equal(cfg.accounts.length, 1);
    assert.equal(cfg.accounts[0].type, 'deepseek');
    const r2 = src.bootstrapFromHermes();
    assert.equal(r2.added, 0);
    assert.ok(/已有账户配置/.test(r2.reason), r2.reason);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('环境变量兜底：config.yaml 没有 deepseek 但 env 有 key → 自动补账户', async () => {
    const os = require('node:os');
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(os.tmpdir(), 'balance-test-env-' + process.pid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'providers:\n  xiaomi:\n    name: Xiaomi MiMo\n', 'utf8');
    process.env.DEEPSEEK_API_KEY = 'sk-env-fallback-0000000000000000';
    const cfg = { enabled: true, accounts: [] };
    const src = create(makeCtx(cfg, { hermesHome: dir }));
    const r = src.bootstrapFromHermes();
    assert.equal(r.added, 1, JSON.stringify(r));
    assert.equal(cfg.accounts[0].type, 'deepseek');
    assert.equal(cfg.accounts[0].keyEnv, 'DEEPSEEK_API_KEY');
    assert.equal(cfg.accounts[0].base_url, 'https://api.deepseek.com');
    delete process.env.DEEPSEEK_API_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log('\n[6] 生命周期');

  await test('start() 拉一次并起 10 分钟定时器；stop() 清干净', async () => {
    const cfg = {
      enabled: true, timeoutMs: 3000,
      accounts: [{ id: 'ds', label: 'DS', type: 'deepseek', base_url: BASE.value, keyEnv: 'TEST_DS_KEY' }],
    };
    const ctx = makeCtx(cfg);
    const src = create(ctx);
    await src.start();
    assert.equal(src.status().ready, true, JSON.stringify(src.status()));
    await new Promise((r) => setTimeout(r, 150)); // 等首轮网络返回
    assert.equal(ctx.snaps.length >= 1, true, 'start 应触发首轮刷新');
    await src.stop();
    assert.equal(src.status().ready, false);
    assert.equal(src.status().detail, '已停止');
    // 反复 start/stop 不许报错
    await src.start();
    await src.stop();
  });

  await test('enabled:false 时 start() 不联网（不发快照）', async () => {
    const cfg = { enabled: false, accounts: [{ id: 'ds', type: 'deepseek', base_url: BASE.value, keyEnv: 'TEST_DS_KEY' }] };
    const ctx = makeCtx(cfg);
    const s = create(ctx);
    await s.start();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ctx.snaps.length, 0);
    assert.ok(/已关闭/.test(s.status().detail), s.status().detail);
    assert.equal(ctx.events.length, 0);
    await s.stop();
  });

  await test('未配置任何账户：快照 items 为空、状态提示手填', async () => {
    const cfg = { enabled: true, accounts: [] };
    const ctx = makeCtx(cfg);
    const src = create(ctx);
    const r = await src.refresh();
    assert.deepEqual(r.items, []);
    assert.equal(ctx.snaps[0].data.items.length, 0);
    assert.ok(/未配置/.test(src.status().detail), src.status().detail);
  });

  await test('金额格式化：¥ / $ / 极小值', () => {
    assert.equal(create.moneyText(173.33, 'CNY'), '¥173.33');
    assert.equal(create.moneyText(-64.551836, 'USD'), '$-64.55');
    assert.equal(create.moneyText(0.0042, 'USD'), '$0.0042');
    assert.equal(create.moneyText(null, 'USD'), '—');
  });

  /* ---------------- 收尾 ---------------- */

  delete process.env.TEST_DS_KEY;
  delete process.env.TEST_PT_KEY;
  for (const name of Object.keys(realEnv)) {
    if (realEnv[name] === undefined) delete process.env[name];
    else process.env[name] = realEnv[name];
  }
  server.closeAllConnections();
  server.close();

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) process.exitCode = 1;
})();
