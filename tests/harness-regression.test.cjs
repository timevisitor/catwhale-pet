'use strict';
// 不需要 Electron、真实 API key、联网或第三方依赖。运行：node --test tests/harness-regression.test.cjs
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { HarnessClient, resolveRepo, inspectRepo, supportsHarnessNode, readHarnessDefaults } = require('../app/harness-client');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-harness-regression-'));
after(() => {
  const resolved = path.resolve(temp);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('pet-harness-regression-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
function write(name, text) {
  fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, text);
}
function repo(name, deps = false, code = '') {
  const root = path.join(temp, name);
  write(path.join(root, 'apps/cli/src/bin.ts'), code);
  write(path.join(root, 'package.json'), '{"type":"module"}');
  if (deps) {
    write(path.join(root, 'node_modules/tsx/package.json'), '{"type":"module","exports":{"./esm":"./loader.mjs"}}');
    write(path.join(root, 'node_modules/tsx/loader.mjs'), 'export {};');
  }
  return root;
}
const good = repo('中文 空格 # 仓库', true, `
import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line);
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{cwd:process.cwd(),tsconfig:process.env.TSX_TSCONFIG_PATH}})+'\\n');
  if(m.method==='shutdown') process.exit(0);
});`);
write(path.join(good, 'tsconfig.json'), '{}');
const bare = repo('missing-deps');
const patch = path.join(temp, 'patch.yml'); write(patch, '[]');

test('仓库根、带引号路径、深层目录、环境变量使用一致的解析', () => {
  assert.equal(resolveRepo(good), good);
  assert.equal(resolveRepo('  "' + good + '"  '), good);
  assert.equal(resolveRepo(path.join(good, 'apps/cli/src')), good);
  process.env.PET_REPO_TEST_ROOT = good;
  try { assert.equal(resolveRepo('%PET_REPO_TEST_ROOT%'), good); }
  finally { delete process.env.PET_REPO_TEST_ROOT; }
});
test('识别 src 嵌套及 ZIP 解压目录；不猜测多个 ZIP 仓库', () => {
  const nested = repo('nested/src');
  assert.equal(resolveRepo(path.dirname(nested)), nested);
  const zip = repo('downloads/deepseek-harness-main');
  assert.equal(resolveRepo(path.dirname(zip)), zip);
  repo('downloads/deepseek-harness-dev');
  assert.equal(resolveRepo(path.dirname(zip)), '');
});
test('目录错误与依赖缺失分别诊断；只叫 bin.ts 的文件夹不能冒充入口', () => {
  assert.equal(inspectRepo(good).status, 'ok');
  assert.equal(inspectRepo(bare).status, 'nodeps');
  assert.match(inspectRepo(bare).detail, /目录正确/);
  assert.equal(inspectRepo(path.join(temp, '.dsh')).status, 'norepo');
  assert.equal(inspectRepo('').status, 'missing');
  const falseRoot = path.join(temp, 'false-root');
  fs.mkdirSync(path.join(falseRoot, 'apps/cli/src/bin.ts'), { recursive: true });
  assert.equal(inspectRepo(falseRoot).status, 'norepo');
});
test('跳过 Node 20、22.18 和 23，接受 22.19 与 24+', () => {
  for (const ver of ['20.19.0', '22.18.0', '23.9.0', 'unknown']) assert.equal(supportsHarnessNode(ver), false);
  for (const ver of ['v22.19.0', '22.20.0', '24.0.0', '26.1.0']) assert.equal(supportsHarnessNode(ver), true);
});
test('尊重 DSH_HOME 的默认模型设置', () => {
  const old = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(temp, 'dsh-home');
  write(path.join(process.env.DSH_HOME, 'settings.yaml'), 'agent-default-model:\n  provider: local-provider\n  model: local-model\n');
  try { assert.deepEqual(readHarnessDefaults(), { provider: 'local-provider', model: 'local-model' }); }
  finally { if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; }
});
test('自定义 cwd 无 node_modules 仍可启动并握手；旧进程退出不清除新进程', async () => {
  const cwd = path.join(temp, '工作目录'); fs.mkdirSync(cwd);
  const client = new HarnessClient({ repo: good, cwd, patch, nodeExe: process.execPath });
  try {
    await client.start();
    assert.equal(client.ready, true);
    assert.equal((await client.prompt('test')).cwd, cwd);
    assert.equal((await client.prompt('config')).tsconfig, path.join(good, 'tsconfig.json'));
    const old = client.child;
    client.kill();
    await client.start();
    old.emit('exit', 1, null);
    assert.equal(client.ready, true);
    assert.equal((await client.prompt('again')).cwd, cwd);
  } finally { await client.shutdown(); }
});
test('缺依赖直接报原因；不存在的可执行文件不会触发未捕获 error', async () => {
  const missingDeps = new HarnessClient({ repo: bare, patch });
  const missingExe = new HarnessClient({ repo: good, patch, nodeExe: path.join(temp, 'not-a-node.exe') });
  try {
    await assert.rejects(missingDeps.start(), /目录正确.*pnpm install/);
    await assert.rejects(missingExe.start(), /启动失败.*ENOENT/);
    assert.equal(missingExe.pending.size, 0);
  } finally { await missingDeps.shutdown(); await missingExe.shutdown(); }
});
test('启动进程退出时保留 stderr 错误原因', async () => {
  const failing = repo('fails-at-boot', true, "process.stderr.write('fixture dependency failure\\n'); process.exit(7);");
  const client = new HarnessClient({ repo: failing, patch, nodeExe: process.execPath });
  try { await assert.rejects(client.start(), /fixture dependency failure/); }
  finally { await client.shutdown(); }
});
test('ASAR 打包时，子进程读取解包后的补丁文件', async () => {
  const unpacked = path.join(temp, 'resources/app.asar.unpacked/harness-sdk/pet-sdk.patch.yml');
  write(unpacked, '[]');
  const client = new HarnessClient({ repo: good, nodeExe: process.execPath,
    patch: unpacked.replace('app.asar.unpacked', 'app.asar') });
  try { assert.equal(client.patch, unpacked); await client.start(); assert.equal(client.ready, true); }
  finally { await client.shutdown(); }
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../app/package.json')));
  assert.ok(pkg.build.asarUnpack.includes('harness-sdk/**'));
});

const main = fs.readFileSync(path.join(__dirname, '../app/main.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
function between(source, a, b) {
  const start = source.indexOf(a), end = source.indexOf(b, start + a.length);
  assert.ok(start >= 0 && end > start, a);
  return source.slice(start, end);
}
function configContext() {
  const context = vm.createContext({ fs, inspectRepo, CFG_FILE: path.join(temp, 'settings.json'),
    CFG_DEFAULTS: { deepseek: {}, harness: { repo: '' } },
    loadCfgRaw: () => ({ harness: { repo: good }, deepseek: {} }),
    safeStorage: { isEncryptionAvailable: () => false }, console });
  vm.runInContext(between(main, 'function saveCfg(', "ipcMain.handle('config:get'"), context);
  return context;
}
test('设置保存归一化路径，拒绝无效目录且不覆盖原设置，缺依赖可以保存', () => {
  const c = configContext();
  assert.equal(c.saveCfg({ harness: { repo: '"' + path.join(good, 'apps/cli') + '"' } }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(c.CFG_FILE)).harness.repo, good);
  const before = fs.readFileSync(c.CFG_FILE, 'utf8');
  assert.equal(c.saveCfg({ harness: { repo: path.join(temp, 'invalid') } }).ok, false);
  assert.equal(fs.readFileSync(c.CFG_FILE, 'utf8'), before);
  assert.equal(c.saveCfg({ harness: { repo: bare } }).ok, true);
  assert.equal(c.saveCfg({ harness: { repo: 123 } }).ok, false);
});
test('有效手动配置优先于旧配置和自动探测；旧配置仍可使用', () => {
  const c = vm.createContext({ inspectRepo, detectRepo: () => bare });
  vm.runInContext(between(main, 'function effectiveHarnessRepo(', 'function envHarnessStatus('), c);
  assert.equal(c.effectiveHarnessRepo({ harness: { repo: good } }, { harnessRepo: bare }).repo, good);
  assert.equal(c.effectiveHarnessRepo({ harness: {} }, { harnessRepo: good }).repo, good);
  assert.equal(c.effectiveHarnessRepo({ harness: {} }, {}).repo, bare);
  assert.equal(c.effectiveHarnessRepo({ harness: { repo: path.join(temp, 'invalid') } }, {}).status, 'norepo');
});
test('重现用户反馈：手动目录有效且自动探测为空时，设置面板不再报目录错误', async () => {
  const elements = {}, messages = {};
  const c = vm.createContext({
    window: { petHost: { getConfig: async () => ({ ok: true, harness: { repo: good, detected: '', ...inspectRepo(good) }, deepseek: {}, everything: {} }) } },
    document: { getElementById: id => elements[id] ||= {} },
    SET: {}, els: {}, setMsg: (id, text, kind) => messages[id] = { text, kind },
  });
  vm.runInContext(between(html, 'async function loadSettingsForm()', 'async function saveSettings()'), c);
  await c.loadSettingsForm();
  assert.equal(messages.setRepoHint.kind, 'ok');
  assert.match(messages.setRepoHint.text, /入口检查通过/);
  assert.equal(elements.setRepo.value, good);
  assert.doesNotMatch(elements.setStatus.textContent, /未找到/);
});
test('重新探测失败保留手动输入，成功才替换为找到的目录', async () => {
  let handler, result = { ok: true, valid: false, path: '' };
  const input = { value: good };
  const c = vm.createContext({ document: { getElementById: id => id === 'setDetect' ? { addEventListener: (_event, fn) => handler = fn } : input },
    SET: {}, setMsg: () => {}, window: { petHost: { detectRepo: async () => result } } });
  vm.runInContext(between(html, "document.getElementById('setDetect').addEventListener", "document.getElementById('setBrowse').addEventListener"), c);
  await handler(); assert.equal(input.value, good);
  result = { ok: true, valid: true, path: bare };
  await handler(); assert.equal(input.value, bare);
});
test('测试连接先保存输入；保存失败时不启动旧配置', async () => {
  const order = []; let saveOK = false;
  const c = vm.createContext({ SET: {}, setMsg: () => {},
    saveSettings: async () => { order.push('save'); return saveOK; },
    window: { petHost: { testConfig: async () => { order.push('test'); return { ok: true }; } } },
  });
  vm.runInContext(between(html, 'async function testSettings()', '/* ===================== DeepSeek 聊天'), c);
  await c.testSettings(); assert.deepEqual(order, ['save']);
  saveOK = true; await c.testSettings(); assert.deepEqual(order, ['save', 'save', 'test']);
});
test('测试连接超时不返回假成功', async () => {
  const handlers = {};
  const h = { onEvent: () => {}, prompt: async () => {}, kill: () => {} };
  const c = vm.createContext({ ipcMain: { handle: (name, fn) => handlers[name] = fn }, harness: null,
    ensureHarness: () => h, setTimeout: fn => setTimeout(fn, 1), clearTimeout });
  vm.runInContext(between(main, "ipcMain.handle('config:test'", '/* ---------- DeepSeek Harness 聊天'), c);
  const result = await handlers['config:test']();
  assert.equal(result.ok, false); assert.match(result.error, /超时/);
});
test('已有仓库补依赖不要求 Git；部署完成但保存失败必须报告失败', async () => {
  const c = vm.createContext({ fs: { ...fs, writeFileSync: () => { throw new Error('fixture write denied'); } }, path,
    envJobs: {}, envTools: () => ({ git: { ok: false }, node: { ok: true }, pnpm: { ok: true, path: 'pnpm' }, nodeOk: true, pnpmOk: true }),
    envLog: () => {}, envJobSend: () => {}, isRepoDir: p => p === good,
    spawnJob: async () => ({ ok: true }), loadCfgRaw: () => ({}), CFG_FILE: path.join(temp, 'not-written.json'),
    NPM_MIRROR: '', harness: null,
  });
  vm.runInContext(between(main, 'async function deployHarness(', '/* ---------- 设置'), c);
  const result = await c.deployHarness(good, false);
  assert.equal(result.ok, false); assert.match(result.error, /依赖已安装，但保存仓库设置失败.*fixture write denied/);
});
test('resolveNode 会退回 Electron 而不是启动 PATH 上过旧的 Node', () => {
  let version = 'v20.19.0';
  const c = vm.createContext({ supportsHarnessNode, process: { execPath: 'electron.exe' },
    require: () => ({ spawnSync: () => ({ status: 0, stdout: version }) }) });
  vm.runInContext(between(main, 'function resolveNode()', '/* ---------- 本地 http 服务'), c);
  assert.equal(c.resolveNode(), 'electron.exe');
  version = 'v24.0.0'; assert.equal(c.resolveNode(), 'node');
});
test('前端所有内联脚本可解析', () => {
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(script[1]);
});
