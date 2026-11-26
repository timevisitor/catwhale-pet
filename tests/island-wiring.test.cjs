'use strict';
/* 灵动岛「事件驱动」在真实页面里的接线断言（静态检查，起 Electron 之前先把低级错误挡掉）。
 *
 * 为什么要有：index.html 是单文件大页面，锚点上报的触发点分散在 place() / play() /
 * applyVideoMirror() / 拖动松手 四处，漏一处就会变成「拖动跟得上、换姿势跟不上」这种
 * 只在一半场景复现的问题。这里把「谁该调谁」和「不该再有谁」都钉住。
 *
 * 运行：node --test tests/island-wiring.test.cjs */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WEB = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
/* app/renderer 是生成物（gitignore），新 clone 里可能还没有 —— 用到时才读 */
const RENDERER_PATH = path.join(ROOT, 'app', 'renderer', 'index.html');
const readRenderer = () => fs.existsSync(RENDERER_PATH) ? fs.readFileSync(RENDERER_PATH, 'utf8') : null;
const ISLAND = fs.readFileSync(path.join(ROOT, 'app', 'island.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'app', 'preload.js'), 'utf8');

const fnBody = (src, name) => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const end = src.indexOf('\n}', i);
  return src.slice(i, end < 0 ? i + 2000 : end);
};

test('页面在跑主脚本之前就加载了 island-anchor.js', () => {
  const lib = WEB.indexOf('<script src="island-anchor.js"></script>');
  const main = WEB.indexOf("<script>\n/* =====");
  const mainAlt = WEB.indexOf('<script>\r\n/* =====');
  const mainAt = main >= 0 ? main : mainAlt;
  assert.ok(lib > 0, 'index.html 里没有 <script src="island-anchor.js">');
  assert.ok(mainAt > lib, 'island-anchor.js 必须在主脚本之前加载（否则首帧拿不到上报器）');
});

test('place() 是位移的唯一出口：它必须登记一次岛锚点', () => {
  const body = fnBody(WEB, 'place');
  assert.ok(body.includes('islandPoke('), 'place() 里没有 islandPoke：拖动/走动时胶囊不会跟');
});

test('play() 换动作时登记锚点（逐像素头顶识别由 key 变化触发）', () => {
  const body = fnBody(WEB, 'play');
  assert.ok(body.includes('islandPoke('), 'play() 里没有 islandPoke：换姿势后头顶不会重新量');
});

test('镜像开关会强制重算（cx 会翻到另一边）', () => {
  const body = fnBody(WEB, 'applyVideoMirror');
  assert.ok(/islandPoke\(true\)/.test(body), 'applyVideoMirror() 必须 islandPoke(true)');
});

test('拖动松手才落盘角色局部锚点', () => {
  assert.ok(/islandAnchorCommit\(\)/.test(WEB), '拖动松手处没有 islandAnchorCommit()：重启后锚点恢复不了');
  const up = WEB.slice(WEB.indexOf("on(pet, 'pointerup'"), WEB.indexOf("on(pet, 'contextmenu'"));
  assert.ok(up.includes('islandAnchorCommit()'), 'islandAnchorCommit() 必须在 pointerup 的分支里');
});

test('旧的 700ms 轮询上报已经拆掉（内容轮询不得再驱动定位）', () => {
  assert.ok(!/setInterval\(\(\) => \{ try \{ reportIslandAnchor\(false\)/.test(WEB),
    'index.html 里还留着 700ms 的 reportIslandAnchor 轮询');
  assert.ok(!/setInterval\(\(\) => \{\s*try \{ islandPoke\(false\); \} catch \(e\) \{\} \}, 700\)/.test(WEB),
    '还留着 700ms 的 islandPoke 轮询');
  /* 兜底只允许 1.5s 一次 */
  assert.ok(/setInterval\(\(\) => \{ try \{ islandPoke\(false\); \} catch \(e\) \{\} \}, 1500\)/.test(WEB),
    '缺少 1.5s 的慢兜底（视频解出首帧后头顶还需再量一次）');
});

test('app/island.js：定位不再挂在 500ms 内容轮询上', () => {
  const tick = fnBody(ISLAND, 'tick');
  assert.ok(!/place\(false\)/.test(tick), 'tick() 里还在 place(false)：内容轮询会拽着窗口跑');
  assert.ok(/place\(true\)/.test(tick), 'tick() 里应在「首次显示 / 球↔胶囊」时补一次落位');
});

test('app/island.js：锚点走 latest-only 合并，且动作换姿直接采纳', () => {
  assert.ok(/function queueAnchor\(/.test(ISLAND), '缺少 queueAnchor（按轮事件循环合并）');
  assert.ok(/noteAnchor\(x\);\s*\n\s*place\(false, TOL_MOVE\)/.test(ISLAND),
    'queueAnchor 里应串起 noteAnchor → place(false, TOL_MOVE)');
  assert.ok(/if \(a\.pose\)/.test(ISLAND), 'noteAnchor 没有采纳 pose 标志（事件驱动下旧的多帧确认会饿死）');
  assert.ok(!/ANCHOR_MISS_NEED/.test(ISLAND), '旧的「连续 N 帧才算数」还留着（轮询时代的写法）');
});

test('app/island.js：没有角色矩形就不落位（不再退回工作区归一化）', () => {
  /* v0.7.1-r2 起默认落点拆到 defaultPos()，islandPos() = defaultPos() + 手动偏移 */
  const base = fnBody(ISLAND, 'defaultPos');
  assert.ok(/if \(!anchorRect/.test(base), 'defaultPos 缺少 anchorRect 必需判断');
  const pos = fnBody(ISLAND, 'islandPos');
  assert.ok(/const d = defaultPos\(\)/.test(pos) && /if \(!d\) return null/.test(pos),
    'islandPos 没先把「没有角色矩形」传上来');
});

test('preload 与主进程的锚点通道对得上', () => {
  assert.ok(PRELOAD.includes("ipcRenderer.send('island:anchor-raw'"), 'preload 缺 island:anchor-raw');
  assert.ok(PRELOAD.includes("ipcRenderer.invoke('island:anchor-commit'"), 'preload 缺 island:anchor-commit');
  assert.ok(ISLAND.includes("ipcMain.on('island:anchor-raw'"), 'island.js 缺 island:anchor-raw 处理器');
  assert.ok(ISLAND.includes("'island:anchor-commit':"), 'island.js 缺 island:anchor-commit 处理器');
});

test('app/renderer/index.html 与 web/index.html 同步（打包进去的是前者）', (t) => {
  const renderer = readRenderer();
  if (renderer === null) {
    t.skip('app/renderer 尚未生成（新 clone 还没跑 node tools/sync-renderer.js）');
    return;
  }
  assert.equal(renderer, WEB, 'renderer 与 web 不一致：忘了跑 node tools/sync-renderer.js');
});
