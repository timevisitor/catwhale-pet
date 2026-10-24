// 猫鲸皮肤编辑器 —— 渲染进程
'use strict';

/* ===================== 元数据：触发逻辑 ===================== */
// 核心 id：桌宠主程序按 id 直接引用（resolveState / 菜单项 / 松手），只能用「替换视频」的方式改，不能改名。
const CORE = {
  idle:        { role: 'idle',     note: '默认待机态：没做任何事时一直演它。' },
  grabbed:     { role: 'drag',     note: '按住角色拖动时演它（松手回待机）。' },
  stand_arms:  { role: 'menu',     note: '打开 SAO 菜单 / 搜索 / 聊天 / 设置时演它。' },
  working:     { role: 'task',     note: 'DeepSeek 处理长任务时演它，空闲时也可能被抽到。' },
  drop:        { role: 'release',  note: '松手后播一次（主程序按 id 调用），播完回待机。' },
  tail_open:   { role: 'lounge',   note: 'SAO 菜单「打个招呼 / 再摇一次尾」按 id 调用；同时也进空闲循环池。' },
  tail_closed: { role: 'lounge',   note: 'SAO 菜单「摇摇尾巴」按 id 调用；同时也进空闲循环池。' },
  eat:         { role: 'idle_act', note: 'SAO 菜单「吃点米饭」按 id 调用；同时也进空闲小动作池。' },
};

// 可选触发逻辑（自定义动作可选的）
const ROLES = [
  { key: 'lounge',   label: '空闲随机 · 循环',      hint: '闲置 12 秒后，每隔 7~14 秒在各「空闲循环」动作里按权重挑一个循环播放。适合坐姿、摇尾、打盹这类常态动作。' },
  { key: 'idle_act', label: '空闲小动作 · 播一次',   hint: '空闲时按 35% 概率触发，播完自动回待机。适合吃饭、跳一下这种短表演。' },
  { key: 'interact', label: '点击互动 · 播一次',     hint: '单击桌宠时按权重随机播一次。只在这里出现的动作不会混进空闲循环。' },
  { key: 'task',     label: '干活中（长任务）',      hint: 'DeepSeek 处理长任务时演它；空闲时也会以 0.6 倍权重被抽到。' },
  { key: 'idle',     label: '待机（默认）',         hint: '没做任何事时的默认动作。全局只能有一个，替换内置待机。' },
  { key: 'menu',     label: '打开菜单时',           hint: '打开菜单/面板时。由内置「站立抬胳膊」承担，只能替换视频。' },
  { key: 'drag',     label: '拖动中',               hint: '按住拖动时。由内置「抓着」承担，只能替换视频。' },
  { key: 'release',  label: '松手落下 · 播一次',     hint: '主程序按 id=drop 调用，只能替换视频。' },
];
const ROLE_LABEL = {};
for (const r of ROLES) ROLE_LABEL[r.key] = r.label;
const ROLE_HINT = {};
for (const r of ROLES) ROLE_HINT[r.key] = r.hint;

/* ===================== 全局状态 ===================== */
const BOX_ASPECT = 0.6;      // 桌宠画布宽/高（与主程序 CANVAS_ASPECT 一致）
const FOOT_Y = 96.67;        // 脚底基线（主程序 transform-origin 50% 96.67%）
const BBOX = new Map();      // absFile -> {ok,top,bottom,vw,vh} | null（测量中）

const S = {
  info: null,          // app:state
  builtin: null,       // 内置动作
  slug: null,          // 当前编辑的皮肤
  name: '',
  actions: {},         // id -> action
  sel: null,
  dirty: false,
  size: 340,
  zoom: 150,
  playing: true,
  probes: {},          // absFile -> probe
};

const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const r3 = (v) => Math.round(v * 1000) / 1000;

