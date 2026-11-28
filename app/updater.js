// 自动检测 GitHub 新版本 + 决定「能不能自动升级」的纯逻辑
//
// 本文件不 require electron（getDefaultFetch 里惰性 require），这样 `node --test tests/*.test.cjs`
// 能直接跑。真正的下载/解包/替换在 update-engine.js，apply.cmd 文本在 apply-cmd.js。
//
// 与线上规格（在线升级-共享规格.md）对应：
//   §2.1 资产按名字正则匹配（绝不按 assets 顺序取 —— 0.7.1 的 bug 就在这儿）
//   §2.1 SHA256SUMS.txt 从 assets 列表里按名字找，不拼 latest/download URL
//   §3   统一响应字段
//   §7   canAutoUpdate=false 的 8 类中文理由
const GITHUB_REPO = 'timevisitor/catwhale-pet';
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const GITHUB_RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases/latest`;
const SUMS_ASSET_NAME = 'SHA256SUMS.txt';

// §2.1 两端各自的资产名正则（对 asset.name 用 .search 语义，忽略大小写）
const END_ASSET_PATTERNS = {
  electron: { primary: /catwhale-(electron|pet)[-_]v?[0-9]/i, fallback: /catwhale-pet-/i },
  tauri: { primary: /catwhale-(tauri|poc)[-_]v?[0-9]/i, fallback: /catwhale-poc-/i },
};

/**
 * 比较两个语义化版本号
 * 返回: 1 (v1 > v2), -1 (v1 < v2), 0 (v1 == v2)
 */
function compareVersions(v1, v2) {
  const clean = (v) => String(v || '').trim().replace(/^[vV]/, '');
  const p1 = clean(v1).split('.').map((n) => parseInt(n, 10) || 0);
  const p2 = clean(v2).split('.').map((n) => parseInt(n, 10) || 0);
  const maxLen = Math.max(p1.length, p2.length, 3);
  for (let i = 0; i < maxLen; i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

/**
 * 按端名挑升级包。**绝不按顺序取第一个 zip。**
 * @param {Array} assets release 的 assets
 * @param {string} end 'electron' | 'tauri'
 * @param {string} [overridePattern] CATWHALE_UPDATE_ASSET 的正则源（调试覆盖）
 * @returns {{count:number, asset:Object|null, names:string[], used:string, reason:string}}
 */
function pickAsset(assets, end = 'electron', overridePattern = '') {
  const list = (Array.isArray(assets) ? assets : [])
    .filter((a) => a && typeof a.name === 'string' && a.browser_download_url);
  const names = list.map((a) => a.name);

  if (overridePattern) {
    let re = null;
    try { re = new RegExp(overridePattern, 'i'); } catch (e) { re = null; }
    if (!re) return { count: 0, asset: null, names, used: 'override-invalid', reason: '升级包匹配规则无效（CATWHALE_UPDATE_ASSET 不是合法正则）' };
    const hits = list.filter((a) => re.test(a.name));
    if (hits.length === 1) return { count: 1, asset: hits[0], names, used: 'override', reason: '' };
    return { count: hits.length, asset: null, names, used: 'override', reason: '' };
  }

  const pats = END_ASSET_PATTERNS[end] || END_ASSET_PATTERNS.electron;
  const zips = list.filter((a) => /\.zip$/i.test(a.name));
  let hits = zips.filter((a) => pats.primary.test(a.name));
  let used = 'primary';
  if (hits.length === 0) {                       // 兜底：接住历史命名的 release
    hits = zips.filter((a) => pats.fallback.test(a.name));
    used = hits.length ? 'fallback' : 'none';
  }
  if (hits.length === 1) return { count: 1, asset: hits[0], names, used, reason: '' };
  return { count: hits.length, asset: null, names, used, reason: '' };
}

/** 在 assets 里按名字找 SHA256SUMS.txt（§2.1：不许拼 latest/download URL） */
function findSumsAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  return list.find((a) => a && a.name === SUMS_ASSET_NAME && a.browser_download_url) || null;
}

/**
 * 解析 GNU sha256sum 清单。
 * 接受 `<64hex>  <name>` 与 `<64hex> *<name>`，忽略空行与 # 注释。
 * @returns {Object<string,string>} 文件名 -> 小写 hex
 */
function parseSums(text) {
  const out = Object.create(null);
  String(text || '').split(/\r?\n/).forEach((line) => {
    const s = line.replace(/\r$/, '');
    if (!s.trim() || /^\s*#/.test(s)) return;
    const m = s.match(/^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/);
    if (m) out[m[2]] = m[1].toLowerCase();
  });
  return out;
}

/**
 * §7：把「事实」翻译成 canAutoUpdate + 中文理由。纯函数，单元测试直接打。
 * facts = {
 *   isDev:boolean, platformOk:boolean, installWritable:boolean, parentWritable:boolean,
 *   assetCount:number, sumsAsset:boolean, expectedSha256:string, sameVolume:boolean
 * }
 * 顺序说明：资产匹配排在「校验清单」之前 —— 一个 release 里若根本没有本端的包，
 * 说「没有适用于本端的升级包」比说「没有校验清单」更贴近真相（验收台 U3 就是这么要求的）。
 */
function evaluateAutoUpdate(facts = {}) {
  const f = facts || {};
  if (f.isDev) return { canAutoUpdate: false, reason: '当前是开发模式运行（没有安装目录），不能自动升级' };
  if (f.platformOk === false) return { canAutoUpdate: false, reason: '当前系统不是 Windows x64，不能自动升级' };
  if (f.installWritable === false) return { canAutoUpdate: false, reason: '安装目录不可写，无法自动升级' };
  if (f.parentWritable === false) return { canAutoUpdate: false, reason: '安装目录的上一级目录不可写（换目录需要写权限）' };
  if (!f.assetCount) return { canAutoUpdate: false, reason: '该版本没有适用于本端的升级包' };
  if (f.assetCount > 1) return { canAutoUpdate: false, reason: '该版本有多个升级包，无法确定用哪一个' };
  if (f.sumsAsset === false) return { canAutoUpdate: false, reason: '该版本没有校验清单（SHA256SUMS.txt）' };
  if (!f.expectedSha256) return { canAutoUpdate: false, reason: '校验清单里没有这个升级包' };
  if (f.sameVolume === false) return { canAutoUpdate: false, reason: '升级包目录与程序目录不在同一个盘，无法安全替换' };
  return { canAutoUpdate: true, reason: '' };
}

/**
 * §8.2 下载地址只接受 https；仅当设置了 CATWHALE_UPDATE_API（本地验收/调试）才额外放行 127.0.0.1。
 */
function isAllowedAssetUrl(url, opts = {}) {
  let u = null;
  try { u = new URL(String(url || '')); } catch (e) { return false; }
  if (u.protocol === 'https:') return true;
  if (opts.debug && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return true;
  return false;
}

/**
 * 获取默认的 fetch 函数：优先用传入的，其次 Electron net.fetch，再次全局 fetch
 */
function getDefaultFetch() {
  try {
    const electron = require('electron');
    if (electron && electron.net && typeof electron.net.fetch === 'function') {
      return electron.net.fetch;
    }
  } catch (e) {}
  if (typeof fetch === 'function') {
    return fetch;
  }
  throw new Error('当前环境无可用 fetch');
}

/**
 * 直连兜底用的最小 fetch（Node https，**不经过 Chromium 网络栈/系统代理**）。
 *
 * 为什么需要它：GitHub 的未认证接口按**出口 IP** 限流（60 次/小时）。Electron 的 net.fetch
 * 跟随系统代理，而代理出口常常是共享 IP —— 同一条代理上的其他人把配额用光，我们就会收到
 * 403。本项目实测量到过这一幕：同一时刻直连剩 56/60，经代理剩 0/60，于是「检查更新」
 * 直接显示 HTTP 403。换成 Node https 走本机出口再试一次，多数情况下就通了。
 *
 * 只实现 GET + headers + text/json，够本文件用；返回形状与 Response 对齐（ok/status/headers.get）。
 */
function getNodeFetch() {
  const https = require('https');
  return function nodeFetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      const req = https.get(
        url,
        { headers: (opts && opts.headers) || {} },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { data += c; });
          res.on('end', () => resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: { get: (k) => res.headers[String(k).toLowerCase()] || '' },
            text: async () => data,
            json: async () => JSON.parse(data),
          }));
        },
      );
      req.on('error', reject);
      const timer = setTimeout(() => req.destroy(new Error('timeout')), (opts && opts.timeoutMs) || 8000);
      req.on('close', () => clearTimeout(timer));
    });
  };
}

const BASE_HEADERS = {
  'User-Agent': 'catwhale-pet-updater',
  'Accept': 'application/vnd.github.v3+json',
};

/**
 * 带「限流直连兜底」的 GET。
 * 先按正常通道（可能是跟随系统代理的 net.fetch）请求；只有遇到 403/429 才换直连再试一次。
 * 返回 { res, via: 'normal'|'direct' }。
 */
async function fetchWithRateLimitFallback(url, { fetchFn, directFn, timeoutMs = 8000, signal } = {}) {
  let res = await fetchFn(url, { method: 'GET', headers: BASE_HEADERS, signal });
  if (!res.ok && (res.status === 403 || res.status === 429)) {
    try {
      const r2 = await directFn(url, { headers: BASE_HEADERS, timeoutMs });
      if (r2 && r2.ok) return { res: r2, via: 'direct' };
      // 直连也被限流/失败，就把原始响应交回去，错误文案里如实说明
      return { res, via: 'normal', directStatus: r2 ? r2.status : 0 };
    } catch (e) {
      return { res, via: 'normal', directStatus: -1 };
    }
  }
  return { res, via: 'normal' };
}

/**
 * 检查 GitHub 上是否有新版本
 * @param {Object} opts
 * @param {string} opts.currentVersion 当前版本号（例如 "0.7.1"）
 * @param {Function} [opts.fetcher] 可选的自定义 fetch 函数
 * @param {number} [opts.timeoutMs] 超时时间，默认 8000ms
 * @param {string} [opts.apiUrl] 自定义 API 地址（CATWHALE_UPDATE_API，本地验收用）
 * @param {string} [opts.end] 'electron' | 'tauri'，默认 electron
 * @param {string} [opts.assetPattern] CATWHALE_UPDATE_ASSET 覆盖正则
 * @param {boolean} [opts.allowInsecure] 允许 http://127.0.0.1 下载源（只在调试覆盖时开）
 */
async function checkUpdate(opts = {}) {
  const currentVersion = opts.currentVersion || '0.0.0';
  const timeoutMs = opts.timeoutMs || 8000;
  const apiUrl = opts.apiUrl || GITHUB_API_URL;
  const end = opts.end === 'tauri' ? 'tauri' : 'electron';
  const fetchFn = opts.fetcher || getDefaultFetch();
  // 直连兜底：优先用注入的（测试用），否则 Node https（不经系统代理）
  const directFn = opts.directFetcher || (opts.fetcher ? opts.fetcher : getNodeFetch());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const got = await fetchWithRateLimitFallback(apiUrl, {
      fetchFn, directFn, timeoutMs, signal: controller.signal,
    });
    const res = got.res;

    clearTimeout(timer);

    if (!res.ok) {
      if (res.status === 404) {
        return { ok: true, hasUpdate: false, currentVersion, message: '暂无已发布的 Release', assetCount: 0 };
      }
      // 403/429 基本都是 GitHub 的未认证接口按出口 IP 限流（60 次/小时）。
      // 共用代理/VPN 时很容易被同 IP 的其他人用光，直连兜底也救不回来时要给人话。
      if (res.status === 403 || res.status === 429) {
        let hint = '';
        try {
          const b = await res.text();
          if (/rate limit/i.test(b)) hint = '（GitHub 返回：rate limit exceeded）';
        } catch (e) {}
        const triedDirect = typeof got.directStatus === 'number';
        return {
          ok: false,
          currentVersion,
          canAutoUpdate: false,
          rateLimited: true,
          error: `GitHub 接口被限流（HTTP ${res.status}）${hint}`,
          reason: '检查更新被 GitHub 限流：未登录接口按出口 IP 每小时只给 60 次，'
            + '同一条代理/VPN 上的其他人也会占用。'
            + (triedDirect ? '已试过直连仍不通，' : '')
            + '等一会儿再试，或点「手动下载」直接拿整包。',
        };
      }
      return { ok: false, error: `GitHub API 响应异常 (HTTP ${res.status})`, currentVersion };
    }

    const data = await res.json();
    const tagName = data.tag_name || '';
    const cleanTag = tagName.replace(/^[vV]/, '');
    const hasUpdate = !!cleanTag && compareVersions(cleanTag, currentVersion) > 0;
    const releaseUrl = data.html_url || GITHUB_RELEASES_PAGE;
    const assets = Array.isArray(data.assets) ? data.assets : [];

    // ---- §2.1 按名字挑包（不再 .find(a => a.name.endsWith('.zip'))，那会拿到对端的包）----
    const pick = pickAsset(assets, end, opts.assetPattern || '');
    const asset = pick.count === 1 ? pick.asset : null;
    const assetUrl = asset ? asset.browser_download_url : '';
    const assetName = asset ? asset.name : '';
    const assetSize = asset && Number.isFinite(asset.size) ? asset.size : 0;
    const sumsAsset = findSumsAsset(assets);
    const sumsUrl = sumsAsset ? sumsAsset.browser_download_url : '';

    // ---- 期望 sha256 ----
    // 先看 GitHub API 响应里自带的 asset.digest（"sha256:..."）。它是同一份响应的字段，
    // 不额外发请求，而且**不依赖 github.com 的下载域** —— 那台机器实测直连 downloads 会被
    // 重置（read ECONNRESET），拉不到 SHA256SUMS.txt 时原来的实现会把 expectedSha256 留空，
    // evaluateAutoUpdate 于是判「清单里没有这个升级包」→ canAutoUpdate=false，
    // 明明能连 API 却升不了。digest 由 GitHub 计算，作为校验值至少不比自传的清单弱。
    let expectedSha256 = '';
    let shaSource = '';
    const apiDigest = asset && typeof asset.digest === 'string' ? asset.digest.trim() : '';
    if (/^sha256:[0-9a-fA-F]{64}$/.test(apiDigest)) {
      expectedSha256 = apiDigest.slice(7).toLowerCase();
      shaSource = 'api-digest';
    }
    // 兜底：老 release / 没有 digest 的情形，仍然去拉同 release 的 SHA256SUMS.txt
    if (!expectedSha256 && asset && sumsAsset) {
      try {
        const sgot = await fetchWithRateLimitFallback(sumsUrl, { fetchFn, directFn, timeoutMs });
        const sr = sgot.res;
        if (sr && sr.ok) {
          const sums = parseSums(await sr.text());
          expectedSha256 = sums[asset.name] || '';
          if (expectedSha256) shaSource = 'sums-asset';
        }
      } catch (e) { expectedSha256 = ''; }
    }

    return {
      ok: true,
      hasUpdate,
      // 这次是不是靠直连兜底才成功的（排查时有用，不影响判定）
      viaDirectFallback: got.via === 'direct',
      currentVersion,
      latestVersion: cleanTag || tagName,
      tagName,
      name: data.name || tagName,
      releaseUrl,
      notes: data.body || '',
      publishedAt: data.published_at || '',
      // §3 字段
      assetName,
      assetUrl,
      assetSize,
      sumsUrl,
      expectedSha256,
      shaSource,
      // 兼容旧字段（旧 UI / 托盘菜单在用）
      downloadUrl: assetUrl || releaseUrl,
      // 给 update-engine 用的中间事实（也给日志/测试看）
      assetCount: pick.count,
      assetPickUsed: pick.used,
      assetNames: pick.names,
      hasSumsAsset: !!sumsAsset,
      assetUrlAllowed: asset ? isAllowedAssetUrl(assetUrl, { debug: !!opts.allowInsecure }) : false,
    };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err && (err.name === 'AbortError' || String(err.message).includes('aborted'));
    return {
      ok: false,
      error: isTimeout ? '检查更新超时（网络连接超时）' : `检查更新失败: ${(err && err.message) || String(err)}`,
      currentVersion,
    };
  }
}

module.exports = {
  compareVersions,
  pickAsset,
  findSumsAsset,
  parseSums,
  evaluateAutoUpdate,
  isAllowedAssetUrl,
  checkUpdate,
  END_ASSET_PATTERNS,
  SUMS_ASSET_NAME,
  GITHUB_REPO,
  GITHUB_API_URL,
  GITHUB_RELEASES_PAGE,
};
