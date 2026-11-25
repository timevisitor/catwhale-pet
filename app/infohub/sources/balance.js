'use strict';
/**
 * infohub 源 · AI 额度（balance）
 *
 * 支持三类适配器：
 *   deepseek      —— GET https://api.deepseek.com/user/balance
 *   puretokens    —— GET console/api-keys/usage（Bearer）→ total_available
 *                    再 GET console/status（不带 key）→ quota_per_unit 换算金额
 *   openai_billing—— GET {base_url}/dashboard/billing/credit_grants（可选，失败静默）
 *
 * 约定（见 docs/infohub-contract.md §0 / §4.5）：
 *   - 只用 Node 内置模块，零第三方依赖；
 *   - 所有请求 15s 超时，错误一律收敛成 snapshot 里的 ok:false，不抛顶层；
 *   - 日志/事件/快照里绝不出现密钥明文；
 *   - 定时器 unref()，stop() 里清干净并中断在途请求。
 *
 * 说明：console.status 实测返回 {success:true,data:{quota_per_unit:500000,quota_display_type:"USD"}}，
 * 即「多少额度单位 = 1 个货币单位」，所以金额 = total_available / quota_per_unit。
 */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

/** 单次 HTTP 超时（契约要求 ≤ 15s） */
const TIMEOUT_MS = 15000;
/** 轮询间隔：10 分钟 */
const POLL_MS = 10 * 60 * 1000;
/** 同一账户告警冷却：6 小时只弹一次 */
const WARN_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const DEEPSEEK_BASE = 'https://api.deepseek.com';
const PURE_CONSOLE_BASE = 'https://console.puretokensx.com';

/** 各类型缺省环境变量名（config.yaml 里抽不到 key_env 时回落到这里） */
const TYPE_DEFAULT_ENV = {
  deepseek: 'DEEPSEEK_API_KEY',
  puretokens: 'PURE_TOKENS_API_KEY',
  openai_billing: 'OPENAI_API_KEY',
};

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 密钥脱敏展示：前 4 位 + … + 总长度，日志只允许出现这个 */
function maskKey(key) {
  const s = String(key || '');
  if (!s) return '(空)';
  if (s.length <= 6) return '…(' + s.length + ')';
  return s.slice(0, 4) + '…(' + s.length + ')';
}

/**
 * 判断一个值是不是「脱敏后的密钥」。
 * config.yaml 里的 api_key 可能是 sk-abc…xyz、«redacted:sk-…»、*** 这类占位，
 * 一律视为不可用（契约 §4.5 要求只认 key_env + 环境变量）。
 */
function looksMasked(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return true;
  if (/…|\.\.\./.test(s)) return true;
  if (/redacted/i.test(s)) return true;
  if (/^[*x·]+$/.test(s)) return true;
  return false;
}

/** 能不能当密钥用：非脱敏、够长 */
function isUsableKey(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < 16) return false;
  if (looksMasked(s)) return false;
  return true;
}

/** 从字符串里抹掉疑似密钥，避免错误信息把密钥带进日志 */
function sanitize(text) {
  return String(text == null ? '' : text)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-**')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer **')
    .slice(0, 200);
}

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 货币符号（拿不到就用代码本身） */
function moneyText(amount, currency) {
  const sym = { CNY: '¥', USD: '$', EUR: '€' }[String(currency || '').toUpperCase()] || '';
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
  const abs = Math.abs(amount);
  const txt = abs > 0 && abs < 0.01 ? amount.toFixed(4) : amount.toFixed(2);
  return (sym ? sym + txt : txt + ' ' + (currency || '')).trim();
}

/** 拼接口地址：base_url 去掉尾部 /v1 与 /，保证 /user/balance 打在根上 */
function endpoint(baseUrl, pathPart) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  b = b.replace(/\/v1$/i, '');
  return b + pathPart;
}

/** HTTP 状态码 → 中文原因 */
function statusReason(code) {
  if (code === 401 || code === 403) return '鉴权失败（密钥无效或无权访问）';
  if (code === 404) return '接口不存在（404，可能是 base_url 不对）';
  if (code === 429) return '请求过于频繁（429）';
  if (code >= 500) return '服务端错误（' + code + '）';
  return 'HTTP ' + code;
}

/* ------------------------------------------------------------------ *
 * 适配器解析（纯函数，方便单测）
 * ------------------------------------------------------------------ */

/**
 * DeepSeek 余额
 * 实测返回：{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"173.33",
 *            "granted_balance":"58.04","topped_up_balance":"115.29"}]}
 */
