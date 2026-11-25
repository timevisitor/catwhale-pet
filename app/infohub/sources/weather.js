'use strict';
/**
 * infohub 源 · 天气（weather）
 *
 * 链路（零第三方依赖，全部 node 内置模块）：
 *   1. 定位：cfg.city 有值 → Open-Meteo Geocoding（中文名，language=zh）；
 *           否则 https://ipwho.is/ → 失败退 https://freeipapi.com/api/json
 *   2. 预报：https://api.open-meteo.com/v1/forecast
 *           current=temperature_2m,weather_code,relative_humidity_2m,
 *                   apparent_temperature,wind_speed_10m
 *           daily=temperature_2m_max,temperature_2m_min,
 *                 precipitation_probability_max,weather_code
 *
 * 约定（docs/infohub-contract.md §0 / §4.6）：
 *   - 只用 node:https / node:http / node:tls / node:url；
 *   - 单次 HTTP ≤ 15s；失败只写 status()，不抛到顶层；
 *   - 15 分钟刷新；30 秒内重复 refresh() 直接回缓存；
 *   - WMO weather_code → 中文现象，自建映射表；
 *   - 定时器 unref()，stop() 清干净；快照里不含任何密钥。
 *
 * 实测备注（本机 2026-11-25）：
 *   本机出网走本地 HTTP 代理（https_proxy=http://127.0.0.1:17891），
 *   Node 原生 fetch 不读环境变量代理，直连 api.open-meteo.com 会被断开。
 *   因此这里自带一个「最小代理隧道」：CONNECT + tls，优先走环境变量代理，
 *   失败再直连；没有代理变量的机器上就是一条普通直连路径。
 */

const https = require('node:https');
const http = require('node:http');
const tls = require('node:tls');
const { URL } = require('node:url');

const NAME = 'weather';

/** 单次请求超时上限（契约要求 ≤ 15s） */
const HTTP_TIMEOUT_MS = 7000;
/** 一次 refresh 的总预算（直连 + 代理两次尝试不吃满 15s） */
const TOTAL_BUDGET_MS = 14000;
/** 缓存复用窗口：30 秒内重复调用直接返回上次结果 */
const CACHE_MS = 30 * 1000;
/** 定位结果内存缓存：6 小时（城市不会天天变） */
const GEO_TTL_MS = 6 * 60 * 60 * 1000;
/** 预报条数上限 */
const FORECAST_DAYS = 7;
/** 响应体最大字节（防止异常大包） */
const MAX_BODY = 1024 * 1024;

/* ------------------------------------------------------------------ *
 * WMO 天气代码 → 中文现象（自建表，0~99 全段覆盖）
 * 参考 WMO Code Table 4677 / Open-Meteo 文档
 * ------------------------------------------------------------------ */
const WMO_TEXT = {
  0: '晴',
  1: '晴间多云',
  2: '多云',
  3: '阴',
  45: '有雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '米雪',
  80: '阵雨',
  81: '强阵雨',
  82: '暴雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴小冰雹',
  99: '雷阵雨伴冰雹',
};

/** 同一套代码给面板用的 emoji（拿不到就空串） */
const WMO_ICON = {
  0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️',
  45: '🌫️', 48: '🌫️',
  51: '🌦️', 53: '🌦️', 55: '🌦️', 56: '🌧️', 57: '🌧️',
  61: '🌧️', 63: '🌧️', 65: '🌧️', 66: '🌧️', 67: '🌧️',
  71: '🌨️', 73: '🌨️', 75: '❄️', 77: '🌨️',
  80: '🌦️', 81: '🌧️', 82: '⛈️',
  85: '🌨️', 86: '❄️',
  95: '⛈️', 96: '⛈️', 99: '⛈️',
};

/** 未知代码兜底 */
function wmoText(code) {
  // 注意：Number(null) 是 0、Number('') 也是 0，必须先挡掉「没有值」的情况
  if (code == null || code === '') return '未知';
  const n = Number(code);
  if (WMO_TEXT[n]) return WMO_TEXT[n];
  if (!Number.isFinite(n)) return '未知';
  return '代码 ' + n;
}
function wmoIcon(code) {
  return WMO_ICON[Number(code)] || '';
}

/* ------------------------------------------------------------------ *
 * 最小 HTTP 客户端：支持环境变量 HTTP 代理（CONNECT 隧道）
 * ------------------------------------------------------------------ */

