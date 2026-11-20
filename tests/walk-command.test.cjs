'use strict';
/* 聊天本地指令的断言（先写测试，再实现 web/walk-command.js）。
   关键约束：
     · 只认「整句都是指令」的明确说法，普通聊天必须原样交给后端（不能被劫持）
     · 停下 / 向左走 / 往右走 200 像素 都能解析出可执行意图
   运行：node --test tests/walk-command.test.cjs */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const C = require('../web/walk-command.js');

test('明确的走动指令被解析（左/右/上/下，含可选像素数）', () => {
  assert.deepEqual(C.parse('向左走'), { type: 'walk', dx: -1, dy: 0, distance: null, dir: 'left' });
  assert.deepEqual(C.parse('往右走 200 像素'), { type: 'walk', dx: 1, dy: 0, distance: 200, dir: 'right' });
  assert.deepEqual(C.parse('朝上走 120px'), { type: 'walk', dx: 0, dy: -1, distance: 120, dir: 'up' });
  assert.deepEqual(C.parse('向下走120'), { type: 'walk', dx: 0, dy: 1, distance: 120, dir: 'down' });
  assert.equal(C.parse('往右走 200 像素').type, 'walk');
});

test('礼貌前缀 / 标点 / 全角数字都不影响解析', () => {
  const r = C.parse('  请帮我往左走 ３００ 像素！ ');
  assert.equal(r.type, 'walk');
  assert.equal(r.dx, -1);
  assert.equal(r.distance, 300);
});

test('停下类指令被识别为 stop', () => {
  for (const s of ['停下', '停下来', '停住', '别走了', '不要走了', '站住', '停止走动', '停一下', '停下！']) {
    assert.deepEqual(C.parse(s), { type: 'stop' }, '未识别：' + s);
  }
});

test('普通聊天绝不被当成指令（这是最容易搞坏聊天的地方）', () => {
  const normal = [
    '我今天向左走了两万步',
    '左边那个按钮是什么',
    '往右走还是往左走好一点？',
    '停下来的英文怎么说',
    '帮我写一段 CSS 让元素往右移动 200 像素',
    '为什么它刚才停下来了',
    '往右',
    '右边',
    '走',
    '',
    '   ',
    '我停不下来'
  ];
  for (const s of normal) assert.equal(C.parse(s), null, '被误判为指令：' + s);
});

test('数字必须真的存在才给 distance（没有就是 null，写错的单位整句不算指令）', () => {
  assert.equal(C.parse('向左走').distance, null);
  assert.equal(C.parse('向左走 像素'), null);       // 有单位没数字 = 写错了，别猜
});

test('像素数被夹到合理区间（0 / 天文数字都不执行）', () => {
  assert.equal(C.parse('向右走 0 像素').distance, C.MIN_DISTANCE);
  assert.equal(C.parse('向右走 999999 像素').distance, C.MAX_DISTANCE);
});

test('describe 生成可回读的中文反馈（含实际走了多远）', () => {
  assert.match(C.describe({ type: 'stop' }, null), /停|停住/);
  const t = C.describe({ type: 'walk', dx: 1, dy: 0, distance: 200, dir: 'right' }, { moved: 200, clamped: false });
  assert.match(t, /右/);
  assert.match(t, /200/);
  const c = C.describe({ type: 'walk', dx: -1, dy: 0, distance: 2000, dir: 'left' }, { moved: 123, clamped: true });
  assert.match(c, /边/);          // 到边了要说清楚
  assert.match(c, /123/);
});
