// 把 ../web 的资源同步到 app/renderer（打进去的是这份拷贝）
const fs = require('fs'), path = require('path');
const src = path.resolve(__dirname, '..', '..', 'web');
const dst = path.resolve(__dirname, '..', 'renderer');
const SKIP = new Set(['_interaction_test.html', '_selftest.html', '启动桌宠.bat']);   // 网页版启动脚本不进 app 包
fs.rmSync(dst, { recursive: true, force: true });
(function copy(a, b) {
  fs.mkdirSync(b, { recursive: true });
  for (const e of fs.readdirSync(a, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(a, e.name), d = path.join(b, e.name);
    if (e.isDirectory()) copy(s, d); else fs.copyFileSync(s, d);
  }
})(src, dst);
console.log('renderer 已同步:', dst);
