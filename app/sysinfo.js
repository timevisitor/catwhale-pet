/**
 * sysinfo.js — 桌宠的实时硬件数据源（详情卡四角标注用）
 *
 * 分工（照 sysmon-widget 项目踩过的坑）：
 *   · CPU 占用  → Node 侧 os.cpus() 两次采样差值（便宜、无需权限）
 *   · 内存占用  → os.totalmem/freemem
 *   · 硬盘占用  → fs.statfs（Node 18.15+），遍历常见盘符
 *   · CPU 实时频率 / 内存频率 / GPU 频率与占用 → 常驻 PowerShell（tools/sysinfo.ps1）
 *     为什么必须走 PS：Windows 上 os.cpus().speed 与 WMI CurrentClockSpeed **只给标称基频**，
 *     恒定不变（本机恒 3400）——实时值要用 '\Processor Information(_Total)\% Processor Performance' × 基频。
 *
 * 资源：**按需启动**，菜单关闭后再多留 REAP_MS 毫秒缓存（重开即时有数），然后自动收掉。
 *
 * @module sysinfo
 */
'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TICK_MS = 1500;            // Node 侧采样间隔
const REAP_MS = 60000;           // 菜单关掉后继续缓存这么久再收进程

let psChild = null;
let psLatest = null;             // { cpuFreqMHz, cpuBaseMHz, ramSpeedMHz, gpu:{...} }
let timer = null;
let reapTimer = null;
let prevCpu = null;
let last = null;
let onData = () => {};
let log = () => {};

function cpuUsagePct() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) for (const k in c.times) { total += c.times[k]; if (k === 'idle') idle += c.times.idle; }
  let pct = null;
  if (prevCpu) {
    const dTotal = total - prevCpu.total, dIdle = idle - prevCpu.idle;
    if (dTotal > 0) pct = Math.max(0, Math.min(100, 100 * (1 - dIdle / dTotal)));
  }
  prevCpu = { total, idle };
  return pct;
}

function memInfo() {
  const t = os.totalmem(), f = os.freemem();
  return { memTotalGB: t / 1073741824, memUsedGB: (t - f) / 1073741824 };
}

function diskInfo() {
  const out = [];
  for (const d of ['C:', 'D:', 'E:', 'F:', 'G:', 'H:']) {
    try {
      const st = fs.statfsSync(d + '\\');
      const total = st.blocks * st.bsize, avail = st.bavail * st.bsize;
      if (total > 0 && total / 1073741824 > 1) {
        out.push({ drive: d.replace(':', ''), usedPct: 100 * (1 - avail / total), totalGB: total / 1073741824 });
      }
    } catch (e) { /* 盘符不存在/未就绪，跳过 */ }
  }
  return out;
}

/** 启动常驻 PowerShell 采样（幂等） */
function startPs() {
  if (psChild) return;
  const srcScript = path.join(__dirname, 'tools', 'sysinfo.ps1');
  if (!fs.existsSync(srcScript)) { log('SYSINFO_PS_MISSING ' + srcScript); return; }
  /* 关键：把脚本复制到**纯 ASCII 的临时路径**再跑。
     powershell.exe -File 的路径参数按 OEM 代码页解释，项目目录里的中文（…\桌宠\…）
     会让它找不到文件且不报错（静默无输出）。 */
  let runScript = srcScript;
  try {
    const tmp = path.join(os.tmpdir(), 'pet-sysinfo.ps1');
    fs.copyFileSync(srcScript, tmp);
    runScript = tmp;
  } catch (e) { log('SYSINFO_PS_COPY_FAIL ' + e.message); }
  try {
    psChild = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runScript],
                    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { log('SYSINFO_PS_SPAWN_FAIL ' + e.message); return; }
  let buf = '';
  psChild.stdout.setEncoding('latin1');   // JSON 全 ASCII，避免 OEM 代码页解码歧义
  psChild.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { psLatest = JSON.parse(line); } catch (e) { /* 非 JSON 行忽略 */ }
    }
    if (buf.length > 65536) buf = '';        // 防御：异常输出不无限增长
  });
  psChild.stderr.on('data', (d) => {
    const t = String(d).trim();
    if (t) log('SYSINFO_PS_ERR ' + t.slice(0, 200));
  });
  psChild.on('exit', (code) => { psChild = null; log('SYSINFO_PS_EXIT ' + code); });
  log('SYSINFO_PS_START');
}

function stopPs() {
  if (!psChild) return;
  try { psChild.kill(); } catch (e) {}
  psChild = null; log('SYSINFO_PS_STOP');
}

function sample() {
  const base = Object.assign({}, memInfo(), { cpuUsage: cpuUsagePct(), disks: diskInfo() });
  const merged = Object.assign({}, base, psLatest || {});
  // GPU 与内存频率来自 PS；还没采到时给 null，UI 会显示 —— 而不是假数
  if (!psLatest) { merged.gpu = null; merged.cpuFreqMHz = null; merged.ramSpeedMHz = null; }
  merged.ready = !!(psLatest && psLatest.gpu);
  last = merged;
  try { onData(merged); } catch (e) { log('SYSINFO_CB_ERR ' + e.message); }
  return merged;
}

/** 开始监视（菜单打开时调，幂等） */
function start(cb, logger) {
  if (cb) onData = cb;
  if (logger) log = logger;
  if (reapTimer) { clearTimeout(reapTimer); reapTimer = null; }
  startPs();
  if (!timer) {
    cpuUsagePct();                            // 先做一次基线采样，第二次才有差值
    sample();
    timer = setInterval(sample, TICK_MS);
    if (timer.unref) timer.unref();
  }
  setTimeout(sample, 1200);                   // PS 首行到达后再刷一次
}

/** 停止高频采样（菜单关闭时调）；进程留一小段缓存后自动收掉 */
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (reapTimer) clearTimeout(reapTimer);
  reapTimer = setTimeout(() => { stopPs(); reapTimer = null; }, REAP_MS);
  if (reapTimer.unref) reapTimer.unref();
}

/** 进程退出时彻底收干净（不留孤儿 powershell） */
function dispose() {
  if (timer) { clearInterval(timer); timer = null; }
  if (reapTimer) { clearTimeout(reapTimer); reapTimer = null; }
  stopPs();
}

function latest() { return last; }

module.exports = { start, stop, dispose, latest, sample };