/** 取代理配置；只认 http:// 形式（socks 不支持，直接忽略） */
function pickProxy(host) {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy;
  if (!raw || !/^https?:\/\//i.test(raw)) return null;
  // no_proxy 命中就不走代理
  const noProxy = String(process.env.NO_PROXY || process.env.no_proxy || '');
  if (noProxy && host) {
    const hit = noProxy.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).some((p) => {
      if (p === '*') return true;
      const q = p.replace(/^\./, '');
      return host.toLowerCase() === q || host.toLowerCase().endsWith('.' + q);
    });
    if (hit) return null;
  }
  try {
    const u = new URL(raw);
    const auth = u.username
      ? decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password || '')
      : '';
    return { host: u.hostname, port: Number(u.port) || 80, auth };
  } catch (e) {
    return null;
  }
}

/** 把 chunked 编码的响应体还原（代理隧道里 Node 不会替我们解） */
function dechunk(buf) {
  let out = '';
  let rest = buf;
  for (;;) {
    const k = rest.indexOf('\r\n');
    if (k < 0) break;
    const n = parseInt(rest.slice(0, k).toString('latin1'), 16);
    if (!n || !Number.isFinite(n)) break;
    out += rest.slice(k + 2, k + 2 + n).toString('utf8');
    rest = rest.slice(k + 2 + n + 2);
  }
  return out;
}

/** 解析一段 HTTP 响应（head + body），返回 {status, headers, body} */
function parseHttpResponse(buf) {
  const sep = buf.indexOf('\r\n\r\n');
  if (sep < 0) throw new Error('响应报文不完整');
  const head = buf.slice(0, sep).toString('latin1');
  const body = buf.slice(sep + 4);
  const lines = head.split('\r\n');
  const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(lines[0] || '');
  const status = m ? Number(m[1]) : 0;
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const chunked = /chunked/i.test(headers['transfer-encoding'] || '');
  return { status, headers, body: chunked ? dechunk(body) : body.toString('utf8') };
}

/** 直连：https.get + 手动超时 */
function directGet(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('URL 非法')); }
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'maojing-pet-infohub/1.0' },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (d) => {
        size += d.length;
        if (size > MAX_BODY) { req.destroy(new Error('响应过大')); return; }
        chunks.push(d);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('HTTP ' + res.statusCode));
        }
        resolve(body);
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('超时 ' + timeoutMs + 'ms')));
    req.on('error', reject);
    req.end();
  });
}

/** 经 HTTP 代理：CONNECT 建隧道 → tls → 写一条 GET → 解析响应 */
function proxyGet(urlStr, proxy, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('URL 非法')); }
    let done = false;
    const fail = (e) => { if (!done) { done = true; reject(e); } };
    const ok = (v) => { if (!done) { done = true; resolve(v); } };

    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: u.hostname + ':' + (u.port || 443),
      headers: Object.assign(
        { host: u.hostname + ':' + (u.port || 443) },
        proxy.auth ? { 'proxy-authorization': 'Basic ' + Buffer.from(proxy.auth).toString('base64') } : {}
      ),
      timeout: timeoutMs,
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return fail(new Error('代理 CONNECT ' + res.statusCode));
      }
      const t = tls.connect({ socket, servername: u.hostname }, () => {
        const path = u.pathname + (u.search || '');
        t.write('GET ' + path + ' HTTP/1.1\r\n'
          + 'Host: ' + u.hostname + '\r\n'
          + 'Accept: application/json\r\n'
          + 'User-Agent: maojing-pet-infohub/1.0\r\n'
          + 'Connection: close\r\n\r\n');
      });
      const chunks = [];
      let size = 0;
      t.on('data', (d) => {
        size += d.length;
        if (size > MAX_BODY) { t.destroy(new Error('响应过大')); return; }
        chunks.push(d);
      });
      t.on('end', () => {
        try {
          const r = parseHttpResponse(Buffer.concat(chunks));
          if (r.status < 200 || r.status >= 300) return fail(new Error('HTTP ' + r.status));
          ok(r.body);
        } catch (e) { fail(e); }
      });
      t.on('error', fail);
      t.setTimeout(timeoutMs + 2000, () => t.destroy(new Error('隧道读超时')));
    });
    connectReq.on('timeout', () => { connectReq.destroy(new Error('代理连接超时')); });
    connectReq.on('error', fail);
    connectReq.end();
  });
}

/**
 * GET 一段 JSON 文本。
 * 有代理变量 → 先走代理再直连；没有 → 只直连（用户家里多半如此）。
 * @returns {Promise<string>}
 */