function fileUrl(p) {
  let s = String(p).replace(/\\/g, '/');
  if (s.startsWith('//')) s = s.slice(1);          // UNC 不建议，但别拼坏
  return 'file:///' + encodeURI(s.replace(/^\/+/, '')).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

/* ===================== 日志 / 脏标记 ===================== */
function log(msg, cls) {
  const e = $('#log');
  e.textContent = msg;
  e.className = 'lg' + (cls ? ' ' + cls : '');
}
function markDirty(on) {
  S.dirty = !!on;
  $('#dirty').style.display = on ? '' : 'none';
}
function status() {
  const a = S.actions[S.sel];
  const cnt = Object.keys(S.actions).length;
  $('#stat').textContent = S.slug ? `${S.slug} · ${cnt} 个动作` + (a ? ` · 当前 ${a.name}` : '') : '';
}

/* ===================== 皮肤读取/保存 ===================== */
async function reloadSkins(selectSlug) {
  const r = await api.listSkins();
  const sel = $('#skinSel');
  sel.innerHTML = '';
  const opt0 = el('option', null, '— 内置皮肤（只读）—');
  opt0.value = '__builtin__';
  sel.appendChild(opt0);
  for (const s of (r.skins || [])) {
    const o = el('option', null, s.name + (s.slug === r.active ? '（生效中）' : ''));
    o.value = s.slug;
    sel.appendChild(o);
  }
  const want = selectSlug || S.slug || r.active || '__builtin__';
  sel.value = [...sel.options].some((o) => o.value === want) ? want : '__builtin__';
  return r;
}

async function openSkin(slug) {
  if (S.dirty && !(await ask('放弃未保存的修改？', '当前皮肤有未保存的改动，切换后这些改动会丢失。', '放弃并切换'))) return false;
  if (slug === '__builtin__') {
    const b = await api.readBuiltin();
    if (!b.ok) { log('读内置素材失败：' + b.error, 'err'); return false; }
    S.builtin = b;
    S.slug = '__builtin__'; S.name = '内置皮肤'; S.actions = b.actions; S.sel = Object.keys(b.actions)[0] || null;
    BBOX.clear();
    markDirty(false);
    renderList(); renderProps(); applyPreview(); status();
    log('内置皮肤是只读基线：想改就先「复制」或「新建」，或直接「从内置添加」到自己的皮肤。', '');
    return true;
  }
  const r = await api.readSkin(slug);
  if (!r.ok) { log('读取皮肤失败：' + r.error, 'err'); return false; }
  S.slug = slug; S.name = r.name; S.actions = r.actions; S.sel = Object.keys(r.actions)[0] || null;
  S.probes = {};
  BBOX.clear();                 // 换皮肤后视频文件变了，身高测量要重来
  markDirty(false);
  renderList(); renderProps(); applyPreview(); status();
  log(`已打开皮肤「${r.name}」：${Object.keys(r.actions).length} 个动作`);
  return true;
}

async function saveSkin(quiet) {
  if (!S.slug || S.slug === '__builtin__') { log('内置皮肤只读，先「复制」或「新建」一个自己的皮肤。', 'err'); return false; }
  // 核心 id 缺失提醒（不阻止，主程序会退回内置素材）
  const miss = ['idle', 'grabbed', 'stand_arms', 'working'].filter((id) => !S.actions[id]);
  const r = await api.saveSkin(S.slug, { name: S.name, actions: S.actions });
  if (!r.ok) { log('保存失败：' + r.error, 'err'); return false; }
  markDirty(false);
  status();
  if (!quiet) log(`已保存 ${r.count} 个动作 → ${r.path}（${(r.bytes / 1024).toFixed(1)} KB）`, 'ok');
  if (miss.length) log(`注意：缺少核心动作 ${miss.join('/')}，桌宠对应时刻会退回内置素材`, '');
  return true;
}

/* ===================== 动作列表 ===================== */
const ROLE_SHORT = { idle: '待机', menu: '菜单', drag: '拖动中', release: '松手落下', task: '干活中',
  lounge: '空闲随机', idle_act: '空闲小动作', interact: '点击互动' };
function roleTag(a) { return ROLE_SHORT[a.role] || a.role || '未设'; }
function sortIds(ids) {
  const coreOrder = Object.keys(CORE);
  const core = coreOrder.filter((id) => ids.includes(id));
  const rest = ids.filter((id) => !core.includes(id));
  return core.concat(rest);
}
function renderList() {
  const ul = $('#actionList');
  ul.innerHTML = '';
  const ids = sortIds(Object.keys(S.actions));
  for (const id of ids) {
    const a = S.actions[id];
    const li = el('li');
    if (id === S.sel) li.classList.add('on');
    const nm = el('span', 'nm', a.name || id);
    const dot = el('span', 'dot' + (a.exists === false ? ' off' : ''));
    const bits = [roleTag(a), a.mode === 'once' ? '播一次' : '循环'];
    if (a.rate && a.rate !== 1) bits.push(a.rate + '×速');
    if (a.scale && a.scale !== 1) bits.push(a.scale + '×大小');
    if (a.exists === false) bits.push('⚠ 缺视频');
    const meta = el('span', 'meta', bits.join(' · '));
    li.append(nm, dot, meta);
    li.onclick = () => { S.sel = id; renderList(); renderProps(); applyPreview(); status(); };
    ul.appendChild(li);
  }
  if (!ids.length) ul.appendChild(el('li', 'meta', '（还没有动作，点上方「＋ 导入动作」）'));
}

/* ===================== 属性面板 ===================== */
function renderProps() {
  const box = $('#props');
  const a = S.actions[S.sel];
  if (!a) {
    box.innerHTML = '<div class="empty">还没有选中动作。<br>点左侧的「＋ 导入动作」把自己做的视频加进来，<br>或「从内置添加」复制现有动作再调整。</div>';
    $('#selTitle').textContent = '未选择动作';
    $('#selHint').textContent = '左侧选一个动作，右边调它的触发逻辑与大小';
    return;
  }
  const id = S.sel;
  const isCore = !!CORE[id];
  const fixedRole = isCore ? CORE[id].role : null;

  box.innerHTML = '';

  /* --- 基本 --- */
  const g1 = el('div', 'pgroup');
  g1.appendChild(el('h3', null, '基本'));
  g1.appendChild(field('名称', inputText('fName', a.name || id, (v) => { S.actions[id].name = v; markDirty(true); renderList(); status(); })));
  const roleSel = el('select');
  roleSel.id = 'fRole';
  const roles = isCore ? ROLES.filter((r) => r.key === fixedRole) : ROLES.filter((r) => ['lounge', 'idle_act', 'interact', 'task'].includes(r.key));
  for (const r of roles) {
    const o = el('option', null, r.label); o.value = r.key;
    if (a.role === r.key) o.selected = true;
    roleSel.appendChild(o);
  }
  // 兼容旧数据里自定义动作带 menu/drag/release 之类的情况
  if (!roles.some((r) => r.key === a.role)) {
    const o = el('option', null, ROLE_LABEL[a.role] || a.role); o.value = a.role; o.selected = true; roleSel.appendChild(o);
  }
  roleSel.disabled = isCore;
  roleSel.onchange = () => onRoleChange(id, roleSel.value);
  g1.appendChild(field('触发', roleSel));
  const note = el('div', 'hintbox');
  note.id = 'fRoleNote';
  note.textContent = isCore ? CORE[id].note : (ROLE_HINT[a.role] || '');
  g1.appendChild(note);

  const modeSel = el('select');
  modeSel.id = 'fMode';
  for (const [v, t] of [['loop', '循环播放'], ['once', '播一次就停']]) {
    const o = el('option', null, t); o.value = v; if ((a.mode || 'loop') === v) o.selected = true; modeSel.appendChild(o);
  }
  modeSel.onchange = () => { S.actions[id].mode = modeSel.value; markDirty(true); renderList(); applyPreview(); };
  g1.appendChild(field('播放', modeSel));

  g1.appendChild(field('速率', numPair('fRate', a.rate ?? 1, 0.25, 3, 0.05,
    (v) => { S.actions[id].rate = v; markDirty(true); applyPreview(); renderList(); })));

  if (a.role === 'lounge' || a.role === 'task' || a.role === 'idle_act') {
    g1.appendChild(field('空闲权重', numPair('fWeight', a.weight ?? (a.role === 'task' ? 25 : 20), 0, 100, 1,
      (v) => { S.actions[id].weight = v; markDirty(true); })));
  }
  if (a.role === 'interact' || a.role === 'lounge' || a.role === 'idle_act') {
    g1.appendChild(field('点击权重', numPair('fReact', a.react ?? 0, 0, 100, 1,
      (v) => { S.actions[id].react = v; markDirty(true); })));
    if (a.role === 'idle_act') {
      const h = el('div', 'hintbox', '点击权重 > 0 时，这个动作也会进入「单击互动」的随机池。');
      g1.appendChild(h);
    }
  }
  box.appendChild(g1);

  /* --- 大小与位置 --- */
  const g2 = el('div', 'pgroup');
  g2.appendChild(el('h3', null, '大小与位置'));
  g2.appendChild(field('整体缩放', numPair('fScale', a.scale ?? 1, 0.2, 2.5, 0.01, (v) => { S.actions[id].scale = v; markDirty(true); applyPreview(); renderList(); })));
  g2.appendChild(field('宽比例', numPair('fScaleX', a.scaleX ?? 1, 0.4, 2, 0.01, (v) => { S.actions[id].scaleX = v; markDirty(true); applyPreview(); }, 'fLock')));
  g2.appendChild(field('高比例', numPair('fScaleY', a.scaleY ?? 1, 0.4, 2, 0.01, (v) => { S.actions[id].scaleY = v; markDirty(true); applyPreview(); }, 'fLock')));
  const lockRow = el('label', 'hintbox');
  const lock = el('input'); lock.type = 'checkbox'; lock.id = 'fLock'; lock.style.width = 'auto'; lock.style.marginRight = '6px';
  lockRow.appendChild(lock);
  lockRow.appendChild(document.createTextNode('锁定比例（改宽同时改高）'));
  g2.appendChild(lockRow);
  g2.appendChild(field('水平位移', numPair('fOffX', a.offX ?? 0, -50, 50, 1, (v) => { S.actions[id].offX = v; markDirty(true); applyPreview(); })));
  g2.appendChild(field('垂直位移', numPair('fOffY', a.offY ?? 0, -50, 50, 1, (v) => { S.actions[id].offY = v; markDirty(true); applyPreview(); })));
  const btns = el('div', 'btnrow');
  const bReset = el('button', 'ghost', '还原 1:1');
  bReset.onclick = () => {
    Object.assign(S.actions[id], { scale: 1, scaleX: 1, scaleY: 1, offX: 0, offY: 0 });
    markDirty(true); renderProps(); applyPreview(); renderList();
  };
  const bCopy = el('button', 'ghost', '套用到全部');
  bCopy.onclick = async () => {
    const { scale, scaleX, scaleY, offX, offY } = S.actions[id];
    for (const k in S.actions) if (k !== id) Object.assign(S.actions[k], { scale, scaleX, scaleY, offX, offY });
    markDirty(true);
    log('已把当前动作的大小/位移套用到全部动作', 'ok');
  };
  btns.append(bReset, bCopy);
  g2.appendChild(btns);
  g2.appendChild(el('div', 'hintbox', '缩放以脚底基线（画布 96.67% 高）为基准，放大不会离地；位移是相对画布宽高的百分比。'));
  box.appendChild(g2);

  /* --- 视频 --- */
  const g3 = el('div', 'pgroup');
  g3.appendChild(el('h3', null, '视频'));
  const kv = el('div', 'kv');
  const pr = S.probes[a.absFile] || null;
  const rows = [
    ['文件', a.file || '—'],
    ['尺寸', pr ? pr.width + ' × ' + pr.height : (a.width ? a.width + ' × ' + a.height : '—')],
    ['时长', (a.duration ? a.duration + ' s' : (pr ? pr.duration.toFixed(2) + ' s' : '—'))],
    ['透明通道', pr ? (pr.hasAlpha ? '有（' + (pr.alphaMode ? 'alpha_mode=' + pr.alphaMode : pr.pixFmt) + '）' : '无（' + pr.pixFmt + '）') : '—'],
    ['文件大小', pr && pr.bytes ? (pr.bytes / 1048576).toFixed(2) + ' MB' : '—'],
  ];
  const bboxVal = BBOX.get(a.absFile);
  for (const [k, v] of rows) { kv.appendChild(el('b', null, k)); kv.appendChild(el('span', null, v)); }
  kv.appendChild(el('b', null, '内容高度'));
  const kvContent = el('span', null, contentText(bboxVal, a));
  kvContent.id = 'kvContent';
  kv.appendChild(kvContent);
  if (a.exists === false) { kv.appendChild(el('b', null, '状态')); kv.appendChild(el('span', null, '⚠ 文件缺失')); }
  g3.appendChild(kv);
  const b1 = el('div', 'btnrow');
  const bRep = el('button', 'ghost', '替换视频');
  bRep.onclick = () => replaceVideo(id);
  const bRev = el('button', 'ghost', '定位文件');
  bRev.onclick = () => api.revealPath(a.absFile);
  b1.append(bRep, bRev);
  g3.appendChild(b1);
  const b2 = el('div', 'btnrow');
  const bDel = el('button', 'danger', '删除这个动作');
  bDel.onclick = async () => {
    if (isCore) { log('核心动作不能删除，只能替换视频。', 'err'); return; }
    if (!(await ask('删除动作', `确定从皮肤里移除「${a.name || id}」？（不会删除视频文件）`, '删除'))) return;
    delete S.actions[id];
    S.sel = Object.keys(S.actions)[0] || null;
    markDirty(true); renderList(); renderProps(); applyPreview(); status();
  };
  b2.appendChild(bDel);
  g3.appendChild(b2);
  box.appendChild(g3);

  $('#selTitle').textContent = `${a.name || id}${isCore ? '（核心动作）' : ''}`;
  $('#selHint').textContent = '青=脚底基线 · 橙=标准身高（待机） · 紫=当前头顶' + (isCore ? ' · 核心动作不能改名/删' : '');

  // 主动测一次内容包围盒（身高参考线用）
  if (a.absFile && a.exists !== false) ensureBbox(a);
  // 读一次视频信息（异步，回填）
  if (a.absFile && a.exists !== false && !S.probes[a.absFile]) {
    api.probe(a.absFile).then((p) => { if (p.ok) { S.probes[a.absFile] = p; if (S.sel === id) renderProps(); } });
  }
  bindLock();
}

function field(label, ctrl) {
  const d = el('div', 'field');
  d.appendChild(el('label', null, label));
  d.appendChild(ctrl);
  return d;
}
function inputText(id, val, oninput) {
  const i = el('input'); i.type = 'text'; i.id = id; i.value = val ?? '';
  i.oninput = () => oninput(i.value);
  return i;
}
/** 滑块 + 数字框联动 */
function numPair(id, val, min, max, step, onchange, lockId) {
  const row = el('div', 'row');
  const r = el('input'); r.type = 'range'; r.id = id; r.min = min; r.max = max; r.step = step; r.value = val;
  const n = el('input'); n.type = 'number'; n.id = id + 'N'; n.min = min; n.max = max; n.step = step; n.value = val;
  const push = (v, from) => {
    const x = Math.min(max, Math.max(min, num(v, val)));
    const vv = Math.round(x / step) * step;
    r.value = r3(vv); n.value = r3(vv);
    if (lockId && document.getElementById(lockId) && document.getElementById(lockId).checked) {
      const other = r.id === 'fScaleX' ? 'fScaleY' : r.id === 'fScaleY' ? 'fScaleX' : null;
      if (other) { const o = document.getElementById(other); if (o) { o.value = r3(vv); const on = document.getElementById(other + 'N'); if (on) on.value = r3(vv); onchange(vv, other); } }
    }
    onchange(vv, from);
  };
  r.oninput = () => push(r.value, 'range');
  n.oninput = () => push(n.value, 'number');
  row.append(r, n);
  return row;
}
function bindLock() {
  const l = document.getElementById('fLock');
  if (l && S.sel && S.actions[S.sel]) {
    const a = S.actions[S.sel];
    if (Math.abs((a.scaleX ?? 1) - (a.scaleY ?? 1)) > 1e-6) l.checked = false;
  }
}

function onRoleChange(id, role) {
  const a = S.actions[id];
  // 独占角色（idle/menu/drag/release）：同一皮肤里只能有一个动作占这个角色
  if (['idle', 'menu', 'drag', 'release'].includes(role)) {
    for (const k in S.actions) if (k !== id && S.actions[k].role === role) {
      log(`触发位「${ROLE_LABEL[role]}」已被「${S.actions[k].name || k}」占用，先把它改成别的触发逻辑。`, 'err');
      renderProps(); return;
    }
  }
  a.role = role;
  if (role === 'interact' && !(a.react > 0)) a.react = 30;
  if ((role === 'idle_act') && a.mode !== 'once') a.mode = 'once';
  if (role === 'interact' && a.mode !== 'once') a.mode = 'once';
  if (role === 'lounge' && !a.mode) a.mode = 'loop';
  markDirty(true); renderList(); renderProps();
}

/* ===================== 预览 ===================== */
function applyPreview() {
  const box = $('#petBox');
  const v = $('#pv');
  const a = S.actions[S.sel];
  const h = S.size, w = Math.round(h * 0.6);
  const z = S.zoom / 100;
  box.style.width = Math.round(w * z) + 'px';
  box.style.height = Math.round(h * z) + 'px';
  if (!a) { v.removeAttribute('src'); v.dataset.src = ''; return; }
  if (a.exists === false) { v.removeAttribute('src'); v.dataset.src = ''; return; }
  if (v.dataset.src !== a.absFile) {
    v.dataset.src = a.absFile;
    v.src = fileUrl(a.absFile);
    try { v.load(); } catch (e) {}          // 换源后显式 load：file:// 下只改 src 偶发不取帧
    if (S.playing) v.play().catch(() => {});
  }
  v.loop = (a.mode || 'loop') !== 'once';
  v.playbackRate = num(a.rate, 1);
  const s = num(a.scale, 1), sx = s * num(a.scaleX, 1), sy = s * num(a.scaleY, 1);
  v.style.transform = `translate(${num(a.offX, 0)}%,${num(a.offY, 0)}%) scaleX(${sx}) scaleY(${sy})`;
  box.classList.toggle('guide', $('#chkGuide').checked);
  updateGuides();
}

/* ===================== 参考线（身高） =====================
   三条线：
     青 = 脚底基线（固定 96.67%，主程序缩放原点）
     橙 = 标准身高：当前皮肤「待机」动作的头顶位置（没待机就退内置待机）
     紫 = 当前动作头顶：跟着它自己的缩放/比例/位移实时走
   百分比都换算成画布百分比；视频宽高比与画布(0.6)不同时按 object-fit:contain 的留边先归一。 */
function fitHeight(vw, vh) {           // 视频在画布里的实际显示高度占画布高度的比例
  if (!vw || !vh) return 1;
  const r = vw / vh;
  return r >= BOX_ASPECT ? BOX_ASPECT / r : 1;
}
function screenTopPct(videoTop, a, vw, vh) {
  const fh = fitHeight(vw, vh);
  const ybox = (1 - fh) / 2 + videoTop * fh;         // 0~1 画布坐标
  const sy = (a.scale != null ? a.scale : 1) * (a.scaleY != null ? a.scaleY : 1);
  const oy = a.offY || 0;
  return FOOT_Y + (ybox * 100 - FOOT_Y) * sy + oy;
}
async function ensureBbox(a) {
  if (!a || !a.absFile || a.exists === false) return null;
  if (BBOX.has(a.absFile)) {
    const v = BBOX.get(a.absFile);
    if (v) return v;
    if (v === null) return null;                     // 正在测
  }
  BBOX.set(a.absFile, null);
  const r = await api.bbox(a.absFile);
  const v = (r && r.ok) ? r : null;
  BBOX.set(a.absFile, v);
  updateGuides();
  const kv = document.getElementById('kvContent');
  if (kv && S.actions[S.sel] && S.actions[S.sel].absFile === a.absFile) kv.textContent = contentText(v, S.actions[S.sel]);
  return v;
}
function contentText(v, a) {
  if (!v) return '测量中…';
  const top = screenTopPct(v.top, a, v.vw, v.vh);
  const foot = screenTopPct(v.bottom, a, v.vw, v.vh);
  return `头顶 ${top.toFixed(1)}% / 脚底 ${foot.toFixed(1)}%（占画布高 ${(foot - top).toFixed(1)}%）`;
}
function updateGuides() {
  const stdEl = document.getElementById('refStd');
  const curEl = document.getElementById('refCur');
  if (!stdEl || !curEl) return;
  // 标准线：当前皮肤的待机动作（没测完时用经验值 20.6% = 内置待机实测头顶）
  const idle = S.actions.idle;
  const stdBox = idle ? BBOX.get(idle.absFile) : null;
  const stdTop = stdBox ? screenTopPct(stdBox.top, idle, stdBox.vw, stdBox.vh) : (idle ? null : 20.6);
  if (stdTop == null) {
    stdEl.style.display = 'none';
    if (idle) ensureBbox(idle);
  } else {
    stdEl.style.display = '';
    stdEl.style.top = stdTop.toFixed(2) + '%';
    stdEl.querySelector('.lbl').textContent = '标准身高 ' + stdTop.toFixed(1) + '%';
  }
  // 当前动作线
  const a = S.actions[S.sel];
  const b = a ? BBOX.get(a.absFile) : null;
  if (!a || !b) {
    curEl.style.display = 'none';
    if (a && a.absFile && a.exists !== false && !BBOX.has(a.absFile)) ensureBbox(a);
  } else {
    const top = screenTopPct(b.top, a, b.vw, b.vh);
    curEl.style.display = '';
    curEl.style.top = top.toFixed(2) + '%';
    let txt = '头顶 ' + top.toFixed(1) + '%';
    if (stdTop != null) {
      const d = stdTop - top;                        // >0 = 比标准矮
      txt += Math.abs(d) < 0.6 ? '（≈标准）' : (d > 0 ? `（比标准矮 ${d.toFixed(1)}）` : `（比标准高 ${(-d).toFixed(1)}）`);
    }
    curEl.querySelector('.lbl').textContent = txt;
  }
}

/* ===================== 新建 / 复制 / 删除皮肤 ===================== */
function openModal(id) { $('#' + id).classList.add('show'); }
function closeModal(id) { $('#' + id).classList.remove('show'); }
document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => closeModal(b.dataset.close); });

