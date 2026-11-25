'use strict';
/* =============================================================================
 * 邮箱验证码源（IMAP 轮询）
 * -----------------------------------------------------------------------------
 * 职责：把「新邮件 → 验证码 → 弹窗」这条链路包装成契约里的统一 source 接口。
 *
 * 设计要点：
 *   1. 基线：首次启动只做一次「SELECT + UID SEARCH UNSEEN」，记下 UIDNEXT-1
 *      作为基线，并把当时的未读 uid 全部塞进 seen，**不弹任何历史邮件**。
 *   2. 轮询：每次都新建连接（IMAP 服务端普遍对长连接有 30 分钟上限，且这里
 *      是 60s 一次的低频场景，短连接反而更稳），SELECT → UID SEARCH UNSEEN →
 *      对 uid > 基线且未见过的邮件 UID FETCH BODY.PEEK[]（PEEK 保证不把用户
 *      的未读标记成已读）。
 *   3. 失败不抛：所有异常在 poll() 里吞掉并写进 status().detail，日志脱敏
 *      （授权码最多出现前 2 位 + 长度）。
 *   4. 定时器 unref()，stop() 里清干净并立刻断开在途连接。
 *
 * 配置：{enabled, host, port:993, user, pass, folder:'INBOX', pollSec:60}
 *       pass 是 IMAP 授权码（不是登录密码），由宿主用 safeStorage 加密存储；
 *       本模块只在内存里拿明文，不落盘、不打日志。
 * ============================================================================= */
const { ImapClient, maskSecret } = require('../lib/imap-lite.js');
const { parseMessage } = require('../lib/mail-parse.js');
const { extractCode } = require('../lib/code-extract.js');

const DEFAULTS = {
  enabled: false,
  host: '',
  port: 993,
  user: '',
  pass: '',
  folder: 'INBOX',
  pollSec: 60,
  timeoutMs: 15000,
  // secure 是给高级场景兜底用的：null = 按端口自动判断（143 明文，其余隐含 TLS）。
  // 契约里的配置项没有它，用户不填就走默认逻辑。
  secure: null
};

const MIN_POLL_SEC = 15;    // 别让用户把自己填成 1 秒，被服务端限流
const MAX_LIST = 20;        // 面板只留最近 20 封
const MAX_PER_POLL = 5;     // 单轮最多抓 5 封，避免一次拉爆
const MAX_TRY = 3;          // 同一封邮件抓取失败 3 次后放弃

