/**
 * web/hud.js — 信息中枢「情报面板」+ 贴角色消息卡片 + 常驻小条
 *
 * 为什么重写而不是复用 hub.js：面板从独立窗口搬回主窗，才能"悬浮在角色旁边"，
 * 并与 SAO 菜单共用一套浅金配色。数据层完全没变（还是 petHost.hub.* 的 IPC），
 * 这里只负责画和把点击变成 hub.do(...)。
 *
 * 由 index.html 末尾 <script src="hud.js"> 载入，自初始化；对外只暴露 window.HUDCTL。
 */
'use strict';

(function () {
  /* 线条图标（1.3px stroke，与 SAO 菜单同一套观感；比 Unicode 符号更整齐） */
  const svg = (d) => '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  const ICON = {
    msgs: svg('<path d="M3.2 4.2h9.6v6.2H7L4.4 12.6V10.4H3.2z"/>'),
    balance: svg('<path d="M8 2.6l5.4 5.4L8 13.4 2.6 8z"/><path d="M8 5.6v4.8"/>'),
    todo: svg('<rect x="3" y="3" width="10" height="10" rx="1"/><path d="M5.6 8.1l1.9 1.9 3.3-3.7"/>'),
    weather: svg('<circle cx="8" cy="8" r="2.7"/><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1"/>'),
    mail: svg('<rect x="2.6" y="4" width="10.8" height="8" rx="1"/><path d="M2.9 4.7L8 8.7l5.1-4"/>'),
    calendar: svg('<rect x="2.6" y="3.6" width="10.8" height="9.8" rx="1"/><path d="M2.6 6.6h10.8M5.6 2.2v3M10.4 2.2v3"/>'),
    music: svg('<path d="M6.2 11.6V4.3l5.6-1.3v7.2"/><ellipse cx="4.7" cy="11.8" rx="1.5" ry="1.3"/><ellipse cx="10.3" cy="10.4" rx="1.5" ry="1.3"/>'),
    clip: svg('<rect x="3.6" y="3.4" width="8.8" height="10" rx="1"/><path d="M6.2 2.3h3.6v2.2H6.2z"/>'),
    settings: svg('<circle cx="8" cy="8" r="2.2"/><path d="M8 2.3v1.4M8 12.3v1.4M2.3 8h1.4M12.3 8h1.4M4 4l1 1M11 11l1 1M4 12l1-1M11 5l1-1"/>'),
  };
  const TABS = [
    { id: 'msgs',     label: '消息' },
    { id: 'balance',  label: '额度' },
    { id: 'todo',     label: '待办' },
    { id: 'weather',  label: '天气' },
    { id: 'mail',     label: '邮件' },
    { id: 'calendar', label: '日历' },
    { id: 'music',    label: '音乐' },
    { id: 'clip',     label: '剪贴板' },
    { id: 'settings', label: '设置' },
  ];

  const H = {
    ready: false,
    open: false,
    tab: 'msgs',
    enabled: true,
    state: null,
    snaps: {},
    notes: [],
    clip: [],
    rem: null,
    fresh: {},
    noteQ: [], note: null, noteT: null, noteHover: false, noteNext: 0,
    scroll: {},
  };

  const $ = (s) => document.querySelector(s);
  const petEl = () => document.getElementById('pet');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const snap = (k) => (H.snaps[k] && H.snaps[k].data) || null;
  const srcOf = (n) => ((H.state && H.state.sources) || []).find((s) => s.name === n) || {};
  const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  const hhmm = (ts) => { const d = new Date(ts || Date.now()); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const ago = (ts) => { const s = Math.max(0, Math.round((Date.now() - (ts || 0)) / 1000)); if (s < 60) return s + ' 秒前'; if (s < 3600) return Math.round(s / 60) + ' 分前'; if (s < 86400) return Math.round(s / 3600) + ' 小时前'; return Math.round(s / 86400) + ' 天前'; };

  function toast(msg) { try { if (typeof window.toast === 'function') window.toast(msg); } catch (e) {} }

  /* ============================ 面板骨架 ============================ */
  function ensureDom() {
    if ($('#hud')) return;
    const hud = document.createElement('div');
    hud.id = 'hud';
    hud.setAttribute('role', 'region');
    hud.setAttribute('aria-label', '情报面板');
    hud.innerHTML =
      // 与主菜单同构：左边一列圆钮（独立，不在卡片里），右边一张大卡片装密集信息
      '<div class="hud-rail" id="hudRail"></div>' +
      '<div class="hud-frame">' +
      '<i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i>' +
      '<div class="hud-head"><span class="hud-mark"></span><span class="hud-title">情报</span>' +
      '<span class="hud-en">SYSTEM CONSOLE</span><span class="hud-grow"></span>' +
      '<button class="hud-x" id="hudClose" title="关闭">✕</button></div>' +
      '<div class="hud-stat" id="hudStat"></div>' +
      '<div class="hud-pane" id="hudPane"></div>' +
      '<div class="hud-foot"><span class="dot" id="hudDot"></span><span id="hudFoot">—</span></div>' +
      '</div>';
    document.body.appendChild(hud);

    const mini = document.createElement('div');
    mini.id = 'hudMini';
    mini.title = '点击打开情报面板';
    document.body.appendChild(mini);

    $('#hudClose').addEventListener('click', () => HUDCTL.close());
    mini.addEventListener('click', () => HUDCTL.open(H.fresh.msgs ? 'msgs' : H.tab));
  }

  function renderRail() {
    const rail = $('#hudRail');
    if (!rail) return;
    rail.innerHTML = TABS.map((t) =>
      '<button data-tab="' + t.id + '" class="' + (H.tab === t.id ? 'on' : '') + (H.fresh[t.id] ? ' new' : '') + '" title="' + t.label + '">' +
      (ICON[t.id] || '') + '<span class="nb"></span></button>').join('');
  }

  /* 顶部状态轨：四格读数，游戏 HUD 的第一眼辨识度就靠它 */
  function renderStat() {
    const el = document.getElementById('hudStat');
    if (!el) return;
    const msgs = (H.notes || []).filter((n) => Date.now() - (n.ts || 0) < 30 * 60 * 1000).length;
    const todos = ((H.rem || {}).todos || []).filter((t) => !t.done).length;
    const focus = (H.rem || {}).focus;
    const left = focus && focus.active ? mmss((focus.endsAt || 0) - Date.now()) : '--:--';
    const bal = ((snap('balance') || {}).items || []).filter((x) => x.ok !== false && typeof x.amount === 'number')
      .sort((a, b) => a.amount - b.amount)[0];
    const seg = (k, v, hot) => '<span class="s' + (hot ? ' hot' : '') + '"><i>' + k + '</i><b>' + v + '</b></span>';
    el.innerHTML = seg('消息', msgs, msgs > 0) + seg('待办', todos, todos > 0) + seg('专注', left, !!(focus && focus.active)) +
      seg('余额', bal ? (bal.amount + ' ' + (bal.currency || '')) : '—', false);
  }

  function render() {
    if (!H.open) return;
    renderRail();
    renderStat();
    const pane = $('#hudPane');
    if (!pane) return;
    pane.innerHTML = ({
      msgs: panMsgs, balance: panBalance, todo: panTodo, weather: panWeather,
      mail: panMail, calendar: panCalendar, music: panMusic, clip: panClip, settings: panSettings,
    }[H.tab] || panMsgs)();
    pane.scrollTop = H.scroll[H.tab] || 0;
    const on = ((H.state && H.state.sources) || []).filter((s) => s.enabled && s.ready).length;
    const all = ((H.state && H.state.sources) || []).length;
    const dot = $('#hudDot'); if (dot) dot.className = 'dot' + (H.enabled ? '' : ' off');
    const foot = $('#hudFoot');
    if (foot) foot.textContent = H.enabled ? (on + '/' + all + ' 源在线 · 更新 ' + hhmm()) : '功能已关闭';
    afterRender();
  }

  function afterRender() {
    if (H.tab === 'music') {
      const sk = document.getElementById('hudSeek');
      if (sk) sk.addEventListener('input', () => { const v = document.getElementById('hudSeekV'); if (v) v.textContent = mmss(sk.value * 1000); });
      if (sk) sk.addEventListener('change', async () => {
        await hubCall('musicControl', { verb: 'seek', seconds: Number(sk.value) });
        toast('已跳转');
      });
    }
  }

  /* ============================ 各页 ============================ */
  function panMsgs() {
    const list = H.notes.slice().reverse().slice(0, 40);
    if (!list.length) return '<div class="hud-empty">暂无消息。<br>在「设置」里打开消息来源后，<br>新消息会贴着角色弹出。</div>';
    return '<div class="hud-sec"><h3>最近消息 · ' + list.length + '</h3><div class="hud-box">' +
      list.map((n) => {
        const tag = n.kind === 'mail' ? 'MAIL' : n.kind === 'reminder' ? 'ALERT' : (n.source === 'winnotify' ? 'IM' : (n.source === 'lark' ? 'LARK' : String(n.source).toUpperCase().slice(0, 6)));
        return '<div class="hud-msg"><div class="h"><span class="tag' + (n.level !== 'info' ? ' w' : '') + '">' + esc(tag) + '</span>' +
          '<span class="ttl">' + esc(n.title || '') + '</span><span class="tm">' + hhmm(n.ts) + '</span></div>' +
          '<div class="bd">' + esc(n.body || '') + '</div>' +
          ((n.actions || []).length ? '<div class="hud-btnrow">' + n.actions.map((a) => '<button class="hud-btn sm" data-act="noteAction" data-id="' + esc(n.id) + '" data-a="' + esc(a.id) + '">' + esc(a.label) + '</button>').join('') + '</div>' : '') +
          '</div>';
      }).join('') + '</div></div>';
  }

  function panBalance() {
    const d = snap('balance');
    const items = (d && Array.isArray(d.items)) ? d.items : [];
    let html = '<div class="hud-sec"><h3>AI 额度<button class="hud-btn sm" style="margin-left:auto" data-act="refresh" data-name="balance">刷新</button></h3>';
    if (!items.length) {
      return html + '<div class="hud-box"><div class="hud-empty">还没有账户。<br>在「设置」里填 DeepSeek / Pure Tokens 的 key。</div></div></div>';
    }
    html += '<div class="hud-box">' + items.map((it) => {
      const amt = it.ok === false ? (it.error || '读取失败') : ((it.amount == null ? '—' : it.amount) + ' ' + (it.currency || ''));
      return '<div class="hud-row"><div class="k">' + esc(it.label || it.id || '') +
        '<div class="m">' + esc(it.detail || it.type || '') + '</div></div>' +
        '<div class="v' + (it.ok === false ? ' warn' : '') + '">' + esc(amt) + '</div></div>';
    }).join('') + '</div>';
    if (d && d.updatedAt) html += '<div class="hud-dim" style="font-size:9.5px;margin-top:5px">更新于 ' + ago(d.updatedAt) + '</div>';
    return html + '</div>';
  }

  function panTodo() {
    const r = H.rem || {};
    const todos = Array.isArray(r.todos) ? r.todos : [];
    const focus = r.focus || null;
    const water = r.water || null;
    const total = water ? (water.totalMl != null ? water.totalMl : 0) : 0;
    const goal = water ? (water.goalMl || 2000) : 2000;
    const pct = Math.min(100, Math.round(total / goal * 100));

    const todoHtml = '<div class="hud-sec"><h3>待办 · ' + todos.filter((t) => !t.done).length + ' 未完</h3><div class="hud-box">' +
      (todos.length ? todos.map((t) => '<div class="hud-row"><input type="checkbox" data-act="todoToggle" data-id="' + esc(t.id) + '"' + (t.done ? ' checked' : '') + ' style="accent-color:#AC7D0C">' +
        '<div class="k" style="' + (t.done ? 'text-decoration:line-through;color:#9aa39c' : '') + '">' + esc(t.text || '') +
        '<div class="m">' + esc((t.repeat === 'daily' ? '每天 ' : t.repeat === 'weekly' ? '每周 ' : '') + (t.at || '') + (t.nextAt ? ' · 下次 ' + hhmm(t.nextAt) : '')) + '</div></div>' +
        '<button class="hud-btn sm" data-act="todoRemove" data-id="' + esc(t.id) + '">✕</button></div>').join('')
        : '<div class="hud-empty" style="padding:6px 0">还没有待办</div>') +
      '<div class="hud-field" style="margin:8px 0 0"><input class="hud-in" type="text" id="hudTodoText" placeholder="要记的事…" maxlength="60">' +
      '<input class="hud-in" type="time" id="hudTodoAt" value="09:00" style="width:78px;flex:none">' +
      '<select class="hud-sel" id="hudTodoRep" style="width:64px;flex:none"><option value="none">单次</option><option value="daily">每天</option></select>' +
      '<button class="hud-btn pri" data-act="todoAdd">记</button></div></div></div>';

    const focusHtml = '<div class="hud-sec"><h3>专注' + (focus && focus.active ? ' · 进行中' : '') + '</h3><div class="hud-box">' +
      (focus && focus.active
        ? '<div style="display:flex;align-items:baseline;gap:9px"><div id="hudFocusLeft" style="font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em">' +
          mmss((focus.endsAt || 0) - Date.now()) + '</div><div class="hud-dim" style="font-size:10px">共 ' + esc(focus.minutes || 0) + ' 分钟</div></div>' +
          '<div class="hud-btnrow"><button class="hud-btn" data-act="focusStop">结束</button></div>'
        : '<div class="hud-dim" style="font-size:11px;margin-bottom:6px">到点角色会过来提醒你休息。</div>' +
          '<div class="hud-btnrow">' + [15, 25, 45, 60].map((m) => '<button class="hud-btn" data-act="focusStart" data-min="' + m + '">' + m + ' 分</button>').join('') + '</div>') +
      '</div></div>';

    const waterHtml = '<div class="hud-sec"><h3>喝水 · ' + total + '/' + goal + 'ml</h3><div class="hud-box">' +
      '<div class="hud-bar blue"><i style="width:' + pct + '%"></i></div>' +
      '<div class="hud-btnrow"><button class="hud-btn pri" data-act="waterAdd" data-ml="' + (water && water.cupMl || 250) + '">+ ' + (water && water.cupMl || 250) + 'ml</button>' +
      '<button class="hud-btn" data-act="waterUndo">撤销</button></div></div></div>';
    return todoHtml + focusHtml + waterHtml;
  }

  function panWeather() {
    const d = snap('weather');
    const head = '<div class="hud-sec"><h3>天气<button class="hud-btn sm" style="margin-left:auto" data-act="refresh" data-name="weather">刷新</button></h3>';
    if (!d || d.ok === false) {
      return head + '<div class="hud-box"><div class="hud-empty">' + esc((d && d.error) || '还没取到天气') + '</div></div></div>';
    }
    const t = d.temp != null ? d.temp : (d.temperature != null ? d.temperature : '—');
    const days = Array.isArray(d.days) ? d.days : (Array.isArray(d.daily) ? d.daily : []);
    return head + '<div class="hud-box">' +
      '<div class="hud-wnow"><div class="t">' + esc(t) + '°</div><div><div style="font-size:12px">' + esc(d.text || d.desc || '') + '</div>' +
      '<div class="hud-dim" style="font-size:10px">' + esc(d.city || '') + (d.feels != null ? ' · 体感 ' + esc(d.feels) + '°' : '') + '</div></div></div>' +
      (days.length ? '<div class="hud-wdays">' + days.slice(0, 7).map((x) => '<div class="hud-wday"><span class="hud-dim">' + esc(x.label || '') + '</span>' +
        '<b>' + esc(x.max != null ? x.max : '') + '°</b><span class="hud-dim">' + esc(x.min != null ? x.min : '') + '°</span></div>').join('') + '</div>' : '') +
      '<div class="hud-field" style="margin-top:8px"><label>城市</label><input class="hud-in" type="text" id="hudCity" placeholder="留空按网络定位（会跟随代理出口）" value="' + esc(((srcOf('weather').cfg) || {}).city || '') + '">' +
      '<button class="hud-btn sm" data-act="saveCity">存</button></div>' +
      '</div></div>';
  }

  function panMail() {
    const d = snap('mail');
    const list = (d && Array.isArray(d.list)) ? d.list : [];
    const head = '<div class="hud-sec"><h3>邮件<button class="hud-btn sm" style="margin-left:auto" data-act="refresh" data-name="mail">收取</button></h3>';
    if (!list.length) return head + '<div class="hud-box"><div class="hud-empty">还没有邮件。<br>在「设置」里填 IMAP 与授权码。</div></div></div>';
    return head + '<div class="hud-box">' + list.map((m) => '<div class="hud-row"><div class="k">' + esc(m.subject || '（无主题）') +
      '<div class="m">' + esc(m.from || '') + ' · ' + ago(m.ts || m.date) + '</div></div>' +
      (m.code ? '<button class="hud-btn sm pri" data-act="copy" data-text="' + esc(m.code) + '">' + esc(m.code) + '</button>' : '') +
      '</div>').join('') + '</div></div>';
  }

  function panCalendar() {
    const d = snap('calendar');
    const today = (d && Array.isArray(d.today)) ? d.today : [];
    const head = '<div class="hud-sec"><h3>今日日程<button class="hud-btn sm" style="margin-left:auto" data-act="refresh" data-name="calendar">刷新</button></h3>';
    if (!today.length) return head + '<div class="hud-box"><div class="hud-empty">' + esc((d && d.error) || '今天没有日程') + '</div></div></div>';
    return head + '<div class="hud-box">' + today.map((e) => '<div class="hud-row"><div class="v" style="width:46px;flex:none">' + esc(e.time || e.start || '') + '</div>' +
      '<div class="k">' + esc(e.title || e.summary || '') + (e.place ? '<div class="m">' + esc(e.place) + '</div>' : '') + '</div></div>').join('') + '</div></div>';
  }

  function panMusic() {
    const m = snap('music') || {};
    const end = Math.max(1, Math.round(Number(m.end || 0)));
    const pos = Math.round(Number(m.pos || 0));
    return '<div class="hud-sec"><h3>音乐<button class="hud-btn sm" style="margin-left:auto" data-act="musicState">刷新</button></h3><div class="hud-box">' +
      (m.hasSession
        ? '<div class="hud-track">' + esc(m.title || '未知曲目') + '<div class="ar">' + esc(m.artist || m.app || '') + '</div></div>' +
          '<input type="range" class="hud-seek" id="hudSeek" min="0" max="' + end + '" value="' + pos + '">' +
          '<div style="display:flex;justify-content:space-between;font-size:10px;color:#7b847d;font-variant-numeric:tabular-nums">' +
          '<span id="hudSeekV">' + mmss(pos * 1000) + '</span><span>' + mmss(end * 1000) + '</span></div>' +
          '<div class="hud-ctrls"><button class="hud-btn" data-act="music" data-v="prev">⏮</button>' +
          '<button class="hud-btn pri" data-act="music" data-v="play_pause">' + (m.playing ? '⏸' : '▶') + '</button>' +
          '<button class="hud-btn" data-act="music" data-v="next">⏭</button>' +
          '<button class="hud-btn" data-act="music" data-v="stop">⏹</button></div>' +
          '<div class="hud-btnrow" style="justify-content:center"><button class="hud-btn sm" data-act="music" data-v="vol_down">音量 −</button>' +
          '<button class="hud-btn sm" data-act="music" data-v="vol_up">音量 ＋</button></div>'
        : '<div class="hud-empty">没有检测到播放器。<br>放一首歌再点刷新。</div>') +
      '</div></div>';
  }

  function panClip() {
    const list = H.clip || [];
    const head = '<div class="hud-sec"><h3>剪贴板 · ' + list.length + '<button class="hud-btn sm" style="margin-left:auto" data-act="clipClear">清未固定</button></h3>';
    if (!list.length) return head + '<div class="hud-box"><div class="hud-empty">还没有记录</div></div></div>';
    return head + '<div class="hud-box">' + list.slice(0, 24).map((c) => '<div class="hud-clip' + (c.pinned ? ' pin' : '') + '" data-act="clipCopy" data-id="' + esc(c.id) + '">' +
      '<div class="x">' + esc(String(c.text).slice(0, 200)) + '</div>' +
      '<div class="f"><span>' + (c.len || 0) + ' 字</span><span>' + ago(c.ts) + '</span><span style="flex:1"></span>' +
      '<button class="hud-btn sm" data-act="clipPin" data-id="' + esc(c.id) + '" data-on="' + (c.pinned ? '0' : '1') + '">' + (c.pinned ? '取消' : '固定') + '</button>' +
      '<button class="hud-btn sm" data-act="clipRemove" data-id="' + esc(c.id) + '">✕</button></div></div>').join('') + '</div></div>';
  }

  function panSettings() {
    const srcs = (H.state && H.state.sources) || [];
    const note = (H.state && H.state.note) || {};
    const rows = srcs.map((s) => '<div class="hud-row"><div class="k">' + esc(s.label) +
      '<div class="m">' + esc(s.ready ? (s.detail || '在线') : (s.enabled ? (s.detail || '未就绪') : '已关闭')) + '</div></div>' +
      '<button class="hud-btn sm" data-act="probe" data-name="' + esc(s.name) + '">试</button>' +
      '<button class="hud-sw ' + (s.enabled ? 'on' : '') + '" data-act="toggle" data-name="' + esc(s.name) + '"></button></div>').join('');

    const mailCfg = (srcOf('mail').cfg) || {};
    const balCfg = (srcOf('balance').cfg) || {};

    const master = '<div class="hud-sec"><h3>功能总开关</h3><div class="hud-box">' +
      '<div class="hud-row"><div class="k">信息中枢<div class="m">关掉后所有来源停止、不再弹卡片</div></div>' +
      '<button class="hud-sw ' + (H.enabled ? 'on' : '') + '" data-act="master"></button></div>' +
      '<div class="hud-row"><div class="k">弹窗停留<div class="m">鼠标移上去会暂停计时</div></div>' +
      '<select class="hud-sel" data-act="noteDur" style="width:auto">' + [4, 6, 7, 10, 15].map((v) => '<option value="' + v + '"' + (Number(note.durationSec) === v ? ' selected' : '') + '>' + v + ' 秒</option>').join('') + '</select></div>' +
      '<div class="hud-row"><div class="k">正文预览<div class="m">关掉只显示"有新消息"</div></div>' +
      '<select class="hud-sel" data-act="noteBody" style="width:auto"><option value="1"' + (note.previewBody !== false ? ' selected' : '') + '>显示</option><option value="0"' + (note.previewBody === false ? ' selected' : '') + '>隐藏</option></select></div>' +
      '<div class="hud-btnrow"><button class="hud-btn" data-act="testNote">试一下弹窗</button></div></div></div>';

    // 通知中心按应用细分：5 个chip，点一下即写进 apps 配置
    const wn = srcOf('winnotify');
    const apps = (wn.cfg && wn.cfg.apps) || {};
    const APPS = [{ k: 'wechat', n: '微信' }, { k: 'qq', n: 'QQ' }, { k: 'feishu', n: '飞书' }, { k: 'dingtalk', n: '钉钉' }, { k: 'wecom', n: '企微' }];
    const appChips = wn && wn.name ? '<div class="hud-sec"><h3>通知中心 · 监控哪些应用</h3><div class="hud-box">' +
      '<div class="hud-chips">' + APPS.map((a) => '<button class="hud-chip' + (apps[a.k] ? ' on' : '') + '" data-act="appToggle" data-app="' + a.k + '">' + a.n + '</button>').join('') + '</div>' +
      '<div class="hud-dim" style="font-size:9.5px;margin-top:5px">微信要自己开「设置 → 通知 → 新消息通知」，系统还要允许应用访问通知</div>' +
      '</div></div>' : '';

    return master +
      '<div class="hud-sec"><h3>来源</h3><div class="hud-box">' + (rows || '<div class="hud-empty">没有来源</div>') + '</div></div>' + appChips +
      '<div class="hud-sec"><h3>邮件 IMAP</h3><div class="hud-box">' +
      '<div class="hud-field"><label>服务器</label><input class="hud-in" id="hudMHost" placeholder="imap.qq.com" value="' + esc(mailCfg.host || '') + '"></div>' +
      '<div class="hud-field"><label>账号</label><input class="hud-in" id="hudMUser" placeholder="you@qq.com" value="' + esc(mailCfg.user || '') + '"></div>' +
      '<div class="hud-field"><label>授权码</label><input class="hud-in" type="password" id="hudMPass" placeholder="' + (mailCfg.hasPass ? '已保存（留空不改）' : 'IMAP 授权码') + '"></div>' +
      '<div class="hud-btnrow"><button class="hud-btn pri" data-act="saveMail">保存并连接</button></div></div></div>' +
      '<div class="hud-sec"><h3>额度密钥</h3><div class="hud-box">' +
      '<div class="hud-field"><label>DeepSeek</label><input class="hud-in" type="password" id="hudBDeep" placeholder="' + (balCfg.hasDeepseekKey || balCfg.hasDeepseekKeyEnc ? '已配置（留空不改）' : 'sk-...') + '"></div>' +
      '<div class="hud-field"><label>PureTok</label><input class="hud-in" type="password" id="hudBPure" placeholder="' + (balCfg.hasPuretokensKey || balCfg.hasPuretokensKeyEnc ? '已配置（留空不改）' : 'sk-...') + '"></div>' +
      '<div class="hud-btnrow"><button class="hud-btn pri" data-act="saveBalance">保存</button></div></div></div>';
  }

  /* ============================ 动作 ============================ */
  async function hubCall(action, arg) {
    try { return await window.petHost.hub.do(action, arg); } catch (e) { return { ok: false, error: e.message }; }
  }

  async function doAct(a, el) {
    const name = el && el.dataset.name;
    const id = el && el.dataset.id;
    if (a === 'master') {
      const want = !H.enabled;
      const r = await window.petHost.hub.setEnabled(want);
      H.enabled = !!(r && r.enabled);
      if (!H.enabled) HUDCTL.close();
      await refreshState();
      render(); updateMini();
      return toast(H.enabled ? '信息中枢已开启' : '信息中枢已关闭');
    }
    if (a === 'toggle') {
      const on = !el.classList.contains('on');
      const r = await hubCall('setSource', { name, patch: { enabled: on } });
      if (r && r.state) H.state = r.state;
      render(); updateMini();
      return toast((on ? '已打开 ' : '已关闭 ') + name);
    }
    if (a === 'appToggle') {
      const key = el.dataset.app;
      const wn = srcOf('winnotify');
      const cur = Object.assign({}, (wn.cfg && wn.cfg.apps) || {});
      cur[key] = !cur[key];
      const r = await hubCall('setSource', { name: 'winnotify', patch: { enabled: true, apps: cur } });
      if (r && r.state) H.state = r.state;
      render();
      return toast((cur[key] ? '开始监控 ' : '不再监控 ') + key);
    }
    if (a === 'probe') {
      toast('正在试 ' + name + ' …');
      const r = await hubCall('tick', { name });
      await refreshState(); render();
      const d = (r && r.result && (r.result.detail || (r.result.apps && ('命中 ' + JSON.stringify(r.result.apps))))) || '';
      return toast(r && r.ok ? (d || '已触发') : ('失败：' + ((r && r.error) || '')));
    }
    if (a === 'refresh') { await hubCall('refresh', { name }); H.snaps = await window.petHost.hub.snapshots(); render(); return toast('已刷新'); }
    if (a === 'noteAction') { const r = await window.petHost.hub.noteAction(id, el.dataset.a); return toast(r && r.ok ? '已执行' : '失败'); }
    if (a === 'copy') { try { await navigator.clipboard.writeText(el.dataset.text || ''); } catch (e) {} return toast('已复制'); }
    if (a === 'todoAdd') {
      const text = ($('#hudTodoText') || {}).value || '';
      if (!text.trim()) return toast('先写点什么');
      await hubCall('todoAdd', { text: text.trim(), at: ($('#hudTodoAt') || {}).value || '09:00', repeat: ($('#hudTodoRep') || {}).value || 'none' });
      H.rem = (await hubCall('remindersState')).state || H.rem; render(); return;
    }
    if (a === 'todoRemove' || a === 'todoToggle') { await hubCall(a, { id }); H.rem = (await hubCall('remindersState')).state || H.rem; return render(); }
    if (a === 'focusStart') { await hubCall('focusStart', { minutes: Number(el.dataset.min) }); H.rem = (await hubCall('remindersState')).state || H.rem; render(); return toast('专注 ' + el.dataset.min + ' 分钟'); }
    if (a === 'focusStop') { await hubCall('focusStop'); H.rem = (await hubCall('remindersState')).state || H.rem; return render(); }
    if (a === 'waterAdd') { await hubCall('waterAdd', { ml: Number(el.dataset.ml) }); H.rem = (await hubCall('remindersState')).state || H.rem; return render(); }
    if (a === 'waterUndo') { await hubCall('waterUndo'); H.rem = (await hubCall('remindersState')).state || H.rem; return render(); }
    if (a === 'music') { const r = await hubCall('musicControl', { verb: el.dataset.v }); H.snaps = await window.petHost.hub.snapshots(); render(); if (!(r && r.ok)) toast('控制失败'); return; }
    if (a === 'musicState') { H.snaps = await window.petHost.hub.snapshots(); render(); return toast('已刷新'); }
    if (a === 'clipCopy') { const r = await hubCall('clipCopy', { id }); if (r && r.list) H.clip = r.list; return toast('已复制回剪贴板'); }
    if (a === 'clipPin') { const r = await hubCall('clipPin', { id, on: el.dataset.on === '1' }); H.clip = r.list || H.clip; return render(); }
    if (a === 'clipRemove') { const r = await hubCall('clipRemove', { id }); H.clip = r.list || H.clip; return render(); }
    if (a === 'clipClear') { const r = await hubCall('clipClear'); H.clip = r.list || []; return render(); }
    if (a === 'testNote') { await hubCall('testNote'); return toast('已发出'); }
    if (a === 'saveCity') {
      const city = (($('#hudCity') || {}).value || '').trim();
      await hubCall('setSource', { name: 'weather', patch: { city } });
      await hubCall('refresh', { name: 'weather' });
      H.snaps = await window.petHost.hub.snapshots(); await refreshState(); render();
      return toast(city ? ('城市：' + city) : '已改为网络定位');
    }
    if (a === 'saveMail') {
      const host = ($('#hudMHost') || {}).value, user = ($('#hudMUser') || {}).value, pass = ($('#hudMPass') || {}).value;
      if (!host || !user) return toast('服务器和账号必填');
      const r = await hubCall('setSource', { name: 'mail', patch: { enabled: true, host, user, port: 993, ...(pass ? { pass } : {}) } });
      if (r && r.state) H.state = r.state; render();
      return toast('已保存，正在连接…');
    }
    if (a === 'saveBalance') {
      const deep = ($('#hudBDeep') || {}).value, pure = ($('#hudBPure') || {}).value;
      const patch = { enabled: true };
      if (deep) patch.deepseekKey = deep;
      if (pure) patch.puretokensKey = pure;
      const r = await hubCall('setSource', { name: 'balance', patch });
      if (r && r.state) H.state = r.state; render();
      return toast('已保存');
    }
  }

  /* ============================ 定位 ============================ */
  function place(el, w, h, prefer) {
    const pr = petEl().getBoundingClientRect();
    const W = innerWidth, Hh = innerHeight, gap = 12;
    let x = pr.right + gap, mirror = false;
    if (x + w > W - 8) { x = pr.left - w - gap; mirror = true; }
    if (x < 8) { x = Math.max(8, Math.min(W - w - 8, pr.left + pr.width / 2 - w / 2)); }
    let y;
    if (prefer === 'below') y = pr.bottom - h * 0.06;
    else y = pr.top + pr.height * 0.12;
    y = Math.max(8, Math.min(Hh - h - 8, y));
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
    el.classList.toggle('mirror', mirror);
    return mirror;
  }

  /** 常驻小条：贴着角色脚底/头顶，水平居中，绝不压住角色本体 */
  function placeMini() {
    const mini = $('#hudMini');
    if (!mini) return;
    const pr = petEl().getBoundingClientRect();
    const w = mini.offsetWidth || 200, h = mini.offsetHeight || 24;
    const W = innerWidth, Hh = innerHeight;
    let y = pr.bottom + 4;
    if (y + h > Hh - 6) y = pr.top - h - 6;            // 角色贴底时翻到头顶
    y = Math.max(6, Math.min(Hh - h - 6, y));
    let x = pr.left + pr.width / 2 - w / 2;
    x = Math.max(8, Math.min(W - w - 8, x));
    mini.style.left = Math.round(x) + 'px';
    mini.style.top = Math.round(y) + 'px';
  }

  /* ============================ 常驻小条 ============================ */
  function updateMini() {
    const mini = $('#hudMini');
    if (!mini) return;
    if (!H.enabled) { mini.classList.remove('show', 'in'); return; }
    const msgs = (H.notes || []).filter((n) => Date.now() - (n.ts || 0) < 30 * 60 * 1000).length;
    const todos = ((H.rem || {}).todos || []).filter((t) => !t.done).length;
    const focus = (H.rem || {}).focus;
    const bal = ((snap('balance') || {}).items || []).filter((x) => x.ok !== false && typeof x.amount === 'number')
      .sort((a, b) => a.amount - b.amount)[0];
    const segs = [];
    segs.push('<div class="seg' + (msgs ? ' hot' : '') + '"><span class="g">◈</span><span class="n">' + msgs + '</span>消息</div>');
    if (todos) segs.push('<div class="seg"><span class="g">✓</span><span class="n">' + todos + '</span>待办</div>');
    if (focus && focus.active) segs.push('<div class="seg"><span class="g">⏱</span><span class="n">' + mmss((focus.endsAt || 0) - Date.now()) + '</span></div>');
    if (bal) segs.push('<div class="seg"><span class="g">◇</span><span class="n">' + bal.amount + '</span>' + esc(bal.currency || '') + '</div>');
    if (!segs.length) segs.push('<div class="seg"><span class="g">◈</span>情报</div>');
    const html = segs.join('');
    if (mini.dataset.sig !== html) { mini.innerHTML = '<span class="diamond"></span>' + html; mini.dataset.sig = html; }
    mini.classList.add('show');
    renderStat();
    placeMini();
    requestAnimationFrame(() => mini.classList.add('in'));
  }

  /* ============================ 消息卡片 ============================ */
  const NICON = { winnotify: '◈', lark: '✧', mail: '✉', reminder: '⏱', balance: '◇', music: '♪', clip: '▦' };

  function notePush(v) {
    if (!v || (!v.title && !v.body) || !H.enabled) return;
    H.notes.push(v);
    if (H.tab !== 'msgs') { H.fresh.msgs = true; renderRail(); }
    H.noteQ.push(v);
    if (!H.note) noteNext();
    updateMini();
  }

  function noteNext() {
    const box = document.getElementById('note');
    if (!box) return;
    const v = H.noteQ.shift();
    if (!v) { H.note = null; return; }
    H.note = v;
    const noteCfg = (H.state && H.state.note) || {};
    const showBody = noteCfg.previewBody !== false;
    const acts = (v.actions || []).map((a, i) =>
      '<button data-nact="' + esc(a.id) + '" class="' + (i === 0 ? 'pri' : '') + '">' + esc(a.label || a.id) + '</button>').join('');
    box.innerHTML = '<div class="nt-body"><div class="nt-h">' +
      '<div class="nt-ic"><span>' + (NICON[v.source] || NICON[v.kind] || '◈') + '</span></div>' +
      '<div class="nt-t">' + esc(v.title) + '</div>' +
      '<div class="nt-tm">' + hhmm(v.ts) + '</div>' +
      '<button class="nt-x" data-nact="__close">✕</button></div>' +
      (showBody && v.body ? '<div class="nt-b">' + esc(v.body) + '</div>' : '') +
      (acts ? '<div class="nt-a">' + acts + '</div>' : '') + '</div>';
    box.classList.add('show');
    placeNote(box);
    requestAnimationFrame(() => box.classList.add('in'));
    noteTimer();
  }

  /** 卡片位置：面板开着 → 放到角色头顶（避免盖住面板）；否则贴角色侧面 */
  function placeNote(box) {
    const pr = petEl().getBoundingClientRect();
    const w = box.offsetWidth || 300, h = box.offsetHeight || 90;
    const W = innerWidth, Hh = innerHeight;
    const hud = $('#hud');
    const hudOpen = !!(hud && hud.classList.contains('show'));
    let x, y;
    const mini = $('#hudMini');
    const miniTop = (mini && mini.classList.contains('show')) ? mini.getBoundingClientRect().top : pr.top;
    if (hudOpen) {
      x = pr.left + pr.width / 2 - w / 2;
      y = Math.min(pr.top, miniTop) - h - 8;
      if (y < 8) {
        const hr = hud.getBoundingClientRect();
        y = Math.min(Hh - h - 8, hr.bottom + 8);
        x = hr.left + hr.width / 2 - w / 2;
      }
    } else {
      x = pr.right + 12;
      if (x + w > W - 8) x = pr.left - w - 12;
      y = pr.top + pr.height * 0.14;
    }
    x = Math.max(8, Math.min(W - w - 8, x));
    y = Math.max(8, Math.min(Hh - h - 8, y));
    box.style.left = Math.round(x) + 'px';
    box.style.top = Math.round(y) + 'px';
    box.classList.toggle('mirror', x + w / 2 < pr.left + pr.width / 2);
  }

  function noteTimer() {
    clearTimeout(H.noteT);
    const dur = Number(((H.state && H.state.note) || {}).durationSec || 7) * 1000;
    H.noteNext = Date.now() + Math.max(1500, dur);
    H.noteT = setTimeout(() => { if (!H.noteHover) noteHide(); }, Math.max(1500, dur));
  }

  function noteHide() {
    const box = document.getElementById('note');
    if (!box) return;
    box.classList.remove('in');
    clearTimeout(H.noteT);
    setTimeout(() => {
      box.classList.remove('show', 'mirror');
      box.innerHTML = '';
      noteNext();
    }, 210);
  }

  async function noteAction(id) {
    const cur = H.note;
    if (!cur) return;
    try { await window.petHost.hub.noteAction(cur.id, id); } catch (e) {}
    noteHide();
  }

  /* ============================ 数据 ============================ */
  async function refreshState() {
    try { H.state = await window.petHost.hub.state(); } catch (e) { return; }
    H.enabled = !!(H.state && H.state.enabled);
    H.notes = (H.state && H.state.notes) || [];
  }

  async function refreshAll() {
    await refreshState();
    try { H.snaps = await window.petHost.hub.snapshots(); } catch (e) {}
    try { H.clip = ((await hubCall('clipList')).list) || H.clip; } catch (e) {}
    try { H.rem = ((await hubCall('remindersState')).state) || H.rem; } catch (e) {}
  }

  /* ============================ 对外 ============================ */
  const HUDCTL = {
    init() {
      if (H.ready) return;
      ensureDom();
      H.ready = true;
      const host = window.petHost;
      if (host && host.hub) {
        try {
          host.hub.onNote((v) => notePush(v));
          host.hub.onSnapshot((s) => {
            H.snaps[s.kind] = { data: s.data, ts: s.ts };
            if (s.kind === 'reminders') H.rem = s.data;
            if (H.open) { if ({ balance: 1, weather: 1, mail: 1, calendar: 1, music: 1 }[s.kind] === 1 && s.kind === H.tab) render(); }
            updateMini();
          });
          host.hub.onEnabled((v) => {
            H.enabled = !!(v && v.enabled);
            if (v && v.state) H.state = v.state;
            if (!H.enabled) HUDCTL.close();
            else updateMini();
            if (H.open) render();
          });
          host.hub.onOpenHud((tab) => HUDCTL.open(tab));
        } catch (e) {}
      }
      const box = document.getElementById('note');
      if (box) {
        box.addEventListener('mouseenter', () => { H.noteHover = true; clearTimeout(H.noteT); });
        box.addEventListener('mouseleave', () => {
          H.noteHover = false;
          clearTimeout(H.noteT);
          H.noteT = setTimeout(() => { if (!H.noteHover) noteHide(); }, Math.max(1200, H.noteNext - Date.now()));
        });
        box.addEventListener('click', (e) => {
          const b = e.target.closest('[data-nact]');
          if (!b) return;
          e.stopPropagation();
          const a = b.dataset.nact;
          if (a === '__close') return noteHide();
          noteAction(a);
        });
      }
      // 悬停 / 点击音（与主菜单同一套四声）
      document.addEventListener('pointerover', (e) => {
        const t = e.target;
        if (t && t.closest && t.closest('#hud .hud-rail button, #hud .row, #hud .hud-chip, #hud .hud-row')) {
          try { SFX.play('hover'); } catch (err) {}
        }
      }, true);
      document.addEventListener('click', (e) => {
        const t = e.target;
        if (t && t.closest && t.closest('#hud button, #hud .row')) { try { SFX.play('click'); } catch (err) {} }
      }, true);

      // 3D 视差：鼠标在面板附近移动时，整块面板轻微歪头（-6°~+6°），离开后回正
      let tiltRaf = 0, tiltPt = null;
      const hudEl = document.getElementById('hud');
      if (hudEl) {
        hudEl.addEventListener('pointermove', (e) => {
          tiltPt = e;
          if (tiltRaf) return;
          tiltRaf = requestAnimationFrame(() => {
            tiltRaf = 0;
            const fr = hudEl.querySelector('.hud-frame');
            if (!fr || !tiltPt) return;
            const r = hudEl.getBoundingClientRect();
            if (!r.width) return;
            const nx = Math.max(-1, Math.min(1, (tiltPt.clientX - (r.left + r.width / 2)) / (r.width / 2)));
            const ny = Math.max(-1, Math.min(1, (tiltPt.clientY - (r.top + r.height / 2)) / (r.height / 2)));
            const base = hudEl.classList.contains('mirror') ? 4 : -4;
            fr.style.setProperty('--hud-ry', (base + nx * 2.2).toFixed(2) + 'deg');
            fr.style.setProperty('--hud-rx', (-ny * 2.2).toFixed(2) + 'deg');
          });
        });
        hudEl.addEventListener('pointerleave', () => {
          const fr = hudEl.querySelector('.hud-frame');
          if (!fr) return;
          fr.style.setProperty('--hud-ry', hudEl.classList.contains('mirror') ? '4deg' : '-4deg');
          fr.style.setProperty('--hud-rx', '0deg');
        });
      }

      document.addEventListener('click', (e) => {
        if (!H.open) return;
        if (e.target.closest('[data-tab]')) {
          H.tab = e.target.closest('[data-tab]').dataset.tab;
          H.fresh[H.tab] = false;
          return render();
        }
        const el = e.target.closest('[data-act]');
        if (!el) return;
        const a = el.dataset.act;
        if (a === 'noteDur' || a === 'noteBody') return;      // 交给 change 事件
        if (el.tagName === 'INPUT' && el.type === 'checkbox') return;
        doAct(a, el).catch((err) => toast('出错：' + err.message));
      });
      document.addEventListener('change', (e) => {
        const el = e.target.closest('[data-act]');
        if (!el) return;
        const a = el.dataset.act;
        if (a === 'noteDur') { window.petHost.hub.do('setNote', { durationSec: Number(el.value) || 7 }); toast('停留 ' + el.value + ' 秒'); }
        if (a === 'noteBody') { window.petHost.hub.do('setNote', { previewBody: el.value === '1' }); toast(el.value === '1' ? '显示正文' : '隐藏正文'); }
        if (a === 'todoToggle') doAct('todoToggle', el).catch(() => {});
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && H.open) HUDCTL.close();
        if (e.key === 'Enter' && e.target && e.target.id === 'hudTodoText') {
          const b = document.querySelector('[data-act="todoAdd"]'); if (b) doAct('todoAdd', b).catch(() => {});
        }
      });
      addEventListener('resize', () => { if (H.open) place($('#hud'), $('#hud').offsetWidth || 436, $('#hud').offsetHeight || 520, 'right'); placeMini(); });

      refreshAll().then(() => { updateMini(); });

      // 页面上电时主进程的信息中枢可能还没建好（拿到的是空兜底）→ 2 秒后补一次
      setTimeout(() => {
        if (H.state && (H.state.sources || []).length) return;
        refreshAll().then(() => { updateMini(); if (H.open) render(); });
      }, 2200);
      // 面板关着也要保持总开关/小条数字是新的（只走一次 IPC，成本可忽略）
      setInterval(() => { refreshState().then(() => { updateMini(); if (H.open) render(); }); }, 15000);

      // 面板打开时低频刷新一次数据（关着时不打扰）
      setInterval(() => {
        if (!H.open) return;
        refreshAll().then(() => render());
      }, 20000);
      // 小条每 10 秒换一次数字（专注倒计时靠 1 秒的本地循环）
      setInterval(() => { if (!H.open) updateMini(); }, 10000);
      setInterval(() => {
        if (!H.enabled) return;
        const f = (H.rem || {}).focus;
        if (f && f.active) {
          const sec = document.querySelector('#hudFocusLeft');
          if (sec) sec.textContent = mmss((f.endsAt || 0) - Date.now());
          updateMini();
        }
      }, 1000);
    },

    async open(tab) {
      if (!H.ready) HUDCTL.init();
      await refreshState();
      if (!H.enabled) {
        toast('信息中枢已关闭，先在菜单里打开');
        const r = await window.petHost.hub.setEnabled(true);
        H.enabled = !!(r && r.enabled);
        await refreshAll();
      }
      if (tab) H.tab = tab;
      H.open = true;
      // 与主菜单互斥：两块面板同时开会在同一块屏幕区域互相压住
      try { if (typeof closeMenu === 'function' && document.getElementById('sao').classList.contains('show')) closeMenu(); } catch (e) {}
      const hud = $('#hud');
      hud.classList.remove('out');
      hud.classList.add('show', 'enter');
      clearTimeout(H.enterT);
      H.enterT = setTimeout(() => hud.classList.remove('enter'), 720);
      try { SFX.play('open'); } catch (e) {}
      render();
      place(hud, hud.offsetWidth || 436, hud.offsetHeight || 520, 'right');
      requestAnimationFrame(() => hud.classList.add('in'));
      // 入场扫光（一次性装饰）
      try {
        const fr = hud.querySelector('.hud-frame');
        const old = fr.querySelector('.sweep');
        if (old) old.remove();
        const sw = document.createElement('i');
        sw.className = 'sweep';
        fr.appendChild(sw);
        setTimeout(() => sw.remove(), 1100);
      } catch (e) {}
    },

    close() {
      const hud = $('#hud');
      if (!hud) return;
      H.open = false;
      try { SFX.play('close'); } catch (e) {}
      hud.classList.remove('in');
      hud.classList.add('out');
      setTimeout(() => { if (!H.open) { hud.classList.remove('show', 'out'); } }, 190);
    },

    toggle() { return H.open ? HUDCTL.close() : HUDCTL.open(); },
    state() { return { open: H.open, tab: H.tab, enabled: H.enabled }; },
    _dbg() { return { enabled: H.enabled, stateEnabled: (H.state||{}).enabled, ready: H.ready, hasState: !!H.state }; },
    push(v) { notePush(v); },
  };

  window.HUDCTL = HUDCTL;
  // 脚本在主窗末尾加载：DOM 已就绪，直接初始化
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => HUDCTL.init());
  else HUDCTL.init();
})();
