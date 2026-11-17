// Minimal CDP driver over Node's built-in WebSocket (Node 22+).
// usage: node cdp.js eval "<js expression>"     -> prints JSON value
//        node cdp.js list                        -> prints page targets
//        node cdp.js shot <out.png>              -> saves a screenshot of the first page target
const BASE = process.env.CDP_BASE || 'http://127.0.0.1:9222';

async function pageWs() {
  const r = await fetch(BASE + '/json/list');
  const list = await r.json();
  const filt = process.env.CDP_URL || '';
  const re = filt ? new RegExp(filt) : null;
  const pages = list.filter((t) => t.type === 'page' && (!re || re.test(t.url || '')));
  if (!pages.length) throw new Error('no page target');
  return pages[0].webSocketDebuggerUrl;
}

let id = 0;
function call(ws, method, params = {}) {
  return new Promise((res, rej) => {
    const mid = ++id;
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== mid) return;
      ws.removeEventListener('message', onMsg);
      if (m.error) rej(new Error(method + ': ' + JSON.stringify(m.error)));
      else res(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  const url = await pageWs();
  const ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  if (cmd === 'eval') {
    const r = await call(ws, 'Runtime.evaluate', { expression: arg, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) console.log('EXCEPTION ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    else console.log(JSON.stringify(r.result.value));
  } else if (cmd === 'shot') {
    const fmt = arg.toLowerCase().endsWith('.jpg') ? 'jpeg' : 'png';
    const r = await call(ws, 'Page.captureScreenshot', { format: fmt, ...(fmt === 'jpeg' ? { quality: 92 } : {}), captureBeyondViewport: false });
    require('node:fs').writeFileSync(arg, Buffer.from(r.data, 'base64'));
    console.log('saved ' + arg + ' (' + Math.round(r.data.length / 1024) + ' kB b64)');
  } else if (cmd === 'list') {
    const r = await fetch(BASE + '/json/list'); console.log(JSON.stringify((await r.json()).map((t) => ({ type: t.type, url: t.url?.slice(0, 90) })), null, 1));
  } else if (cmd === 'call') {
    const r = await call(ws, arg, JSON.parse(process.argv[4] || '{}'));
    console.log(JSON.stringify(r).slice(0, 800));
  } else if (cmd === 'reload') {
    await call(ws, 'Page.reload', { ignoreCache: false });
    console.log('reloaded');
  } else if (cmd === 'nav') {
    await call(ws, 'Page.enable');
    await call(ws, 'Page.navigate', { url: arg });
    console.log('navigating ' + arg);
  }
  ws.close();
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