function clip(str, max) {
  const s = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function hhmmss(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

module.exports = function create(ctx) {
  const host = ctx || {};
  const readCfg = () => Object.assign({}, DEFAULTS, (typeof host.cfg === 'function' && host.cfg()) || {});
  const emit = (evt) => { try { if (typeof host.emit === 'function') host.emit(evt); } catch (e) { /* 宿主异常不影响轮询 */ } };
  const snapshot = (kind, data) => { try { if (typeof host.snapshot === 'function') host.snapshot(kind, data); } catch (e) { /* 同上 */ } };
  const log = (msg) => { try { if (typeof host.log === 'function') host.log(String(msg)); } catch (e) { /* 同上 */ } };

  let timer = null;
  let stopped = true;
  let busy = false;
  let client = null;
  let baselineUid = null;           // null = 还没建立基线
  const seen = new Set();           // 已处理（或已判定跳过）的 uid
  const tries = new Map();          // uid → 失败次数
  let list = [];                    // 面板快照用的最近邮件
  let state = { ready: false, detail: '未启动' };

  /** 错误信息脱敏：万一服务端把凭据回显出来，也只留前 2 位 + 长度。 */
  function safeMsg(err) {
    let s = String((err && err.message) || err || '未知错误');
    const pass = String(readCfg().pass || '');
    if (pass.length >= 3) s = s.split(pass).join(maskSecret(pass));
    return clip(s, 200);
  }

  function cfgProblem(cfg) {
    if (!cfg.enabled) return '未启用（设置里开启并填 IMAP 授权码）';
    if (!cfg.host) return '缺少 IMAP 服务器地址';
    if (!cfg.user) return '缺少邮箱账号';
    if (!cfg.pass) return '缺少 IMAP 授权码（不是登录密码）';
    return '';
  }

  /** 新建一条连接并登录。调用方负责 logout/close。 */
  async function connectClient(cfg) {
    const port = Number(cfg.port) || 993;
    // 993（以及自定义端口）默认走隐含 TLS；143 是明文端口（需要 STARTTLS，本模块不支持）。
    // cfg.secure 显式给了就听它的（测试/自建服务器会用到）。
    const secure = cfg.secure === true || cfg.secure === false ? cfg.secure : port !== 143;
    const c = new ImapClient({
      host: cfg.host,
      port,
      secure,
      timeout: Number(cfg.timeoutMs) || DEFAULTS.timeoutMs,
      log: (m) => log(m)
    });
    await c.connect();
    await c.login(cfg.user, cfg.pass);
    return c;
  }

  function pushList(item) {
    list = [item].concat(list).slice(0, MAX_LIST);
  }

  /**
   * 走一轮：连接 → SELECT → SEARCH UNSEEN → 抓新邮件 → 解析 → 抽码 → 上报。
   * 永不抛错。
   */
  async function poll() {
    const cfg = readCfg();
    const bad = cfgProblem(cfg);
    if (bad) {
      state = { ready: false, detail: bad };
      return { ok: false, detail: bad };
    }
    if (busy) return { ok: false, detail: '上一轮仍在进行' };
    if (stopped) return { ok: false, detail: '已停止' };

    busy = true;
    let conn = null;
    let fetched = 0;
    try {
      conn = await connectClient(cfg);
      client = conn;
      const box = await conn.select(cfg.folder || 'INBOX');
      const unread = await conn.uidSearch('UNSEEN');

      // ---- 首次：只建基线 ----
      if (baselineUid === null) {
        baselineUid = Number.isFinite(box.uidNext) ? box.uidNext - 1
          : (unread.length ? unread[unread.length - 1] : 0);
        for (const u of unread) seen.add(u);
        log(`首次连接：UID 基线 ${baselineUid}，跳过 ${unread.length} 封历史未读（不弹历史）`);
        state = { ready: true, detail: `运行中（基线 ${baselineUid}，${box.exists == null ? '?' : box.exists} 封邮件）` };
        snapshot('mail', { list: list.slice(), unread: unread.length, updatedAt: Date.now(), baseline: baselineUid });
        return { ok: true, baseline: baselineUid, skipped: unread.length };
      }

      // ---- 之后：只处理基线之上的新未读 ----
      const fresh = unread.filter((u) => u > baselineUid && !seen.has(u)).sort((a, b) => a - b);
      for (const uid of fresh.slice(0, MAX_PER_POLL)) {
        if (stopped) break;
        try {
          const raw = await conn.uidFetchBody(uid);
          const mail = parseMessage(raw);
          const got = extractCode({ subject: mail.subject, text: mail.text });
          seen.add(uid);
          tries.delete(uid);
          fetched++;

          const fromName = (mail.from && (mail.from.name || mail.from.address)) || '未知发件人';
          const subject = mail.subject || '(无主题)';
          const item = {
            uid,
            from: clip(fromName, 40),
            address: (mail.from && mail.from.address) || '',
            subject: clip(subject, 120),
            code: got.code || '',
            ts: Date.now()
          };
          pushList(item);
          log(`新邮件 uid=${uid} 来自 ${item.from}：${got.code ? '验证码 ' + got.code : '无验证码'}（${clip(subject, 40)}）`);

          emit({
            source: 'mail',
            kind: 'mail',
            level: got.code ? 'warn' : 'info',
            title: `邮件 · ${clip(fromName, 24)}`,
            body: clip(got.code ? `验证码 ${got.code}｜${subject}` : subject, 90),
            ts: Date.now(),
            key: `mail:${cfg.host}:${uid}`,      // 同一封邮件只弹一次
            actions: got.code
              ? [
                { id: 'copy', label: '复制验证码', kind: 'copy', payload: got.code },
                { id: 'open', label: '打开邮箱', kind: 'app', payload: 'mail' }
              ]
              : [{ id: 'open', label: '打开邮箱', kind: 'app', payload: 'mail' }],
            data: {
              uid,
              subject,
              from: fromName,
              address: item.address,
              code: got.code || '',
              context: got.context || '',
              date: mail.date || ''
            }
          });
        } catch (e) {
          // 单封失败不影响整轮：记次数，超过 MAX_TRY 就不再纠缠
          const n = (tries.get(uid) || 0) + 1;
          tries.set(uid, n);
          if (n >= MAX_TRY) seen.add(uid);
          log(`抓取 uid=${uid} 失败（第 ${n} 次，${n >= MAX_TRY ? '放弃' : '下轮重试'}）：${safeMsg(e)}`);
        }
      }

      snapshot('mail', {
        list: list.slice(),
        unread: unread.length,
        updatedAt: Date.now(),
        baseline: baselineUid
      });
      state = { ready: true, detail: `运行中，${hhmmss(Date.now())} 检查，未读 ${unread.length} 封` };
      return { ok: true, fetched, unread: unread.length };
    } catch (e) {
      const msg = safeMsg(e);
      state = { ready: false, detail: `连接失败：${msg}` };
      log(`轮询失败：${msg}`);
      return { ok: false, detail: msg };
    } finally {
      busy = false;
      if (conn) {
        client = null;
        try { await conn.logout(); } catch (e) { try { conn.close(); } catch (e2) { /* 忽略 */ } }
      }
    }
  }

  return {
    name: 'mail',
    label: '邮箱验证码',
    defaults: Object.assign({}, DEFAULTS),

    async start() {
      await this.stop();
      stopped = false;
      const cfg = readCfg();
      const bad = cfgProblem(cfg);
      if (bad) {
        state = { ready: false, detail: bad };
        log(`未启动：${bad}`);
        return;
      }
      state = { ready: false, detail: '连接中…' };
      log(`启动：${cfg.user} @ ${cfg.host}:${Number(cfg.port) || 993}/${cfg.folder || 'INBOX'}，授权码 ${maskSecret(cfg.pass)}，间隔 ${cfg.pollSec}s`);
      await poll();                       // 首轮顺便建基线
      if (stopped) return;                // 首轮期间被 stop() 掉了，别再挂定时器
      const every = Math.max(MIN_POLL_SEC, Number(cfg.pollSec) || DEFAULTS.pollSec) * 1000;
      timer = setInterval(() => { poll().catch(() => {}); }, every);
      if (timer.unref) timer.unref();
    },

    async stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
      const c = client;
      client = null;
      if (c) { try { c.close(); } catch (e) { /* 忽略 */ } }   // 打断在途请求
      if (state.ready) state = { ready: false, detail: '已停止' };
    },

    status() { return Object.assign({}, state); },

    async refresh() { return poll(); },

    /** 连通性自检：只登录 + SELECT，不抓正文，不建基线。 */
    async probe() {
      const cfg = readCfg();
      const bad = cfgProblem(cfg);
      if (bad) return { ok: false, detail: bad };
      let conn = null;
      try {
        conn = await connectClient(cfg);
        const box = await conn.select(cfg.folder || 'INBOX');
        return {
          ok: true,
          detail: `登录成功：${cfg.folder || 'INBOX'} 共 ${box.exists == null ? '?' : box.exists} 封，UIDNEXT=${box.uidNext == null ? '?' : box.uidNext}`
        };
      } catch (e) {
        return { ok: false, detail: safeMsg(e) };
      } finally {
        if (conn) { try { await conn.logout(); } catch (e) { try { conn.close(); } catch (e2) { /* 忽略 */ } } }
      }
    },

    /** 面板拿最近邮件列表（宿主也可以只用 snapshot）。 */
    getList() { return list.slice(); }
  };
};
