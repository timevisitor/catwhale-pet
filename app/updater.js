// 自动检测 GitHub 新版本与更新信息
const GITHUB_REPO = 'timevisitor/catwhale-pet';
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const GITHUB_RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases/latest`;

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
 * 检查 GitHub 上是否有新版本
 * @param {Object} opts
 * @param {string} opts.currentVersion 当前版本号（例如 "0.1.3"）
 * @param {Function} [opts.fetcher] 可选的自定义 fetch 函数
 * @param {number} [opts.timeoutMs] 超时时间，默认 8000ms
 * @param {string} [opts.apiUrl] 自定义 API 地址（测试用）
 */
async function checkUpdate(opts = {}) {
  const currentVersion = opts.currentVersion || '0.0.0';
  const timeoutMs = opts.timeoutMs || 8000;
  const apiUrl = opts.apiUrl || GITHUB_API_URL;
  const fetchFn = opts.fetcher || getDefaultFetch();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(apiUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'catwhale-pet-updater',
        'Accept': 'application/vnd.github.v3+json',
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      if (res.status === 404) {
        return { ok: true, hasUpdate: false, currentVersion, message: '暂无已发布的 Release' };
      }
      return { ok: false, error: `GitHub API 响应异常 (HTTP ${res.status})`, currentVersion };
    }

    const data = await res.json();
    const tagName = data.tag_name || '';
    const cleanTag = tagName.replace(/^[vV]/, '');
    const hasUpdate = !!cleanTag && compareVersions(cleanTag, currentVersion) > 0;
    const releaseUrl = data.html_url || GITHUB_RELEASES_PAGE;

    // 尝试在 assets 中寻找 zip 下载地址
    let downloadUrl = releaseUrl;
    if (Array.isArray(data.assets)) {
      const zipAsset = data.assets.find((a) => a.name && a.name.endsWith('.zip'));
      if (zipAsset && zipAsset.browser_download_url) {
        downloadUrl = zipAsset.browser_download_url;
      }
    }

    return {
      ok: true,
      hasUpdate,
      currentVersion,
      latestVersion: cleanTag || tagName,
      tagName,
      name: data.name || tagName,
      releaseUrl,
      downloadUrl,
      notes: data.body || '',
      publishedAt: data.published_at || '',
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
  checkUpdate,
  GITHUB_REPO,
  GITHUB_API_URL,
  GITHUB_RELEASES_PAGE,
};
