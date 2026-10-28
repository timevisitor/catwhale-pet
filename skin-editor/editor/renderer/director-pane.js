/* =============================================================================
 * 皮肤编辑器 · 作息页
 * -----------------------------------------------------------------------------
 * 编辑 director.json：时段划分 + 「时段 × 动作」倍率矩阵 + CPU 三档 + 节奏。
 * 直接读写 <皮肤目录>/director.json（与桌宠同一份文件，桌宠 2.5s 热重载会自动生效）。
 *
 * 依赖 app.js 的全局：S（当前皮肤/动作）、CORE（核心 id）、$ / el / num / log
 * ============================================================================= */
(function () {
  'use strict';

  const D = { cfg: null, defaults: null, file: null, source: null, loaded: false, dirty: false };
  const STATE_CN = {};                 // id -> 中文名（用于矩阵行标签）
  for (const id in CORE) STATE_CN[id] = CORE[id].name || id;

  /* ---------- 小工具 ---------- */
  const hhmm = (m) => ('0' + Math.floor((m % 1440) / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2);
  const toMin = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    return m ? (Number(m[1]) * 60 + Number(m[2])) : null;
  };
  const PHASE_COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#b07aa1', '#e15759', '#76b7b2', '#edc948', '#9c755f'];

  function allActionIds() {
    const ids = new Set();
    for (const id in CORE) ids.add(id);
    for (const id in (S.actions || {})) ids.add(id);
    return [...ids].sort((a, b) => {
      const ra = (S.actions[a] && S.actions[a].role) || (CORE[a] && CORE[a].role) || 'zz';
      const rb = (S.actions[b] && S.actions[b].role) || (CORE[b] && CORE[b].role) || 'zz';
      return ra === rb ? a.localeCompare(b) : ra.localeCompare(rb);
    });
  }

  function markDirtyDir(on) {
    D.dirty = on;
    const d = document.getElementById('dirDirty');
    if (d) d.style.display = on ? 'inline' : 'none';
  }

  /* ---------- 载入 / 保存 ---------- */
  async function load() {
    if (!window.api || !window.api.readDirector) { log('作息：preload 缺少 director 接口', 'err'); return; }
    const r = await window.api.readDirector(S.slug);
    if (!r || r.ok === false) { log('作息读取失败：' + (r && r.error || '未知'), 'err'); return; }
    D.cfg = r.cfg;
    /* director.json 里 phases 可以是 null（表示"用预设"），桌宠那边由 normalizeConfig 展开，
       编辑器读的是原始配置，必须在这里自己展开，否则时段条/矩阵/边界都渲染成空。 */
    if (!Array.isArray(D.cfg.phases) || !D.cfg.phases.length) {
      const pre = D.cfg.preset || 'standard';
      const list = (D.cfg.phasesPresets && D.cfg.phasesPresets[pre]) ||
                   (r.defaults && r.defaults.phasesPresets && r.defaults.phasesPresets[pre]) || [];
      D.cfg.phases = JSON.parse(JSON.stringify(list));
      if (D.cfg.phases.length) log('作息表为空，已按预设「' + pre + '」展开 ' + D.cfg.phases.length + ' 个时段');
    }
    D.defaults = r.defaults;
    D.file = r.file;
    D.source = r.source;
    D.loaded = true;
    markDirtyDir(false);
    render();
    log('作息表已载入（' + (r.source === 'file' ? r.file : '内置默认，尚未保存到皮肤') + '）');
  }

  async function save() {
    if (!D.cfg) return;
    if (!S.slug) { log('内置皮肤只读：先「新建」或「复制」一个皮肤再保存作息', 'err'); return; }
    // 保存前做一次完整性校验：时段必须首尾相接、覆盖 24 小时
    const chk = validatePhases(D.cfg.phases);
    if (!chk.ok) { log('时段有问题：' + chk.error, 'err'); return; }
    const r = await window.api.writeDirector(S.slug, D.cfg);
    if (!r || r.ok === false) { log('作息保存失败：' + (r && r.error || '未知'), 'err'); return; }
    D.file = r.file; D.source = 'file';
    markDirtyDir(false);
    log('作息已保存 → ' + r.file);
  }

  function validatePhases(list) {
    if (!Array.isArray(list) || !list.length) return { ok: false, error: '时段表为空' };
    const segs = list.map((p) => ({ id: p.id, a: toMin(p.from), b: toMin(p.to) }))
                     .sort((x, y) => x.a - y.a);
    for (const s of segs) if (s.a === null || s.b === null) return { ok: false, error: '时间格式应为 HH:MM' };
    for (let i = 0; i < segs.length; i++) {
      const cur = segs[i], nxt = segs[(i + 1) % segs.length];
      if (cur.a === cur.b) return { ok: false, error: cur.id + ' 的起止时间相同' };
      if (cur.b !== nxt.a) return { ok: false, error: cur.id + ' 的结束时间(' + hhmm(cur.b) + ') 与下一段开始(' + hhmm(nxt.a) + ') 不相接' };
    }
    return { ok: true };
  }

  /* ---------- 渲染 ---------- */
  function phaseList() {
    if (!D.cfg.phases || !D.cfg.phases.length) return [];
    // 规范化过的 phases 带 start/dur，这里统一回 from/to 字符串工作
    return D.cfg.phases.map((p) => ({ id: p.id, name: p.name || p.id, from: p.from, to: p.to }));
  }

  function render() {
    const cfg = D.cfg;
    if (!cfg) return;
    document.getElementById('dirEnabled').checked = cfg.enabled !== false;
    document.getElementById('dirPreset').value = cfg.preset || 'standard';
    document.getElementById('dirSrc').textContent = D.file ? '配置：' + D.file.replace(/^.*[\\/]/, '') : '配置：内置默认（未保存）';
    renderBar();
    renderPhases();
    renderTable();
    renderCpu();
  }

  function renderBar() {
    const bar = document.getElementById('dirBar');
    bar.innerHTML = '';
    const list = phaseList();
    for (const p of list) {
      const a = toMin(p.from), b = toMin(p.to);
      const dur = ((b - a) + 1440) % 1440 || 1440;
      const seg = el('div', 'dirseg');
      seg.style.left = (a / 1440 * 100) + '%';
      seg.style.width = (dur / 1440 * 100) + '%';
      seg.style.background = PHASE_COLORS[list.indexOf(p) % PHASE_COLORS.length];
      seg.title = p.name + ' ' + p.from + '–' + p.to;
      seg.textContent = p.name;
      bar.appendChild(seg);
    }
    const tick = document.getElementById('dirTick');
    tick.innerHTML = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) =>
      '<span style="left:' + (h / 24 * 100) + '%">' + ('0' + h).slice(-2) + '</span>').join('');
  }

  function renderPhases() {
    const box = document.getElementById('dirPhases');
    box.innerHTML = '';
    const list = phaseList();
    list.forEach((p, i) => {
      const row = el('div', 'dirphase');
      const dot = el('i', 'dot');
      dot.style.background = PHASE_COLORS[i % PHASE_COLORS.length];
      const name = el('input', 'pname');
      name.value = p.name;
      name.oninput = () => { p.name = name.value; D.cfg.phases[i].name = name.value; markDirtyDir(true); renderBar(); };
      const from = el('input', 'ptime'); from.type = 'time'; from.value = p.from;
      const to = el('input', 'ptime'); to.type = 'time'; to.value = p.to;
      const apply = () => {
        D.cfg.phases[i].from = from.value; D.cfg.phases[i].to = to.value;
        p.from = from.value; p.to = to.value;
        markDirtyDir(true); renderBar();
      };
      from.onchange = apply; to.onchange = apply;
      row.appendChild(dot); row.appendChild(name); row.appendChild(from);
      row.appendChild(el('span', 'pto', '→')); row.appendChild(to);
      box.appendChild(row);
    });
  }

  function renderTable() {
    const cfg = D.cfg;
    const tbl = document.getElementById('dirTable');
    tbl.innerHTML = '';
    const phases = phaseList();
    const bands = (cfg.cpu && cfg.cpu.bands) || [];

    const thead = el('thead');
    const tr1 = el('tr');
    tr1.appendChild(el('th', 'corner', '动作'));
    for (const p of phases) {
      const th = el('th', 'ph');
      th.textContent = p.name;
      th.title = p.from + '–' + p.to;
      tr1.appendChild(th);
    }
    for (const b of bands) {
      const th = el('th', 'cpu');
      th.textContent = 'CPU ' + (b.label || b.id);
      tr1.appendChild(th);
    }
    thead.appendChild(tr1);
    tbl.appendChild(thead);

    const tbody = el('tbody');
    for (const id of allActionIds()) {
      const tr = el('tr');
      const th = el('th', 'rowhead');
      th.innerHTML = '<b>' + (STATE_CN[id] || (S.actions[id] && S.actions[id].name) || id) + '</b><i>' + id + '</i>';
      tr.appendChild(th);
      const cells = [];
      for (const p of phases) {
        cfg.weights[p.id] = cfg.weights[p.id] || {};
        const v = cfg.weights[p.id][id];
        const inp = el('input', 'mw');
        inp.type = 'number'; inp.min = '0'; inp.max = '6'; inp.step = '0.1';
        inp.value = (v === undefined) ? '1' : String(v);
        inp.placeholder = '1';
        inp.oninput = () => {
          const n = Number(inp.value);
          if (!isFinite(n) || n < 0) { inp.classList.add('bad'); return; }
          inp.classList.remove('bad');
          if (Math.abs(n - 1) < 1e-9) delete cfg.weights[p.id][id];
          else cfg.weights[p.id][id] = Math.round(n * 100) / 100;
          markDirtyDir(true);
        };
        cells.push(inp);
        const td = el('td'); td.appendChild(inp); tr.appendChild(td);
      }
      for (const b of bands) {
        cfg.cpu.weights = cfg.cpu.weights || {};
        b.weights = b.weights || {};
        const inp = el('input', 'mw');
        inp.type = 'number'; inp.min = '0'; inp.max = '6'; inp.step = '0.1';
        inp.value = (b.weights[id] === undefined) ? '1' : String(b.weights[id]);
        inp.oninput = () => {
          const n = Number(inp.value);
          if (!isFinite(n) || n < 0) { inp.classList.add('bad'); return; }
          inp.classList.remove('bad');
          if (Math.abs(n - 1) < 1e-9) delete b.weights[id];
          else b.weights[id] = Math.round(n * 100) / 100;
          markDirtyDir(true);
        };
        const td = el('td', 'cpucell'); td.appendChild(inp); tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
  }

  function renderCpu() {
    const cfg = D.cfg;
    const box = document.getElementById('dirCpu');
    box.innerHTML = '';
    const cpu = cfg.cpu || (cfg.cpu = {});
    const row = (label, node) => { const r = el('div', 'dirfield'); r.appendChild(el('label', null, label)); r.appendChild(node); box.appendChild(r); };

    const en = el('input'); en.type = 'checkbox'; en.checked = cpu.enabled !== false;
    en.onchange = () => { cpu.enabled = en.checked; markDirtyDir(true); };
    row('启用负载联动', en);

    const tau = el('input', 'pnum'); tau.type = 'number'; tau.min = '1'; tau.max = '60'; tau.step = '1';
    tau.value = num(cpu.smoothTauSec, 8);
    tau.oninput = () => { cpu.smoothTauSec = num(tau.value, 8); markDirtyDir(true); };
    row('平滑时间常数（秒）', tau);

    const hold = el('input', 'pnum'); hold.type = 'number'; hold.min = '0'; hold.max = '600'; hold.step = '10';
    hold.value = Math.round(num(cpu.minHoldMs, 90000) / 1000);
    hold.oninput = () => { cpu.minHoldMs = num(hold.value, 90) * 1000; markDirtyDir(true); };
    row('最短停留（秒）', hold);

    const hys = el('input', 'pnum'); hys.type = 'number'; hys.min = '0'; hys.max = '30'; hys.step = '1';
    hys.value = num(cpu.hysteresis, 8);
    hys.oninput = () => { cpu.hysteresis = num(hys.value, 8); markDirtyDir(true); };
    row('滞回（百分点）', hys);

    for (const b of (cpu.bands || [])) {
      const t = el('input', 'pnum'); t.type = 'number'; t.min = '0.1'; t.max = '3'; t.step = '0.05';
      t.value = num(b.tempo, 1);
      t.oninput = () => { b.tempo = num(t.value, 1); markDirtyDir(true); };
      row('节奏 ' + (b.label || b.id), t);
    }

    const fz = el('input'); fz.type = 'checkbox'; fz.checked = cfg.deepNightFreeze !== false;
    fz.onchange = () => { cfg.deepNightFreeze = fz.checked; markDirtyDir(true); };
    row('深夜自动降速', fz);
  }

  /* ---------- 页签切换 ---------- */
  function showPane(which) {
    const isDir = which === 'dir';
    document.querySelector('main').style.display = isDir ? 'none' : '';
    document.getElementById('dirMain').style.display = isDir ? '' : 'none';
    document.getElementById('navActions').classList.toggle('on', !isDir);
    document.getElementById('navDirector').classList.toggle('on', isDir);
    if (isDir) load();
  }

  /* ---------- 初始化 ---------- */
  function init() {
    document.getElementById('navActions').onclick = () => showPane('act');
    document.getElementById('navDirector').onclick = () => showPane('dir');
    document.getElementById('dirSave').onclick = save;
    document.getElementById('dirReset').onclick = () => {
      if (!D.defaults) return;
      D.cfg = JSON.parse(JSON.stringify(D.defaults));
      D.file = null; D.source = 'default';
      markDirtyDir(true);
      render();
      log('已恢复默认作息表（记得保存）');
    };
    document.getElementById('dirPreset').onchange = (e) => {
      const preset = e.target.value;
      D.cfg.preset = preset;
      const d = D.defaults && D.defaults.phasesPresets && D.defaults.phasesPresets[preset];
      if (d) D.cfg.phases = JSON.parse(JSON.stringify(d));
      markDirtyDir(true);
      render();
    };
    document.getElementById('dirEnabled').onchange = (e) => { D.cfg.enabled = e.target.checked; markDirtyDir(true); };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.DirPane = { load, save, state: D };
})();
