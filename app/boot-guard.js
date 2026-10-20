// boot-guard.js — 启动看门狗 + 兼容模式逐级降级
//
// 为什么需要它：
//   桌面版是"全屏透明 + 置顶 + 逐像素穿透"的窗口，这类窗口在 Windows 上走分层合成路径，
//   第三方输入法（典型是搜狗：ichat / isgpet / PicFace / systembeautify 四个 bundle + SogouPY/SogouTSF）
//   会往宿主进程注入 DLL 并 hook 窗口/输入相关 API。一旦 hook 与 Chromium 的初始化顺序撞上，
//   Chromium 会在原生层 CHECK 失败并直接 __debugbreak（异常码 0x80000003）——**JS 层接不住**，
//   app.on('render-process-gone') / uncaughtException 都不会触发，进程直接消失。
//
//   所以"避免类似情况"只能分两层做：
//     ① 预防：能预先判定环境时可切更保守的参数（本模块的等级机制）；
//     ② 兜底：真崩过一次也没关系——下一次启动自动升一档兼容模式，用户双击照样能用。
//
// 判定方式：每次启动把"走到哪个阶段"写进 userData/boot-guard.json。
//   正常退出会写 phase=quit，成功启动会写 phase=ready。
//   下次启动若发现上次停在 process-boot / window-created / page-loaded，就认为上次是崩在启动阶段，
//   兼容等级 +1（最高 3），并追加一行到 boot-guard.log。
//
// 等级：
//   L0 正常
//   L1 关掉 Chromium 的 Windows TSF 输入支持（disable-features=TSFImeSupport）——针对输入法注入
//   L2 L1 + 关硬件加速（透明窗口改走软件合成）——针对 GPU/驱动侧的 CHECK
//   L3 L2 + 延迟建窗 + 不用 screen-saver 级置顶 ——针对窗口合成时序
//
// 手动控制：
//   --compat=0|1|2|3   强制指定等级（不改文件，本次生效）
//   --compat-reset     等级归零并清掉失败计数
//   --compat-off       本次按 L0 跑（排查用，不改文件）

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// 各等级的 Chromium 功能禁用项（会与 main.js 原有的合并，不覆盖）
// 注意：曾试着用 disable-features=TSFImeSupport 阻止搜狗 TSF 组件注入，实测无效——
// 桌宠进程照样加载 SogouTSF.ime / SogouPY.ime（模块数、列表与正常启动完全一致）。
// 所以这里不再动输入法支持（那个开关只会让用户打不了中文），只做时序与渲染层面的降级。
const LEVEL_FEATURES = {
  0: [],
  1: [],
  2: ['CalculateNativeWinOcclusion'],
  3: ['CalculateNativeWinOcclusion'],
};

// 建窗延迟（毫秒）：让输入法的注入/初始化先跑完，再建透明窗口，避开竞态
const LEVEL_DELAY_MS = { 0: 0, 1: 800, 2: 800, 3: 3000 };

const LEVEL_NOTES = {
  0: '正常',
  1: '延迟 0.8 秒建窗（让输入法注入先跑完，改时序）',
  2: '再关硬件加速（透明窗口走软件合成）',
  3: '再拉长到 3 秒、降置顶级别、禁用 GPU',
};

// 常见输入法安装位置（只用于写日志，不改变行为）
const IME_PROBES = [
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'SogouInput'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'SogouInput'),
  path.join(process.env.LOCALAPPDATA || '', 'SogouInput'),
  'G:\\SogouInput',
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tencent', 'QQPinyin'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Baidu', 'BaiduPinyin'),
];

function detectIme() {
  const found = [];
  for (const p of IME_PROBES) {
    if (!p) continue;
    try { if (fs.existsSync(p)) found.push(p); } catch (e) { /* ignore */ }
  }
  return found;
}