let askResolve = null;
function ask(title, text, okLabel) {
  $('#askTitle').textContent = title;
  $('#askText').textContent = text;
  $('#askOk').textContent = okLabel || '确定';
  openModal('mAsk');
  return new Promise((res) => { askResolve = res; });
}
$('#askOk').onclick = () => { closeModal('mAsk'); if (askResolve) { askResolve(true); askResolve = null; } };
document.querySelector('[data-close="mAsk"]').addEventListener('click', () => { if (askResolve) { askResolve(false); askResolve = null; } });

$('#btnNew').onclick = () => {
  $('#newName').value = '';
  $('#newSlug').value = '';
  $('#newBase').value = 'full';
  openModal('mNew');
};
$('#newName').oninput = () => {
  if ($('#newSlug').value) return;
  $('#newSlug').value = slugify($('#newName').value);
};
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || ('skin-' + Date.now().toString(36));
}
$('#newOk').onclick = async () => {
  const name = $('#newName').value.trim() || '我的猫鲸';
  const slug = ($('#newSlug').value.trim() || slugify(name));
  if (!/^[A-Za-z0-9_.-]{1,48}$/.test(slug)) { log('皮肤 ID 只能用字母/数字/下划线/短横线', 'err'); return; }
  if ((await api.listSkins()).skins.some((s) => s.slug === slug)) { log('这个皮肤 ID 已存在', 'err'); return; }
  closeModal('mNew');
  log('正在创建皮肤…');
  // 建目录 + 空 skin.json（保证目录先存在）
  const empty = await api.saveSkin(slug, { name, actions: {} });
  if (!empty.ok) { log('创建失败：' + empty.error, 'err'); return; }
  const mode = $('#newBase').value;
  const base = (await api.readBuiltin()).actions || {};
  let want = [];
  if (mode === 'full') want = Object.keys(base).filter((id) => base[id].exists);
  if (mode === 'core') want = ['idle', 'grabbed', 'stand_arms', 'working'].filter((id) => base[id] && base[id].exists);
  let n = 0;
  const acts = {};
  for (const id of want) {
    const b = base[id];
    const r = await api.importBuiltinOrCopy(slug, id, b.absFile);
    if (!r.ok) { log(`复制 ${id} 失败：${r.error}`, 'err'); continue; }
    acts[id] = {
      id, name: b.name || id, role: b.role, mode: b.mode || 'loop',
      scale: b.scale ?? 1, scaleX: 1, scaleY: 1, offX: 0, offY: 0,
      rate: b.rate ?? 1, weight: b.weight ?? 20, react: b.react ?? 0,
      file: r.file, absFile: r.absFile, exists: true,
      duration: r.duration, width: r.width, height: r.height,
    };
    n++;
  }
  // 动作定义必须和视频一起落盘：只复制文件而不写 skin.json，重开就变空皮肤
  const sv = await api.saveSkin(slug, { name, actions: acts });
  if (!sv.ok) { log('写入皮肤失败：' + sv.error, 'err'); return; }
  log(`皮肤「${name}」已创建，复制 ${n} 个内置动作`, 'ok');
  await reloadSkins(slug);
  await openSkin(slug);
};

