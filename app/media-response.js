'use strict';
/* =============================================================================
 * 本地静态文件响应（纯 Node，不认 Electron）
 * -----------------------------------------------------------------------------
 * 为什么需要这个响应层：
 *   旧实现用 fs.readFile + 200，且没有显式 Content-Length（Node 退化成
 *   Transfer-Encoding: chunked）、没有 Accept-Ranges。Chromium 拿不到长度，
 *   就把媒体标成不可 seek（seekable 恒为 [0,0]）；动画片段循环把 currentTime
 *   设成 0.6 时会被拉回 0。注意：Content-Length 是可 seek 的前提（Python
 *   http.server 不支持 Range 但有 Content-Length，同样可 seek）；本层补上
 *   Content-Length 与单区间 206，才能让播放器按需取任意位置。
 *
 * 这里实现 HTTP/1.1 单区间 Range：
 *   - 无 Range            → 200 + Content-Length
 *   - 合法 Range          → 206 + Content-Range: bytes start-end/size
 *   - 越界/反向/空文件     → 416 + Content-Range: bytes *\/size
 *   - 多区间/语法不合法    → 忽略 Range，按 200 全量返回（RFC 允许）
 *   - HEAD                → 与 GET 相同的头，不发 body
 *   - 文件用 createReadStream 按区间流式发送，不把整个视频读进内存
 * ============================================================================= */
const fs = require('node:fs');
const path = require('node:path');
const urlmod = require('node:url');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json; charset=utf-8', '.webm': 'video/webm',
  '.png': 'image/png', '.ico': 'image/x-icon'
};

function mimeFor(file) {
  return MIME[path.extname(String(file || '')).toLowerCase()] || 'application/octet-stream';
}

/* 文件必须严格位于 root 内：挡住 .. 穿越，也挡住 root 同前缀的兄弟目录
   （path.join 会先归一化，绝对路径/`..` 都靠 relative 判出来）。 */
function isInside(root, file) {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/* 把请求 URL 解析成磁盘文件。坏转义（decodeURIComponent 抛错）→ 400，
   路径越界 → 403，没有当前皮肤时 /skin/ → 404。 */
function resolveRequestPath(rawUrl, opts) {
  opts = opts || {};
  let pathname;
  try {
    pathname = decodeURIComponent(urlmod.parse(String(rawUrl || '')).pathname || '/');
  } catch (e) {
    return { ok: false, status: 400 };
  }
  let p = pathname;
  if (p === '/') p = '/index.html';
  if (p.startsWith('/skin/')) {
    const dir = typeof opts.getSkinDir === 'function' ? opts.getSkinDir() : opts.skinDir;
    if (!dir) return { ok: false, status: 404 };
    const file = path.join(dir, p.slice('/skin/'.length));
    if (!isInside(dir, file)) return { ok: false, status: 403 };
    return { ok: true, file: file };
  }
  const file = path.join(opts.webRoot, p);
  if (!isInside(opts.webRoot, file)) return { ok: false, status: 403 };
  return { ok: true, file: file };
}

/* 解析单区间 Range。返回：
   - null                  → 不是可识别的单区间，按 200 全量
   - { unsatisfiable:true} → 416（起点越界 / 起止反向 / 后缀为 0 / 空文件）
   - { start, end }        → 206（end 已按文件大小收敛，含端点）
   多区间（逗号）按 RFC 可以忽略，这里统一走 null。 */
function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header.trim());
  if (!m) return null;
  const a = m[1], b = m[2];
  if (a === '' && b === '') return null;

  if (a === '') {                                  // bytes=-N：最后 N 字节
    const n = Number(b);
    if (!Number.isSafeInteger(n)) return null;
    if (n === 0 || size === 0) return { unsatisfiable: true };
    return { start: Math.max(0, size - n), end: size - 1 };
  }

  const start = Number(a);
  if (!Number.isSafeInteger(start)) return null;
  let end;
  if (b === '') {                                  // bytes=N-：到文件末尾
    end = size - 1;
  } else {
    end = Number(b);
    if (!Number.isSafeInteger(end)) return null;
    if (end < start) return { unsatisfiable: true };
    end = Math.min(end, size - 1);                 // 终点超出文件：收敛到末尾
  }
  if (start >= size || end < start) return { unsatisfiable: true };
  return { start: start, end: end };
}

/* 把 file 作为静态资源发给 res。contentType 缺省按扩展名。
   stat 失败/不是普通文件 → 404（与旧实现一致）。 */
function serveFile(req, res, file, contentType) {
  const onStat = function (err, st) {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    const size = st.size;
    const headers = {
      'Content-Type': contentType || mimeFor(file),
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes'
    };

    let status = 200;
    let start = 0;
    let end = size - 1;
    const range = parseRange(req.headers.range, size);
    if (range && range.unsatisfiable) {
      headers['Content-Range'] = 'bytes */' + size;
      headers['Content-Length'] = '0';
      res.writeHead(416, headers);
      return res.end();
    }
    if (range) {
      status = 206;
      start = range.start;
      end = range.end;
    }

    const length = size === 0 ? 0 : end - start + 1;   // end 含端点
    headers['Content-Length'] = String(length);
    if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;

    if (req.method === 'HEAD') {                       // HEAD：同样的头，不发 body
      res.writeHead(status, headers);
      return res.end();
    }
    res.writeHead(status, headers);
    if (length === 0) return res.end();

    const stream = fs.createReadStream(file, { start: start, end: end });
    stream.on('error', function () {
      // 头已经发出去了，只能断开连接，不能让异常冒到 http server 顶层
      try { res.destroy(); } catch (e) {}
    });
    res.on('close', function () {
      // 播放器 seek 时会主动中断当前请求；及时关掉文件句柄
      try { stream.destroy(); } catch (e) {}
    });
    stream.pipe(res);
  };
  // 文件名含 NUL 等非法字节时 fs.stat 会同步抛错：统一按 404，不让异常冒到 server
  try { fs.stat(file, onStat); } catch (e) { onStat(e); }
}

module.exports = { MIME: MIME, mimeFor: mimeFor, isInside: isInside, resolveRequestPath: resolveRequestPath, parseRange: parseRange, serveFile: serveFile };
