// 在线升级状态机（Electron 端）
//
// 规格：在线升级-共享规格.md §4（命令/phase）、§5（磁盘布局）、§7（拒绝条件）、§8（安全）
//
// 磁盘布局（§5，全部在 %LOCALAPPDATA%\catwhale-update\ 下；**只从 process.env 解析**，
// 因为验收台是靠改环境变量来隔离的，用 shell API 取 KnownFolder 就读不到隔离值）：
//   state.json / last-result.json / v<VER>\package.zip / v<VER>\staging\ / v<VER>\package.sha256
//   apply-<ts>.cmd / apply-<ts>.log
//
// 本文件不 import electron（惰性 require），所以能在纯 node 下被 require（单测用）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { checkUpdate, evaluateAutoUpdate, parseSums, isAllowedAssetUrl } = require('./updater.js');
const { buildApplyCmd, stamp } = require('./apply-cmd.js');
const { extractZip, readZipText } = require('./zip-extract.js');

const UPDATE_DIR_NAME = 'catwhale-update';
const PHASE_LABEL = {
  idle: '空闲',
  checking: '正在检查',
  unsupported: '不支持自动升级',
  downloading: '正在下载',
  verifying: '正在校验',
  extracting: '正在解包',
  ready: '已就绪',
  applying: '正在应用',
  error: '失败',
};

function updateRoot(env) {
  const e = env || process.env;
  const base = e.LOCALAPPDATA || '';
  if (!base) return path.join(os.tmpdir(), UPDATE_DIR_NAME);
  return path.join(base, UPDATE_DIR_NAME);
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* 留给下次启动清理 */ }
}

function sha256File(file, onStep) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let read = 0;
    const rs = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    rs.on('data', (c) => { h.update(c); read += c.length; if (onStep) { try { onStep(read); } catch (e) {} } });
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

/* ------------------------------------------------------------------ 下载 */

function makeCtl() {
  let aborted = false;
  const cbs = [];
  return {
    get aborted() { return aborted; },
    abort() { if (aborted) return; aborted = true; cbs.forEach((cb) => { try { cb(); } catch (e) {} }); },
    onAbort(cb) { if (aborted) { try { cb(); } catch (e) {} } else cbs.push(cb); },
  };
}

function nodeDownload(url, destPath, opts, ctl) {
  const onProgress = opts.onProgress || (() => {});
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, val) => { if (settled) return; settled = true; err ? reject(err) : resolve(val); };
    const go = (u, hops) => {
      if (hops > 8) return done(new Error('重定向次数过多'));
      let parsed = null;
      try { parsed = new URL(u); } catch (e) { return done(new Error('下载地址无效')); }
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.get(parsed, { headers: { 'User-Agent': 'catwhale-pet-updater', 'Accept': '*/*' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return go(new URL(res.headers.location, u).toString(), hops + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return done(new Error('下载失败：HTTP ' + res.statusCode)); }
        const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let received = 0;
        let lastT = Date.now();
        let lastB = 0;
        const ws = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          received += chunk.length;
          const now = Date.now();
          onProgress({ received, total, bytesPerSec: now > lastT ? Math.round(((received - lastB) * 1000) / (now - lastT)) : 0 });
          if (now - lastT > 500) { lastT = now; lastB = received; }
        });
        res.on('error', (e) => { try { ws.destroy(); } catch (x) {} done(e); });
        ws.on('error', (e) => done(e));
        ws.on('finish', () => {
          if (total && received !== total) return done(new Error(`下载不完整（${received}/${total} 字节）`));
          done(null, { received, total });
        });
        res.pipe(ws);
      });
      req.on('error', (e) => done(e));
      ctl.onAbort(() => { try { req.destroy(new Error('已取消')); } catch (e) {} });
    };
    go(url, 0);
  });
}