$('#btnDup').onclick = () => {
  if (!S.slug || S.slug === '__builtin__') { log('内置皮肤不能直接复制为皮肤？可以——但先用「新建」并选完整复制更省事。', 'err'); return; }
  $('#dupName').value = S.name + ' 副本';
  $('#dupSlug').value = S.slug + '-copy';
  openModal('mDup');
};
$('#dupOk').onclick = async () => {
  const name = $('#dupName').value.trim() || (S.name + ' 副本');
  const slug = $('#dupSlug').value.trim();
  const r = await api.duplicateSkin(S.slug, slug, name);
  if (!r.ok) { log('复制失败：' + r.error, 'err'); return; }
  closeModal('mDup');
  await reloadSkins(slug);
  await openSkin(slug);
  log('已复制为「' + name + '」', 'ok');
};

$('#btnDel').onclick = async () => {
  if (!S.slug || S.slug === '__builtin__') return;
  if (!(await ask('删除皮肤', `确定删除皮肤「${S.name}」？目录连同里面的视频会被彻底删除。`, '删除'))) return;
  const r = await api.deleteSkin(S.slug);
  if (!r.ok) { log('删除失败：' + r.error, 'err'); return; }
  markDirty(false);
  S.slug = null; S.actions = {}; S.sel = null;
  await reloadSkins('__builtin__');
  await openSkin('__builtin__');
  log('皮肤已删除', 'ok');
};

