// 把 ../web 的资源同步到 app/renderer（打进去的是这份拷贝）
const fs = require('fs'), path = require('path');
const src = path.resolve(__dirname, '..', '..', 'web');
const dst = path.resolve(__dirname, '..', 'renderer');
const SKIP = new Set(['_interaction_test.html', '_selftest.html', '启动桌宠.bat']);   // 网页版启动脚本不进 app 包
/* *_poster.png 是 encode_webm.py 的编码中间产物：页面没有任何 <video poster>，皮肤编辑器与
   工具脚本也都不读（全仓只有生成它的那个脚本提到它）。26 张共约 11 MB，原先原样进了
   app/renderer 并随发布 ZIP 分发（v0.7.1 包内实测）。源文件留在 web/ 里，只是不拷贝。 */
const isPoster = (name) => /_poster\.png$/i.test(name);
let skippedPosters = 0;
fs.rmSync(dst, { recursive: true, force: true });
(function copy(a, b) {
  fs.mkdirSync(b, { recursive: true });
  for (const e of fs.readdirSync(a, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    if (isPoster(e.name)) { skippedPosters++; continue; }
    const s = path.join(a, e.name), d = path.join(b, e.name);
    if (e.isDirectory()) copy(s, d); else fs.copyFileSync(s, d);
  }
})(src, dst);
console.log('renderer 已同步:', dst, '(跳过未使用的 poster 图 ' + skippedPosters + ' 张)');
