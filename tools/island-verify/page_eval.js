/* 页面求值小工具（灵动岛/桌宠页面通用）
   用法：node page_eval.js <page|island> "<js>" [--port 9224] [--shot out.png]
   page   → url 含 /index.html   island → url 含 island.html
   输出：求值结果（JSON 或原样字符串）；--shot 时把页面截图存盘并打印路径 */
'use strict';
const fs = require('node:fs');
const http = require('node:http');

const argv = process.argv.slice(2);
const which = (argv[0] || 'page').toLowerCase();
const expr = argv[1] || '1';
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const port = Number(arg('--port', 9224));
const shot = arg('--shot', '');

const get = (path) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path }, (r) => {
    let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

(async () => {
  const list = await get('/json/list');
  const want = which === 'island' ? 'island.html' : 'index.html';
  const t = list.find((x) => x.type === 'page' && (x.url || '').includes(want));
  if (!t) { console.log('NO_TARGET ' + want + ' | have: ' + list.filter((x) => x.type === 'page').map((x) => x.url.split('/').pop()).join(', ')); process.exit(2); }
  const { wsConnect } = require('./miniws');
  const ws = await wsConnect(t.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.sendText(JSON.stringify({ id: i, method, params })); });
  ws.onMessage((raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const out = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const v = out.result && out.result.result;
  if (v && v.subtype === 'error') console.log('EVAL_ERROR ' + (v.description || '').split('\n')[0]);
  else console.log(typeof v.value === 'object' ? JSON.stringify(v.value) : String(v.value));
  if (shot) {
    const png = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shot, Buffer.from(png.result.data, 'base64'));
    console.log('SHOT ' + shot);
  }
  ws.close();
})();
