// 最小 zip 解包器（不依赖任何第三方库：发布包里 app/node_modules 是被排除的）
//
// 只做升级需要的事：
//   · 读中央目录（不支持 zip64 —— 单个升级包不会超过 4 GB，超了直接报错而不是猜）
//   · stored(0) 与 deflate(8)
//   · 防 Zip Slip：条目名含 .. / 绝对路径 / 盘符 / 以 / 或 \ 开头 → 整包拒绝
//   · 流式写盘（一个 200 MB 的 electron.exe 不会把内存顶爆）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, offset);
  if (n !== length) throw new Error('zip 文件被截断');
  return buf;
}

/** 解析中央目录，返回条目数组（不含数据） */
function readCentralDirectory(zipPath) {
  const size = fs.statSync(zipPath).size;
  if (size < 22) throw new Error('不是有效的 zip 文件（太小）');
  const fd = fs.openSync(zipPath, 'r');
  try {
    const tailLen = Math.min(size, 66 * 1024);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到中央目录结尾）');
    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      throw new Error('不支持 zip64 格式的升级包');
    }
    if (cdOffset + cdSize > size) throw new Error('zip 中央目录越界（文件损坏）');
    const cd = readAt(fd, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < total; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CD_SIG) throw new Error('zip 中央目录损坏');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const rawName = cd.slice(p + 46, p + 46 + nameLen);
      const name = rawName.toString('utf8');
      if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
        throw new Error('不支持 zip64 格式的升级包');
      }
      entries.push({ name, flags, method, compSize, uncompSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 条目名 → 安全的相对路径（用 / 分隔）。危险路径返回 null。
 * Zip Slip 判别规则（规格 §8.4）：含 .. 段、以 / 或 \ 开头、带盘符 → 拒绝。
 */
function safeRelPath(name) {
  const raw = String(name || '').replace(/\\/g, '/');
  if (!raw) return null;
  if (raw.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(raw)) return null;
  if (/^\/\//.test(raw)) return null;
  const parts = raw.split('/');
  const clean = [];
  for (const s of parts) {
    if (s === '' || s === '.') continue;
    if (s === '..') return null;
    clean.push(s);
  }
  return clean.length ? clean.join('/') : '';
}

function isInside(root, target) {
  const a = path.resolve(root).toLowerCase();
  const b = path.resolve(target).toLowerCase();
  return b === a || b.startsWith(a + path.sep);
}

async function extractEntry(zipPath, e, target) {
  if (e.method === 0 && e.compSize === e.uncompSize) {
    if (e.compSize === 0) { fs.writeFileSync(target, Buffer.alloc(0)); return; }
    await pipeline(fs.createReadStream(zipPath, { start: e.dataStart, end: e.dataStart + e.compSize - 1 }),
      fs.createWriteStream(target));
    return;
  }
  if (e.method !== 8) throw new Error(`不支持 zip 压缩方式 ${e.method}（${e.name}）`);
  if (e.compSize === 0) { fs.writeFileSync(target, Buffer.alloc(0)); return; }
  await pipeline(
    fs.createReadStream(zipPath, { start: e.dataStart, end: e.dataStart + e.compSize - 1 }),
    zlib.createInflateRaw(),
    fs.createWriteStream(target),
  );
}

/**
 * 解包到 destDir。所有条目先整体校验路径，再逐个写盘（先查后写，避免写了一半才发现恶意条目）。
 * @returns {{files:number, bytes:number}}
 */
async function extractZip(zipPath, destDir, opts = {}) {
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : () => {};
  const entries = readCentralDirectory(zipPath);
  if (!entries.length) throw new Error('升级包是空的');

  const planned = [];
  for (const e of entries) {
    const rel = safeRelPath(e.name);
    if (rel === null) throw new Error(`升级包里有非法路径条目（可能的 Zip Slip 攻击）：${e.name}`);
    const isDir = /[\\/]$/.test(e.name);
    if (isDir) { planned.push({ e, rel, isDir: true }); continue; }
    const target = path.join(destDir, ...rel.split('/'));
    if (!isInside(destDir, target)) throw new Error(`升级包条目越出解包目录：${e.name}`);
    planned.push({ e, rel, isDir: false, target });
  }

  fs.mkdirSync(destDir, { recursive: true });
  let files = 0;
  let bytes = 0;
  for (const item of planned) {
    const { e } = item;
    if (item.isDir) { fs.mkdirSync(path.join(destDir, ...item.rel.split('/')), { recursive: true }); continue; }
    if (e.flags & 0x1) throw new Error(`升级包里有加密条目，无法解包：${e.name}`);
    // 定位数据段：local header 的 name/extra 长度可能与中央目录不同，必须重读
    const fd = fs.openSync(zipPath, 'r');
    let nameLen = 0, extraLen = 0, sig = 0;
    try {
      const h = readAt(fd, e.localOffset, 30);
      sig = h.readUInt32LE(0);
      nameLen = h.readUInt16LE(26);
      extraLen = h.readUInt16LE(28);
    } finally {
      fs.closeSync(fd);
    }
    if (sig !== LFH_SIG) throw new Error(`zip 条目头损坏：${e.name}`);
    e.dataStart = e.localOffset + 30 + nameLen + extraLen;
    fs.mkdirSync(path.dirname(item.target), { recursive: true });
    await extractEntry(zipPath, e, item.target);
    files += 1;
    bytes += e.uncompSize;
    if (files % 40 === 0) onStep({ files, bytes });
  }
  onStep({ files, bytes, done: true });
  return { files, bytes };
}

/** 读 zip 里的某个条目为字符串（找不到返回 null）——用来查包内自带的 SHA256SUMS.txt */
function readZipText(zipPath, wanted) {
  let entries;
  try { entries = readCentralDirectory(zipPath); } catch (e) { return null; }
  const e = entries.find((x) => x.name === wanted);
  if (!e) return null;
  const fd = fs.openSync(zipPath, 'r');
  let nameLen = 0, extraLen = 0;
  try {
    const h = readAt(fd, e.localOffset, 30);
    nameLen = h.readUInt16LE(26);
    extraLen = h.readUInt16LE(28);
  } finally { fs.closeSync(fd); }
  const start = e.localOffset + 30 + nameLen + extraLen;
  const fdx = fs.openSync(zipPath, 'r');
  try {
    const buf = readAt(fdx, start, e.compSize);
    if (e.method === 0) return buf.toString('utf8');
    if (e.method === 8) return zlib.inflateRawSync(buf).toString('utf8');
    return null;
  } finally { fs.closeSync(fdx); }
}

module.exports = { extractZip, readCentralDirectory, safeRelPath, readZipText };