/* ===================== 保存 / 应用 ===================== */
$('#btnSave').onclick = () => saveSkin();
$('#btnApply').onclick = async () => {
  if (!S.slug || S.slug === '__builtin__') { log('先把皮肤建出来（新建/复制）再应用。', 'err'); return; }
  if (!(await saveSkin(true))) return;
  const r = await api.applySkin(S.slug);
  if (!r.ok) { log('应用失败：' + r.error, 'err'); return; }
  log('已应用到桌宠：桌宠会在 2~3 秒内自动刷新皮肤（没运行就点右上「启动桌宠」）', 'ok');
  const st = await api.petRunning();
  if (!st.running) log('桌宠当前没在运行 —— 点右上角「启动桌宠」', '');
};
$('#btnOpenFolder').onclick = async () => {
  const st = await api.state();
  if (S.slug && S.slug !== '__builtin__') api.openPath(st.skinRoot + '\\' + S.slug);
  else api.openPath(st.skinRoot);
};
$('#btnLaunch').onclick = async () => {
  const r = await api.launchPet();
  if (!r.ok) { log('启动失败：' + r.error, 'err'); return; }
  log('已启动桌宠（' + r.exe + '）', 'ok');
};

/* ===================== 导入动作 ===================== */
$('#btnImport').onclick = async () => {
  if (!S.slug || S.slug === '__builtin__') { log('内置皮肤只读：先「新建」或「复制」一个自己的皮肤再导入动作。', 'err'); return; }
  const r = await api.pickVideo();
  if (!r.ok || !r.files.length) return;
  if (r.files.length > 1) { log('一次导入一个动作；已取第一个：' + r.files[0], ''); }
  const src = r.files[0];
  const pr = await api.probe(src);
  if (!pr.ok) { log('读不了这个视频：' + pr.error, 'err'); return; }
  $('#impSrc').value = src;
  $('#impName').value = (src.split(/[\\/]/).pop() || '新动作').replace(/\.[^.]+$/, '');
  const rs = $('#impRole'); rs.innerHTML = '';
  for (const role of ROLES.filter((x) => ['lounge', 'idle_act', 'interact', 'task'].includes(x.key))) {
    const o = el('option', null, role.label); o.value = role.key; rs.appendChild(o);
  }
  $('#impRole').value = 'lounge';
  $('#impRoleNote').textContent = ROLE_HINT['lounge'];
  $('#impWidth').value = Math.min(pr.width, 576);
  $('#impKey').value = '#00ff00';
  $('#rowKey').style.display = pr.hasAlpha ? 'none' : '';
  $('#rowSim').style.display = pr.hasAlpha ? 'none' : '';
  $('#impInfo').innerHTML = pr.hasAlpha
    ? `源视频已带透明通道（${pr.pixFmt}${pr.alphaMode ? ' / alpha_mode=' + pr.alphaMode : ''}），只做转码与缩放。`
    : `源视频没有透明通道（${pr.pixFmt}），会按「抠像颜色」把背景抠掉。默认取左上角像素色。`;
  if (!pr.hasAlpha) {
    const cc = await api.cornerColor(src);
    if (cc.ok) $('#impKey').value = cc.color;
  }
  $('#impProg').style.display = 'none';
  openModal('mImport');
  $('#impInfo').dataset.src = JSON.stringify(pr);
};
$('#impRole').onchange = () => { $('#impRoleNote').textContent = ROLE_HINT[$('#impRole').value] || ''; };
$('#impSim').oninput = () => { $('#impSimVal').textContent = $('#impSim').value; };
$('#impOk').onclick = async () => {
  const src = $('#impSrc').value;
  const name = $('#impName').value.trim() || '新动作';
  const role = $('#impRole').value;
  const pr = JSON.parse($('#impInfo').dataset.src || '{}');
  const id = nextId();
  $('#impOk').disabled = true;
  $('#impProg').style.display = '';
  log('转码中：' + name + ' → VP9 alpha WebM（' + $('#impWidth').value + 'px 宽）…');
  const r = await api.importVideo({
    slug: S.slug, id, src,
    opts: {
      width: num($('#impWidth').value, pr.width),
      keyColor: pr.hasAlpha ? null : $('#impKey').value,
      similarity: num($('#impSim').value, 0.14),
      fps: 24,
    },
  });
  $('#impOk').disabled = false;
  $('#impProg').style.display = 'none';
  if (!r.ok) { log('转码失败：' + r.error, 'err'); return; }
  S.actions[id] = {
    id, name, role, mode: (role === 'interact' || role === 'idle_act') ? 'once' : 'loop',
    scale: 1, scaleX: 1, scaleY: 1, offX: 0, offY: 0, rate: 1,
    weight: (role === 'interact') ? 0 : 20, react: (role === 'interact') ? 30 : 0,
    file: r.file, absFile: r.absFile, exists: true,
    duration: r.duration, width: r.width, height: r.height,
  };
  S.probes[r.absFile] = await api.probe(r.absFile);
  S.sel = id;
  markDirty(true);
  renderList(); renderProps(); applyPreview(); status();
  closeModal('mImport');
  await saveSkin(true);
  log(`已导入「${name}」：${r.width}×${r.height}，${r.duration}s，${(r.bytes / 1048576).toFixed(2)}MB（转码 ${(r.ms / 1000).toFixed(1)}s）`, 'ok');
};