async function httpGetText(urlStr, timeoutMs) {
  const host = (() => { try { return new URL(urlStr).hostname; } catch (e) { return ''; } })();
  const proxy = pickProxy(host);
  const plan = proxy ? ['proxy', 'direct'] : ['direct'];
  let lastErr = new Error('未发起请求');
  for (const mode of plan) {
    try {
      const t = Math.min(timeoutMs, mode === 'proxy' ? timeoutMs : HTTP_TIMEOUT_MS);
      return mode === 'proxy' ? await proxyGet(urlStr, proxy, t) : await directGet(urlStr, t);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function httpGetJson(urlStr, timeoutMs) {
  const txt = await httpGetText(urlStr, timeoutMs);
  const s = String(txt || '').trim();
  // 个别服务会在 JSON 前面加一行说明，容错从第一个 { 或 [ 开始
  const a = s.indexOf('{');
  const b = s.indexOf('[');
  let start = 0;
  if (a >= 0 && (b < 0 || a < b)) start = a;
  else if (b >= 0) start = b;
  try { return JSON.parse(s.slice(start)); } catch (e) { throw new Error('返回不是 JSON'); }
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
function pad2(n) { return (n < 10 ? '0' : '') + n; }

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function fmtDate(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function weekdayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return '';
  return WEEK_CN[d.getDay()];
}

/** 统一取整：null/NaN 一律 null，面板好判空 */
function num(v, digits) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const d = digits || 0;
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

/* ------------------------------------------------------------------ *
 * 工厂
 * ------------------------------------------------------------------ */
module.exports = function create(ctx) {
  const cfg = () => ctx.cfg() || {};
  const log = (m) => { try { ctx.log(m); } catch (e) {} };
  const clock = () => (typeof ctx.now === 'function' ? ctx.now() : Date.now());

  let timer = null;
  let started = false;
  let state = { ready: false, detail: '未启动' };

  let place = null;          // { city, lat, lon, source }
  let placeAt = 0;           // 定位时间
  let lastData = null;       // 最近一次成功快照
  let lastAt = 0;            // 最近一次成功取数时间
  let lastTryAt = 0;         // 最近一次尝试时间（失败也算，避免面板连点爆请求）
  let inflight = null;

  /* ---------- 定位 ---------- */

  /** 中文/英文城市名 → 经纬度（Open-Meteo Geocoding） */
  async function geocode(city) {
    const url = 'https://geocoding-api.open-meteo.com/v1/search?name='
      + encodeURIComponent(city) + '&count=1&language=zh&format=json';
    const j = await httpGetJson(url, HTTP_TIMEOUT_MS);
    const r = j && Array.isArray(j.results) ? j.results[0] : null;
    if (!r || !Number.isFinite(Number(r.latitude))) throw new Error('查不到城市「' + city + '」');
    return {
      city: String(r.name || city),
      lat: Number(r.latitude),
      lon: Number(r.longitude),
      source: 'geocoding',
    };
  }

  /** IP 定位：ipwho.is → freeipapi.com */
  async function locateByIp() {
    // 1) ipwho.is
    try {
      const j = await httpGetJson('https://ipwho.is/', HTTP_TIMEOUT_MS);
      if (j && j.success !== false && Number.isFinite(Number(j.latitude))) {
        return {
          city: String(j.city || j.region || j.country || '未知城市'),
          lat: Number(j.latitude),
          lon: Number(j.longitude),
          source: 'ipwho.is',
        };
      }
      throw new Error('ipwho.is 返回 success=false');
    } catch (e) {
      log('ipwho.is 定位失败：' + e.message);
    }
    // 2) freeipapi.com
    const j2 = await httpGetJson('https://freeipapi.com/api/json', HTTP_TIMEOUT_MS);
    if (!j2 || !Number.isFinite(Number(j2.latitude))) throw new Error('IP 定位全部失败');
    return {
      city: String(j2.cityName || j2.regionName || j2.countryName || '未知城市'),
      lat: Number(j2.latitude),
      lon: Number(j2.longitude),
      source: 'freeipapi.com',
    };
  }

  async function resolvePlace(force) {
    const now = clock();
    if (!force && place && now - placeAt < GEO_TTL_MS) return place;
    const city = String(cfg().city || '').trim();
    if (city) {
      try {
        place = await geocode(city);
        placeAt = now;
        log('定位（配置城市）→ ' + place.city + ' ' + place.lat.toFixed(3) + ',' + place.lon.toFixed(3));
        return place;
      } catch (e) {
        log('配置城市定位失败，退回 IP 定位：' + e.message);
      }
    }
    place = await locateByIp();
    placeAt = now;
    log('定位（IP）→ ' + place.city + ' ' + place.lat.toFixed(3) + ',' + place.lon.toFixed(3));
    return place;
  }

  /* ---------- 取预报 ---------- */
  function buildUrl(p) {
    const q = [
      'latitude=' + p.lat,
      'longitude=' + p.lon,
      'current=temperature_2m,weather_code,relative_humidity_2m,apparent_temperature,wind_speed_10m',
      'daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code',
      'timezone=auto',
      'forecast_days=' + FORECAST_DAYS,
    ];
    return 'https://api.open-meteo.com/v1/forecast?' + q.join('&');
  }

  /** 把 open-meteo 原始响应压成快照（单独抽出，方便单测/核对） */
  function shape(placeInfo, j) {
    const cur = (j && j.current) || {};
    const daily = (j && j.daily) || {};
    const times = Array.isArray(daily.time) ? daily.time : [];
    const days = [];
    for (let i = 0; i < times.length && i < FORECAST_DAYS; i++) {
      const code = num(daily.weather_code ? daily.weather_code[i] : null);
      days.push({
        date: String(times[i] || ''),
        week: weekdayOf(String(times[i] || '')),
        max: num(daily.temperature_2m_max ? daily.temperature_2m_max[i] : null),
        min: num(daily.temperature_2m_min ? daily.temperature_2m_min[i] : null),
        pop: num(daily.precipitation_probability_max ? daily.precipitation_probability_max[i] : null),
        code,
        text: wmoText(code),
        icon: wmoIcon(code),
      });
    }
    const code = num(cur.weather_code);
    return {
      city: placeInfo.city,
      lat: num(placeInfo.lat, 3),
      lon: num(placeInfo.lon, 3),
      temp: num(cur.temperature_2m),
      text: wmoText(code),
      icon: wmoIcon(code),
      code,
      feels: num(cur.apparent_temperature),
      humidity: num(cur.relative_humidity_2m),
      wind: num(cur.wind_speed_10m),
      days,
      placeSource: placeInfo.source,
      updatedAt: clock(),
    };
  }

  /* ---------- 主流程 ---------- */
  async function doRefresh(force) {
    const now = clock();
    // 30 秒缓存：面板连点 / 宿主重复 start 时不重复打网
    if (!force && lastData && now - lastTryAt < CACHE_MS) {
      return { ok: true, cached: true, data: lastData };
    }
    if (inflight) return inflight;

    inflight = (async () => {
      lastTryAt = now;
      const deadline = clock() + TOTAL_BUDGET_MS;
      try {
        const p = await resolvePlace(false);
        const left = Math.max(3000, deadline - clock());
        const j = await httpGetJson(buildUrl(p), Math.min(HTTP_TIMEOUT_MS, left));
        if (!j || !j.current) throw new Error('预报返回缺少 current 字段');
        const data = shape(p, j);
        lastData = data;
        lastAt = clock();
        state = { ready: true, detail: data.city + ' ' + (data.temp == null ? '—' : data.temp + '°C') + ' ' + data.text };
        ctx.snapshot('weather', data);
        log('刷新成功：' + state.detail);
        return { ok: true, data };
      } catch (e) {
        const msg = String((e && e.message) || e);
        state = { ready: !!lastData, detail: '取数失败：' + msg };
        log('刷新失败：' + msg);
        // 有旧数据就继续用旧的，面板不至于空
        if (lastData) return { ok: false, error: msg, data: lastData, stale: true };
        return { ok: false, error: msg };
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    name: NAME,
    label: '天气',
    defaults: {
      enabled: true,
      city: '',              // 留空 = IP 定位；填中文名如「北京」走 geocoding
      refreshMin: 15,
    },

    async start() {
      stopTimer();
      started = true;
      const mins = Math.max(1, Number(cfg().refreshMin) || 15);
      state = { ready: false, detail: '首次取数中' };
      await doRefresh(true);
      timer = setInterval(() => { doRefresh(false).catch(() => {}); }, mins * 60 * 1000);
      if (timer.unref) timer.unref();
    },

    async stop() {
      started = false;
      stopTimer();
      state = { ready: false, detail: '已停止' };
    },

    status() {
      if (!started) return { ready: false, detail: state.detail || '未启动' };
      return state;
    },

    /** 手动刷新（面板按钮）；不加 force，保留 30 秒缓存语义 */
    async refresh() {
      const r = await doRefresh(false);
      return { ok: !!r.ok, cached: !!r.cached, detail: r.ok ? (r.data && r.data.city) || 'ok' : r.error };
    },

    /** 连通性自检：强制真打一次 */
    async probe() {
      const r = await doRefresh(true);
      if (!r.ok) return { ok: false, detail: r.error };
      const d = r.data;
      return { ok: true, detail: d.city + ' ' + d.temp + '°C ' + d.text + '（' + d.placeSource + '）' };
    },

    /* 给测试/调试用 */
    _wmoText: wmoText,
    _shape: shape,
    _geocodeUrl: (city) => 'https://geocoding-api.open-meteo.com/v1/search?name='
      + encodeURIComponent(city) + '&count=1&language=zh&format=json',
    _pickProxy: pickProxy,
  };
};

module.exports.WMO_TEXT = WMO_TEXT;
module.exports.wmoText = wmoText;
