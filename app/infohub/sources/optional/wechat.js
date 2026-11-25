'use strict';
/* =====================================================================
   infohub/sources/wechat.js —— 微信消息（Windows 通知中心，尽力而为）
   ---------------------------------------------------------------------
   原理：微信在 Windows 上收到消息时会往「通知中心」推一条 toast。
   本模块定时跑 wechat_probe.ps1（WinRT UserNotificationListener / UIA 兜底）
   把通知中心里的条目读出来，过滤应用名/AUMID 含 微信|WeChat|Weixin 的条目，
   按通知 id 去重后转成统一事件。

   重要：微信 4.x（Weixin.exe）默认不再把聊天消息推给通知中心，只有系统级
   提示（如「已登录」）偶尔出现；3.x 的 AUMID TencentWeChatLimited.forWindows10
   才稳定有 toast。所以本模块默认 enabled:false，探测不到就如实报告，
   绝不上报假消息。

   契约 §4.2：轮询 3s；拿不到就把原因写进 status().detail。
   ===================================================================== */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PS1 = path.join(__dirname, 'wechat_probe.ps1');
const BODY_MAX = 90;
const PS_TIMEOUT = 15000;          // 子进程超时（契约：≤20s）
const DEFAULT_POLL = 3;            // 3 秒轮询

/** 微信条目的应用名/AUMID 特征 */
const WECHAT_RE = /微信|wechat|weixin/i;

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

function clip(text, max) {
  const s = clean(text);
  const n = max || BODY_MAX;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** 判断一条通知是不是微信的 */
function isWechat(item) {
  if (!item) return false;
  return WECHAT_RE.test(clean(item.app) + ' ' + clean(item.aumid));
}

/**
 * 通知条目 → 归一化事件（纯函数，单测用）
 * @param {object} item  {app,aumid,id,title,body,creation}
 * @param {object} [opts] { selfHint }
 */
function toEvent(item, opts) {
  const o = opts || {};
  if (!item || !isWechat(item)) return null;
  const title = clean(item.title);
  const body = clean(item.body);
  if (!title && !body) return null;
  const chatName = title || '微信';
  const key = 'wechat:m:' + clean(item.aumid || item.app) + ':' + clean(item.id);
  const ts = Date.parse(item.creation) || Date.now();
  return {
    source: 'wechat',
    kind: 'message',
    level: /@我|@所有人/.test(body) ? 'warn' : 'info',
    title: ('微信 · ' + chatName).slice(0, 40),
    body: clip(body || title),
    ts,
    key,
    actions: [
      { id: 'copy', label: '复制', kind: 'copy', payload: clip(body || title, 200) },
      { id: 'open', label: '打开微信', kind: 'app', payload: 'wechat' },
    ],
    data: {
      app: clean(item.app),
      aumid: clean(item.aumid),
      notificationId: clean(item.id),
      chatName,
      via: 'windows-notification-center',
      ...(o.selfHint ? { selfHint: o.selfHint } : {}),
    },
  };
}

/** 把 ps1 的 JSON 文本解析成对象；坏 JSON 不抛 */
function parseProbeJson(text) {
  const s = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!s) return { ok: false, error: '探针没有输出' };
  // 只取最后一个 JSON 对象，防止 PS 在前后夹了警告文本
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) return { ok: false, error: '探针输出不是 JSON：' + s.slice(0, 120) };
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    // PowerShell 5.1 的 ConvertTo-Json 会把「只有一个元素的数组」压成对象，这里补回来
    if (obj.items && !Array.isArray(obj.items)) obj.items = [obj.items];
    obj.items = Array.isArray(obj.items) ? obj.items : [];
    return obj;
  } catch (e) {
    return { ok: false, error: '探针 JSON 解析失败：' + e.message };
  }
}

