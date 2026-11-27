'use strict';
/* web/index.html 里几段纯逻辑的回归测试（UI/性能优化配套）
 *
 * 这些函数内联在页面脚本里、不依赖 DOM，这里把源码抽出来放进 vm 跑：
 *   · streamStable：流式回答的「稳定前缀」切分 —— 必须保证
 *         mdLite(全文) === 稳定前缀HTML + mdLite(尾段)
 *     对任意文本、任意增量节奏都成立，否则聊天会出现内容丢失/重复/代码块错位。
 *   · snapPx：角色坐标贴物理像素网格。
 *   · rollLounge(preselect)：只预选不起播。
 *
 * 运行：node --test tests/ui-perf.test.cjs */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

/* 从页面脚本里抠出一个顶层 function（花括号配平） */
function grab(name) {
  const head = html.indexOf('function ' + name + '(');
  assert.ok(head >= 0, 'index.html 里找不到函数 ' + name);
  let i = html.indexOf('{', head), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(head, i + 1);
  }
  throw new Error('函数 ' + name + ' 花括号不配平');
}

const ctx = { Math, String, Number, console };
vm.createContext(ctx);
vm.runInContext(grab('mdLite') + '\n' + grab('streamStable'), ctx);
/* streamStable 引用的是页面里的模块级 const SP：vm 全局用 var 声明一份即可 */
vm.runInContext('var SP = { len: 0, html: \'\', src: \'\' };', ctx);
const mdLite = (t) => vm.runInContext('mdLite(' + JSON.stringify(t) + ')', ctx);
const feed = (t) => vm.runInContext('streamStable(' + JSON.stringify(t) + ')', ctx);
const state = () => vm.runInContext('({ len: SP.len, html: SP.html })', ctx);
const reset = () => vm.runInContext('SP = { len: 0, html: \'\', src: \'\' };', ctx);

const SAMPLES = [
  '简单一句话',
  '第一行有 **粗体** 和 `行内代码`\n第二行 <tag> & "引号"\n第三行',
  '说明：\n```js\nconst a = 1;\nif (a) {\n  console.log(`<${a}>`);\n}\n```\n后面还有一行，带 **重点**。\n',
  '```python\ndef f(x):\n    return x * 2\n```',
  '未闭合的代码块：\n```\nstrea',
  '连续代码块\n```\na\n```\n```\nb\n```\n结束',
  '四个反引号 ```` 不是围栏起点吗\n继续',
  '无换行的长文本'.repeat(60) + ' 结尾',
  'a\nb\nc\n',                                   // 很短的行
  '\n\n\n',                                      // 只有换行
  '行尾是反引号 `\n下一行 `code`\n',
  '**未闭合的粗体\n**闭合**\n',
  '中英混排 emoji 🐳 whale\n\t缩进行\r\nCRLF 行\n',
];

/* 逐字符喂 + 随机块喂：每一步都要求 等价 且 前缀只增不减 */
function checkEquivalence(t, chunk) {
  reset();
  let prevLen = 0;
  for (let i = 1; i <= t.length; i += chunk) {
    const cur = t.slice(0, Math.min(i, t.length));
    const p = feed(cur);
    const st = state();
    assert.equal(st.len, p, 'SP.len 与返回的切点一致');
    assert.ok(p >= prevLen, '前缀只增不减（同一轮内）');
    prevLen = p;
    assert.equal(st.html + mdLite(cur.slice(p)), mdLite(cur),
      '增量渲染必须与整段渲染逐字节一致\n--- 文本(到 ' + cur.length + ') ---\n' + JSON.stringify(cur) + '\n--- 切点 ' + p + ' ---');
  }
}

test('streamStable：任意文本、逐字符增量下，前缀+尾段 === 整段 mdLite', () => {
  for (const s of SAMPLES) checkEquivalence(s, 1);
});

test('streamStable：随机块大小（1~37 字符）的增量节奏下同样等价', () => {
  let seed = 20261127;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n + 1; };
  for (const s of SAMPLES) checkEquivalence(s, rnd(37));
});

