'use strict';
/* =====================================================================
   persona-store.js —— 本机角色卡库（纯 Node，不认 Electron）
   目录：<userData>/characters/
     active.json            {"id":"xxx"}（没有 = 不扮演角色，走默认助手）
     <id>.json              角色卡（chara_card_v2，只含人设）
     <id>.png               可选头像（导入 PNG 卡时保留原图，导出时把卡写回这张图）
   聊天记录按角色分文件：<userData>/chat-history/<id>.json（默认助手仍用旧的 chat-history.json）。
   记忆/聊天记录永远不进卡文件 —— 导出只走 character-card.toV2() 白名单。
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const CC = require('./character-card.js');

const ID_RE = /^[a-z0-9_-]{1,64}$/;

function createPersonaStore(root) {
  const dir = path.join(root, 'characters');
  const histDir = path.join(root, 'chat-history');
  const activeFile = path.join(dir, 'active.json');
  const ensure = () => fs.mkdirSync(dir, { recursive: true });
  const fileOf = (id, ext) => {
    if (!ID_RE.test(String(id || ''))) throw new Error('非法角色 id');
    return path.join(dir, id + ext);
  };
  function atomicWrite(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  }

  function list() {
    ensure();
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f === 'active.json') continue;
      const id = f.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      try {
        const card = CC.normalizeCard(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
        out.push({ id, name: card.name, tags: card.tags, creator: card.creator,
                   hasAvatar: fs.existsSync(path.join(dir, id + '.png')),
                   updated: fs.statSync(path.join(dir, f)).mtimeMs });
      } catch (e) { out.push({ id, name: id, broken: (e && e.message) || String(e) }); }
    }
    return out.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }
  function get(id) {
    const card = CC.normalizeCard(JSON.parse(fs.readFileSync(fileOf(id, '.json'), 'utf8')));
    return { id, card };
  }
  /** 新建或覆盖；id 为空 = 新建 */
  function save(card, id) {
    ensure();
    const v2 = CC.toV2(card);
    const useId = id && ID_RE.test(id) ? id : CC.cardId(v2.data.name);
    atomicWrite(fileOf(useId, '.json'), JSON.stringify(v2, null, 2));
    return { id: useId, card: CC.normalizeCard(v2) };
  }
  /** 从文件内容导入（PNG/JSON 自动判断）。PNG 原图留作头像。 */
  function importBuffer(buf) {
    const { card, format } = CC.parseCardFile(buf);
    const r = save(card);
    if (format === 'png') fs.writeFileSync(fileOf(r.id, '.png'), CC.cardToPng(card, buf));
    return Object.assign(r, { format });
  }
  /** 导出：format=json → V2 JSON 文本；png → 写进头像（没有头像用 fallbackPng） */
  function exportBuffer(id, format, fallbackPng) {
    const { card } = get(id);
    if (format === 'json') return Buffer.from(JSON.stringify(CC.toV2(card), null, 2), 'utf8');
    const avatar = fs.existsSync(fileOf(id, '.png')) ? fs.readFileSync(fileOf(id, '.png')) : fallbackPng;
    if (!avatar) throw new Error('没有可用的 PNG 底图');
    return CC.cardToPng(card, avatar);
  }
  function remove(id) {
    for (const ext of ['.json', '.png']) { try { fs.unlinkSync(fileOf(id, ext)); } catch (e) { /* 不存在 */ } }
    if (activeId() === id) setActive('');
    return { ok: true };
  }
  function activeId() {
    try {
      const id = JSON.parse(fs.readFileSync(activeFile, 'utf8')).id || '';
      return id && ID_RE.test(id) && fs.existsSync(fileOf(id, '.json')) ? id : '';
    } catch (e) { return ''; }
  }
  function setActive(id) {
    ensure();
    if (id) fileOf(id, '.json');                 // 校验 id
    if (id && !fs.existsSync(fileOf(id, '.json'))) throw new Error('角色不存在：' + id);
    atomicWrite(activeFile, JSON.stringify({ id: id || '' }));
    return activeId();
  }
  function active() {
    const id = activeId();
    if (!id) return null;
    try { return get(id); } catch (e) { return null; }
  }
  /** 当前角色的聊天记录文件；无角色时用 legacy 文件（保持旧版本行为） */
  function historyFile(legacyFile) {
    const id = activeId();
    return id ? path.join(histDir, id + '.json') : legacyFile;
  }
  function avatarPath(id) { const f = fileOf(id, '.png'); return fs.existsSync(f) ? f : ''; }

  return { dir, list, get, save, importBuffer, exportBuffer, remove, activeId, setActive, active, historyFile, avatarPath };
}

module.exports = { createPersonaStore };
