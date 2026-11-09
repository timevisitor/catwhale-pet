'use strict';
/* =============================================================================
 * 本地 http 单 Range 支持的真实网络测试（不是字符串断言）
 * -----------------------------------------------------------------------------
 * 起一个真正的 node:http 服务（走 app/media-response.js 的实际响应逻辑），
 * 用 fetch / http.request 发请求，再把响应体与源文件切片逐字节比对。
 *
 * 覆盖：200 全量、HEAD、起点终点、开区间、后缀、终点越界收敛、416、
 *       非法/多区间回退 200、404、坏 percent 400、.. 穿越 403、/skin/ 路由。
 *
 * 运行：node --test tests/media-response.test.cjs
 * 临时文件放 os.tmpdir()；跑测试时把 TEMP/TMP 指到 H: 工作区即可。
 * ============================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { serveFile, resolveRequestPath, mimeFor, parseRange } = require('../app/media-response.js');

let tmp, webRoot, skinDir, outsideFile, server, port;
let blob, realVideo;

function patternBuffer(n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 37 + 11) & 0xff;
  return b;
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(handler);
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

/* 用原生 http.request 发请求：fetch 的 URL 解析会提前归一化 %2e%2e，
   测不到服务端的穿越拦截。 */
function rawRequest(pathname, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: port, path: pathname,
      method: opts.method || 'GET', headers: opts.headers || {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function get(pathname, headers) {
  const res = await fetch('http://127.0.0.1:' + port + pathname, { headers: headers || {} });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body: body };
}

function assertBytes(actual, expected, label) {
  assert.equal(actual.length, expected.length, label + '：响应长度');
  assert.equal(Buffer.compare(actual, expected), 0, label + '：响应字节与源文件切片不一致');
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-range-'));
  webRoot = path.join(tmp, 'web');
  skinDir = path.join(tmp, 'skin');
  fs.mkdirSync(webRoot);
  fs.mkdirSync(skinDir);
  outsideFile = path.join(tmp, 'outside.txt');
  fs.writeFileSync(outsideFile, 'TOP-SECRET-OUTSIDE-WEB-ROOT');

  blob = patternBuffer(65537);
  fs.writeFileSync(path.join(webRoot, 'blob.bin'), blob);
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>range test</title>');
  fs.writeFileSync(path.join(skinDir, 'foo.bin'), patternBuffer(7777));

  // 真实视频也过一遍：字节级比对 + MIME 语义
  const candidates = [
    path.join(__dirname, '..', 'web', 'assets', 'video', 'tail_open.webm'),
    path.join(__dirname, '..', 'app', 'renderer', 'assets', 'video', 'tail_open.webm')
  ];
  const src = candidates.find((p) => fs.existsSync(p));
  realVideo = src ? fs.readFileSync(src) : null;
  if (realVideo) fs.writeFileSync(path.join(webRoot, 'real.webm'), realVideo);

  server = await listen((req, res) => {
    const r = resolveRequestPath(req.url, { webRoot: webRoot, getSkinDir: () => skinDir });
    if (!r.ok) { res.writeHead(r.status); return res.end(String(r.status)); }
    serveFile(req, res, r.file, mimeFor(r.file));
  });
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('无 Range：200 + Content-Length + Accept-Ranges，字节完整', async () => {
  const r = await get('/blob.bin');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(r.headers.get('content-length'), String(blob.length));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assertBytes(r.body, blob, '全量');
});

test('HEAD：头与 GET 一致但不发 body', async () => {
  const r = await get('/blob.bin', {});
  const h = await fetch('http://127.0.0.1:' + port + '/blob.bin', { method: 'HEAD' });
  const body = Buffer.from(await h.arrayBuffer());
  assert.equal(h.status, 200);
  assert.equal(h.headers.get('content-length'), String(blob.length));
  assert.equal(body.length, 0);
  assert.equal(h.headers.get('content-type'), r.headers.get('content-type'));
});

test('Range bytes=0-99：206 + Content-Range，字节等于前 100 字节', async () => {
  const r = await get('/blob.bin', { Range: 'bytes=0-99' });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 0-99/' + blob.length);
  assert.equal(r.headers.get('content-length'), '100');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assertBytes(r.body, blob.subarray(0, 100), 'bytes=0-99');
});

test('Range bytes=1000-（开区间）：从 1000 到文件尾', async () => {
  const r = await get('/blob.bin', { Range: 'bytes=1000-' });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 1000-' + (blob.length - 1) + '/' + blob.length);
  assert.equal(r.headers.get('content-length'), String(blob.length - 1000));
  assertBytes(r.body, blob.subarray(1000), 'bytes=1000-');
});

test('Range bytes=-257（后缀）：最后 257 字节', async () => {
  const r = await get('/blob.bin', { Range: 'bytes=-257' });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes ' + (blob.length - 257) + '-' + (blob.length - 1) + '/' + blob.length);
  assertBytes(r.body, blob.subarray(blob.length - 257), 'bytes=-257');
});

test('Range 后缀大于文件：收敛成整个文件（206）', async () => {
  const r = await get('/blob.bin', { Range: 'bytes=-999999' });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 0-' + (blob.length - 1) + '/' + blob.length);
  assertBytes(r.body, blob, 'bytes=-999999');
});

test('Range 终点超出文件：收敛到文件尾', async () => {
  const r = await get('/blob.bin', { Range: 'bytes=100-999999999' });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 100-' + (blob.length - 1) + '/' + blob.length);
  assertBytes(r.body, blob.subarray(100), 'bytes=100-999999999');
});

test('Range 起点越界：416 + Content-Range: bytes */size', async () => {
  const r = await get('/blob.bin', { Range: 'bytes=' + blob.length + '-' });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get('content-range'), 'bytes */' + blob.length);
  assert.equal(r.headers.get('content-length'), '0');
  assert.equal(r.body.length, 0);
});

test('Range 起点大于终点：416', async () => {
  const r = await get('/blob.bin', { Range: 'bytes=100-99' });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get('content-range'), 'bytes */' + blob.length);
});

