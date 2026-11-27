#!/usr/bin/env node
/**
 * tools/make-sha256sums.js — 给发布目录里的 zip 生成 SHA256SUMS.txt
 *
 * 为什么必须做：客户端自动升级前会用同 release 的 SHA256SUMS.txt 校验下载下来的整包，
 * 没有清单 → canAutoUpdate=false（理由「该版本没有校验清单」），用户只能手动下载。
 * **发版必须带 SHA256SUMS.txt，否则客户端拒绝自动升级。**
 *
 * 用法：
 *   node tools/make-sha256sums.js dist                       # 扫描 dist/*.zip
 *   node tools/make-sha256sums.js dist -o dist/SHA256SUMS.txt
 *   node tools/make-sha256sums.js dist --include 桌宠_便携版.zip
 *
 * 输出格式（GNU sha256sum，客户端 updater.js 的 parseSums 认这种）：
 *   <64 位小写 hex><两个空格><文件名>
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    rs.on('data', (c) => h.update(c));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

function usage(code) {
  console.log('用法: node tools/make-sha256sums.js <目录> [-o 输出文件] [--include 名字1,名字2]');
  process.exit(code || 0);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('-h') || args.includes('--help')) usage(1);
  const dir = path.resolve(args[0]);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error('找不到目录：' + dir);
    process.exit(2);
  }
  const oi = args.indexOf('-o');
  const out = oi >= 0 && args[oi + 1] ? path.resolve(args[oi + 1]) : path.join(dir, 'SHA256SUMS.txt');
  const ii = args.indexOf('--include');
  const only = ii >= 0 && args[ii + 1] ? new Set(args[ii + 1].split(',').map((s) => s.trim()).filter(Boolean)) : null;

  let files = fs.readdirSync(dir).filter((n) => /\.zip$/i.test(n)).sort();
  if (only) files = files.filter((n) => only.has(n));
  if (!files.length) {
    console.error('目录里没有 .zip：' + dir);
    process.exit(3);
  }

  const lines = [];
  for (const name of files) {
    const full = path.join(dir, name);
    const hex = await sha256(full);
    const size = fs.statSync(full).size;
    lines.push(`${hex}  ${name}`);
    console.log(`  ${name}  ${(size / 1048576).toFixed(1)} MB  ${hex.slice(0, 16)}…`);
  }
  fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
  console.log(`[OK] 写入 ${out}（${lines.length} 行）`);
  console.log('提醒：把 SHA256SUMS.txt 和 zip 一起传到同一个 GitHub Release，否则客户端会拒绝自动升级。');
}

main().catch((e) => { console.error(e); process.exit(1); });