/** 找 PowerShell：Windows PowerShell 优先（UIAutomation/WinRT 都在它上面验过），再试 pwsh */
function findPowerShell() {
  const candidates = [];
  if (process.env.SystemRoot) candidates.push(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  candidates.push('powershell.exe');
  return candidates[0];
}

/* ---------------------------------------------------------------------
   工厂
   --------------------------------------------------------------------- */
module.exports = function create(ctx) {
  const cfg = () => (typeof ctx.cfg === 'function' ? ctx.cfg() || {} : {});
  const log = (m) => { try { ctx.log(m); } catch (e) { /* 忽略 */ } };
  const emit = (e) => { try { ctx.emit(e); } catch (err) { log('emit 失败：' + err.message); } };

  let state = { ready: false, detail: '未启动' };
  let timer = null;
  let stopped = true;
  let seen = new Set();          // 已处理过的通知 key
  let baselineDone = false;
  let last = null;               // 最近一次探针结果
  let tmpFile = null;
  let runs = 0;

  function tmpPath() {
    if (tmpFile) return tmpFile;
    const dir = (ctx && ctx.dataDir) || os.tmpdir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 忽略 */ }
    tmpFile = path.join(dir, '.infohub-wechat-probe.json');
    return tmpFile;
  }

  /**
   * 跑一次探针。永不抛异常，返回 {ok, ...}。
   * @param {object} [opts] { engine, requestAccess }
   */
  function runProbe(opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      const out = tmpPath();
      try { fs.unlinkSync(out); } catch (e) { /* 不存在就算了 */ }
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-OutFile', out];
      if (o.engine) args.push('-Engine', String(o.engine));
      if (o.requestAccess) args.push('-RequestAccess');

      let child;
      try {
        child = spawn(findPowerShell(), args, { windowsHide: true });
      } catch (err) {
        resolve({ ok: false, error: '启动 PowerShell 失败：' + (err && err.message ? err.message : String(err)) });
        return;
      }
      let stderr = '';
      let done = false;
      const finish = (res) => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        resolve(res);
      };
      const killTimer = setTimeout(() => {
        try { child.kill(); } catch (e) { /* 忽略 */ }
        finish({ ok: false, error: 'PowerShell 探针超时（' + Math.round(PS_TIMEOUT / 1000) + 's）' });
      }, PS_TIMEOUT);
      if (typeof killTimer.unref === 'function') killTimer.unref();

      child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += String(d); });
      child.on('error', (err) => finish({ ok: false, error: 'PowerShell 不可用：' + (err && err.message ? err.message : String(err)) }));
      child.on('close', (code) => {
        let text = '';
        try { text = fs.readFileSync(out, 'utf8'); } catch (e) { /* 没生成文件 */ }
        if (!text) {
          finish({ ok: false, error: '探针没产出结果（退出码 ' + code + '）' + (stderr ? '：' + clean(stderr).slice(0, 160) : '') });
          return;
        }
        const parsed = parseProbeJson(text);
        try { fs.unlinkSync(out); } catch (e) { /* 忽略 */ }
        if (parsed && parsed.ok === false && parsed.error) {
          finish({ ok: false, error: parsed.error, access: parsed.access, engine: parsed.engine, count: 0, items: [] });
          return;
        }
        finish(parsed);
      });
    });
  }

  /** 处理一批通知；首轮只建基线 */
  function ingest(res) {
    const items = Array.isArray(res.items) ? res.items : [];
    const wx = items.filter(isWechat);

    if (!baselineDone) {
      for (const it of items) seen.add(clean(it.aumid || it.app) + ':' + clean(it.id));
      baselineDone = true;
      log('建立基线：通知中心 ' + items.length + ' 条，其中微信 ' + wx.length + ' 条（历史条目不弹）');
      return 0;
    }

    let emitted = 0;
    for (const it of wx) {
      const id = clean(it.aumid || it.app) + ':' + clean(it.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const evt = toEvent(it);
      if (!evt) continue;
      emit(evt);
      emitted += 1;
    }
    // 顺手记住非微信条目，避免数量统计漂移
    for (const it of items) seen.add(clean(it.aumid || it.app) + ':' + clean(it.id));
    if (seen.size > 800) seen = new Set(Array.from(seen).slice(-400));   // 防止无限膨胀
    return emitted;
  }

  function setStateFrom(res) {
    if (!res || res.ok === false) {
      state = { ready: false, detail: '通知中心读不到：' + (res && res.error ? res.error : '未知原因') };
      return;
    }
    const wx = (res.items || []).filter(isWechat).length;
    const engine = res.engine === 'uia' ? 'UIA' : 'WinRT';
    if (wx === 0) {
      state = {
        ready: true,
        detail: '运行中（' + engine + '）· 通知中心 ' + (res.count || 0) + ' 条，微信 0 条' +
          '（本机微信当前没往通知中心推消息；微信 4.x 默认不推聊天消息）',
      };
    } else {
      state = { ready: true, detail: '运行中（' + engine + '）· 通知中心 ' + (res.count || 0) + ' 条，微信 ' + wx + ' 条' };
    }
  }

  async function tick() {
    if (stopped) return;
    runs += 1;
    let res;
    try {
      res = await runProbe({});
    } catch (err) {
      res = { ok: false, error: '探针异常：' + (err && err.message ? err.message : String(err)) };
    }
    last = res;
    try { setStateFrom(res); } catch (e) { /* 忽略 */ }
    if (res && res.ok) {
      try {
        const n = ingest(res);
        if (n) log('新微信通知 ' + n + ' 条');
      } catch (e) { log('解析通知失败：' + e.message); }
    } else if (runs === 1) {
      log('首轮探测失败：' + (res && res.error));
    }
    // 每一轮都写一次快照，面板能看到「通知中心里有什么」
    try {
      ctx.snapshot('wechat', {
        ok: !!(res && res.ok),
        engine: res && res.engine,
        access: res && res.access,
        count: (res && res.count) || 0,
        wechatCount: ((res && res.items) || []).filter(isWechat).length,
        items: ((res && res.items) || []).slice(0, 10).map((i) => ({
          app: clean(i.app), title: clip(i.title, 40), creation: i.creation,
        })),
        updatedAt: Date.now(),
      });
    } catch (e) { /* 忽略 */ }
  }

  function scheduleNext() {
    if (stopped) return;
    const sec = Math.max(2, Number(cfg().pollSec) || DEFAULT_POLL);
    timer = setTimeout(async () => {
      timer = null;
      await tick();
      scheduleNext();
    }, sec * 1000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    name: 'wechat',
    label: '微信消息',
    defaults: { enabled: false, pollSec: 3 },

    async start() {
      stopped = false;
      baselineDone = false;
      seen = new Set();
      runs = 0;
      if (!fs.existsSync(PS1)) {
        state = { ready: false, detail: '缺少探针脚本 wechat_probe.ps1' };
        log(state.detail);
        return { ok: false, detail: state.detail };
      }
      state = { ready: false, detail: '首次探测中' };
      await tick();          // 立刻探一次，别等 3 秒
      scheduleNext();
      return { ok: state.ready, detail: state.detail };
    },

    async stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      state = { ready: false, detail: '已停止' };
    },

    status() { return state; },

    async refresh() {
      await tick();
      return { ok: state.ready, detail: state.detail };
    },

    /** 连通性自检：真跑一次 PowerShell，把原始结论带回来 */
    async probe() {
      const res = await runProbe({});
      if (!res.ok) return { ok: false, detail: res.error || '探针失败', raw: { engine: res.engine, access: res.access } };
      const wx = (res.items || []).filter(isWechat);
      return {
        ok: true,
        detail: 'WinRT/UIA 可用（access=' + res.access + '），通知中心 ' + (res.count || 0) + ' 条，微信 ' + wx.length + ' 条',
        count: res.count || 0,
        wechatCount: wx.length,
        engine: res.engine,
        access: res.access,
        sample: (res.items || []).slice(0, 3),
      };
    },
  };
};

