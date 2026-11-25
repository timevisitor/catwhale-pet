/**
 * app/infohub/clipboard.js — 文字剪贴板历史（信息中枢的一个源）
 *
 * 为什么是轮询而不是监听：Windows 没有"剪贴板变化"的普通 API，
 * Electron 的 clipboard 只能读；700ms 轮询一次 readText 的 CPU 代价可忽略
 * （实测 <0.1%），换来零钩子、零反作弊面。
 *
 * 刻意不做的事：
 *   - 不记录图片（会把 %APPDATA% 撑大，且图片历史不是这次需求）；
 *   - 不记录像密钥的东西（sk-/ghp_/AKIA/PEM），避免把凭据存进明文历史；
 *   - 超过 20000 字的文本截断保存，只在内存里保留原文。
 *
 * @module infohub/clipboard
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_ITEMS = 200;         // 落盘上限
const MAX_TEXT = 20000;        // 单条落盘上限
const POLL_MS = 700;

const SECRET_RE = /(^|\s)(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

module.exports = function create(ctx) {
  const file = path.join(ctx.dataDir, 'clip-history.json');
  let items = [];
  let timer = null;
  let last = '';
  let ready = false;
  let detail = '未启动';

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw.items)) items = raw.items.filter((x) => x && typeof x.text === 'string');
    } catch (e) { items = []; }
  }
  function save() {
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ items: items.slice(0, MAX_ITEMS) }));
      fs.renameSync(tmp, file);
    } catch (e) { ctx.log('保存剪贴板历史失败: ' + e.message); }
  }
  function uid() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function push(text) {
    const t = String(text || '');
    if (!t.trim()) return;
    if (/^\[object [A-Za-z]+\]$/.test(t)) return;      // 宿主把 Promise 之类塞进来时的兜底
    if (t === last) return;
    last = t;
    if (SECRET_RE.test(t)) { ctx.log('跳过一条疑似密钥的剪贴板内容'); return; }
    // 已存在同内容 → 提到最前，不重复存
    const hit = items.findIndex((x) => x.text === t);
    if (hit >= 0) {
      const [it] = items.splice(hit, 1);
      it.ts = Date.now();
      items.unshift(it);
    } else {
      items.unshift({ id: uid(), text: t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) : t, ts: Date.now(), pinned: false, len: t.length });
    }
    // 淘汰：未固定的最旧
    while (items.length > MAX_ITEMS) {
      let idx = -1;
      for (let i = items.length - 1; i >= 0; i--) { if (!items[i].pinned) { idx = i; break; } }
      if (idx < 0) break;
      items.splice(idx, 1);
    }
    save();
  }

  function list() {
    const sorted = items.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.ts - a.ts);
    return sorted.slice(0, 60).map((x) => ({
      id: x.id, text: x.text, ts: x.ts, pinned: !!x.pinned, len: x.len || x.text.length,
    }));
  }

  return {
    name: 'clip',
    label: '剪贴板历史',
    defaults: { enabled: true },

    async start() {
      load();
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        // Electron 某些版本的 clipboard.readText 可能返回 Promise，两种都吃
        try {
          const got = require('electron').clipboard.readText();
          if (got && typeof got.then === 'function') got.then((t) => push(t)).catch(() => {});
          else push(got);
        } catch (e) {}
      }, POLL_MS);
      if (timer.unref) timer.unref();
      // 启动时先把当前剪贴板记一条基线，避免重复弹
      try {
        const got = require('electron').clipboard.readText();
        if (got && typeof got.then === 'function') got.then((t) => { last = String(t || ''); }).catch(() => {});
        else last = String(got || '');
      } catch (e) {}
      ready = true; detail = '已记录 ' + items.length + ' 条';
    },
    async stop() { if (timer) clearInterval(timer); timer = null; ready = false; detail = '已停止'; },
    status() { return { ready, detail }; },
    async refresh() { load(); detail = '已记录 ' + items.length + ' 条'; return { ok: true, count: items.length }; },

    list,
    async copyToClipboard(id) {
      const it = items.find((x) => x.id === id);
      if (!it) return { ok: false, error: '条目不存在' };
      try {
        require('electron').clipboard.writeText(it.text);
        last = it.text;
        it.ts = Date.now();
        items = [it].concat(items.filter((x) => x !== it));
        save();
        return { ok: true };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    pin(id, on) {
      const it = items.find((x) => x.id === id);
      if (it) { it.pinned = !!on; save(); }
      return list();
    },
    remove(id) { items = items.filter((x) => x.id !== id); save(); return list(); },
    clear() { items = items.filter((x) => x.pinned); save(); return list(); },
  };
};
