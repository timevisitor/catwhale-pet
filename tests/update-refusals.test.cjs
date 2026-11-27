// §7「必须拒绝自动升级的 8 种情形」的单元测试
// 事实集全部给「通过」，再单独把某一项打坏 —— 这样能保证每一条理由都是它自己触发的。
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAutoUpdate } = require('../app/updater.js');

const GOOD = {
  isDev: false,
  platformOk: true,
  installWritable: true,
  parentWritable: true,
  assetCount: 1,
  sumsAsset: true,
  expectedSha256: 'a'.repeat(64),
  sameVolume: true,
};

const cases = [
  ['1 开发模式', { isDev: true }, /开发模式/],
  ['2 安装目录不可写', { installWritable: false }, /安装目录不可写/],
  ['3 父目录不可写', { parentWritable: false }, /上一级目录不可写/],
  ['4 无 SHA256SUMS', { sumsAsset: false }, /校验清单/],
  ['5 无匹配资产', { assetCount: 0 }, /没有适用于本端/],
  ['5b 多个匹配资产', { assetCount: 2 }, /多个升级包/],
  ['6 清单里没这个文件', { expectedSha256: '' }, /清单里没有这个升级包/],
  ['7 非 win-x64', { platformOk: false }, /Windows x64/],
  ['8 不在同一个卷', { sameVolume: false }, /不在同一个盘/],
];

for (const [name, patch, re] of cases) {
  test('拒绝理由 ' + name, () => {
    const r = evaluateAutoUpdate({ ...GOOD, ...patch });
    assert.equal(r.canAutoUpdate, false);
    assert.match(r.reason, re);
    assert.ok(r.reason.length >= 6, '理由必须是给人看的中文句子');
  });
}

test('全部事实通过时才允许自动升级', () => {
  const r = evaluateAutoUpdate(GOOD);
  assert.equal(r.canAutoUpdate, true);
  assert.equal(r.reason, '');
});

test('理由的优先级：开发模式压过一切；资产匹配压过校验清单', () => {
  assert.match(evaluateAutoUpdate({ ...GOOD, isDev: true, platformOk: false }).reason, /开发模式/);
  assert.match(evaluateAutoUpdate({ ...GOOD, sumsAsset: false, assetCount: 0 }).reason, /没有适用于本端/,
    'U3 场景：release 里只有对端包且没有清单 → 必须说「没有适用于本端」，不能说「没有校验清单」');
});

test('没有事实（undefined）时按空对象处理，不抛异常', () => {
  const r = evaluateAutoUpdate();
  assert.equal(r.canAutoUpdate, false);
  assert.equal(typeof r.reason, 'string');
});

// 打印清单：报告里要「8 种拒绝理由的实测文本」，直接 node 跑这个文件就能看到
test('打印 8 种拒绝理由（供报告引用）', () => {
  const out = cases.map(([name, patch]) => [name, evaluateAutoUpdate({ ...GOOD, ...patch }).reason]);
  console.log('\n--- canAutoUpdate=false 的实测文本 ---');
  for (const [k, v] of out) console.log(k.padEnd(22) + ' | ' + v);
  assert.ok(out.length >= 8);
});
