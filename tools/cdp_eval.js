/* CDP 小工具：连到页面，执行一段 JS 并打印结果（可选截图）
   用法：node cdp_eval.js "<expression>" [--shot out.png] [--port 9222] */
'use strict';
const fs = require('node:fs');

const args = process.argv.slice(2);
const expr = args[0] || 'document.title';
const shotIdx = args.indexOf('--shot');
const shot = shotIdx >= 0 ? args[shotIdx + 1] : '';
const portIdx = args.indexOf('--port');
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 9222;

const http = require('node:http');

function listPages() {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 5000 }, (r) => {
      let b = '';
      r.on('data', (d) => (b += d));
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

(async () => {
  const pages = await listPages();
  const mi = args.indexOf('--match');
  const match = mi >= 0 ? args[mi + 1] : 'index\\.html';
  const re = new RegExp(match);
  const page = pages.find((p) => p.type === 'page' && re.test(p.url)) || pages.find((p) => p.type === 'page');
  if (!page) { console.error('没有可用的页面'); process.exit(2); }
  console.log('PAGE ' + page.url);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await new Promise((res) => (ws.onopen = res));

  // 可选：真实鼠标点击（页面内 .click() 绕过命中测试，验收时必须用这个）
  const ci = args.indexOf('--click'), ri = args.indexOf('--rclick');
  if (ci >= 0 || ri >= 0) {
    const i = ci >= 0 ? ci : ri;
    const x = Number(args[i + 1]), y = Number(args[i + 2]);
    const button = ci >= 0 ? 'left' : 'right';
    const clickCount = 1;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
    await new Promise((res) => setTimeout(res, 400));
  }
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const v = r.result && r.result.result;
  console.log(JSON.stringify(v && v.value !== undefined ? v.value : (r.result && r.result.exceptionDetails) || r, null, 1));

  if (shot) {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s.result && s.result.data) { fs.writeFileSync(shot, Buffer.from(s.result.data, 'base64')); console.log('SHOT ' + shot); }
  }
  ws.close();
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