test('Range 后缀 0：416', async () => {
  const r = await get('/blob.bin', { Range: 'bytes=-0' });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get('content-range'), 'bytes */' + blob.length);
});

test('非法 Range / 多区间：忽略 Range 按 200 全量', async () => {
  const bad = await get('/blob.bin', { Range: 'bytes=abc' });
  assert.equal(bad.status, 200);
  assertBytes(bad.body, blob, 'bytes=abc');

  const multi = await get('/blob.bin', { Range: 'bytes=0-1,3-4' });
  assert.equal(multi.status, 200);
  assertBytes(multi.body, blob, 'multi-range');
});

test('真实 tail_open.webm：Range 字节与 MIME 正确', async (t) => {
  if (!realVideo) return t.skip('找不到真实视频素材');
  const mid = 700000;
  const r = await get('/real.webm', { Range: 'bytes=' + mid + '-' + (mid + 4095) });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-type'), 'video/webm');
  assert.equal(r.headers.get('content-range'), 'bytes ' + mid + '-' + (mid + 4095) + '/' + realVideo.length);
  assertBytes(r.body, realVideo.subarray(mid, mid + 4096), 'webm range');
});

test('文件不存在：404', async () => {
  const r = await get('/nope.bin');
  assert.equal(r.status, 404);
});

test('坏 percent 编码：400（decodeURIComponent 抛错不拖垮进程）', async () => {
  const r = await rawRequest('/bad/%E0%A4%A');
  assert.equal(r.status, 400);
  assert.equal(r.body.toString(), '400');
});

test('路径含 NUL：404，且服务不崩（同步 fs 抛错被兜住）', async () => {
  const r = await rawRequest('/bad/%00name');
  assert.equal(r.status, 404);
  const again = await get('/blob.bin', { Range: 'bytes=0-0' });
  assert.equal(again.status, 206);
  assert.equal(again.body.length, 1);
});

test('路径穿越：403（严格限制在 webRoot 内）', async () => {
  const r = await rawRequest('/%2e%2e%2foutside.txt');
  assert.equal(r.status, 403);
  assert.notEqual(r.body.toString(), fs.readFileSync(outsideFile, 'utf8'));
});

test('/skin/ 路由：命中当前皮肤目录，穿越被 403', async () => {
  const ok = await get('/skin/foo.bin', { Range: 'bytes=0-9' });
  assert.equal(ok.status, 206);
  assertBytes(ok.body, patternBuffer(7777).subarray(0, 10), 'skin range');

  const bad = await rawRequest('/skin/%2e%2e%2foutside.txt');
  assert.equal(bad.status, 403);
});

test('没有当前皮肤时 /skin/ → 404（纯解析层）', () => {
  const r = resolveRequestPath('/skin/a.webm', { webRoot: webRoot, getSkinDir: () => null });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

test('空文件：200 长度为 0；任何 Range 都是 416', async () => {
  fs.writeFileSync(path.join(webRoot, 'empty.bin'), Buffer.alloc(0));
  const full = await get('/empty.bin');
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-length'), '0');
  assert.equal(full.body.length, 0);

  const ranged = await get('/empty.bin', { Range: 'bytes=0-' });
  assert.equal(ranged.status, 416);
  assert.equal(ranged.headers.get('content-range'), 'bytes */0');
});

test('parseRange 边界（纯函数对照）', () => {
  assert.deepEqual(parseRange('bytes=0-0', 10), { start: 0, end: 0 });
  assert.deepEqual(parseRange('bytes=-5', 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange('bytes=5-', 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange('bytes=5-100', 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange('bytes=5-4', 10), { unsatisfiable: true });
  assert.deepEqual(parseRange('bytes=10-', 10), { unsatisfiable: true });
  assert.equal(parseRange('bytes=0-1,2-3', 10), null);
  assert.equal(parseRange('items=0-1', 10), null);
  assert.equal(parseRange(undefined, 10), null);
});