function nextId() {
  let n = 1;
  while (S.actions['act_' + n]) n++;
  return 'act_' + n;
}

/* ===================== 替换视频 ===================== */
async function replaceVideo(id) {
  const a = S.actions[id];
  const r = await api.pickVideo();
  if (!r.ok || !r.files.length) return;
  const src = r.files[0];
  const pr = await api.probe(src);
  if (!pr.ok) { log('读不了这个视频：' + pr.error, 'err'); return; }
  log('转码中（替换 ' + a.name + '）…');
  const out = await api.importVideo({
    slug: S.slug, id: id, src,
    opts: { width: Math.min(pr.width, 576), keyColor: pr.hasAlpha ? null : '#00ff00', similarity: 0.14, fps: 24 },
  });
  if (!out.ok) { log('替换失败：' + out.error, 'err'); return; }
  a.file = out.file; a.absFile = out.absFile; a.exists = true;
  a.duration = out.duration; a.width = out.width; a.height = out.height;
  delete S.probes[out.absFile];
  markDirty(true);
  renderProps(); applyPreview(); renderList();
  await saveSkin(true);
  log(`已替换「${a.name}」的视频：${out.width}×${out.height}，${out.duration}s`, 'ok');
}

/* ===================== 从内置添加 ===================== */
$('#btnFromBuiltin').onclick = async () => {
  if (!S.slug || S.slug === '__builtin__') { log('先新建/复制一个自己的皮肤。', 'err'); return; }
  const b = await api.readBuiltin();
  if (!b.ok) { log('读内置失败：' + b.error, 'err'); return; }
  S.builtin = b;
  const list = $('#builtinList');
  list.innerHTML = '';
  for (const id of sortIds(Object.keys(b.actions))) {
    const a = b.actions[id];
    const lab = el('label');
    const cb = el('input'); cb.type = 'checkbox'; cb.value = id; cb.disabled = !a.exists;
    const nm = el('span', 'nm', `${a.name || id}（${id}）`);
    const tag = el('span', 'tag', ROLE_LABEL[a.role] || a.role);
    lab.append(cb, nm, tag);
    list.appendChild(lab);
  }
  openModal('mBuiltin');
};
$('#builtinOk').onclick = async () => {
  const ids = [...$('#builtinList').querySelectorAll('input:checked')].map((i) => i.value);
  if (!ids.length) { closeModal('mBuiltin'); return; }
  closeModal('mBuiltin');
  let n = 0;
  for (const id of ids) {
    const base = S.builtin.actions[id];
    const dup = !!S.actions[id];
    const r = await api.importBuiltinOrCopy(S.slug, id, base.absFile);
    if (!r.ok) { log('复制 ' + id + ' 失败：' + r.error, 'err'); continue; }
    S.actions[id] = Object.assign({}, S.actions[id] || {
      id, name: base.name || id, role: base.role, mode: base.mode || 'loop',
      scale: base.scale ?? 1, scaleX: 1, scaleY: 1, offX: 0, offY: 0,
      rate: base.rate ?? 1, weight: base.weight ?? 20, react: base.react ?? 0,
    }, { file: r.file, absFile: r.absFile, exists: true, duration: r.duration, width: r.width, height: r.height });
    S.probes[r.absFile] = await api.probe(r.absFile);
    n++;
    if (dup) log(`已覆盖「${id}」的视频文件（原动作参数保留）`, '');
  }
  markDirty(true);
  renderList(); renderProps(); applyPreview(); status();
  await saveSkin(true);
  log(`已添加 ${n} 个内置动作（复制视频到当前皮肤）`, 'ok');
};

