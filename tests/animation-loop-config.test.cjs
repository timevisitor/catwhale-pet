'use strict';
/* 动画片段循环配置（animation-loop.json）的公开行为测试。
   不需要 Electron / 联网 / 第三方依赖。运行：node --test tests/animation-loop-config.test.cjs
   这些用例只断言"对外承诺"：缺省值、canonical 输出、拒绝规则、损坏文件降级、写盘失败保留旧配置。 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_CONFIG, MIN_SPAN_SEC, normalizeConfig, createStore,
} = require('../app/animation-loop-config.js');

/* PET_TEST_TMP 可指定测试工作目录；缺省遵循系统临时目录，便于跨平台运行。 */
const TEMP_ROOT = process.env.PET_TEST_TMP || os.tmpdir();
fs.mkdirSync(TEMP_ROOT, { recursive: true });
process.env.TMPDIR = TEMP_ROOT;
process.env.TMP = TEMP_ROOT;
process.env.TEMP = TEMP_ROOT;

const temp = fs.mkdtempSync(path.join(TEMP_ROOT, 'animloop-'));
after(() => {
  const resolved = path.resolve(temp);
  assert.equal(path.dirname(resolved), path.resolve(TEMP_ROOT));
  assert.ok(path.basename(resolved).startsWith('animloop-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});

let seq = 0;
/** 每个用例一个独立目录，互不干扰 */
function makeStore(opts = {}) {
  const dir = path.join(temp, 'c' + (++seq));
  return createStore({ file: path.join(dir, 'animation-loop.json'), fs: opts.fs });
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function tmpLeft(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.includes('.tmp')); } catch (e) { return []; }
}
const VALID = { enabled: true, actionId: 'jump_high', start: 1.25, end: 2.75 };

test('缺省：没有配置文件时 get 返回内置缺省，且读配置不会落盘', () => {
  assert.deepEqual({ ...DEFAULT_CONFIG }, { enabled: false, actionId: 'idle', start: 0, end: 2 });
  const s = makeStore();
  const r = s.get();
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, { enabled: false, actionId: 'idle', start: 0, end: 2 });
  assert.equal(r.error, undefined);                       // 没文件 ≠ 出错
  assert.equal(fs.existsSync(s.file), false);             // 启动/读取不写用户配置
});

test('set 落盘 → get 读回同一份；目录自动创建，不残留临时文件', () => {
  const s = makeStore();
  const w = s.set(VALID);
  assert.equal(w.ok, true);
  assert.deepEqual(w.config, VALID);
  assert.equal(fs.existsSync(s.file), true);
  const onDisk = readJson(s.file);
  assert.deepEqual(onDisk, VALID);
  const r = s.get();
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, VALID);
  assert.deepEqual(tmpLeft(path.dirname(s.file)), []);
});

test('set 返回 canonical：去掉 actionId 首尾空格、只保留 4 个字段、不改 DEFAULT_CONFIG', () => {
  const s = makeStore();
  const w = s.set({ enabled: false, actionId: '  idle  ', start: 0, end: 2, duration: 99, foo: 'x' });
  assert.equal(w.ok, true);
  assert.deepEqual(w.config, { enabled: false, actionId: 'idle', start: 0, end: 2 });
  assert.deepEqual(Object.keys(w.config).sort(), ['actionId', 'enabled', 'end', 'start']);
  assert.deepEqual({ ...DEFAULT_CONFIG }, { enabled: false, actionId: 'idle', start: 0, end: 2 });
  assert.equal(normalizeConfig(VALID).config.actionId, 'jump_high');
});

test('拒绝非对象输入，且绝不抛异常', () => {
  const s = makeStore();
  for (const bad of [null, undefined, 42, 'idle', '{"enabled":true}', [], true, () => {}]) {
    const r = s.set(bad);
    assert.equal(r.ok, false, '应拒绝 ' + String(bad));
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 0);
    assert.equal(r.config, undefined);
  }
  assert.equal(fs.existsSync(s.file), false);             // 被拒绝的输入不能落盘
});

