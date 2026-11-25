/* 极简 CDP 客户端：不依赖 ws 包，自己走 WebSocket 握手 + 文本帧。
   只为本地调试（页面求值/截图）用，不支持分片、压缩、二进制。 */
'use strict';
const net = require('node:net');
const crypto = require('node:crypto');

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n`
        + `Host: ${u.hostname}:${u.port}\r\n`
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let frag = Buffer.alloc(0);
    const handlers = [];
    const onText = (t) => { for (const h of handlers) h(t); };

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.slice(0, i).toString();
        if (!/101/.test(head.split('\r\n')[0])) return reject(new Error('handshake failed: ' + head.split('\r\n')[0]));
        buf = buf.slice(i + 4);
        upgraded = true;
        resolve(api);
      }
      // 解析帧
      while (buf.length >= 2) {
        const b1 = buf[1];
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len);
        const opcode = buf[0] & 0x0f;
        buf = buf.slice(off + len);
        if (opcode === 0x8) { try { sock.end(); } catch (e) {} return; }
        if (opcode === 0x1 || opcode === 0x0) {
          frag = Buffer.concat([frag, payload]);
          try { onText(frag.toString()); } catch (e) {}
          frag = Buffer.alloc(0);
        } else if (opcode === 0x9) { send(0xA, payload); }
      }
    });
    sock.on('error', reject);

    function send(opcode, data) {
      const mask = crypto.randomBytes(4);
      const n = data.length;
      let head;
      if (n < 126) head = Buffer.from([0x80 | opcode, 0x80 | n]);
      else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(n, 2); }
      else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(n), 2); }
      const body = Buffer.from(data);
      for (let i = 0; i < n; i++) body[i] ^= mask[i & 3];
      sock.write(Buffer.concat([head, mask, body]));
    }

    const api = {
      onMessage: (h) => handlers.push(h),
      sendText: (t) => send(0x1, Buffer.from(t)),
      close: () => { try { send(0x8, Buffer.alloc(0)); } catch (e) {} try { sock.end(); } catch (e) {} },
    };
  });
}

module.exports = { wsConnect };
