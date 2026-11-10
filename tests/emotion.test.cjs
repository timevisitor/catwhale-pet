// 情绪识别单测：node tests/emotion.test.cjs
const assert = require('assert');
const E = require('../web/emotion.js');

const cases = [
  ['你好呀！今天也要加油哦', 'wave'],
  ['哈哈，太好了！', 'happy'],
  ['*脸红* 才、才不是因为你夸我呢', 'shy'],
  ['哼！不理你了 😤', 'angry'],
  ['呜呜……对不起，我搞砸了 😭', 'sad'],
  ['诶？！真的吗？', 'surprised'],
  ['嗯……让我想想 🤔', 'think'],
  ['交给我吧，小菜一碟 😎', 'proud'],
  ['我一点都不难过', null],                 // 否定：不该演难过
  ['我不开心', null],
  ['好的，已经帮你把文件移到桌面。', null],     // 中性回复：保持原状态
  ['', null],
  ['```\ngit commit -m "抱歉 修复"\n```\n已提交。', null],   // 代码块里的词不算
  ['（开心地摇尾巴）其实有点难过', 'happy'],    // 动作描写权重 3 > 普通词 1
  ['晚安，明天见 👋', 'wave'],
];
let n = 0;
for (const [text, want] of cases) {
  const got = E.detect(text);
  assert.strictEqual(got, want, `「${text}」期望 ${want} 实得 ${got} ${JSON.stringify(E.analyze(text).score)}`);
  n++;
}
assert.deepStrictEqual(E.EMOTIONS, ['happy', 'shy', 'angry', 'sad', 'surprised', 'think', 'proud', 'wave']);
for (const e of E.EMOTIONS) assert.ok(E.LABEL[e], '缺中文名 ' + e);
console.log(`emotion: ${n + 2}/${n + 2} 通过`);
