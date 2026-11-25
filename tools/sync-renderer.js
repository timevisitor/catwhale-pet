#!/usr/bin/env node
/**
 * tools/sync-renderer.js — 把 web/ 同步到 app/renderer/
 *
 * 为什么需要这一步：主进程的 WEB_ROOT 指向 app/renderer（打包时整目录拷进 resources/app），
 * 而人在 web/ 里改页面。少了这步，改了 web/index.html 却看不到任何变化 —— 这个坑真踩过。
 *
 * 规则：
 *   - 只同步 web/ 顶层的 .html/.js/.css 与 assets/ 目录（不递归除 assets 外的子目录）；
 *   - 跳过以下划线开头的测试页（_selftest.html / _interaction_test.html）与 .bat 启动脚本；
 *   - 目标目录里同名旧文件覆盖，但**不删除**目标里多出来的文件（可能有历史遗留需要保留）。
 *
 * 用法：node tools/sync-renderer.js [--check]
 *   --check 只比较不写入，发现差异返回码 1（给构建脚本做防呆用）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'web');
const DST = path.join(ROOT, 'app', 'renderer');
const CHECK = process.argv.includes('--check');

const KEEP_EXT = new Set(['.html', '.js', '.css', '.json', '.png', '.svg', '.ico', '.woff2']);

function listTop(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
}

function main() {
  if (!fs.existsSync(SRC)) { console.error('找不到 web/ 目录: ' + SRC); process.exit(2); }
  fs.mkdirSync(DST, { recursive: true });

  let copied = 0, same = 0;
  const diffs = [];

  for (const ent of listTop(SRC)) {
    const name = ent.name;
    if (name.startsWith('_') || name.toLowerCase().endsWith('.bat')) continue;
    const src = path.join(SRC, name);
    const dst = path.join(DST, name);

    if (ent.isDirectory()) {
      if (name !== 'assets') continue;               // 只同步 assets，其余子目录不管
      copyDir(src, dst, () => { copied++; }, () => { same++; });
      continue;
    }
    if (!KEEP_EXT.has(path.extname(name).toLowerCase())) continue;

    const a = fs.readFileSync(src);
    const b = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
    if (b && a.equals(b)) { same++; continue; }
    diffs.push(name);
    if (!CHECK) { fs.copyFileSync(src, dst); copied++; }
  }

  if (CHECK) {
    if (diffs.length) { console.error('[sync-renderer] 未同步: ' + diffs.join(', ')); process.exit(1); }
    console.log('[sync-renderer] 已是最新（' + same + ' 个文件一致）');
    return;
  }
  console.log('[sync-renderer] 写入 ' + copied + ' 个，未变 ' + same + ' 个' + (diffs.length ? '（' + diffs.join(', ') + '）' : ''));
}

function copyDir(src, dst, onCopy, onSame) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of listTop(src)) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) { copyDir(s, d, onCopy, onSame); continue; }
    const a = fs.readFileSync(s);
    const b = fs.existsSync(d) ? fs.readFileSync(d) : null;
    if (b && a.equals(b)) { onSame(); continue; }
    if (!CHECK) fs.copyFileSync(s, d);
    onCopy();
  }
}

main();