module.exports = function makeBootGuard(app) {
  const dir = app.getPath('userData');
  const statePath = path.join(dir, 'boot-guard.json');
  const logPath = path.join(dir, 'boot-guard.log');
  const t0 = Date.now();

  const argv = process.argv;
  const argOf = (name) => {
    const hit = argv.find((a) => a.startsWith(name + '='));
    return hit === undefined ? undefined : hit.slice(name.length + 1);
  };

  const readState = () => {
    try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (e) { return {}; }
  };
  const writeState = (obj) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(obj, null, 1), 'utf8');
    } catch (e) { /* 写不了就算了，不能影响启动 */ }
  };
  const log = (line) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(logPath, line + '\n', 'utf8');
    } catch (e) { /* ignore */ }
  };

  const prev = readState();

  // ---- 判定"上次是不是崩在启动阶段" ----
  // 只有 phase 停在启动中间态、且距上次启动不超过 10 分钟，才算崩溃
  // （超过 10 分钟多为关机/任务管理器结束，不该算）
  const BOOT_PHASES = ['process-boot', 'window-created', 'page-loaded'];
  const lastStart = Number(prev.lastStart || 0);
  const fresh = lastStart > 0 && (t0 - lastStart) < 10 * 60 * 1000;
  let crashedLastTime = false;
  if (BOOT_PHASES.includes(prev.phase) && fresh) crashedLastTime = true;

  // ---- 决定等级 ----
  // persistLevel：写进文件、下次启动仍然生效的等级（只由崩溃判定和 --compat-reset 改）
  // runLevel    ：本次实际用的等级（--compat=N / --compat-off 只改它，不落盘）
  let persistLevel = Number(prev.level || 0);
  let resetBy = '';
  if (argv.includes('--compat-reset')) {
    persistLevel = 0;
    prev.fails = 0;
    resetBy = '--compat-reset';
  }
  if (crashedLastTime && !resetBy) {
    persistLevel = Math.min(3, persistLevel + 1);
    log(`[${new Date().toISOString()}] CRASH-DETECTED lastPhase=${prev.phase} ` +
        `lastStart=${new Date(lastStart).toISOString()} failCount=${Number(prev.fails || 0) + 1} -> level=${persistLevel}`);
  }

  const forced = argOf('--compat');
  let runLevel = persistLevel;
  let forcedNote = '';
  if (forced !== undefined && /^[0-3]$/.test(forced)) {
    runLevel = Number(forced);
    forcedNote = '--compat=' + forced;
  }
  if (argv.includes('--compat-off')) {
    runLevel = 0;
    forcedNote = '--compat-off';
  }
  const level = runLevel;                 // 下面一律用"本次实际等级"

  const state = {
    level: persistLevel,                  // 落盘的是持久等级
    runLevel,                             // 本次实际（排查用，下次启动不参考）
    fails: crashedLastTime ? Number(prev.fails || 0) + 1 : Number(prev.fails || 0),
    phase: 'process-boot',
    lastStart: t0,
    lastCrashedPhase: crashedLastTime ? prev.phase : (prev.lastCrashedPhase || ''),
    lastCrashedAt: crashedLastTime ? lastStart : (prev.lastCrashedAt || 0),
    note: LEVEL_NOTES[persistLevel],
  };
  writeState(state);

  const ime = detectIme();
  log(`[${new Date().toISOString()}] BOOT level=${level}${forcedNote ? ' (' + forcedNote + '，不落盘)' : ''}` +
      `${resetBy ? ' (' + resetBy + ')' : ''} ` +
      `prevPhase=${prev.phase || '-'} ime=${ime.length ? ime.join(';') : '(none)'} ` +
      `electron=${process.versions.electron} win=${os.release()}`);

  const features = LEVEL_FEATURES[level] || [];

  const delayMs = LEVEL_DELAY_MS[level] || 0;

  return {
    level,               // 本次实际生效的等级
    delayMs,             // 建窗前等待毫秒数
    persistLevel,        // 落盘的等级（下次启动参考）
    features,
    crashedLastTime,
    lastCrashedPhase: state.lastCrashedPhase,
    statePath,
    logPath,
    ime,

    /** 追加阶段（只前进，不后退），ready/quit 视为终点 */
    phase(name, extra) {
      const cur = readState();
      // 终态之后不再覆盖，避免 before-quit 把 ready 写成 quit 后又被别的阶段改回
      if (cur.phase === 'ready' && name !== 'quit') return;
      cur.phase = name;
      cur.lastStart = cur.lastStart || t0;
      if (extra) Object.assign(cur, extra);
      cur.runLevel = runLevel;
      writeState(cur);
      log(`[${new Date().toISOString()}] PHASE ${name} +${Date.now() - t0}ms` +
          (extra ? ' ' + JSON.stringify(extra) : ''));
    },

    /** 供设置面板/托盘显示的一行说明 */
    describe() {
      if (level === 0) return '正常启动';
      return `兼容模式 L${level}：${LEVEL_NOTES[level]}` +
        (state.lastCrashedPhase ? `（上次启动停在 ${state.lastCrashedPhase}）` : '');
    },
  };
};