/* ===================== 清理未引用视频 ===================== */
$('#btnClean').onclick = async () => {
  if (!S.slug || S.slug === '__builtin__') return;
  const keep = Object.values(S.actions).map((a) => a.file).filter(Boolean);
  if (!(await ask('清理视频文件', `会删除 ${S.slug}/videos 里没被任何动作引用的 .webm（当前 ${keep.length} 个被引用）。`, '清理'))) return;
  const r = await api.cleanSkin(S.slug, keep);
  if (!r.ok) { log('清理失败：' + r.error, 'err'); return; }
  log(`已删除 ${r.removed.length} 个未引用文件${r.removed.length ? '：' + r.removed.join(', ') : ''}`, 'ok');
};

/* ===================== 预览控件 ===================== */
$('#btnPlay').onclick = () => {
  const v = $('#pv');
  S.playing = !S.playing;
  if (S.playing) { v.play().catch(() => {}); $('#btnPlay').textContent = '⏸ 暂停'; }
  else { v.pause(); $('#btnPlay').textContent = '▶ 播放'; }
};
$('#sizeR').oninput = (e) => { S.size = +e.target.value; $('#sizeVal').textContent = S.size; applyPreview(); };
$('#zoomR').oninput = (e) => { S.zoom = +e.target.value; $('#zoomVal').textContent = S.zoom + '%'; applyPreview(); };
$('#chkGuide').onchange = () => applyPreview();
$('#btnReset').onclick = () => {
  S.size = 340; S.zoom = 150;
  $('#sizeR').value = 340; $('#sizeVal').textContent = '340';
  $('#zoomR').value = 150; $('#zoomVal').textContent = '150%';
  applyPreview();
};