test('enabled 只接受真正的布尔值', () => {
  const s = makeStore();
  for (const bad of ['true', 'false', 1, 0, null, {}, []]) {
    const r = s.set({ enabled: bad, actionId: 'idle', start: 0, end: 2 });
    assert.equal(r.ok, false, '应拒绝 enabled=' + JSON.stringify(bad));
    assert.match(r.error, /enabled/i);
  }
  for (const good of [true, false]) {
    const r = s.set({ enabled: good, actionId: 'idle', start: 0, end: 2 });
    assert.equal(r.ok, true);
    assert.equal(r.config.enabled, good);
  }
});

test('actionId：空串 / 原型链关键字 / 路径分隔符 / 控制字符 / 超长都拒绝', () => {
  const s = makeStore();
  const bad = ['', '   ', '__proto__', 'constructor', 'prototype', '../idle', 'a/b', 'a\\b',
    'idle\n', '.hidden', 'x'.repeat(65), 123, null, {}];
  for (const id of bad) {
    const r = s.set({ enabled: true, actionId: id, start: 0, end: 2 });
    assert.equal(r.ok, false, '应拒绝 actionId=' + JSON.stringify(id));
    assert.match(r.error, /actionId/);
  }
  for (const id of ['idle', 'jump_high', 'tail-open.v2', '吃米饭', 'x'.repeat(64)]) {
    const r = s.set({ enabled: true, actionId: id, start: 0, end: 2 });
    assert.equal(r.ok, true, '应接受 actionId=' + id);
    assert.equal(r.config.actionId, id);
  }
});

test('start/end 必须是有限数值，且 0 <= start < end', () => {
  const s = makeStore();
  const bad = [
    { start: NaN, end: 2 }, { start: 0, end: NaN }, { start: 0, end: Infinity },
    { start: -Infinity, end: 2 }, { start: -1, end: 2 }, { start: 1, end: 1 },
    { start: 2, end: 1 }, { start: '0.5', end: 2 }, { start: 0, end: '2' },
    { start: null, end: 2 }, { start: 0, end: true }, { start: 0, end: undefined },
  ];
  for (const p of bad) {
    const r = s.set(Object.assign({ enabled: true, actionId: 'idle' }, p));
    assert.equal(r.ok, false, '应拒绝 ' + JSON.stringify(p));
    assert.match(r.error, /start|end|数值|时长/);
  }
  const ok = s.set({ enabled: true, actionId: 'idle', start: 0, end: 0.5 });
  assert.equal(ok.ok, true);
});

test('最短片段 0.2 秒：浮点边界用容差，真正太短的拒绝', () => {
  const s = makeStore();
  const short = [
    { start: 0, end: 0.1 }, { start: 0, end: 0.199 }, { start: 5.0, end: 5.19 },
  ];
  for (const p of short) {
    const r = s.set(Object.assign({ enabled: true, actionId: 'idle' }, p));
    assert.equal(r.ok, false, '应拒绝过短片段 ' + JSON.stringify(p));
    assert.match(r.error, /0\.2|最短|时长/);
  }
  // 0.3-0.1 在二进制浮点里是 0.19999999999999998，必须放行
  for (const p of [{ start: 0, end: 0.2 }, { start: 0.1, end: 0.3 }, { start: 1, end: 1.2 }]) {
    const r = s.set(Object.assign({ enabled: true, actionId: 'idle' }, p));
    assert.equal(r.ok, true, '应接受恰好 0.2s 的片段 ' + JSON.stringify(p));
  }
  assert.equal(MIN_SPAN_SEC, 0.2);
});

test('缺字段按内置缺省补齐（手改文件只写 enabled 也能用）', () => {
  const s = makeStore();
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.writeFileSync(s.file, JSON.stringify({ enabled: true }));
  const r = s.get();
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, { enabled: true, actionId: 'idle', start: 0, end: 2 });
  const w = s.set({ enabled: false });
  assert.equal(w.ok, true);
  assert.deepEqual(w.config, { enabled: false, actionId: 'idle', start: 0, end: 2 });
});