function parseDeepseek(json) {
  if (!json || typeof json !== 'object') return { ok: false, error: '返回体不是 JSON' };
  const infos = Array.isArray(json.balance_infos) ? json.balance_infos : [];
  if (!infos.length) return { ok: false, error: '返回体里没有 balance_infos' };
  // 多币种时优先人民币，否则取第一条
  const pick = infos.find((it) => it && String(it.currency || '').toUpperCase() === 'CNY') || infos[0];
  const amount = num(pick && pick.total_balance);
  if (amount === null) return { ok: false, error: 'total_balance 不是数字' };
  const currency = String((pick && pick.currency) || '').toUpperCase();
  const parts = [];
  if (json.is_available === false) parts.push('账户暂不可用');
  parts.push('可用 ' + moneyText(amount, currency));
  const topped = num(pick.topped_up_balance);
  const granted = num(pick.granted_balance);
  if (topped !== null || granted !== null) {
    parts.push('（充值 ' + moneyText(topped === null ? 0 : topped, currency) +
      ' / 赠送 ' + moneyText(granted === null ? 0 : granted, currency) + '）');
  }
  return { ok: true, amount, currency, detail: parts.join(''), warnable: true };
}

/**
 * Pure Tokens 用量
 * 实测返回：{code:true,data:{total_available:-32275918,total_used:32275918,
 *            unlimited_quota:true,money:{remaining:-64.551836,currency:"USD"}}}
 * 金额 = total_available / quota_per_unit（quota_per_unit 来自 status 接口）
 */
function parsePuretokensUsage(json, statusJson) {
  const body = json && typeof json === 'object' ? json : null;
  if (!body) return { ok: false, error: '用量返回体不是 JSON' };
  const data = body.data && typeof body.data === 'object' ? body.data : body;
  const total = num(data.total_available);
  if (total === null) return { ok: false, error: '用量返回体里没有 total_available' };

  const st = statusJson && typeof statusJson === 'object'
    ? (statusJson.data && typeof statusJson.data === 'object' ? statusJson.data : statusJson)
    : null;
  const per = st ? num(st.quota_per_unit) : null;

  // 优先按契约用 status 的 quota_per_unit 换算；status 拿不到时退用返回体自带的 money.remaining
  let amount = null;
  let currency = '';
  let basis = '';
  if (per && per > 0) {
    amount = total / per;
    currency = String((st && (st.quota_display_type || st.currency)) || 'USD').toUpperCase();
    basis = total + ' / ' + per;
  } else if (data.money && num(data.money.remaining) !== null) {
    amount = num(data.money.remaining);
    currency = String(data.money.currency || 'USD').toUpperCase();
    basis = 'money.remaining 兜底';
  } else {
    return { ok: false, error: '取不到 quota_per_unit，无法换算金额' };
  }

  const unlimited = data.unlimited_quota === true;
  const parts = [];
  if (unlimited) {
    parts.push('不限额度');
    parts.push('（账面 ' + moneyText(amount, currency) + '，' + basis + '）');
  } else {
    parts.push('可用 ' + moneyText(amount, currency));
    parts.push('（' + basis + '）');
  }
  if (data.name) parts.push(' · ' + String(data.name));
  return {
    ok: true,
    amount,
    currency,
    detail: parts.join(''),
    // unlimited_quota 的 key 账面可能是负数，报警只是噪音，不弹
    warnable: !unlimited,
  };
}

/**
 * OpenAI 兼容 billing（可选）
 * 常见返回：{total_granted: 18.0, total_used: 2.5, total_available: 15.5}
 * 老接口也可能只给 total_granted / total_used，这里都兜住。
 */
function parseOpenAIBilling(json) {
  if (!json || typeof json !== 'object') return { ok: false, error: '返回体不是 JSON' };
  let amount = num(json.total_available);
  if (amount === null) {
    const granted = num(json.total_granted);
    const used = num(json.total_used);
    if (granted !== null && used !== null) amount = granted - used;
  }
  if (amount === null) return { ok: false, error: '返回体里没有可用额度字段' };
  const currency = String(json.currency || 'USD').toUpperCase();
  return { ok: true, amount, currency, detail: '可用 ' + moneyText(amount, currency), warnable: true };
}

/* ------------------------------------------------------------------ *
 * config.yaml 尽力抽取（正则，不写 YAML 解析器）
 * ------------------------------------------------------------------ */