/* ===================== 键盘 ===================== */
addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveSkin(); }
  if (e.key === 'Escape') document.querySelectorAll('.modal.show').forEach((m) => { if (m.id === 'mAsk' && askResolve) { askResolve(false); askResolve = null; } m.classList.remove('show'); });
});

/* ===================== 启动 ===================== */
(async function boot() {
  S.info = await api.state();
  $('#envChip').textContent = (S.info.ffmpeg ? 'ffmpeg ✓' : 'ffmpeg ✗') + ' · ' + (S.info.petRunning ? '桌宠运行中' : '桌宠未运行');
  $('#envChip').className = 'chip ' + (S.info.ffmpeg ? 'ok' : 'warn');
  if (!S.info.ffmpeg) log('没找到 ffmpeg：导入动作会失败。请先安装 ffmpeg（winget install Gyan.FFmpeg）。', 'err');
  await reloadSkins();
  const target = S.info.active || '__builtin__';
  const ok = await openSkin(target);
  if (!ok && target !== '__builtin__') await openSkin('__builtin__');
  if (!(await api.listSkins()).skins.length) {
    log('还没有自己的皮肤：点「新建」建一个（可完整复制内置动作），再改大小或导入新动作。', '');
  }
  $('#skinSel').onchange = async (e) => {
    const v = e.target.value;
    if (!(await openSkin(v))) e.target.value = S.slug || '__builtin__';
  };
})();
