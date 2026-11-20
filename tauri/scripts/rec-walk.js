// 主窗 CDP 录屏（Page.startScreencast 逐帧 PNG），给演示源用。
// usage: CDP_PORT=9240 CDP_BASE=http://127.0.0.1:9240 CDP_URL='tauri.localhost/$' \
//          node rec-walk.js <outDir> <seconds>
const fs = require('node:fs');
const path = require('node:path');
const BASE = process.env.CDP_BASE || 'http://127.0.0.1:9222';
const FILT = process.env.CDP_URL || '';
const [outDir, secsArg] = process.argv.slice(2);
const secs = Number(secsArg || 6);

async function main() {
  const list = await (await fetch(BASE + '/json/list')).json();
  const re = FILT ? new RegExp(FILT) : null;
  const pages = list.filter((t) => t.type === 'page' && (!re || re.test(t.url || '')));
  if (!pages.length) throw new Error('no page target');
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  fs.mkdirSync(outDir, { recursive: true });

  let id = 0;
  const call = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++id;
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id !== mid) return;
        ws.removeEventListener('message', onMsg);
        m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result);
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  let n = 0;
  const t0 = Date.now();
  await call('Page.enable');
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method !== 'Page.screencastFrame') return;
    n += 1;
    fs.writeFileSync(path.join(outDir, String(n).padStart(4, '0') + '.png'),
      Buffer.from(m.params.data, 'base64'));
    call('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
  });
  await call('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 612, maxHeight: 1020 });
  await new Promise((r) => setTimeout(r, secs * 1000));
  await call('Page.stopScreencast');
  console.log(JSON.stringify({ frames: n, seconds: ((Date.now() - t0) / 1000).toFixed(1), out: outDir }));
  ws.close();
}

main().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