test('get 遇到损坏 JSON / 非法字段 / 路径是目录 → 安全缺省 + 可读 error，不抛异常', () => {
  const s1 = makeStore();
  fs.mkdirSync(path.dirname(s1.file), { recursive: true });
  fs.writeFileSync(s1.file, '{这不是 JSON');
  const r1 = s1.get();
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.config, { enabled: false, actionId: 'idle', start: 0, end: 2 });
  assert.equal(typeof r1.error, 'string');
  assert.ok(r1.error.length > 0);

  const s2 = makeStore();
  fs.mkdirSync(path.dirname(s2.file), { recursive: true });
  fs.writeFileSync(s2.file, JSON.stringify({ enabled: true, actionId: 'idle', start: 9, end: 1 }));
  const r2 = s2.get();
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.config, { enabled: false, actionId: 'idle', start: 0, end: 2 });
  assert.match(r2.error, /start|end|无效/);

  const s3 = makeStore();
  fs.mkdirSync(s3.file, { recursive: true });             // 同名目录冒充配置文件
  const r3 = s3.get();
  assert.equal(r3.ok, true);
  assert.deepEqual(r3.config, { enabled: false, actionId: 'idle', start: 0, end: 2 });
  assert.equal(typeof r3.error, 'string');
});

test('写盘失败 → ok:false，旧的有效配置原样保留，且不留临时垃圾', () => {
  const s = makeStore();
  assert.equal(s.set(VALID).ok, true);
  const realFs = fs;
  const broken = Object.assign({}, fs, {
    writeFileSync() { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; },
  });
  const s2 = createStore({ file: s.file, fs: broken });
  const w = s2.set({ enabled: false, actionId: 'idle', start: 0, end: 2 });
  assert.equal(w.ok, false);
  assert.match(w.error, /写入|失败/);
  assert.equal(w.config, undefined);
  assert.deepEqual(readJson(s.file), VALID);              // 旧配置没被覆盖
  const r = s.get();
  assert.deepEqual(r.config, VALID);
  assert.deepEqual(tmpLeft(path.dirname(s.file)), []);
  assert.equal(realFs.existsSync(s.file + '.tmp'), false);
});

test('rename 失败（原子替换失败）也不破坏旧文件', () => {
  const s = makeStore();
  assert.equal(s.set(VALID).ok, true);
  const broken = Object.assign({}, fs, {
    renameSync() { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; },
  });
  const s2 = createStore({ file: s.file, fs: broken });
  const w = s2.set({ enabled: true, actionId: 'eat', start: 0, end: 3 });
  assert.equal(w.ok, false);
  assert.deepEqual(readJson(s.file), VALID);
  assert.deepEqual(tmpLeft(path.dirname(s.file)), []);    // 失败的 tmp 被清掉
});

test('原型污染键（__proto__ 等）被拒绝，不会改写对象原型', () => {
  const s = makeStore();
  const evil = JSON.parse('{"enabled":true,"actionId":"idle","start":0,"end":2,"__proto__":{"polluted":1}}');
  const r = s.set(evil);
  assert.equal(r.ok, false);
  assert.match(r.error, /__proto__|原型/);
  assert.equal({}.polluted, undefined);
  const evil2 = JSON.parse('{"enabled":true,"actionId":"idle","start":0,"end":2,"constructor":{"polluted":1}}');
  assert.equal(s.set(evil2).ok, false);
  assert.equal(fs.existsSync(s.file), false);
});

test('大 end 值不由后端裁剪（视频真实时长上界由前端处理）', () => {
  const s = makeStore();
  const r = s.set({ enabled: true, actionId: 'idle', start: 0, end: 3600 });
  assert.equal(r.ok, true);
  assert.equal(r.config.end, 3600);
});

test('配置独立：多次 set 只写自己那份文件，目录里没有别的产物', () => {
  const s = makeStore();
  s.set(VALID);
  s.set({ enabled: false, actionId: 'idle', start: 0, end: 2 });
  const dir = path.dirname(s.file);
  assert.deepEqual(fs.readdirSync(dir), ['animation-loop.json']);
});

test('createStore 缺 file 直接报错（编程错误不静默）', () => {
  assert.throws(() => createStore({}), /file/);
  assert.throws(() => createStore(), /file/);
  assert.throws(() => createStore({ file: '' }), /file/);
});