function netDownload(net, url, destPath, opts, ctl) {
  const onProgress = opts.onProgress || (() => {});
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, val) => { if (settled) return; settled = true; err ? reject(err) : resolve(val); };
    let req = null;
    try {
      req = net.request({ url, method: 'GET', redirect: 'follow' });
    } catch (e) { return done(e); }
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        try { res.resume(); } catch (e) {}
        return done(new Error('下载失败：HTTP ' + res.statusCode));
      }
      const rawLen = res.headers['content-length'];
      const total = parseInt(Array.isArray(rawLen) ? rawLen[0] : rawLen, 10) || 0;
      let received = 0;
      let lastT = Date.now();
      let lastB = 0;
      const ws = fs.createWriteStream(destPath);
      res.on('data', (chunk) => {
        received += chunk.length;
        const now = Date.now();
        onProgress({ received, total, bytesPerSec: now > lastT ? Math.round(((received - lastB) * 1000) / (now - lastT)) : 0 });
        if (now - lastT > 500) { lastT = now; lastB = received; }
        try { ws.write(chunk); } catch (e) {}
      });
      res.on('end', () => { try { ws.end(); } catch (e) {} });
      res.on('error', (e) => { try { ws.destroy(); } catch (x) {} done(e); });
      ws.on('error', (e) => done(e));
      ws.on('finish', () => {
        if (total && received !== total) return done(new Error(`下载不完整（${received}/${total} 字节）`));
        done(null, { received, total });
      });
    });
    req.on('error', (e) => done(e));
    ctl.onAbort(() => { try { req.abort(); } catch (e) {} });
    req.end();
  });
}

/* --------------------------------------------------- 包结构与包内清单校验 */

