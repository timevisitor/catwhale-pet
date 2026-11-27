/* =====================================================================
   本地媒体演出 · 主进程服务（Electron 侧）
   
   职责：
   1. 起一个常驻的 PowerShell 子进程（media_probe.ps1），每 1s 吐一行 JSON
      （SMTC 元数据 + WASAPI 谁在出声）。为何用常驻进程而不是每轮 spawn：
      实测每次 spawn 冷启动 0.43s，且每次都要重新 Add-Type 编译 C#，1s 一次
      会把主进程事件循环拖住（历史上 envTools() 用 12 个 where.exe 同步探测
      导致开机冻住 1.3s，这里不能重犯）。常驻进程只在启动时付一次代价。
   2. 合并两层信号 → 判定「在看视频 / 在听音乐」→ 去抖 → 推给页面。
   3. 开关落在 settings.json 的 media.show（页面设置面板读写同一份）。

   设计上的硬约束：
   - 主进程**绝不**用 spawnSync/execSync（技能里已记录的坑）。
   - 子进程 stdout 逐行解析；坏行/半行直接丢弃，不能让 JSON.parse 抛出去。
   - 页面的「游戏模式」必须能把它彻底停掉（含 kill 子进程），否则反作弊场景
     会多一个常驻的 PowerShell。
   - 探测频率对 CPU 的影响必须实测（见 evidence/cpu-budget.txt）。
   ===================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const detect = require('./media-detect.js');

const PROBE_PS1 = 'media_probe.ps1';
const PROBE_CS = 'WasapiProbe.cs';

/* 探测脚本放在 app/media-probe/ 下（打包时随 app 一起复制） */
function probeDir() { return path.join(__dirname, 'media-probe'); }
function probeScript() { return path.join(probeDir(), PROBE_PS1); }
function probeCs() { return path.join(probeDir(), PROBE_CS); }

function powershellExe() {
  /* 优先用系统 PowerShell：实测 5.1/7 都能跑 WinRT + WASAPI。
     7 起动快，但 WinRT 互操作在 7 上需要额外的 WinRT.Runtime 包，5.1 反而稳。 */
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows',
                        'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(sys) ? sys : 'powershell.exe';
}

