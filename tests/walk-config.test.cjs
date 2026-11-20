'use strict';
/* 走动配置（<userData>/walk.json）的断言（先写测试，再实现 app/walk-config.js）。
   为什么要独立文件：范围要跨重启保留，但绝不能污染 settings.json / pet-state.json
   （那两个一改就会触发 harness 重启或位置覆盖）。
   运行：node --test tests/walk-config.test.cjs */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const W = require('../app/walk-config.js');

const TEMP_ROOT = process.env.PET_TEST_TMP || os.tmpdir();
fs.mkdirSync(TEMP_ROOT, { recursive: true });
const temp = fs.mkdtempSync(path.join(TEMP_ROOT, 'walkcfg-'));
after(() => {
  const resolved = path.resolve(temp);
  assert.equal(path.dirname(resolved), path.resolve(TEMP_ROOT));
  fs.rmSync(resolved, { recursive: true, force: true });
});

test('默认值：巡游关闭、没有范围（= 整个工作区）', () => {
  assert.equal(W.DEFAULT_CONFIG.enabled, false);
  assert.equal(W.DEFAULT_CONFIG.rect, null);
  assert.ok(W.DEFAULT_CONFIG.speed > 0);
});

test('没配过文件时 get() 返回缺省且 ok:true（不报错、不阻断启动）', () => {
  const s = W.createStore({ file: path.join(temp, 'none.json') });
  const r = s.get();
  assert.equal(r.ok, true);
  assert.equal(r.config.enabled, false);
  assert.equal(r.config.rect, null);
});

test('set() 写盘后 get() 能读回同一份（范围持久化的判据）', () => {
  const s = W.createStore({ file: path.join(temp, 'walk.json') });
  const cfg = { enabled: true, rect: { x: 120, y: 80, width: 900, height: 600 },
                win: { width: 2560, height: 1440 }, displayId: 65537, speed: 150 };
  const w = s.set(cfg);
  assert.equal(w.ok, true);
  assert.deepEqual(w.config, cfg);
  assert.deepEqual(W.createStore({ file: path.join(temp, 'walk.json') }).get().config, cfg);
});

test('非法输入被拒绝且旧文件不被破坏（安全缺省 + 可读错误）', () => {
  const file = path.join(temp, 'bad.json');
  const s = W.createStore({ file });
  assert.equal(s.set({ enabled: 'yes' }).ok, false);
  assert.equal(s.set({ rect: { x: 0, y: 0, width: -10, height: 100 } }).ok, false);
  assert.equal(s.set({ speed: -1 }).ok, false);
  assert.equal(s.set({ rect: { x: 'a', y: 0, width: 10, height: 10 } }).ok, false);
  assert.equal(fs.existsSync(file), false, '被拒绝的写入不能留下文件');
  fs.writeFileSync(file, '{ 坏掉的 json');
  const r = s.get();
  assert.equal(r.ok, true, '读坏了也必须 ok:true，按缺省处理');
  assert.equal(r.config.enabled, false);
  assert.ok(r.error && r.error.length > 0, '要给出可读原因，不能静默');
});

test('尺寸/速度被夹到合理区间，矩形边界不为负', () => {
  const s = W.createStore({ file: path.join(temp, 'clamp.json') });
  const r = s.set({ enabled: true, speed: 99999, rect: { x: -50, y: -20, width: 300, height: 200 } });
  assert.equal(r.ok, true);
  assert.ok(r.config.speed <= 600);
  assert.ok(r.config.rect.x >= 0 && r.config.rect.y >= 0);
});

test('窗口尺寸变化时矩形按比例重算（换屏/改分辨率不能把范围留在旧坐标系）', () => {
  const out = W.rescaleConfig({ enabled: true, rect: { x: 100, y: 100, width: 800, height: 600 },
                                win: { width: 1920, height: 1080 } }, { width: 3840, height: 2160 });
  assert.deepEqual(out.rect, { x: 200, y: 200, width: 1600, height: 1200 });
  assert.deepEqual(out.win, { width: 3840, height: 2160 });
  const same = W.rescaleConfig({ enabled: true, rect: { x: 1, y: 2, width: 3, height: 4 }, win: { width: 100, height: 100 } },
                                { width: 100, height: 100 });
  assert.deepEqual(same.rect, { x: 1, y: 2, width: 3, height: 4 });
});

/* ---- walk:get 每次读都重写 walk.json（评审挡发布项之三） ---- */
test('sameConfig：值相同就判同（读路径不该因为拿到新对象就落盘）', () => {
  const a = { enabled: true, rect: { x: 100, y: 150, width: 1200, height: 400 }, win: { width: 2560, height: 1392 }, displayId: 7, speed: 130 };
  const b = { enabled: true, rect: { x: 100, y: 150, width: 1200, height: 400 }, win: { width: 2560, height: 1392 }, displayId: 7, speed: 130 };
  assert.equal(W.sameConfig(a, b), true);
  assert.equal(W.sameConfig(a, W.rescaleConfig(a, { width: 2560, height: 1392 })), true,
    '同尺寸换算一遍后应当判同（这正是 walk:get 每次都会走的一步）');
});

test('sameConfig：范围/开关/速度/显示器任一不同就判不同（该写还是要写）', () => {
  const base = { enabled: false, rect: { x: 100, y: 150, width: 1200, height: 400 }, win: { width: 2560, height: 1392 }, displayId: 7, speed: 130 };
  assert.equal(W.sameConfig(base, Object.assign({}, base, { enabled: true })), false);
  assert.equal(W.sameConfig(base, Object.assign({}, base, { speed: 200 })), false);
  assert.equal(W.sameConfig(base, Object.assign({}, base, { displayId: 9 })), false);
  assert.equal(W.sameConfig(base, Object.assign({}, base, { rect: { x: 100, y: 150, width: 1201, height: 400 } })), false);
  assert.equal(W.sameConfig(base, Object.assign({}, base, { win: { width: 1920, height: 1080 } })), false);
  assert.equal(W.sameConfig(base, Object.assign({}, base, { rect: null })), false);
  assert.equal(W.sameConfig(base, null), false);
});