/** 找「包根」：解包根目录直接有主 exe → 就是它；否则恰好一个子目录里有 → 那个子目录 */
function findPackageRoot(extractDir, exeName) {
  if (fs.existsSync(path.join(extractDir, exeName))) return extractDir;
  let subs = [];
  try { subs = fs.readdirSync(extractDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch (e) { throw new Error('解包目录读不出来：' + e.message); }
  const hits = subs.filter((n) => fs.existsSync(path.join(extractDir, n, exeName)));
  if (hits.length === 1) return path.join(extractDir, hits[0]);
  if (hits.length === 0) throw new Error(`升级包里没有找到本端主程序（${exeName}）`);
  throw new Error(`升级包里有 ${hits.length} 个目录都含主程序，无法确定包根`);
}

/** §8.3 结构校验 */
function validatePackage(pkgRoot, exeName, kind = 'electron') {
  const exe = path.join(pkgRoot, exeName);
  if (!fs.existsSync(exe)) throw new Error(`升级包里没有主程序 ${exeName}`);
  const st = fs.statSync(exe);
  if (!st.isFile() || st.size < 1024) throw new Error(`升级包里的主程序不完整（${st.size} 字节）`);
  if (kind === 'electron') {
    const pkgJson = path.join(pkgRoot, 'resources', 'app', 'package.json');
    if (!fs.existsSync(pkgJson)) throw new Error('升级包结构不对：缺少 resources\\app\\package.json');
  }
  return true;
}

/**
 * 包内自带 SHA256SUMS.txt 时逐个校验（§8.3）。
 * 名字先按解包根解析、再按包根解析 —— 带包裹目录的包，清单里的名字常带包裹前缀。
 * 清单里全是「包外的文件名」（比如 zip 自身）时，一个都对不上，此时不拦（那不是文件清单）。
 */
function verifyInnerSums(pkgRoot, extractDir, sumsText) {
  const sums = parseSums(sumsText);
  const names = Object.keys(sums);
  if (!names.length) return { checked: 0 };
  let checked = 0;
  for (const name of names) {
    const cands = [path.join(extractDir, name), path.join(pkgRoot, name)];
    const hit = cands.find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
    if (!hit) continue;
    const actual = crypto.createHash('sha256').update(fs.readFileSync(hit)).digest('hex');
    if (actual.toLowerCase() !== sums[name]) {
      throw new Error(`包内文件校验失败：${name}`);
    }
    checked += 1;
  }
  return { checked };
}

/* ------------------------------------------------------------------ 引擎 */

class UpdateEngine {
  constructor(opts = {}) {
    this.env = opts.env || process.env;
    this.installDir = opts.installDir || path.dirname(process.execPath);
    this.exeName = opts.exeName || path.basename(process.execPath);
    this.currentVersion = opts.currentVersion || '';
    this.end = opts.end || 'electron';
    this.platform = opts.platform || process.platform;
    this.arch = opts.arch || process.arch;
    this.isDev = opts.isDev !== undefined ? opts.isDev : !!process.defaultApp;
    this.relaunchArgs = Array.isArray(opts.relaunchArgs) ? opts.relaunchArgs : process.argv.slice(1);
    this.root = opts.root || updateRoot(this.env);
    this.onState = opts.onState || (() => {});
    this.quit = opts.quit || (() => {});
    this.log = opts.log || ((s) => { try { console.log(s); } catch (e) {} });
    this.debugApi = !!this.env.CATWHALE_UPDATE_API;
    this.assetPattern = this.env.CATWHALE_UPDATE_ASSET || '';
    this.state = this._blank();
    this.release = null;
    this._inflight = null;
    this._ctl = null;
    this._cancelled = false;
    this._lastEmit = 0;
    this._emitTimer = null;
    this._stats = null;
  }

  _blank() {
    return { phase: 'idle', percent: 0, received: 0, total: 0, bytesPerSec: 0, error: '',
      targetVersion: '', readyToRestart: false, updatedAt: Date.now() };
  }

  snapshot() { return { ...this.state }; }

  _persist() {
    try {
      fs.mkdirSync(this.root, { recursive: true });
      const tmp = path.join(this.root, 'state.json.tmp');
      fs.writeFileSync(tmp, JSON.stringify({ ...this.state, pid: process.pid }, null, 1), 'utf8');
      fs.renameSync(tmp, path.join(this.root, 'state.json'));
    } catch (e) { /* 状态快照写不进去不该影响升级本身 */ }
  }

  _emit(force) {
    const now = Date.now();
    const fire = () => { this._lastEmit = Date.now(); const s = this.snapshot(); try { this.onState(s); } catch (e) {} };
    if (force || now - this._lastEmit >= 200) { fire(); return; }
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => { this._emitTimer = null; fire(); }, Math.max(20, 200 - (now - this._lastEmit)));
  }

  setState(patch, force) {
    const prevPhase = this.state.phase;
    this.state = { ...this.state, ...patch, updatedAt: Date.now() };
    const phaseChanged = this.state.phase !== prevPhase;
    // state.json 只在阶段变化/显式要求时落盘（下载时每块都写会把盘刷爆）
    const now = Date.now();
    if (phaseChanged || force || now - (this._lastPersist || 0) > 1000) {
      this._lastPersist = now;
      this._persist();
    }
    this._emit(force || phaseChanged);
    if (phaseChanged) {
      this.log('UPDATE_PHASE ' + JSON.stringify({ phase: this.state.phase, percent: Math.round(this.state.percent || 0),
        error: this.state.error || '', target: this.state.targetVersion || '' }));
    }
  }

  /* ---- 环境事实（§7）---- */

  _canWriteDir(dir) {
    try {
      const p = path.join(dir, `.cw-write-probe-${process.pid}-${Date.now()}`);
      fs.writeFileSync(p, 'probe');
      fs.unlinkSync(p);
      return true;
    } catch (e) { return false; }
  }

  _sameVolume(a, b) {
    try { return fs.statSync(a).dev === fs.statSync(b).dev; } catch (e) { return true; }
  }

  envFacts() {
    return {
      isDev: this.isDev,
      platformOk: this.platform === 'win32' && this.arch === 'x64',
      installWritable: this.isDev ? true : this._canWriteDir(this.installDir),
      parentWritable: this.isDev ? true : this._canWriteDir(path.dirname(this.installDir)),
      sameVolume: this.isDev ? true : this._sameVolume(this.installDir, this.root),
    };
  }

  /* ---- update:check ---- */

  async check() {
    this.setState({ phase: 'checking', error: '', percent: 0, received: 0, total: 0, bytesPerSec: 0, readyToRestart: false }, true);
    const facts = this.envFacts();
    let res = null;
    try {
      res = await checkUpdate({
        currentVersion: this.currentVersion,
        apiUrl: this.env.CATWHALE_UPDATE_API || '',
        end: this.end,
        assetPattern: this.assetPattern,
        allowInsecure: this.debugApi,
      });
    } catch (e) {
      res = { ok: false, error: (e && e.message) || String(e), currentVersion: this.currentVersion };
    }
    if (!res || !res.ok) {
      const error = (res && res.error) || '检查更新失败';
      this.setState({ phase: 'error', error });
      return { ok: false, currentVersion: this.currentVersion, canAutoUpdate: false, reason: error, ...(res || {}) };
    }
    const verdict = evaluateAutoUpdate({
      ...facts,
      assetCount: res.assetCount || 0,
      sumsAsset: !!res.hasSumsAsset,
      expectedSha256: res.expectedSha256 || '',
    });
    let canAutoUpdate = verdict.canAutoUpdate;
    let reason = verdict.reason;
    if (canAutoUpdate && res.assetUrl && !isAllowedAssetUrl(res.assetUrl, { debug: this.debugApi })) {
      canAutoUpdate = false;
      reason = '升级包下载地址不是 HTTPS，为安全起见不自动升级';
    }
    const out = { ...res, canAutoUpdate, reason };
    this.release = out;
    this.setState({
      phase: !res.hasUpdate ? 'idle' : (canAutoUpdate ? 'idle' : 'unsupported'),
      targetVersion: res.hasUpdate ? res.latestVersion : '',
      error: '',
    }, true);
    this.log('UPDATE_CHECK_RESULT ' + JSON.stringify({
      hasUpdate: !!res.hasUpdate, latest: res.latestVersion || '', canAutoUpdate, reason,
      asset: res.assetName || '', assetCount: res.assetCount, pick: res.assetPickUsed,
      sums: !!res.hasSumsAsset, expected: (res.expectedSha256 || '').slice(0, 12),
    }));
    return out;
  }

  /* ---- update:download ---- */

  download() {
    const ph = this.state.phase;
    if (ph === 'downloading' || ph === 'verifying' || ph === 'extracting') {
      return { ok: true, already: true, phase: ph };
    }
    if (this._inflight) return { ok: true, already: true, phase: this.state.phase };
    const rel = this.release;
    if (!rel || !rel.hasUpdate) {
      return { ok: false, phase: this.state.phase, error: '没有发现新版本，请先检查更新' };
    }
    if (!rel.canAutoUpdate) {
      this.setState({ phase: 'unsupported', error: rel.reason || '' });
      return { ok: false, phase: 'unsupported', error: rel.reason || '不支持自动升级' };
    }
    this._cancelled = false;
    this._inflight = this._run(rel)
      .catch((e) => this._failDownload(e))
      .finally(() => { this._inflight = null; this._ctl = null; });
    return { ok: true, phase: 'downloading' };
  }

  async _download(url, destPath, onProgress, ctl) {
    if (this.env.CATWHALE_UPDATE_TRANSPORT === 'node') return nodeDownload(url, destPath, { onProgress }, ctl);
    let net = null;
    try { net = require('electron').net; } catch (e) { net = null; }
    if (net && typeof net.request === 'function') return netDownload(net, url, destPath, { onProgress }, ctl);
    return nodeDownload(url, destPath, { onProgress }, ctl);
  }

  async _run(rel) {
    const ver = rel.latestVersion;
    const verDir = path.join(this.root, 'v' + ver);
    fs.mkdirSync(verDir, { recursive: true });
    const zipPath = path.join(verDir, 'package.zip');
    try { fs.unlinkSync(zipPath); } catch (e) {}
    const ctl = makeCtl();
    this._ctl = ctl;
    this.setState({
      phase: 'downloading', percent: 0, received: 0, total: rel.assetSize || 0, bytesPerSec: 0,
      error: '', targetVersion: ver, readyToRestart: false,
    }, true);

    let peak = 0;
    await this._download(rel.assetUrl, zipPath, (p) => {
      if (this._cancelled) return;
      peak = Math.max(peak, p.bytesPerSec || 0);
      this._stats = { received: p.received, total: p.total || rel.assetSize || 0 };
      this.setState({
        received: p.received,
        total: p.total || rel.assetSize || 0,
        percent: p.total ? Math.min(100, (p.received / p.total) * 100) : 0,
        bytesPerSec: p.bytesPerSec || 0,
      });
    }, ctl);
    if (this._cancelled) throw new Error('已取消');

    this.setState({ phase: 'verifying', percent: 100, bytesPerSec: 0 }, true);
    const actual = await sha256File(zipPath);
    const expect = String(rel.expectedSha256 || '').toLowerCase();
    if (!expect || actual.toLowerCase() !== expect) {
      try { fs.unlinkSync(zipPath); } catch (e) {}
      throw new Error(`升级包校验失败（sha256 不匹配），已删除下载的文件（实际 ${actual.slice(0, 16)}…）`);
    }
    fs.writeFileSync(path.join(verDir, 'package.sha256'), `${actual}  ${rel.assetName}\n`, 'utf8');
    this.log('UPDATE_SHA256_OK ' + JSON.stringify({ file: rel.assetName, sha: actual.slice(0, 16), bytes: fs.statSync(zipPath).size }));

    this.setState({ phase: 'extracting', percent: 100, bytesPerSec: 0 }, true);
    await this._stageZip({
      zipPath, verDir,
      onStep: (s) => { if (s && s.files) this.setState({ percent: 100 }); },
    });
    this.setState({ phase: 'ready', percent: 100, received: this.state.total, bytesPerSec: 0,
      readyToRestart: true, error: '' }, true);
    this.log('UPDATE_READY ' + JSON.stringify({ version: ver, staging: path.join(verDir, 'staging') }));
    return { ok: true, phase: 'ready' };
  }

  async _stageZip({ zipPath, verDir, onStep }) {
    const staging = path.join(verDir, 'staging');
    const extractDir = path.join(verDir, 'extract');
    if (path.resolve(staging) === path.resolve(this.installDir)) {
      throw new Error('staging 目录与安装目录相同，拒绝继续（会自己搬自己）');
    }
    rmrf(staging);
    rmrf(extractDir);
    await extractZip(zipPath, extractDir, { onStep });
    const pkgRoot = findPackageRoot(extractDir, this.exeName);
    validatePackage(pkgRoot, this.exeName, this.end);
    const inner = readZipText(zipPath, 'SHA256SUMS.txt');
    if (inner) {
      const r = verifyInnerSums(pkgRoot, extractDir, inner);
      if (r.checked) this.log('UPDATE_INNER_SUMS checked=' + r.checked);
    }
    // staging 的**内容**必须是包根内容（§6：这样 move STAGE INSTALL 才能一步到位）
    fs.renameSync(pkgRoot, staging);
    if (path.resolve(pkgRoot) !== path.resolve(extractDir)) rmrf(extractDir);
    if (!fs.existsSync(path.join(staging, this.exeName))) {
      throw new Error('解包后 staging 里没有主程序，拒绝继续');
    }
    if (!this._sameVolume(this.installDir, staging)) {
      throw new Error('升级包目录与程序目录不在同一个盘，无法安全替换');
    }
    return { staging, pkgRoot };
  }

  _failDownload(e) {
    const msg = (e && e.message) || String(e);
    try { rmrf(path.join(this.root, 'v' + (this.state.targetVersion || '0'), 'extract')); } catch (x) {}
    if (this._cancelled) {
      this.setState({ phase: 'idle', error: '', percent: 0, received: 0, total: 0, bytesPerSec: 0, readyToRestart: false }, true);
      return;
    }
    this.log('UPDATE_FAILED ' + JSON.stringify({ error: msg }));
    this.setState({ phase: 'error', error: msg, bytesPerSec: 0, readyToRestart: false }, true);
  }

  /* ---- update:stage（下载流程里已经自动做过，这里给单独调用留口）---- */

  async stage() {
    if (this.state.phase === 'ready') return { ok: true, phase: 'ready' };
    if (this.state.phase === 'downloading' || this.state.phase === 'verifying' || this.state.phase === 'extracting') {
      return { ok: false, phase: this.state.phase, error: '正在下载/校验中，等它自己跑完' };
    }
    const ver = this.state.targetVersion;
    if (!ver) return { ok: false, phase: this.state.phase, error: '还没有确定目标版本' };
    const verDir = path.join(this.root, 'v' + ver);
    const zipPath = path.join(verDir, 'package.zip');
    if (!fs.existsSync(zipPath)) return { ok: false, phase: this.state.phase, error: '还没有下载好的升级包' };
    const expect = String((this.release && this.release.expectedSha256) || '').toLowerCase();
    this.setState({ phase: 'verifying' }, true);
    const actual = await sha256File(zipPath);
    if (!expect || actual.toLowerCase() !== expect) {
      try { fs.unlinkSync(zipPath); } catch (e) {}
      this.setState({ phase: 'error', error: '升级包校验失败（sha256 不匹配）' }, true);
      return { ok: false, phase: 'error', error: '升级包校验失败（sha256 不匹配）' };
    }
    this.setState({ phase: 'extracting' }, true);
    try {
      await this._stageZip({ zipPath, verDir });
    } catch (e) {
      this.setState({ phase: 'error', error: (e && e.message) || String(e) }, true);
      return { ok: false, phase: 'error', error: (e && e.message) || String(e) };
    }
    this.setState({ phase: 'ready', readyToRestart: true }, true);
    return { ok: true, phase: 'ready' };
  }

  /* ---- update:cancel ---- */

  cancel() {
    this._cancelled = true;
    try { if (this._ctl) this._ctl.abort(); } catch (e) {}
    const ver = this.state.targetVersion;
    if (ver) {
      try { fs.unlinkSync(path.join(this.root, 'v' + ver, 'package.zip')); } catch (e) {}
      rmrf(path.join(this.root, 'v' + ver, 'extract'));
    }
    this.setState({ phase: 'idle', percent: 0, received: 0, total: 0, bytesPerSec: 0, error: '',
      readyToRestart: false }, true);
    return { ok: true };
  }

  /* ---- update:apply ---- */

  apply() {
    const ph = this.state.phase;
    if (ph === 'downloading' || ph === 'extracting' || ph === 'verifying') {
      return { ok: false, error: `正在${PHASE_LABEL[ph] || ph}，现在不能替换安装目录` };
    }
    if (ph !== 'ready') return { ok: false, error: '升级包还没准备好（先检查更新并下载）' };
    const ver = this.state.targetVersion;
    const staging = path.join(this.root, 'v' + ver, 'staging');
    if (!fs.existsSync(path.join(staging, this.exeName))) {
      return { ok: false, error: 'staging 里没有主程序，请重新下载' };
    }
    if (!this._sameVolume(this.installDir, staging)) {
      this.setState({ phase: 'unsupported', error: '升级包目录与程序目录不在同一个盘，无法安全替换' }, true);
      return { ok: false, error: '升级包目录与程序目录不在同一个盘，无法安全替换' };
    }
    const ts = stamp();
    const backupDir = this.installDir + '.bak-' + ts;
    const logName = `apply-${ts}.log`;
    let built = null;
    try {
      built = buildApplyCmd({
        installDir: this.installDir,
        stageDir: staging,
        exeName: this.exeName,
        pid: process.pid,
        backupDir,
        updateDir: this.root,
        logName,
        fromVersion: this.currentVersion,
        toVersion: ver,
        relaunchArgs: this.relaunchArgs,
        atUnix: Math.floor(Date.now() / 1000),
      });
    } catch (e) {
      this.setState({ phase: 'error', error: '生成升级脚本失败：' + ((e && e.message) || e) }, true);
      return { ok: false, error: '生成升级脚本失败：' + ((e && e.message) || e) };
    }
    const cmdPath = path.join(this.root, `apply-${ts}.cmd`);
    try {
      fs.mkdirSync(this.root, { recursive: true });
      // 脚本纯 ASCII、无 BOM；中文路径通过环境变量传给子进程（见 apply-cmd.js 顶部说明）
      fs.writeFileSync(cmdPath, built.cmd, 'utf8');
    } catch (e) {
      return { ok: false, error: '写升级脚本失败：' + ((e && e.message) || e) };
    }
    this.setState({ phase: 'applying' }, true);
    try { fs.writeFileSync(path.join(this.root, 'apply-last.cmd'), built.cmd, 'utf8'); } catch (e) {}
    // cwd 必须离开安装目录 —— 任何进程把安装目录当 CWD，move "<INSTALL>" 就必然失败
    const comspec = process.env.ComSpec || 'cmd.exe';
    let child = null;
    try {
      child = spawn(comspec, ['/c', cmdPath], {
        cwd: this.root, detached: true, stdio: 'ignore', windowsHide: true,
        env: { ...process.env, ...built.env },
      });
      child.unref();
    } catch (e) {
      this.setState({ phase: 'error', error: '启动升级脚本失败：' + ((e && e.message) || e) }, true);
      return { ok: false, error: '启动升级脚本失败：' + ((e && e.message) || e) };
    }
    this.log('UPDATE_APPLY ' + JSON.stringify({ cmd: path.basename(cmdPath), install: this.installDir,
      stage: staging, bak: path.basename(backupDir), to: ver }));
    const willQuitAt = Date.now() + 600;
    setTimeout(() => { try { this.quit(); } catch (e) {} }, 600);
    return { ok: true, willQuitAt, cmdPath, logPath: path.join(this.root, logName) };
  }

  /* ---- 启动后：读回执 + 清理 ---- */

  readLastResult() {
    try {
      const p = path.join(this.root, 'last-result.json');
      const st = fs.statSync(p);
      const raw = fs.readFileSync(p, 'utf8');
      const obj = JSON.parse(raw);
      return { ...obj, mtimeMs: st.mtimeMs, path: p };
    } catch (e) { return null; }
  }

  /** 升级回执 → 给用户看的一句话（10 分钟内才提示，避免每次启动都叨叨） */
  startupReport() {
    const r = this.readLastResult();
    if (!r) return null;
    const fresh = Date.now() - (r.mtimeMs || 0) < 10 * 60 * 1000;
    if (r.result === 'ok') {
      if (!fresh) return null;
      return { kind: 'ok', text: `已升级到 v${r.to || this.currentVersion}` };
    }
    if (r.result === 'failed') {
      const log = r.log || r.logPath || '';
      return { kind: 'failed', text: `上次升级失败${r.error ? '（' + r.error + '）' : ''}，已保留旧版本${log ? '，日志：' + log : ''}` };
    }
    return null;
  }

  /** §5 启动清理：v* 只留最近一次；.bak-* 不删（可能正被脚本用），只报告 */
  cleanupOld(maxAgeMs) {
    const out = { removed: [], kept: [], baks: [] };
    let dirs = [];
    try { dirs = fs.readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory() && /^v\d/.test(d.name)).map((d) => d.name); }
    catch (e) { return out; }
    const now = Date.now();
    const maxAge = maxAgeMs || 3 * 24 * 60 * 60 * 1000;
    for (const name of dirs) {
      const full = path.join(this.root, name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch (e) { continue; }
      if (now - mtime > maxAge) { rmrf(full); out.removed.push(name); } else out.kept.push(name);
    }
    try {
      const parent = path.dirname(this.installDir);
      out.baks = fs.readdirSync(parent).filter((n) => n.includes('.bak-'));
    } catch (e) {}
    return out;
  }
}

module.exports = {
  UpdateEngine,
  updateRoot,
  sha256File,
  findPackageRoot,
  validatePackage,
  PHASE_LABEL,
  UPDATE_DIR_NAME,
};