test('streamStable：长回答（约 12KB，多段代码块）按 token 喂', () => {
  const para = '这是第 N 段说明，包含 **粗体**、`inline` 与 <特殊> & 符号。\n'
    + '```ts\nfunction f<N>(x: N): N {\n  return x ** 2; // `<b>` 不该被当标签\n}\n```\n小结。\n';
  let t = '';
  for (let i = 0; i < 140; i++) t += para.replace(/N/g, String(i));
  assert.ok(t.length > 10000);
  checkEquivalence(t, 3);
  /* 喂到末尾时尾段应远小于全文：否则「稳定前缀」没起作用 */
  reset();
  for (let i = 3; i <= t.length; i += 3) feed(t.slice(0, i));
  const p = feed(t);
  assert.ok(t.length - p < 600, '尾段应只有最后一两行，实际 ' + (t.length - p) + ' 字符');
});

test('streamStable：新一轮（文本变短 / 被整段替换）会重置，不沿用旧前缀', () => {
  reset();
  feed('上一轮的回答\n'.repeat(30));
  const before = state().len;
  assert.ok(before > 0);
  /* 新一轮从空开始再长过旧前缀：不能把旧的 HTML 接在新文本前面 */
  assert.equal(feed(''), 0);
  const t2 = '全新的一轮回答\n'.repeat(40);
  const p = feed(t2);
  const st = state();
  assert.equal(st.html + mdLite(t2.slice(p)), mdLite(t2));
  /* 同长度但内容不同（message 事件整段替换）也要能识别 */
  const t3 = t2.slice(0, 200) + 'X'.repeat(t2.length - 200);
  feed(t3);
  const st3 = state();
  assert.equal(st3.html + mdLite(t3.slice(st3.len)), mdLite(t3));
});

/* ---------- snapPx ---------- */
test('snapPx：坐标贴到物理像素网格（DPR 1 / 1.5 / 2），整数坐标不变', () => {
  const run = (v, dpr) => {
    const c = { Math, window: { devicePixelRatio: dpr } };
    vm.createContext(c);
    vm.runInContext(grab('snapPx'), c);
    return c.snapPx(v);
  };
  assert.equal(run(100, 1), 100);
  assert.equal(run(100.4, 1), 100);
  assert.equal(run(100.5, 1), 101);              // Math.round 语义
  assert.equal(run(823.3333333, 1), 823);
  assert.equal(run(823.4, 1.5), 1235 / 1.5);     // 1235.1 物理像素 → 1235 = 823.33… CSS
  assert.equal(run(204, 1.5), 204);
  assert.equal(run(823.26, 2), 823.5);           // 1646.52 → 1647 物理 = 823.5 CSS
  assert.equal(run(-0.2, 1.25), 0);
  assert.equal(run(500, undefined), 500);        // 无 DPR 信息时按 1
});

/* ---------- rollLounge(preselect) ---------- */
test('rollLounge(preselect=true)：只预选并预热，不起播一次性动作', () => {
  const calls = [];
  const c = {
    Math: Object.assign(Object.create(Math), { random: () => 0 }),   // 必中「做一次性动作」
    IDLE_ACT_CHANCE: 0.35, IDLE_HOLD_MS: 12000,
    directorCtx: () => null,
    usable: () => true,
    states: { idle: { role: 'loop' }, eat: { role: 'idle_act' }, read: { role: 'lounge' } },
    ensureVideoData: (id) => calls.push('warm:' + id),
    playOnce: (id) => calls.push('playOnce:' + id),
    baseWeightOf: () => 1, pickWeighted: (arr) => (arr[0] || {}).id, loungeSpan: () => 8000,
    director: {},
    now: () => 1000,
  };
  c.M = { lastInteract: 1000 };
  vm.createContext(c);
  vm.runInContext(grab('rollLounge'), c);
  calls.length = 0;
  const r1 = c.rollLounge(true);
  assert.equal(calls.some((x) => x.startsWith('playOnce:')), false, '预选模式不得起播');
  assert.equal(r1, undefined);
  assert.equal(c.M.lounge, 'read', '预选模式仍要选出一个空闲状态');
  assert.ok(calls.includes('warm:read'), '预选模式仍要预热该状态');
  /* 对照：不传 preselect 时保持原行为（会起播） */
  calls.length = 0;
  c.rollLounge();
  assert.equal(calls.some((x) => x.startsWith('playOnce:')), true, '正常运行时的一次性动作路径仍在');
});