module.exports._internals = { toEvent, parseProbeJson, isWechat, clip, WECHAT_RE };

/* ---------------------------------------------------------------------
   命令行自检：node app/infohub/sources/wechat.js --probe
   输出 JSON（真跑 PowerShell 的结果，不做任何美化/伪造）
   --------------------------------------------------------------------- */
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--probe')) {
    const ctx = {
      cfg: () => ({ enabled: true }),
      setCfg: () => {},
      emit: (e) => console.log('[emit] ' + JSON.stringify(e).slice(0, 400)),
      snapshot: () => {},
      log: (m) => console.error('[log] ' + m),
      dataDir: path.join(os.tmpdir(), 'infohub-wechat'),
      appDir: path.join(__dirname, '..', '..'),
      paths: { localAppData: process.env.LOCALAPPDATA, home: os.homedir() },
    };
    const inst = module.exports(ctx);
    const t0 = Date.now();
    Promise.resolve()
      .then(() => inst.probe())
      .then((r) => {
        r.elapsedMs = Date.now() - t0;
        r.ps1 = PS1;
        console.log(JSON.stringify(r, null, 2));
        process.exitCode = r.ok ? 0 : 1;
      })
      .catch((e) => {
        console.log(JSON.stringify({ ok: false, detail: '未捕获异常：' + e.message }, null, 2));
        process.exitCode = 1;
      });
  } else {
    console.log('用法：node app/infohub/sources/wechat.js --probe');
    process.exitCode = 2;
  }
}