function createMediaShow(opts) {
  const o = opts || {};
  const cfg = Object.assign({
    enabled: false,          // 页面设置面板 / settings.json 的 media.show.enabled
    pollMs: 2000,            // 采样间隔：实测 1s→单核 2.4%，2s→0.83%，2.5s→0.52%。
                             // 取 2s 折中：人「点播放」到桌宠开演约 2~4 秒，观感自然，开销减到三分之一。
    slowMs: 2500,            // 自适应节奏（v0.7.2）：有媒体在放时按 pollMs 采样，连续静默后退到这个间隔。
                             // 灵动岛把 pollMs 压到 600 换波形，常驻就是单核 2.6%；配合 slowMs 实测空闲 0.3%。
                             // 0 = 关闭自适应，固定 pollMs（旧行为）。
    startMs: 1200,           // 持续多久算「真的开始了」
    stopMs: 2500,            // 停了多久算「真的结束了」
    showInGameMode: false,   // 游戏模式下一律停
  }, o.cfg || {});

  const state = {
    running: false,          // 探测子进程是否在跑
    child: null,
    buf: '',
    lastSample: 0,
    lastDecision: null,
    lastPush: 0,
    kind: null,              // 当前确认的演出类别（'video' | 'music' | null）
    info: null,
    samples: 0,
    errors: 0,
    restarts: 0,
    lastError: '',
    startedAt: 0,
    probeMs: 0,              // 最近一次采样的自身耗时（脚本自报）
  };

  const smoother = detect.createSmoother({ startMs: cfg.startMs, stopMs: cfg.stopMs });
  let emit = () => {};
  let restartTimer = null;
  let backoff = 1000;
  let wantRunning = false;          // 探测「应该」在跑（区分有意停止与意外退出，决定 exit 后要不要重启）

  function snapshot() {
    return {
      enabled: !!cfg.enabled,
      running: state.running,
      kind: state.kind,
      playing: !!state.kind,
      info: state.info,
      samples: state.samples,
      errors: state.errors,
      restarts: state.restarts,
      lastError: state.lastError,
      lastSampleAge: state.lastSample ? Date.now() - state.lastSample : null,
      pollMs: cfg.pollMs,
      slowMs: Number(cfg.slowMs) > 0 ? Number(cfg.slowMs) : 0,
    };
  }

  function push(force) {
    const t = Date.now();
    if (!force && t - state.lastPush < 120) return;    // 页面对 8 次/秒以上的更新没意义
    state.lastPush = t;
    try { emit('media:state', snapshot()); } catch (e) {}
  }

  /* 一行采样 → 判定 → 去抖 → 推 */
  function ingest(line) {
    let rec;
    try { rec = JSON.parse(line); } catch (e) { return; }
    if (!rec || typeof rec !== 'object') return;
    state.samples++;
    state.lastSample = Date.now();
    if (rec.ts) state.probeMs = Math.max(0, Date.now() - Number(rec.ts));

    const d = detect.decide(rec, { selfPid: process.pid });
    state.lastDecision = d;

    const r = smoother.push(d, Date.now());
    if (r.changed) {
      state.kind = r.kind;
      state.info = r.kind ? {
        kind: r.kind,
        app: d.app || '',
        proc: d.proc || '',
        title: d.title || '',
        artist: d.artist || '',
        album: d.album || '',
        peak: d.peak || 0,
        source: d.source || '',
        confidence: d.confidence || '',
        since: Date.now(),
      } : null;
      push(true);
      return;
    }
    /* 内容变了（切歌/换视频）但类别没变：标题要更新，桌面上的胶囊才不显示旧歌 */
    if (r.kind && d.playing && state.info) {
      if ((d.title || '') !== state.info.title || (d.app || '') !== state.info.app) {
        state.info = Object.assign({}, state.info, {
          app: d.app || '', proc: d.proc || '', title: d.title || '',
          artist: d.artist || '', album: d.album || '', peak: d.peak || 0,
        });
        push(true);
        return;
      }
      state.info.peak = d.peak || 0;
    }
    push(false);
  }

  function onData(chunk) {
    state.buf += chunk.toString('utf8');
    /* 半行保护：只处理到最后一个换行之前的内容 */
    let idx;
    while ((idx = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, idx).replace(/\r$/, '').trim();
      state.buf = state.buf.slice(idx + 1);
      if (!line || line[0] !== '{') continue;
      try { ingest(line); } catch (e) { state.errors++; state.lastError = String(e && e.message || e); }
    }
    if (state.buf.length > 1 << 20) state.buf = '';     // 防跑飞
  }

  function startProbe() {
    if (state.child) return;
    if (!fs.existsSync(probeScript()) || !fs.existsSync(probeCs())) {
      state.lastError = '探测脚本缺失：' + probeScript();
      push(true);
      return;
    }
    let child;
    try {
      const psArgs = [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', probeScript(), '-IntervalMs', String(cfg.pollMs),
      ];
      if (Number(cfg.slowMs) > 0) psArgs.push('-SlowMs', String(cfg.slowMs));
      child = spawn(powershellExe(), psArgs, {
        cwd: probeDir(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
      });
    } catch (e) {
      state.lastError = 'spawn 失败：' + (e && e.message || e);
      push(true);
      scheduleRestart();
      return;
    }
    state.child = child;
    state.running = true;
    state.startedAt = Date.now();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s) => {
      const t = String(s || '').trim();
      if (t) { state.lastError = t.slice(0, 300); }
    });
    child.on('error', (e) => {
      if (state.child !== child) return;          // 已被替换/停止的旧进程：别污染当前状态
      state.errors++;
      state.lastError = String(e && e.message || e);
    });
    child.on('exit', (code, sig) => {
      /* 只有「当前登记的那个进程」退出才代表探测断了。stopProbe() 先把 state.child 清空再 kill，
         所以有意停止（关闭开关 / 游戏模式 suspend / 换采样节奏）后迟到的 exit 走到这里时
         state.child 已经不是它 —— 以前这里不看是谁，会把刚起的新进程登记清掉、再退避重启一个，
         结果是双探测；游戏模式 suspend 也是这样在 1 秒后把 PowerShell 又拉了回来。 */
      if (state.child !== child) { push(true); return; }
      state.running = false;
      state.child = null;
      state.buf = '';
      if (!cfg.enabled || !wantRunning) { push(true); return; }
      /* 非正常退出（脚本崩了/被 kill）→ 退避重启，最多 1 分钟一次 */
      restartTimer = null;
      scheduleRestart();
      push(true);
    });
    wantRunning = true;
    push(true);
  }

  function scheduleRestart() {
    if (restartTimer || !cfg.enabled || !wantRunning) return;
    state.restarts++;
    backoff = Math.min(backoff * 2, 60000);
    restartTimer = setTimeout(() => { restartTimer = null; startProbe(); }, backoff);
  }

  function stopProbe(reason) {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    wantRunning = false;                           // 有意停止：exit 不再触发重启（游戏模式/关闭开关）
    const child = state.child;
    state.child = null;
    state.running = false;
    state.buf = '';
    smoother.reset();
    state.kind = null;
    state.info = null;
    state.lastSample = 0;
    if (child) {
      try { child.kill(); } catch (e) {}
      /* PowerShell 有时不响应 SIGTERM（Windows 上 kill 走 TerminateProcess，通常有效），
         保险起见 3 秒后再确认一次；不强依赖任务管理器式批量杀进程。 */
      const killer = setTimeout(() => {
        try { if (!child.killed) child.kill('SIGKILL'); } catch (e) {}
      }, 3000);
      if (killer.unref) killer.unref();           // 兜底定时器不该拖着进程不让退
    }
    backoff = 1000;
    push(true);
    return { ok: true, stopped: !!child, reason: reason || '' };
  }

  return {
    setEmitter(fn) { emit = typeof fn === 'function' ? fn : () => {}; },
    get: () => snapshot(),
    cfg: () => cfg,
    /* 页面开关：开启就起探测进程，关闭立刻停并清状态 */
    apply(next) {
      const merged = Object.assign({}, cfg, next || {});
      const wasOn = cfg.enabled;
      const oldPoll = cfg.pollMs, oldSlow = cfg.slowMs;
      Object.assign(cfg, merged);
      const cadenceChanged = (cfg.pollMs !== oldPoll || cfg.slowMs !== oldSlow);
      if (cfg.enabled && (!wasOn || !state.running)) {
        /* 关掉再开时把去抖器清干净，避免带着上一次的候选状态 */
        smoother.reset();
        startProbe();
      } else if (!cfg.enabled && wasOn) {
        stopProbe('disabled');
      } else if (cfg.enabled && state.running && cadenceChanged) {
        /* 采样间隔是启动参数：进程已经在跑时只改 cfg 不会生效（灵动岛把 600 压给一个
           按 2000 起的探测，实际还是 2000）。换节奏就重启一次，让 cfg 与进程一致。 */
        stopProbe('recadence');
        startProbe();
      } else {
        push(true);
      }
      return { ok: true, state: snapshot() };
    },
    /* 游戏模式等场景用：暂停探测但保留用户开关（恢复时按开关决定要不要起） */
    suspend(reason) { return stopProbe(reason || 'suspend'); },
    resume() { if (cfg.enabled && !state.running) startProbe(); return { ok: true, state: snapshot() }; },
    /* 一次性读取（设置面板的"现在试试"用，不常驻） */
    probeOnce() {
      return new Promise((resolve) => {
        if (!fs.existsSync(probeScript())) return resolve({ ok: false, error: '脚本缺失' });
        execFile(powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                                   '-File', probeScript(), '-Once'],
          { cwd: probeDir(), windowsHide: true, timeout: 15000, encoding: 'utf8' },
          (err, stdout, stderr) => {
            if (err) return resolve({ ok: false, error: String(err.message || err) });
            const lines = String(stdout || '').split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
            if (!lines.length) return resolve({ ok: false, error: '无输出：' + String(stderr || '').slice(-200) });
            let rec;
            try { rec = JSON.parse(lines[lines.length - 1]); } catch (e) {
              return resolve({ ok: false, error: '解析失败' });
            }
            const d = detect.decide(rec, { selfPid: process.pid });
            resolve({ ok: true, raw: rec, decision: d });
          });
      });
    },
    stopAll() { return stopProbe('shutdown'); },
  };
}

module.exports = { createMediaShow, probeDir, probeScript, probeCs, powershellExe };
