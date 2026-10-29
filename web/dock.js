/* =====================================================================
   dock.js — Agent 看板（渲染层）

   只有三样东西：桌宠旁边的小胶囊、会话卡片列表、点卡片展开的详情。
   没有按键台、没有虚拟摇杆、没有语音键——这块面板只负责"看谁在干活"：
     · 点卡片       = 选中（钉住）该会话
     · 再点同一张   = 展开 / 收起详情
     · 头部喇叭图标 = 静音（桌宠不再为 Agent 演动作，只留数字）
     · 头部 × / Esc = 收起面板

   与页面的关系（单一方向）：只发 `dock:state` 事件告诉状态机"最紧急状态"，
   由 index.html 里的监听器决定演哪个动作（它自己还保有完整优先级链）。
   ===================================================================== */
'use strict';

(function () {
  const DK = {
    ready: false,
    open: false,
    muted: false,
    snap: null,
    lastState: '',
    hintUntil: 0,
  };

  const host = () => window.petHost && window.petHost.dock;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ---------------- 构建界面 ---------------- */

  let chip = null, pan = null, listEl = null, subEl = null, detEl = null, portEl = null;
  let dotEl = null, nameEl = null, nEl = null, warnEl = null, muteBtn = null;

  const ICON_SOUND_ON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M11 5 6.5 9H3v6h3.5L11 19V5z"/><path d="M16 9.5a3.5 3.5 0 0 1 0 5"/><path d="M18.5 7a7 7 0 0 1 0 10"/></svg>';
  const ICON_SOUND_OFF =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M11 5 6.5 9H3v6h3.5L11 19V5z"/><path d="M16 9.5a3.5 3.5 0 0 1 0 5"/><path d="M20.5 4 3.5 20"/></svg>';

  function build() {
    if (chip) return;

    chip = el('div', '', null);
    chip.id = 'dockchip';
    chip.title = 'Agent 看板：点开看谁在干活';
    dotEl = el('span', 'dkc-dot');
    nameEl = el('span', 'dkc-name', 'Agent');
    nEl = el('span', 'dkc-n', '');
    chip.append(dotEl, nameEl, nEl);
    chip.addEventListener('click', () => toggle());

    pan = el('div', '', null);
    pan.id = 'dockpan';
    pan.innerHTML = `
      <div class="dk-head">
        <span class="dkc-dot" id="dkDot2"></span>
        <b>Agent 看板</b>
        <span class="dk-port" id="dkPort"></span>
        <button class="dk-icon" id="dkMute" title="静音"></button>
        <button class="dk-x" title="收起（Esc）">×</button>
      </div>
      <div class="dk-sub" id="dkSub">正在连接…</div>
      <div class="dk-list" id="dkList"></div>
      <div class="dk-det" id="dkDet"></div>
      <div class="dk-warn" id="dkWarn" style="display:none"></div>
      <div class="dk-foot">点卡片选中，再点一次看详情</div>`;

    document.body.append(chip, pan);

    listEl = pan.querySelector('#dkList');
    subEl = pan.querySelector('#dkSub');
    detEl = pan.querySelector('#dkDet');
    portEl = pan.querySelector('#dkPort');
    warnEl = pan.querySelector('#dkWarn');
    muteBtn = pan.querySelector('#dkMute');
    pan.querySelector('.dk-x').addEventListener('click', () => close());
    muteBtn.addEventListener('click', () => {
      DK.muted = !DK.muted;
      paintSub();
      paintList();
      if (DK.snap) notifyState(DK.snap.state || 'idle');   // 取消静音要立刻把状态补回页面，不能等下一条事件
    });

    listEl.addEventListener('click', (e) => {
      const item = e.target.closest('.dk-item');
      if (!item || !host()) return;
      const key = item.dataset.key || '';
      const cur = selected();
      if (cur && cur.key === key) {
        detEl.classList.toggle('show');        // 再点同一张 → 展开/收起详情
        paintList();
        paintDetail();
      } else {
        host().pin(key);                       // 点别的卡片 → 选中它（详情开着就跟着换人）
      }
    });

    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && DK.open) { e.preventDefault(); close(); }
    });
  }

  /* ---------------- 按键动作 ---------------- */

  function sessions() { return (DK.snap && DK.snap.sessions) || []; }
  function selected() {
    const s = sessions();
    if (!s.length) return null;
    const pin = DK.snap && DK.snap.pinned;
    return s.find((x) => x.key === pin) || s.find((x) => x.agent === DK.snap.selected) || s[0];
  }

  /* ---------------- 渲染 ---------------- */

  function stateText(s) {
    return ({ working: '干活中', speaking: '输出中', waiting_user: '等你确认', done: '刚结束', error: '出错了', idle: '空闲', sleeping: '休息' })[s] || s || '';
  }
  function ago(ts) {
    const d = Math.max(0, Date.now() - ts);
    if (d < 8000) return '刚刚';
    if (d < 60_000) return Math.round(d / 1000) + 's';
    return Math.round(d / 60_000) + 'm';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function paintMute() {
    if (!muteBtn) return;
    muteBtn.innerHTML = DK.muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
    muteBtn.classList.toggle('muted', DK.muted);
    muteBtn.title = DK.muted ? '已静音（点一下恢复：桌宠会随 Agent 演动作）' : '静音（桌宠不再为 Agent 演动作）';
    if (chip) chip.classList.toggle('muted', DK.muted);
  }

  function paintChip() {
    if (!chip) return;
    const ss = sessions();
    const st = (DK.snap && DK.snap.state) || 'idle';
    const show = ss.length > 0 || DK.open || Date.now() < DK.hintUntil;
    chip.classList.toggle('show', show);
    if (!show) return;
    dotEl.className = 'dkc-dot ' + st;
    const cur = selected();
    nameEl.textContent = ss.length ? (cur ? cur.agentName : 'Agent') : 'Agent 看板';
    nEl.textContent = ss.length > 1 ? String(ss.length) : '';
    chip.style.opacity = ss.length ? '1' : '.82';
  }

  function paintSub() {
    if (!subEl || !DK.snap) return;
    const ss = sessions();
    const avail = (DK.snap.channels || []).filter((c) => c.available);
    const wired = avail.some((c) => c.id === 'hermes' && c.wired);
    const parts = [ss.length ? `<b>${ss.length}</b> 个会话 · <b>${avail.length}</b> 个可用通道`
                             : `<b>${avail.length}</b> 个可用通道，暂无会话`];
    if (wired) parts.push('Hermes 已接 hook');
    if (DK.muted) parts.push('<b>已静音</b>');
    subEl.innerHTML = parts.join('　·　');
    paintMute();
  }

  function paintList() {
    if (!listEl) return;
    const ss = sessions();
    const cur = selected();
    if (!ss.length) {
      const chs = ((DK.snap && DK.snap.channels) || []).slice(0, 8);
      const rows = chs.map((c) => `${c.available ? '●' : '○'} ${esc(c.name)}<span class="dim">　${esc(c.detail || '')}</span>`).join('<br>');
      listEl.innerHTML = `<div class="dk-empty">现在没有 Agent 在干活。<br><br>${rows}</div>`;
      return;
    }
    listEl.innerHTML = ss.map((s) => {
      /* 正文只放"有信息量"的内容：干活中优先显示在调用的工具，其余显示最后一句；
         都没有（比如只收到一个 stop 事件）就不渲染正文行，免得和右边的状态重复。 */
      const busy = s.state === 'working' || s.state === 'speaking';
      const bodyText = busy && s.tool ? `正在调用 <b>${esc(s.tool)}</b>` : esc(s.lastAgent || s.lastUser || '');
      const cls = busy && s.tool ? 'dki-line tool' : 'dki-line';
      const bodyHtml = bodyText ? `<div class="${cls}">${bodyText}</div>` : '';
      const isSel = !!(cur && cur.key === s.key);
      const chev = isSel ? (detEl.classList.contains('show') ? ' ▾' : ' ▸') : '';
      return `<div class="dk-item${isSel ? ' sel' : ''}" data-key="${esc(s.key)}" title="点一下选中，再点看详情">
        <span class="dki-dot ${esc(s.state)}"></span>
        <div class="dki-top"><span class="dki-agent">${esc(s.agentName)}</span><span class="dki-title">${esc(s.title)}</span></div>
        <span class="dki-meta">${esc(stateText(s.state))} · ${ago(s.updatedAt)}${chev}</span>
        ${bodyHtml}
      </div>`;
    }).join('');
  }

  function paintDetail() {
    if (!detEl) return;
    if (!detEl.classList.contains('show')) return;
    const s = selected();
    if (!s) { detEl.innerHTML = '<span class="dim">没有选中的会话</span>'; return; }
    const rows = [
      ['Agent', s.agentName],
      ['会话', s.sessionId],
      ['标题', s.title],
      ['状态', stateText(s.state) + (s.event ? '（' + s.event + '）' : '')],
      ['工具', s.tool || '—'],
      ['目录', s.cwd || '—'],
      ['来源', s.source === 'log' ? '会话日志推断' : s.source === 'native' ? '桌宠内置通道' : 'hook 推送'],
      ['最后你说', s.lastUser || '—'],
      ['最后它说', s.lastAgent || '—'],
    ];
    detEl.innerHTML = '<dl>' + rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('') + '</dl>';
  }

  function render(snap) {
    if (!snap || !snap.sessions) return;
    DK.snap = snap;
    if (portEl) portEl.textContent = ':' + snap.port;
    if (warnEl) {
      const avail = (snap.channels || []).filter((c) => c.available).length;
      const msg = avail === 0 ? '没探测到任何 Agent：看下面通道列表里的说明，或让任意程序 POST /state 推送。' : '';
      warnEl.style.display = msg ? 'block' : 'none';
      warnEl.textContent = msg;
    }
    paintChip();
    paintSub();
    paintList();
    paintDetail();
    place();

    /* 只有当"最紧急的状态"真的变了才通知页面，避免每 2 秒重演一次动作 */
    const st = snap.state || 'idle';
    if (st !== DK.lastState) notifyState(st);
  }

  /* 把"最紧急状态"告诉桌宠状态机（静音时页面那头会忽略动作，但仍要知道当前是谁） */
  function notifyState(st) {
    const prev = DK.lastState;
    DK.lastState = st;
    window.dispatchEvent(new CustomEvent('dock:state', {
      detail: { state: st, prev, count: sessions().length, muted: DK.muted, selected: DK.snap && DK.snap.selected },
    }));
  }

  /* ---------------- 摆放 ---------------- */

  function place() {
    const petEl = document.getElementById('pet');
    if (!petEl || !chip || !pan) return;
    const r = petEl.getBoundingClientRect();
    if (!r.width) return;
    const vw = innerWidth, vh = innerHeight;
    chip.style.left = Math.max(4, Math.min(vw - 150, r.left + 4)) + 'px';
    chip.style.top = Math.max(4, r.top - 34) + 'px';
    if (!DK.open) return;
    const pw = pan.offsetWidth || 342;
    const ph = pan.offsetHeight || 320;
    let x = r.right + 10;
    if (x + pw > vw - 6) x = r.left - pw - 10;
    if (x < 6) x = Math.max(6, Math.min(vw - pw - 6, r.left + 4));
    let y = Math.max(6, r.top - 20);
    if (y + ph > vh - 6) y = Math.max(6, vh - ph - 6);
    pan.style.left = Math.round(x) + 'px';
    pan.style.top = Math.round(y) + 'px';
  }

  /* ---------------- 开关 ---------------- */

  function open() {
    if (!pan) return;
    if (DK.open) return;
    /* 面板互斥：把 SAO/搜索/聊天/设置让出去（它们各自有 close 函数） */
    try { if (typeof closeMenu === 'function') closeMenu(); } catch (e) { /* ignore */ }
    try { if (typeof S !== 'undefined' && S.open) closeSearch(); } catch (e) { /* ignore */ }
    try { if (typeof C !== 'undefined' && C.open) closeChat(); } catch (e) { /* ignore */ }
    try { if (typeof SET !== 'undefined' && SET.open) closeSettings(); } catch (e) { /* ignore */ }
    /* 首次启动的环境自检向导 z-index 比面板高，会正好压住看板 → 让开（部署进行中不动它） */
    try { if (typeof ENV !== 'undefined' && ENV.open && !ENV.busy && typeof closeEnv === 'function') closeEnv(); } catch (e) { /* ignore */ }
    DK.open = true;
    pan.classList.add('show');
    if (host()) host().get().then(render).catch(() => {});
    render(DK.snap || { sessions: [], channels: [], port: (DK.snap && DK.snap.port) || 0 });
    place();
    if (typeof touch === 'function') touch();
  }
  function close() {
    if (!pan) return;
    DK.open = false;
    pan.classList.remove('show');
    if (typeof touch === 'function') touch();
  }
  function toggle() { DK.open ? close() : open(); }

  /* ---------------- 初始化 ---------------- */

  function init() {
    build();
    DK.hintUntil = Date.now() + 25_000;      // 启动后先亮 25 秒，让人知道有这块面板
    paintMute();
    const h = host();
    if (!h) {
      if (warnEl) { warnEl.style.display = 'block'; warnEl.textContent = '浏览器演示模式：没有主进程通道，看板不可用（桌面版可用）。'; }
      paintChip();
      return;
    }
    DK.ready = true;
    h.onUpdate(render);
    h.get().then(render).catch((e) => {
      if (warnEl) { warnEl.style.display = 'block'; warnEl.textContent = '看板服务没起来：' + ((e && e.message) || e); }
    });
    setInterval(() => { paintChip(); if (DK.open) place(); }, 1000);   // 跟着桌宠走，顺便刷新"多久之前"
    setInterval(() => { if (DK.open) { paintList(); paintDetail(); } }, 5000);
    setTimeout(paintChip, 300);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.DockUI = {
    isOpen: () => DK.open,
    open: () => open(),
    close: () => close(),
    toggle: () => toggle(),
    state: () => (DK.snap && DK.snap.state) || 'idle',
    muted: () => DK.muted,
    detailOpen: () => !!(detEl && detEl.classList.contains('show')),
    snapshot: () => DK.snap,
  };
})();
