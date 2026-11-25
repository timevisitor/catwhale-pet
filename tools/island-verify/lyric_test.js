// 歌词链路自检：真实请求网易云接口 + 解析 LRC（不启动 Electron）
const { _lyric } = require('./app/island.js');
const L = _lyric;
(async () => {
  const cases = [['YELLOW', '神山羊'], ['100 Bad Days', 'AJR'], ['ばかじゃないのに', 'ずっと真夜中でいいのに。']];
  for (const [t, a] of cases) {
    const t0 = Date.now();
    const r = await L.fetchLyric(t, a);
    const ms = Date.now() - t0;
    if (!r) { console.log(JSON.stringify({ title: t, ok: false, ms })); continue; }
    const cur = r.lines.slice(0, 3).map((x) => x[1]);
    console.log(JSON.stringify({ title: t, ok: true, lines: r.lines.length, ms, first: cur }));
  }
  // 解析器单测：非法行/多时间戳/空文本
  const p = L.parseLrc('[00:01.50]A\n[bad]x\n\n[01:02.25]B\n[00:00.00]');
  console.log(JSON.stringify({ parse: p }));
})();
