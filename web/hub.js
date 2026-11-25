/**
 * web/hub.js — 「信息中枢」面板渲染层
 *
 * 只做三件事：要数据（hub.* IPC）、画出来、把点击变成 hub.do(...)。
 * 所有真实能力都在主进程 app/infohub/ 下；这里不认识 fs/net/electron。
 *
 * 数据容错：每个模块的数据形状由各自 source 决定，渲染一律"有就画、没有就空态"，
 * 任何一个源缺失不能让整个面板白屏。
 */
'use strict';

(function () {
  const TABS = [
    { id: 'msgs',    ic: '💬', label: '消息' },
    { id: 'balance', ic: '💰', label: '额度' },
    { id: 'todo',    ic: '✅', label: '待办' },
    { id: 'weather', ic: '🌤', label: '天气' },
    { id: 'mail',    ic: '✉️', label: '邮件' },
    { id: 'calendar',ic: '📅', label: '日历' },
    { id: 'music',   ic: '🎵', label: '音乐' },
    { id: 'clip',    ic: '📋', label: '剪贴板' },
    { id: 'settings',ic: '⚙', label: '设置' },
  ];

  const H = {
    tab: 'msgs',
    state: null,
    snaps: {},
    notes: [],
    clip: [],
    reminders: null,
    fresh: {},          // 有未读的页签
    tickTimer: null,
  };

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('on'), 1600);
  }
  function hhmm(ts) {
    const d = new Date(ts || Date.now());
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - (ts || 0)) / 1000));
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.round(s / 60) + ' 分钟前';
    if (s < 86400) return Math.round(s / 3600) + ' 小时前';
    return Math.round(s / 86400) + ' 天前';
  }
  function mmss(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  const snap = (k) => (H.snaps[k] && H.snaps[k].data) || null;
  const srcOf = (name) => ((H.state && H.state.sources) || []).find((s) => s.name === name) || {};

  /* ---------------- 骨架 ---------------- */
  function renderRail() {
    $('#rail').innerHTML = TABS.map((t) =>
      '<button data-tab="' + t.id + '" class="' + (H.tab === t.id ? 'on' : '') + (H.fresh[t.id] ? ' hasnew' : '') + '">' +
      '<span class="ic">' + t.ic + '</span><span>' + t.label + '</span><span class="dot"></span></button>').join('');
  }

  function renderHead() {
    const srcs = (H.state && H.state.sources) || [];
    const on = srcs.filter((s) => s.enabled && s.ready).length;
    const all = srcs.length;
    $('#sub').textContent = H.state ? (on + '/' + all + ' 个来源在跑 · 最近更新 ' + hhmm(Date.now())) : '正在读取…';
  }

  function render() {
    renderRail();
    renderHead();
    const body = $('#body');
    const fn = {
      msgs: panMsgs, balance: panBalance, todo: panTodo, weather: panWeather,
      mail: panMail, calendar: panCalendar, music: panMusic, clip: panClip, settings: panSettings,
    }[H.tab] || panMsgs;
    body.innerHTML = fn();
    body.scrollTop = H['_scroll_' + H.tab] || 0;
    after();
  }

  function after() {
    if (H.tab === 'music') {
      const sk = document.getElementById('seek');
      if (sk) sk.addEventListener('input', () => { document.getElementById('seekv').textContent = mmss(sk.value * 1000); });
    }
    if (H.tab === 'todo') {
      clearInterval(H.tickTimer);
      H.tickTimer = setInterval(() => {
        const el = document.getElementById('focusLeft');
        if (!el) { clearInterval(H.tickTimer); return; }
        const f = (H.reminders && (H.reminders.focus || H.reminders.focusState)) || null;
        if (f && (f.running || f.active) && f.endsAt) el.textContent = mmss(f.endsAt - Date.now());
      }, 1000);
    }
  }

  /* ---------------- 各页 ---------------- */
  function panMsgs() {
    const list = H.notes.slice().reverse().slice(0, 30);
    if (!list.length) {
      return '<div class="empty">还没有消息。<br>在「设置」里打开 QQ / 飞书 / 邮件等来源后，<br>新消息会以卡片形式弹在桌宠旁边。</div>';
    }
    return '<div class="sec"><h2>最近消息<span class="grow"></span><span class="muted">' + list.length + ' 条</span></h2><div class="card">' +
      list.map((n) => {
        const tag = n.kind === 'mail' ? '邮件' : (n.kind === 'reminder' ? '提醒' : (n.source === 'napcat' ? 'QQ' : (n.source === 'lark' ? '飞书' : (n.source === 'wechat' ? '微信' : n.source))));
        return '<div class="msg"><div class="h"><span class="tag' + (n.level === 'warn' || n.level === 'alert' ? ' w' : '') + '">' + esc(tag) + '</span>' +
          '<span class="ttl">' + esc(n.title || '') + '</span><span class="tm">' + hhmm(n.ts) + '</span></div>' +
          '<div class="bd">' + esc(n.body || '') + '</div>' +
          (n.actions && n.actions.length ? '<div class="btnrow" style="margin-top:6px">' + n.actions.map((a) =>
            '<button class="btn sm" data-act="noteAction" data-id="' + esc(n.id) + '" data-a="' + esc(a.id) + '">' + esc(a.label) + '</button>').join('') + '</div>' : '') +
          '</div>';
      }).join('') + '</div></div>';
  }

  function panBalance() {
    const d = snap('balance');
    const items = (d && Array.isArray(d.items)) ? d.items : [];
    const head = '<div class="sec"><h2>AI 额度<span class="grow"></span><button class="btn sm" data-act="refresh" data-name="balance">刷新</button></h2>';
    if (!items.length) {
      return head + '<div class="card"><div class="empty">还没有配置账户。<br>在「设置 → 额度」里填 DeepSeek / Pure Tokens 的 key，<br>或让程序从 Hermes 的 config.yaml 自动读。</div></div></div>';
    }
    return head + '<div class="card">' + items.map((it) => {
      const amount = it.ok === false ? (it.error || '读取失败') : ((it.amount == null ? '—' : it.amount) + ' ' + (it.currency || ''));
      return '<div class="row"><div class="t"><div class="n">' + esc(it.label || it.id || '') + '</div>' +
        '<div class="m">' + esc(it.detail || (it.type || '')) + (it.updatedAt ? ' · ' + ago(it.updatedAt) : '') + '</div></div>' +
        '<div class="v ' + (it.ok === false ? 'warn' : '') + '">' + esc(amount) + '</div></div>';
    }).join('') + '</div>' +
      (d && d.updatedAt ? '<div class="muted" style="font-size:10.5px;margin-top:6px">更新于 ' + ago(d.updatedAt) + '，每 10 分钟自动刷新</div>' : '') +
      '</div>';
  }

  function panTodo() {
    const r = H.reminders || {};
    const todos = Array.isArray(r.todos) ? r.todos : [];
    const focus = r.focus || r.focusState || null;
    const water = r.water || null;

    const todoHtml = '<div class="sec"><h2>待办<span class="grow"></span><span class="muted">' + todos.filter((t) => !t.done).length + ' 项未做</span></h2><div class="card">' +
      (todos.length ? todos.map((t) => '<div class="row"><input type="checkbox" data-act="todoToggle" data-id="' + esc(t.id) + '"' + (t.done ? ' checked' : '') + ' style="accent-color:#AC7D0C">' +
        '<div class="t"><div class="n" style="' + (t.done ? 'text-decoration:line-through;color:#9aa39c' : '') + '">' + esc(t.text || '') + '</div>' +
        '<div class="m">' + esc((t.repeat === 'daily' ? '每天 ' : t.repeat === 'weekly' ? '每周 ' : '') + (t.at || '') + (t.nextAt ? ' · 下次 ' + hhmm(t.nextAt) : '')) + '</div></div>' +
        '<button class="btn sm" data-act="todoRemove" data-id="' + esc(t.id) + '">删</button></div>').join('')
        : '<div class="empty" style="padding:8px 0">还没有待办</div>') +
      '<div class="field" style="margin:10px 0 0"><input type="text" id="todoText" placeholder="要记的事…" maxlength="60">' +
      '<input type="time" id="todoAt" value="09:00" style="width:96px;flex:none">' +
      '<select id="todoRep" style="width:78px;flex:none"><option value="none">单次</option><option value="daily">每天</option><option value="weekly">每周</option></select>' +
      '<button class="btn primary" data-act="todoAdd">加</button></div></div></div>';

    const focusHtml = '<div class="sec"><h2>专注<span class="grow"></span><span class="muted">' +
      (focus && (focus.running || focus.active) ? '进行中' : '未开始') + '</span></h2><div class="card">' +
      (focus && (focus.running || focus.active)
        ? '<div style="display:flex;align-items:baseline;gap:10px"><div id="focusLeft" style="font-size:26px;font-weight:600;font-variant-numeric:tabular-nums">' +
          mmss((focus.endsAt || 0) - Date.now()) + '</div><div class="muted">还剩 · 共 ' + esc(focus.minutes || 0) + ' 分钟</div></div>' +
          '<div class="btnrow"><button class="btn" data-act="focusStop">结束专注</button></div>'
        : '<div class="muted" style="font-size:12px;margin-bottom:8px">番茄钟：到点桌宠会过来提醒你休息。</div>' +
          '<div class="btnrow">' + [15, 25, 45, 60].map((m) => '<button class="btn" data-act="focusStart" data-min="' + m + '">' + m + ' 分钟</button>').join('') + '</div>') +
      '</div></div>';

    const total = water ? (water.totalMl != null ? water.totalMl : (Array.isArray(water.today) ? water.today.reduce((a, b) => a + (Number(b && b.ml || b) || 0), 0) : 0)) : 0;
    const goal = water ? (water.goalMl || 2000) : 2000;
    const pct = Math.min(100, Math.round(total / goal * 100));
    const waterHtml = '<div class="sec"><h2>喝水<span class="grow"></span><span class="muted">' + total + ' / ' + goal + ' ml</span></h2><div class="card">' +
      '<div style="height:8px;border-radius:99px;background:rgba(90,100,92,.14);overflow:hidden"><div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,#8fc3e8,#4f9fd6)"></div></div>' +
      '<div class="btnrow"><button class="btn primary" data-act="waterAdd" data-ml="' + (water && water.cupMl || 250) + '">喝一杯 ' + (water && water.cupMl || 250) + 'ml</button>' +
      '<button class="btn" data-act="waterUndo">撤销</button></div></div></div>';

    return todoHtml + focusHtml + waterHtml;
  }

  function panWeather() {
    const d = snap('weather');
    if (!d || d.ok === false) {
      return '<div class="sec"><h2>天气<span class="grow"></span><button class="btn sm" data-act="refresh" data-name="weather">刷新</button></h2><div class="card"><div class="empty">' +
        (d && d.error ? esc(d.error) : '还没取到天气。') + '<br>点刷新试试（用 Open-Meteo，免费无需 key）。</div></div></div>';
    }
    const t = (d.temp != null ? d.temp : d.temperature) != null ? (d.temp != null ? d.temp : d.temperature) : '—';
    const days = Array.isArray(d.days) ? d.days : (Array.isArray(d.daily) ? d.daily : []);
    return '<div class="sec"><h2>天气<span class="grow"></span><button class="btn sm" data-act="refresh" data-name="weather">刷新</button></h2><div class="card">' +
      '<div class="wnow"><div class="t">' + esc(t) + '°</div><div><div>' + esc(d.text || d.desc || '') + '</div>' +
      '<div class="muted" style="font-size:11px">' + esc(d.city || '') + (d.feels != null ? ' · 体感 ' + esc(d.feels) + '°' : '') + '</div></div></div>' +
      (d.humidity != null ? '<div class="muted" style="font-size:11px">湿度 ' + esc(d.humidity) + '%' + (d.wind != null ? ' · 风 ' + esc(d.wind) + ' km/h' : '') + '</div>' : '') +
      (days.length ? '<div class="wdays">' + days.slice(0, 7).map((x) => '<div class="wday"><span class="muted">' + esc(x.label || x.date || '') + '</span>' +
        '<b>' + esc((x.max != null ? x.max : x.tmax) != null ? (x.max != null ? x.max : x.tmax) : '') + '°</b>' +
        '<span class="muted">' + esc((x.min != null ? x.min : x.tmin) != null ? (x.min != null ? x.min : x.tmin) : '') + '°</span>' +
        '<div style="margin-top:3px">' + esc(x.text || '') + '</div></div>').join('') + '</div>' : '') +
      '<div class="field" style="margin-top:10px"><label>城市</label>' +
      '<input type="text" id="wCity" placeholder="留空则按网络定位（当前走代理会定到出口城市）" value="' + esc(((srcOf('weather').cfg) || {}).city || '') + '">' +
      '<button class="btn sm" data-act="saveWeatherCity">保存</button></div>' +
      '</div>' + (d.updatedAt ? '<div class="muted" style="font-size:10.5px;margin-top:6px">更新于 ' + ago(d.updatedAt) + '</div>' : '') + '</div>';
  }

  function panMail() {
    const d = snap('mail');
    const list = (d && Array.isArray(d.list)) ? d.list : [];
    const head = '<div class="sec"><h2>邮件<span class="grow"></span><button class="btn sm" data-act="refresh" data-name="mail">收取</button></h2>';
    if (!list.length) {
      return head + '<div class="card"><div class="empty">还没有邮件。<br>在「设置 → 邮件」里填 IMAP 服务器与授权码，<br>新邮件里的验证码会直接弹在桌宠旁边。</div></div></div>';
    }
    return head + '<div class="card">' + list.map((m) => '<div class="row"><div class="t"><div class="n">' + esc(m.subject || '（无主题）') + '</div>' +
      '<div class="m">' + esc(m.from || '') + ' · ' + ago(m.ts || m.date) + '</div></div>' +
      (m.code ? '<button class="btn sm primary" data-act="copy" data-text="' + esc(m.code) + '">复制 ' + esc(m.code) + '</button>' : '') +
      '</div>').join('') + '</div></div>';
  }

  function panCalendar() {
    const d = snap('calendar');
    const today = (d && Array.isArray(d.today)) ? d.today : [];
    const head = '<div class="sec"><h2>今天<span class="grow"></span><button class="btn sm" data-act="refresh" data-name="calendar">刷新</button></h2>';
    if (!today.length) {
      return head + '<div class="card"><div class="empty">' + (d && d.error ? esc(d.error) : '今天没有日程。') +
        '<br>数据来自飞书日历（走本机 lark-cli）。</div></div></div>';
    }
    return head + '<div class="card">' + today.map((e) => '<div class="row"><div class="v" style="width:52px;flex:none">' + esc(e.time || e.start || '') + '</div>' +
      '<div class="t"><div class="n">' + esc(e.title || e.summary || '') + '</div>' +
      (e.place ? '<div class="m">' + esc(e.place) + '</div>' : '') + '</div></div>').join('') + '</div></div>';
  }

  function panMusic() {
    const m = snap('music') || {};
    const playing = !!m.playing;
    const pos = Number(m.pos || 0), end = Number(m.end || 0);
    return '<div class="sec"><h2>音乐<span class="grow"></span><button class="btn sm" data-act="musicState">刷新</button></h2><div class="card">' +
      (m.hasSession
        ? '<div class="track">' + esc(m.title || '未知曲目') + '<div class="ar">' + esc(m.artist || m.app || '') + '</div></div>' +
          '<input type="range" class="seek" id="seek" min="0" max="' + Math.max(1, Math.round(end)) + '" value="' + Math.round(pos) + '">' +
          '<div style="display:flex;justify-content:space-between;font-size:10.5px;color:var(--muted);font-variant-numeric:tabular-nums">' +
          '<span id="seekv">' + mmss(pos * 1000) + '</span><span>' + mmss(end * 1000) + '</span></div>' +
          '<div class="ctrls"><button class="btn" data-act="music" data-v="prev">⏮</button>' +
          '<button class="btn primary" data-act="music" data-v="play_pause">' + (playing ? '⏸' : '▶') + '</button>' +
          '<button class="btn" data-act="music" data-v="next">⏭</button>' +
          '<button class="btn" data-act="music" data-v="stop">⏹</button></div>' +
          '<div class="btnrow" style="justify-content:center"><button class="btn sm" data-act="music" data-v="vol_down">音量 −</button>' +
          '<button class="btn sm" data-act="music" data-v="vol_up">音量 ＋</button></div>'
        : '<div class="empty">没有检测到正在播放的播放器。<br>先用网易云 / QQ 音乐 / 浏览器放一首，再点刷新。<br>' +
          '<span class="muted" style="font-size:11px">（靠 Windows 媒体会话读取，读不到不代表播放器坏了）</span></div>') +
      '</div></div>';
  }

  function panClip() {
    const list = H.clip.length ? H.clip : [];
    const head = '<div class="sec"><h2>剪贴板<span class="grow"></span><button class="btn sm" data-act="clipClear">清空未固定</button></h2>';
    if (!list.length) return head + '<div class="card"><div class="empty">还没有记录。复制一段文字后回来看看。</div></div></div>';
    return head + '<div class="card">' + list.map((c) => '<div class="clip' + (c.pinned ? ' pin' : '') + '" data-act="clipCopy" data-id="' + esc(c.id) + '">' +
      '<div class="x">' + esc(c.text.slice(0, 240)) + '</div>' +
      '<div class="f"><span class="tag">' + c.len + ' 字</span><span>' + ago(c.ts) + '</span><span class="grow" style="flex:1"></span>' +
      '<button class="btn sm" data-act="clipPin" data-id="' + esc(c.id) + '" data-on="' + (c.pinned ? '0' : '1') + '">' + (c.pinned ? '取消固定' : '固定') + '</button>' +
      '<button class="btn sm" data-act="clipRemove" data-id="' + esc(c.id) + '">删</button></div></div>').join('') + '</div></div>';
  }

  function panSettings() {
    const srcs = (H.state && H.state.sources) || [];
    const note = (H.state && H.state.note) || {};
    const rows = srcs.map((s) => '<div class="src"><div class="nm"><div class="l">' + esc(s.label) + '</div>' +
      '<div class="d">' + esc(s.ready ? (s.detail || '运行中') : (s.enabled ? (s.detail || '未就绪') : '已关闭')) + '</div></div>' +
      '<button class="btn sm" data-act="probe" data-name="' + esc(s.name) + '">试试</button>' +
      '<button class="sw ' + (s.enabled ? 'on' : '') + '" data-act="toggle" data-name="' + esc(s.name) + '" title="开关"></button></div>').join('');

    const mail = srcOf('mail');
    const mailCfg = mail.cfg || {};

    const mailForm = '<div class="sec"><h2>邮件 IMAP</h2><div class="card">' +
      '<div class="field"><label>服务器</label><input type="text" id="mHost" placeholder="imap.qq.com" value="' + esc(mailCfg.host || '') + '"></div>' +
      '<div class="field"><label>端口</label><input type="number" id="mPort" value="' + esc(mailCfg.port || 993) + '"></div>' +
      '<div class="field"><label>账号</label><input type="text" id="mUser" placeholder="you@qq.com" value="' + esc(mailCfg.user || '') + '"></div>' +
      '<div class="field"><label>授权码</label><input type="password" id="mPass" placeholder="' + (mailCfg.hasPass ? '已保存（留空不改）' : 'QQ 邮箱的 IMAP 授权码') + '"></div>' +
      '<div class="btnrow"><button class="btn primary" data-act="saveMail">保存并连接</button>' +
      '<span class="muted" style="font-size:10.5px;align-self:center">授权码只存在本机</span></div></div></div>';

    const bal = srcOf('balance');
    const balCfg = bal.cfg || {};
    const balForm = '<div class="sec"><h2>AI 额度账户</h2><div class="card">' +
      '<div class="field"><label>DeepSeek</label><input type="password" id="bDeep" placeholder="' + (balCfg.hasDeepseekKey || balCfg.hasDeepseekKeyEnc ? '已配置（留空不改）' : 'sk-...') + '"></div>' +
      '<div class="field"><label>PureTokens</label><input type="password" id="bPure" placeholder="' + (balCfg.hasPuretokensKey || balCfg.hasPuretokensKeyEnc ? '已配置（留空不改）' : 'sk-...') + '"></div>' +
      '<div class="btnrow"><button class="btn primary" data-act="saveBalance">保存</button>' +
      '<span class="muted" style="font-size:10.5px;align-self:center">也能从 Hermes 的 config.yaml 自动读</span></div></div></div>';

    return '<div class="sec"><h2>来源开关</h2><div class="card">' + (rows || '<div class="empty">没有可用的来源</div>') + '</div></div>' +
      '<div class="sec"><h2>弹窗</h2><div class="card"><div class="field"><label>停留</label>' +
      '<select id="noteDur" data-act="noteDur">' + [4, 6, 7, 10, 15].map((v) => '<option value="' + v + '"' + (Number(note.durationSec) === v ? ' selected' : '') + '>' + v + ' 秒</option>').join('') + '</select></div>' +
      '<div class="field"><label>正文</label><select id="noteBody"><option value="1"' + (note.previewBody !== false ? ' selected' : '') + '>显示</option><option value="0"' + (note.previewBody === false ? ' selected' : '') + '>只显示"有新消息"</option></select></div>' +
      '<div class="muted" style="font-size:10.5px">弹窗贴着桌宠出现，鼠标移上去才能点按钮，其余时候完全穿透。</div>' +
      '<div class="btnrow"><button class="btn" data-act="testNote">试一下弹窗</button>' +
      '<button class="btn" data-act="openMsgs">看最近消息</button></div></div></div>' +
      mailForm + balForm;
  }

  /* ---------------- 动作 ---------------- */
  async function act(a, el) {
    const name = el && el.dataset.name;
    const id = el && el.dataset.id;
    if (a === 'tab') return;
    if (a === 'toggle') {
      const on = !el.classList.contains('on');
      const r = await hub.do('setSource', { name, patch: { enabled: on } });
      if (r && r.state) H.state = r.state;
      render();
      return toast((on ? '已打开 ' : '已关闭 ') + name);
    }
    if (a === 'probe') {
      toast('正在试 ' + name + ' …');
      const r = await hub.do('tick', { name });
      H.state = await hub.state();
      render();
      return toast(r && r.ok ? '已触发，看看消息页' : ('失败：' + (r && r.error || '未知')));
    }
    if (a === 'refresh') {
      await hub.do('refresh', { name });
      H.snaps = await hub.snapshots();
      render();
      return toast('已刷新');
    }
    if (a === 'noteAction') {
      const r = await hub.noteAction(id, el.dataset.a);
      return toast(r && r.ok ? '已执行' : ('失败：' + (r && r.error || '')));
    }
    if (a === 'copy') {
      await navigator.clipboard.writeText(el.dataset.text || '');
      return toast('已复制');
    }
    if (a === 'todoAdd') {
      const text = ($('#todoText') || {}).value || '';
      if (!text.trim()) return toast('先写点什么');
      await hub.do('todoAdd', { text: text.trim(), at: ($('#todoAt') || {}).value || '09:00', repeat: ($('#todoRep') || {}).value || 'none' });
      H.reminders = (await hub.do('remindersState')).state || H.reminders;
      render();
      return toast('已加入');
    }
    if (a === 'todoRemove') { await hub.do('todoRemove', { id }); H.reminders = (await hub.do('remindersState')).state || H.reminders; render(); return; }
    if (a === 'todoToggle') { await hub.do('todoToggle', { id }); H.reminders = (await hub.do('remindersState')).state || H.reminders; render(); return; }
    if (a === 'focusStart') { await hub.do('focusStart', { minutes: Number(el.dataset.min) }); H.reminders = (await hub.do('remindersState')).state || H.reminders; render(); return toast('开始专注 ' + el.dataset.min + ' 分钟'); }
    if (a === 'focusStop') { await hub.do('focusStop'); H.reminders = (await hub.do('remindersState')).state || H.reminders; render(); return toast('已结束'); }
    if (a === 'waterAdd') { await hub.do('waterAdd', { ml: Number(el.dataset.ml) }); H.reminders = (await hub.do('remindersState')).state || H.reminders; render(); return; }
    if (a === 'waterUndo') { await hub.do('waterUndo'); H.reminders = (await hub.do('remindersState')).state || H.reminders; render(); return; }
    if (a === 'music') {
      const v = el.dataset.v;
      const r = await hub.do('musicControl', { verb: v });
      H.snaps = await hub.snapshots();
      render();
      if (!(r && r.ok)) toast('控制失败：' + (r && (r.result && r.result.detail) || r.error || ''));
      return;
    }
    if (a === 'musicState') { H.snaps = await hub.snapshots(); render(); return toast('已刷新'); }
    if (a === 'seek') return;
    if (a === 'clipCopy') {
      const r = await hub.do('clipCopy', { id });
      if (r && r.list) H.clip = r.list;
      return toast(r && r.ok ? '已复制回剪贴板' : '复制失败');
    }
    if (a === 'clipPin') { const r = await hub.do('clipPin', { id, on: el.dataset.on === '1' }); H.clip = r.list || H.clip; return render(); }
    if (a === 'clipRemove') { const r = await hub.do('clipRemove', { id }); H.clip = r.list || H.clip; return render(); }
    if (a === 'clipClear') { const r = await hub.do('clipClear'); H.clip = r.list || []; return render(); }
    if (a === 'testNote') { await hub.do('testNote'); return toast('弹窗已发出（看桌宠旁边）'); }
    if (a === 'openMsgs') { H.tab = 'msgs'; H.fresh.msgs = false; return render(); }
    if (a === 'saveWeatherCity') {
      const city = (($('#wCity') || {}).value || '').trim();
      const r = await hub.do('setSource', { name: 'weather', patch: { city } });
      H.state = (r && r.state) || await hub.state();
      await hub.do('refresh', { name: 'weather' });
      H.snaps = await hub.snapshots();
      render();
      return toast(city ? ('天气城市已设为 ' + city) : '已改为按网络定位');
    }
    if (a === 'saveMail') {
      const host = ($('#mHost') || {}).value || '';
      const port = Number(($('#mPort') || {}).value || 993);
      const user = ($('#mUser') || {}).value || '';
      const pass = ($('#mPass') || {}).value || '';
      if (!host || !user) return toast('服务器和账号必填');
      const r = await hub.do('setSource', { name: 'mail', patch: { enabled: true, host, port, user, ...(pass ? { pass } : {}) } });
      H.state = (r && r.state) || await hub.state();
      render();
      return toast('已保存，正在连接…');
    }
    if (a === 'saveBalance') {
      const deep = ($('#bDeep') || {}).value || '';
      const pure = ($('#bPure') || {}).value || '';
      const patch = { enabled: true };
      if (deep) patch.deepseekKey = deep;
      if (pure) patch.puretokensKey = pure;
      const r = await hub.do('setSource', { name: 'balance', patch });
      H.state = (r && r.state) || await hub.state();
      render();
      return toast('已保存');
    }
  }

  /* ---------------- 装载 ---------------- */
  async function boot() {
    try {
      H.state = await hub.state();
      H.notes = (H.state && H.state.notes) || [];
    } catch (e) { H.state = null; }
    try { H.snaps = await hub.snapshots(); } catch (e) {}
    try { const r = await hub.do('clipList'); H.clip = r.list || []; } catch (e) {}
    try { const r = await hub.do('remindersState'); H.reminders = r.state || null; } catch (e) {}
    const q = new URLSearchParams(location.search);
    if (q.get('tab')) H.tab = q.get('tab');
    render();

    hub.onNote((n) => {
      H.notes.push(n);
      if (H.tab !== 'msgs') H.fresh.msgs = true;
      if (H.tab === 'msgs') render();
    });
    hub.onSnapshot((s) => {
      H.snaps[s.kind] = { data: s.data, ts: s.ts };
      const map = { balance: 'balance', weather: 'weather', mail: 'mail', calendar: 'calendar', music: 'music', reminders: 'todo' };
      const t = map[s.kind];
      if (t && t === H.tab) render();
      if (s.kind === 'reminders') H.reminders = s.data;
    });
    hub.onTab((t) => { H.tab = t; H.fresh[t] = false; render(); });

    setInterval(async () => {
      try { H.state = await hub.state(); } catch (e) {}
      if (H.tab === 'clip') { try { const r = await hub.do('clipList'); H.clip = r.list || H.clip; } catch (e) {} }
      render();
    }, 15000);
  }

  /* 事件委托 */
  document.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) { H.tab = tabBtn.dataset.tab; H.fresh[H.tab] = false; return render(); }
    if (e.target.id === 'close') return hub.close();
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const a = el.dataset.act;
    if (a === 'noteDur') {
      const v = Number(el.value) || 7;
      hub.do('setNote', { durationSec: v });
      return toast('弹窗停留 ' + v + ' 秒');
    }
    if (el.tagName === 'SELECT' || el.tagName === 'INPUT' && el.type !== 'checkbox' && !el.dataset.act) return;
    act(a, el).catch((err) => toast('出错：' + err.message));
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'noteBody') {
      hub.do('setNote', { previewBody: e.target.value === '1' });
      toast(e.target.value === '1' ? '弹窗显示正文' : '弹窗只显示提示');
    }
    if (e.target.id === 'noteDur') hub.do('setNote', { durationSec: Number(e.target.value) || 7 });
    const cb = e.target.closest('[data-act="todoToggle"]');
    if (cb) act('todoToggle', cb).catch(() => {});
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hub.close();
    if (e.key === 'Enter' && e.target.id === 'todoText') {
      const b = document.querySelector('[data-act="todoAdd"]');
      if (b) act('todoAdd', b);
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'seek') {
      const v = document.getElementById('seekv');
      if (v) v.textContent = mmss(Number(e.target.value) * 1000);
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'seek') {
      hub.do('musicControl', { verb: 'seek', seconds: Number(e.target.value) }).then(() => toast('已跳转'));
    }
  });

  boot();
})();