/** 由 provider 名/显示名/base_url 判断类型 */
function classifyProvider(p) {
  const hay = (p.id + ' ' + p.name + ' ' + p.base_url).toLowerCase();
  if (hay.includes('deepseek')) return 'deepseek';
  if (hay.includes('puretokens') || hay.includes('pure tokens') || hay.includes('pure-tokens')) return 'puretokens';
  return '';
}

/**
 * 从 config.yaml 文本里抽 providers 段。
 * 只取 provider 名、name、base_url、key_env —— 绝不取 api_key
 * （那里可能是脱敏占位，也可能是别的用途的明文，按契约一概不用）。
 */
function extractAccounts(text) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^providers:\s*$/.test(l));
  if (start < 0) return [];

  const raw = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // 回到顶层键，providers 段结束
    const head = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (head) {
      if (cur) raw.push(cur);
      cur = { id: head[1], name: '', base_url: '', key_env: '' };
      continue;
    }
    if (!cur) continue;
    const kv = /^ {4}([A-Za-z_]+):\s*(.*)$/.exec(line); // 只认 4 空格这一层的直接子键
    if (!kv) continue;
    const val = kv[2].trim().replace(/^["']|["']$/g, '');
    if (kv[1] === 'base_url') cur.base_url = val;
    else if (kv[1] === 'key_env') cur.key_env = val;
    else if (kv[1] === 'name') cur.name = val;
  }
  if (cur) raw.push(cur);

  const out = [];
  const seen = new Set();
  for (const p of raw) {
    const type = classifyProvider(p);
    if (!type) continue;
    const base = type === 'puretokens'
      ? (/console\./i.test(p.base_url) ? p.base_url : PURE_CONSOLE_BASE)
      : (p.base_url || DEEPSEEK_BASE);
    let host = base;
    try { host = new URL(base).host; } catch (e) { /* 保留原串 */ }
    const dedupe = type + '|' + host; // 同一 host 的纯额度账户只留一个（额度按 key 算，不按 base_url 分）
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      id: p.id,
      label: p.name || p.id,
      type,
      base_url: base,
      keyEnv: p.key_env || TYPE_DEFAULT_ENV[type] || '',
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 工厂
 * ------------------------------------------------------------------ */

/**
 * @param {object} ctx 宿主上下文（见契约 §1）
 * @returns {object}    源实例
 */
module.exports = function create(ctx) {
  const log = (msg) => { try { ctx.log(msg); } catch (e) { /* 日志失败不影响主流程 */ } };
  const getCfg = () => {
    try {
      const c = ctx.cfg();
      return c && typeof c === 'object' ? c : {};
    } catch (e) { return {}; }
  };

  let timer = null;
  let state = { ready: false, detail: '未启动' };
  let cycle = null;               // 进行中的刷新，避免重入
  let lastItems = [];
  let lastUpdatedAt = 0;
  const warnedAt = new Map();     // 账户 id → 上次告警时间戳
  const inflight = new Set();     // 在途请求，stop() 时统一中断

  /* ---------------- 密钥 ---------------- */

  /** keyEnv 优先读 process.env，其次 cfg.key；脱敏值不用 */
  function resolveKey(acc) {
    if (acc.keyEnv) {
      const v = process.env[acc.keyEnv];
      if (isUsableKey(v)) return { key: v.trim(), from: 'env:' + acc.keyEnv };
    }
    if (isUsableKey(acc.key)) return { key: acc.key.trim(), from: 'cfg.key' };
    return null;
  }

  /* ---------------- HTTP ---------------- */

  /**
   * 极简 GET JSON（node:http / node:https）
   * @returns {Promise<{ok:boolean,status?:number,json?:object,text?:string,error?:string}>}
   */
  function getJson(url, headers, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      let u;
      try { u = new URL(url); } catch (e) { return done({ ok: false, error: '非法 URL：' + sanitize(url) }); }
      const mod = u.protocol === 'http:' ? http : https;
      let req;
      try {
        req = mod.request({
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'http:' ? 80 : 443),
          path: u.pathname + u.search,
          method: 'GET',
          headers: Object.assign({ Accept: 'application/json', 'User-Agent': 'zhuochong-infohub/1.0' }, headers || {}),
          timeout: timeoutMs,
        }, (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size <= 512 * 1024) chunks.push(c); // 防御性截断
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
            done({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, text });
          });
          res.on('error', (e) => done({ ok: false, error: sanitize(e.message || '响应中断') }));
        });
      } catch (e) {
        return done({ ok: false, error: sanitize(e.message || '请求构造失败') });
      }
      inflight.add(req);
      req.on('timeout', () => { req.destroy(new Error('超时')); });
      req.on('error', (e) => done({ ok: false, error: sanitize((e && e.message) || '网络错误') }));
      req.on('close', () => inflight.delete(req));
      req.end();
    });
  }

  /* ---------------- 单个账户取数 ---------------- */

  async function fetchAccount(acc, timeoutMs) {
    const base = { id: acc.id, label: acc.label, type: acc.type };
    const picked = resolveKey(acc);
    if (!picked) {
      return Object.assign(base, {
        ok: false,
        amount: null,
        currency: '',
        detail: '未配置密钥',
        error: acc.keyEnv ? ('环境变量 ' + acc.keyEnv + ' 未设置或不可用') : '未配置 key / keyEnv',
      });
    }
    log('查询 ' + acc.id + '（' + acc.type + '），密钥 ' + maskKey(picked.key) + ' 来源 ' + picked.from);

    try {
      if (acc.type === 'deepseek') {
        const url = endpoint(acc.base_url || DEEPSEEK_BASE, '/user/balance');
        const r = await getJson(url, { Authorization: 'Bearer ' + picked.key }, timeoutMs);
        if (!r.ok) return Object.assign(base, {
          ok: false, amount: null, currency: '',
          detail: r.error || statusReason(r.status), error: r.error || statusReason(r.status),
        });
        const p = parseDeepseek(r.json);
        return Object.assign(base, p.ok ? p : { ok: false, amount: null, currency: '', detail: p.error, error: p.error });
      }

      if (acc.type === 'puretokens') {
        const root = String(acc.base_url || PURE_CONSOLE_BASE).replace(/\/+$/, '');
        // 契约要求：key 无 sk- 前缀时仅在内存里补，不改配置
        const key = /^sk-/i.test(picked.key) ? picked.key : 'sk-' + picked.key;
        const usage = await getJson(root + '/api/product/console/api-keys/usage', { Authorization: 'Bearer ' + key }, timeoutMs);
        if (!usage.ok) return Object.assign(base, {
          ok: false, amount: null, currency: '',
          detail: usage.error || statusReason(usage.status), error: usage.error || statusReason(usage.status),
        });
        // status 不带 key；失败不致命，解析时用 money.remaining 兜底
        const status = await getJson(root + '/api/product/console/status', {}, timeoutMs);
        const p = parsePuretokensUsage(usage.json, status.ok ? status.json : null);
        return Object.assign(base, p.ok ? p : { ok: false, amount: null, currency: '', detail: p.error, error: p.error });
      }

      if (acc.type === 'openai_billing') {
        const url = endpoint(acc.base_url || '', '/dashboard/billing/credit_grants');
        const r = await getJson(url, { Authorization: 'Bearer ' + picked.key }, timeoutMs);
        if (!r.ok) return Object.assign(base, {
          ok: false, amount: null, currency: '',
          detail: r.error || statusReason(r.status), error: r.error || statusReason(r.status),
        });
        const p = parseOpenAIBilling(r.json);
        return Object.assign(base, p.ok ? p : { ok: false, amount: null, currency: '', detail: p.error, error: p.error });
      }

      return Object.assign(base, {
        ok: false, amount: null, currency: '', detail: '未知账户类型：' + acc.type, error: '未知账户类型',
      });
    } catch (e) {
      // 兜底：任何异常都不许冒到顶层
      const msg = sanitize((e && e.message) || '未知错误');
      return Object.assign(base, { ok: false, amount: null, currency: '', detail: msg, error: msg });
    }
  }

  /* ---------------- 配置归一化 ---------------- */

  function normalizeAccounts(cfg) {
    const raw = Array.isArray(cfg.accounts) ? cfg.accounts : [];
    const out = [];
    raw.forEach((a, i) => {
      if (!a || typeof a !== 'object') return;
      const type = String(a.type || '').trim().toLowerCase();
      if (!TYPE_DEFAULT_ENV[type]) return; // 不支持的类型直接忽略
      // 用户显式给了 key 就只认 key，不许被类型默认环境变量「抢」过去
      const key = typeof a.key === 'string' ? a.key.trim() : '';
      const explicitEnv = String(a.keyEnv || a.key_env || '').trim();
      const keyEnv = explicitEnv || (isUsableKey(key) ? '' : (TYPE_DEFAULT_ENV[type] || ''));
      out.push({
        id: String(a.id || ('acc' + (i + 1))),
        label: String(a.label || a.id || a.type),
        type,
        base_url: String(a.base_url || ''),
        keyEnv,
        key,
      });
    });
    return out;
  }

  /* ---------------- 告警冷却持久化 ---------------- */

  function warnStateFile() {
    if (!ctx.dataDir) return '';
    return path.join(ctx.dataDir, 'infohub-balance-warn.json');
  }

  function loadWarnState() {
    const file = warnStateFile();
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const k of Object.keys(raw)) {
          const t = Number(raw[k]);
          if (Number.isFinite(t)) warnedAt.set(k, t);
        }
      }
    } catch (e) { /* 没有文件或坏了都无所谓 */ }
  }

  function saveWarnState() {
    const file = warnStateFile();
    if (!file) return;
    try {
      const obj = {};
      for (const [k, v] of warnedAt) obj[k] = v;
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
      fs.renameSync(tmp, file); // 原子替换
    } catch (e) { /* 落盘失败不影响功能 */ }
  }

  /* ---------------- 一轮刷新 ---------------- */

  function timeoutMs() {
    const v = Number(getCfg().timeoutMs);
    return Number.isFinite(v) && v > 0 ? v : TIMEOUT_MS;
  }

  async function runCycle(opts) {
    const o = opts || {};
    const cfg = getCfg();
    const accounts = normalizeAccounts(cfg);
    const tmo = timeoutMs();

    const items = accounts.length
      ? await Promise.all(accounts.map((a) => fetchAccount(a, tmo)))
      : [];
    lastItems = items;
    lastUpdatedAt = Date.now();

    const okCount = items.filter((it) => it.ok).length;
    const badCount = items.length - okCount;

    if (o.snapshot !== false) {
      try { ctx.snapshot('balance', { items, updatedAt: lastUpdatedAt }); } catch (e) { /* 宿主异常不致命 */ }
    }

    // 阈值告警
    const warnBelow = Number.isFinite(Number(cfg.warnBelow)) ? Number(cfg.warnBelow) : 1;
    for (const it of items) {
      if (o.warn === false) break;
      if (!it.ok || typeof it.amount !== 'number' || it.warnable === false) continue;
      if (it.amount >= warnBelow) continue;
      const last = warnedAt.get(it.id) || 0;
      if (Date.now() - last < WARN_COOLDOWN_MS) continue;
      warnedAt.set(it.id, Date.now());
      saveWarnState();
      try {
        ctx.emit({
          source: 'balance',
          kind: 'balance',
          level: 'warn',
          title: 'AI 额度偏低 · ' + it.label,
          body: ('剩余 ' + moneyText(it.amount, it.currency) + '，低于阈值 ' + warnBelow).slice(0, 90),
          ts: Date.now(),
          key: 'balance:warn:' + it.id,
          actions: [],
          data: { id: it.id, amount: it.amount, currency: it.currency, warnBelow },
        });
      } catch (e) { /* 宿主 emit 失败不致命 */ }
      log('额度告警：' + it.id + ' 剩余 ' + moneyText(it.amount, it.currency) + ' < ' + warnBelow);
    }

    if (!items.length) {
      state = { ready: true, detail: '未配置额度账户（可在设置里手填，或让应用首次启动自动抽取）' };
    } else {
      state = {
        ready: true,
        detail: okCount + '/' + items.length + ' 个账户有数据' +
          (badCount ? '，' + badCount + ' 个异常' : '') +
          '（' + new Date(lastUpdatedAt).toTimeString().slice(0, 5) + ' 更新）',
      };
    }
    log('额度刷新完成：' + okCount + '/' + items.length + ' 成功');
    return { ok: badCount === 0, items, updatedAt: lastUpdatedAt };
  }

  /** 合并并发刷新：正在进行时直接复用同一个 Promise */
  function refresh(opts) {
    if (cycle) return cycle;
    cycle = runCycle(opts)
      .catch((e) => ({ ok: false, items: lastItems, updatedAt: lastUpdatedAt, error: sanitize(e && e.message) }))
      .finally(() => { cycle = null; });
    return cycle;
  }

  /* ---------------- 首次启动抽取 ---------------- */

  function hermesConfigPath() {
    const p = ctx.paths || {};
    const home = p.hermesHome || (p.localAppData ? path.join(p.localAppData, 'hermes') : '');
    if (!home) return '';
    return path.join(home, 'config.yaml');
  }

  function bootstrapFromHermes() {
    const cfg = getCfg();
    if (Array.isArray(cfg.accounts) && cfg.accounts.length) return { added: 0, reason: '已有账户配置' };
    if (cfg.bootstrapped) return { added: 0, reason: '已经抽取过（用户可能清空了账户）' };
    const file = hermesConfigPath();
    if (!file) return { added: 0, reason: '拿不到 hermes 配置目录' };
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return { added: 0, reason: '读不到 config.yaml' };
    }
    const accounts = extractAccounts(text);

    // 环境变量兜底：config.yaml 里没有该 provider，但环境里已经有可用 key，就补一个账户，
    // 免得用户还得手填。openai_billing 必须有 base_url，不做兜底。
    for (const type of Object.keys(TYPE_DEFAULT_ENV)) {
      if (type === 'openai_billing') continue;
      if (accounts.some((a) => a.type === type)) continue;
      const envName = TYPE_DEFAULT_ENV[type];
      if (!isUsableKey(process.env[envName])) continue;
      accounts.push({
        id: type,
        label: type === 'deepseek' ? 'DeepSeek' : 'Pure Tokens',
        type,
        base_url: type === 'deepseek' ? DEEPSEEK_BASE : PURE_CONSOLE_BASE,
        keyEnv: envName,
      });
    }

    try {
      if (ctx.setCfg) ctx.setCfg({ accounts, bootstrapped: true });
    } catch (e) { /* 落盘失败就当每次启动重抽 */ }
    log(accounts.length
      ? '首次启动从 hermes config.yaml 抽取到 ' + accounts.length + ' 个额度账户：' +
        accounts.map((a) => a.id + '(' + a.type + ')').join(', ')
      : 'config.yaml 里没抽到可用的额度 provider，留空等手填');
    return { added: accounts.length, accounts };
  }

  /* ---------------- 对外实例 ---------------- */

  return {
    name: 'balance',
    label: 'AI 额度',
    defaults: {
      enabled: false,
      warnBelow: 1,
      accounts: [],
    },

    async start() {
      if (timer) { clearInterval(timer); timer = null; }
      state = { ready: true, detail: '启动中' };
      loadWarnState();
      // 先抽取配置（即使当前没启用，也把账户填好，用户打开开关即有数据）
      bootstrapFromHermes();
      if (getCfg().enabled === false) {
        state = { ready: false, detail: '已关闭（账户已自动抽取，打开开关即开始刷新）' };
        return;
      }
      refresh().catch(() => {});
      timer = setInterval(() => { refresh().catch(() => {}); }, POLL_MS);
      if (typeof timer.unref === 'function') timer.unref();
    },

    async stop() {
      if (timer) { clearInterval(timer); timer = null; }
      for (const req of inflight) {
        try { req.destroy(new Error('模块停止')); } catch (e) { /* 忽略 */ }
      }
      inflight.clear();
      state = { ready: false, detail: '已停止' };
    },

    status() { return state; },

    /** 手动刷新（面板「刷新」按钮） */
    async refresh() {
      const r = await refresh();
      return { ok: r.ok, items: r.items, updatedAt: r.updatedAt };
    },

    /** 连通性自检：不触发告警、不发快照 */
    async probe() {
      const accounts = normalizeAccounts(getCfg());
      if (!accounts.length) return { ok: false, detail: '未配置账户' };
      const items = await Promise.all(accounts.map((a) => fetchAccount(a, timeoutMs())));
      const bad = items.filter((i) => !i.ok);
      return {
        ok: bad.length === 0,
        detail: items.map((i) => i.id + '：' + (i.ok ? i.detail : (i.error || i.detail))).join('；').slice(0, 200),
      };
    },

    /** 供测试/宿主显式调用：从 hermes config.yaml 抽取账户 */
    bootstrapFromHermes,

    /** 最近一次快照数据（面板兜底用） */
    last() { return { items: lastItems, updatedAt: lastUpdatedAt }; },
  };
};

/* 纯函数挂到工厂上，方便单测直接断言解析逻辑 */
module.exports.parseDeepseek = parseDeepseek;
module.exports.parsePuretokensUsage = parsePuretokensUsage;
module.exports.parseOpenAIBilling = parseOpenAIBilling;
module.exports.extractAccounts = extractAccounts;
module.exports.maskKey = maskKey;
module.exports.isUsableKey = isUsableKey;
module.exports.moneyText = moneyText;
module.exports.endpoint = endpoint;
