/* =====================================================================
   persona.js — 角色卡面板（渲染层）
   挂在聊天面板内部的一层浮层：列表 / 编辑 / 导入导出。
     · 导入：按钮选文件，或把 PNG/JSON 角色卡直接拖进聊天面板
     · 导出：PNG（酒馆通用，卡写进图片 tEXt 块）或 JSON（chara_card_v2）
     · 卡里只有人设，不含记忆与聊天记录（主进程白名单导出）
   与 index.html 的关系：只调 window.onPersonaChanged(info) 通知聊天面板刷新。
   ===================================================================== */
'use strict';
(function () {
  const P = { open: false, list: [], activeId: '', active: null, editing: null, busy: false };
  const host = () => window.petHost && window.petHost.persona;
  let root = null, listEl = null, formEl = null, msgEl = null;

  const FIELDS = [
    ['name', '角色名 *', 'input', '例如：小鲸'],
    ['description', '人设描述 *（外貌、身份、背景；可用 {{char}} / {{user}}）', 'area', '{{char}}是一只住在{{user}}桌面上的猫鲸……'],
    ['personality', '性格', 'area', '傲娇、嘴硬心软、爱吃米饭'],
    ['scenario', '场景', 'area', '深夜，{{user}}还在加班'],
    ['first_mes', '开场白（切到该角色且没有聊天记录时显示）', 'area', '又熬夜？'],
    ['mes_example', '对话示例（只示范语气和长度，<START> 分隔）', 'area', '<START>\n{{user}}: 在吗\n{{char}}: 哼，干嘛。'],
    ['system_prompt', '系统提示词（可选，留空用默认扮演指令）', 'area', ''],
    ['post_history_instructions', '历史后指令（可选，每轮都放在最后，用来压住跑偏）', 'area', ''],
    ['creator', '作者', 'input', ''],
    ['tags', '标签（逗号分隔）', 'input', ''],
  ];

  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function say(t, cls) { if (msgEl) { msgEl.textContent = t || ''; msgEl.className = 'pmsg' + (cls ? ' ' + cls : ''); } }

  function build() {
    if (root) return;
    const chat = document.getElementById('chat');
    if (!chat) return;
    root = el('div'); root.id = 'personaPane'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', '角色卡');
    const head = el('div', 'phead');
    head.append(el('b', '', '角色卡'), el('span', 'psub', '兼容 SillyTavern PNG / JSON · 只含人设，不含记忆'));
    const x = el('button', 'pclose', '×'); x.type = 'button'; x.title = '返回聊天（Esc）'; x.onclick = () => close();
    head.append(x);
    const bar = el('div', 'pbar');
    const bImp = el('button', '', '导入…'); bImp.type = 'button'; bImp.onclick = () => importFile();
    const bNew = el('button', '', '新建'); bNew.type = 'button'; bNew.onclick = () => edit(null);
    const bOff = el('button', '', '不扮演（默认助手）'); bOff.type = 'button'; bOff.onclick = () => use('');
    const bDir = el('span', 'plink', '打开目录'); bDir.onclick = () => host() && host().reveal();
    bar.append(bImp, bNew, bOff, bDir);
    msgEl = el('div', 'pmsg');
    listEl = el('div', 'plist');
    formEl = el('div', 'pform'); formEl.style.display = 'none';
    const drop = el('div', 'phint', '提示：把别人发来的角色卡（PNG 或 JSON）直接拖进聊天窗口即可导入。');
    root.append(head, bar, msgEl, listEl, formEl, drop);
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (P.editing) showList(); else close(); } });
    chat.appendChild(root);
    bindDrop(chat);
  }

  function bindDrop(chat) {
    chat.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); chat.classList.add('pdrop'); } });
    chat.addEventListener('dragleave', (e) => { if (e.target === chat) chat.classList.remove('pdrop'); });
    chat.addEventListener('drop', async (e) => {
      chat.classList.remove('pdrop');
      const files = e.dataTransfer && e.dataTransfer.files ? [...e.dataTransfer.files] : [];
      if (!files.length) return;
      e.preventDefault();
      const ok = [], bad = [];
      for (const f of files) {
        if (!/\.(png|json)$/i.test(f.name)) { bad.push(f.name + '：只认 .png / .json'); continue; }
        try {
          const bytes = new Uint8Array(await f.arrayBuffer());
          const r = await host().importBytes(bytes);
          if (r && r.ok) { ok.push(r.imported); apply(r); } else bad.push(f.name + '：' + ((r && r.error) || '未知错误'));
        } catch (err) { bad.push(f.name + '：' + (err && err.message || err)); }
      }
      if (!P.open) open();
      render();
      say((ok.length ? '已导入 ' + ok.length + ' 张角色卡，点「使用」切换。' : '') + (bad.length ? ' 失败：' + bad.join('；') : ''), bad.length ? 'bad' : 'ok');
    });
  }

  function apply(info) {
    if (!info || !info.ok) return;
    if (Array.isArray(info.list)) P.list = info.list;
    if ('activeId' in info) { P.activeId = info.activeId || ''; P.active = info.active || null; }
  }

  async function refresh() {
    if (!host()) return P;
    try { apply(await host().list()); } catch (e) { /* 宿主不支持 */ }
    if (P.open) render();
    return P;
  }

  function render() {
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!P.list.length) {
      listEl.append(el('div', 'pempty', '还没有角色卡。点「新建」写一个，或导入酒馆（SillyTavern）的 PNG / JSON 卡。'));
      return;
    }
    for (const it of P.list) {
      const row = el('div', 'prow' + (it.id === P.activeId ? ' on' : '') + (it.broken ? ' broken' : ''));
      const info = el('div', 'pinfo');
      info.append(el('div', 'pname', (it.id === P.activeId ? '● ' : '') + it.name));
      const meta = [it.creator ? '作者 ' + it.creator : '', (it.tags || []).slice(0, 4).join(' · ')].filter(Boolean).join('  ');
      info.append(el('div', 'pmeta', it.broken ? '无法读取：' + it.broken : (meta || it.id)));
      const ops = el('div', 'pops');
      const mk = (t, fn, cls) => { const b = el('button', cls || '', t); b.type = 'button'; b.onclick = fn; return b; };
      if (!it.broken) {
        if (it.id !== P.activeId) ops.append(mk('使用', () => use(it.id), 'primary'));
        else ops.append(el('span', 'pbadge', '使用中'));
        ops.append(mk('编辑', () => edit(it.id)), mk('导出 PNG', () => exp(it.id, 'png')), mk('导出 JSON', () => exp(it.id, 'json')), mk('删除', () => del(it), 'danger'));
      }
      else ops.append(mk('删除', () => del(it), 'danger'));
      row.append(info, ops);
      listEl.append(row);
    }
  }

  async function use(id) {
    const r = await host().setActive(id);
    if (!r || !r.ok) { say('切换失败：' + ((r && r.error) || '未知错误'), 'bad'); return; }
    apply(r); render();
    say(id ? '已切换为「' + (P.active && P.active.name) + '」，聊天记录按角色分开保存。' : '已关闭角色扮演，回到默认助手。', 'ok');
    if (typeof window.onPersonaChanged === 'function') window.onPersonaChanged(r);
    setTimeout(() => close(), 450);
  }

  async function exp(id, format) {
    const r = await host().exportCard(id, format);
    if (r && r.ok) say('已导出：' + r.path + '（只含人设，可直接发给别人）', 'ok');
    else if (!(r && r.canceled)) say('导出失败：' + ((r && r.error) || '未知错误'), 'bad');
  }

  async function del(it) {
    if (!confirm('删除角色卡「' + it.name + '」？\n（该角色的聊天记录文件保留在 chat-history 目录，不会删除）')) return;
    const r = await host().remove(it.id);
    if (r && r.ok) { apply(r); render(); say('已删除', 'ok'); if (typeof window.onPersonaChanged === 'function') window.onPersonaChanged(r); }
    else say('删除失败：' + ((r && r.error) || ''), 'bad');
  }

  async function importFile() {
    const r = await host().importFile();
    if (r && r.canceled) return;
    apply(r); render();
    if (r && r.ok) say('已导入 ' + r.count + ' 张' + (r.failed && r.failed.length ? '；失败：' + r.failed.join('；') : '') + '。点「使用」切换。', r.failed && r.failed.length ? 'bad' : 'ok');
    else say('导入失败：' + ((r && r.error) || '未知错误'), 'bad');
  }

  async function edit(id) {
    let card = {};
    if (id) {
      const r = await host().get(id);
      if (!r || !r.ok) { say('读取失败：' + ((r && r.error) || ''), 'bad'); return; }
      card = r.card;
    }
    P.editing = { id: id || '' };
    formEl.innerHTML = '';
    formEl.append(el('div', 'ptitle', id ? '编辑：' + card.name : '新建角色卡'));
    for (const [k, label, kind, ph] of FIELDS) {
      formEl.append(el('label', '', label));
      const inp = kind === 'area' ? el('textarea') : el('input');
      if (kind === 'area') inp.rows = (k === 'description' || k === 'mes_example') ? 4 : 2;
      inp.dataset.k = k; inp.placeholder = ph; inp.spellcheck = false;
      inp.value = k === 'tags' ? (card.tags || []).join(', ') : (card[k] || '');
      formEl.append(inp);
    }
    const row = el('div', 'pbtns');
    const ok = el('button', 'primary', '保存'); ok.type = 'button'; ok.onclick = () => saveForm();
    const cancel = el('button', '', '取消'); cancel.type = 'button'; cancel.onclick = () => showList();
    row.append(ok, cancel);
    formEl.append(row);
    listEl.style.display = 'none'; formEl.style.display = 'flex';
    say('');
    const first = formEl.querySelector('input,textarea'); if (first) first.focus();
  }

  async function saveForm() {
    const card = {};
    formEl.querySelectorAll('[data-k]').forEach((n) => { card[n.dataset.k] = n.value; });
    card.tags = String(card.tags || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const r = await host().save(card, P.editing && P.editing.id);
    if (!r || !r.ok) { say('保存失败：' + ((r && r.error) || '未知错误'), 'bad'); return; }
    apply(r);
    showList();
    say('已保存「' + card.name + '」' + (r.saved === P.activeId ? '（当前角色，下一条消息生效）' : ''), 'ok');
    if (r.saved === P.activeId && typeof window.onPersonaChanged === 'function') window.onPersonaChanged(r);
  }

  function showList() { P.editing = null; formEl.style.display = 'none'; listEl.style.display = ''; render(); }

  function open() {
    build(); if (!root) return;
    P.open = true; root.classList.add('show');
    showList(); refresh();
    setTimeout(() => { const b = root.querySelector('.pbar button'); if (b) b.focus(); }, 0);
  }
  function close() { if (!root) return; P.open = false; root.classList.remove('show'); P.editing = null; say(''); const i = document.getElementById('cinput'); if (i) i.focus(); }

  window.PersonaUI = {
    open, close, refresh, isOpen: () => P.open,
    toggle: () => (P.open ? close() : open()),
    activeName: () => (P.active && P.active.name) || '',
    state: () => ({ open: P.open, activeId: P.activeId, count: P.list.length, editing: !!P.editing }),
  };
  document.addEventListener('DOMContentLoaded', () => { build(); refresh().then(() => { if (typeof window.onPersonaChanged === 'function') window.onPersonaChanged({ ok: true, activeId: P.activeId, active: P.active, list: P.list, silent: true }); }); });
})();
