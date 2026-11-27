const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, checkUpdate } = require('../app/updater.js');

test('compareVersions 版本号比较', () => {
  assert.equal(compareVersions('0.1.4', '0.1.3'), 1);
  assert.equal(compareVersions('v0.1.4', '0.1.3'), 1);
  assert.equal(compareVersions('0.1.3', 'v0.1.3'), 0);
  assert.equal(compareVersions('0.1.3', '0.1.4'), -1);
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.1.3.1', '0.1.3'), 1);
  assert.equal(compareVersions('0.1.3', '0.1.3.1'), -1);
});

test('checkUpdate: 模拟存在新版本', async () => {
  const fakeFetcher = async (url) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v0.1.4',
        name: '猫鲸桌宠 v0.1.4',
        html_url: 'https://github.com/timevisitor/catwhale-pet/releases/tag/v0.1.4',
        body: '修复了若干问题并增加更新检查',
        assets: [
          {
            name: 'catwhale-pet-v0.1.4-win-x64.zip',
            browser_download_url: 'https://github.com/timevisitor/catwhale-pet/releases/download/v0.1.4/catwhale-pet-v0.1.4-win-x64.zip',
          },
        ],
      }),
    };
  };

  const res = await checkUpdate({
    currentVersion: '0.1.3',
    fetcher: fakeFetcher,
  });

  assert.equal(res.ok, true);
  assert.equal(res.hasUpdate, true);
  assert.equal(res.currentVersion, '0.1.3');
  assert.equal(res.latestVersion, '0.1.4');
  assert.equal(res.downloadUrl, 'https://github.com/timevisitor/catwhale-pet/releases/download/v0.1.4/catwhale-pet-v0.1.4-win-x64.zip');
  assert.match(res.notes, /修复了若干问题/);
});

test('checkUpdate: 模拟无新版本（已是最新）', async () => {
  const fakeFetcher = async (url) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v0.1.4',
        name: '猫鲸桌宠 v0.1.4',
        html_url: 'https://github.com/timevisitor/catwhale-pet/releases/tag/v0.1.4',
        body: '',
        assets: [],
      }),
    };
  };

  const res = await checkUpdate({
    currentVersion: '0.1.4',
    fetcher: fakeFetcher,
  });

  assert.equal(res.ok, true);
  assert.equal(res.hasUpdate, false);
  assert.equal(res.currentVersion, '0.1.4');
  assert.equal(res.latestVersion, '0.1.4');
});

test('checkUpdate: HTTP 错误与 404 处理', async () => {
  const notFoundFetcher = async () => ({
    ok: false,
    status: 404,
  });
  const res404 = await checkUpdate({ currentVersion: '0.1.4', fetcher: notFoundFetcher });
  assert.equal(res404.ok, true);
  assert.equal(res404.hasUpdate, false);

  const errorFetcher = async () => ({
    ok: false,
    status: 500,
  });
  const res500 = await checkUpdate({ currentVersion: '0.1.4', fetcher: errorFetcher });
  assert.equal(res500.ok, false);
  assert.match(res500.error, /HTTP 500/);
});

test('checkUpdate: 超时处理不崩溃', async () => {
  const slowFetcher = async (_url, { signal }) => {
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };

  const res = await checkUpdate({
    currentVersion: '0.1.4',
    fetcher: slowFetcher,
    timeoutMs: 50,
  });

  assert.equal(res.ok, false);
  assert.match(res.error, /超时/);
});

// ---------------------------------------------------------------- 限流（403/429）与直连兜底
// 背景：GitHub 未认证接口按出口 IP 限流 60 次/小时。Electron 的 net.fetch 跟随系统代理，
// 共享代理出口很容易被用光 —— 实测过「直连剩 56/60、经代理剩 0/60」。
// 这里锁定两条行为：①能靠直连兜底救回来就别报错；②救不回来要给人话，而不是光秃秃的 403。
function rateLimitedFetcher() {
  return async () => ({
    ok: false,
    status: 403,
    text: async () => '{"message":"API rate limit exceeded for 1.2.3.4."}',
    json: async () => ({ message: 'API rate limit exceeded for 1.2.3.4.' }),
  });
}

function okReleaseFetcher() {
  return async (url) => {
    if (String(url).includes('SHA256SUMS')) {
      return {
        ok: true, status: 200,
        text: async () => '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08  catwhale-pet-v0.8.1-win-x64.zip\n',
        json: async () => ({}),
      };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        tag_name: 'v0.8.1',
        html_url: 'https://github.com/timevisitor/catwhale-pet/releases/tag/v0.8.1',
        body: 'x',
        assets: [
          { name: 'catwhale-poc-v0.8.1-win-x64.zip', browser_download_url: 'https://github.com/a/poc.zip', size: 10 },
          { name: 'catwhale-pet-v0.8.1-win-x64.zip', browser_download_url: 'https://github.com/a/pet.zip', size: 20 },
          { name: 'SHA256SUMS.txt', browser_download_url: 'https://github.com/a/SHA256SUMS.txt', size: 5 },
        ],
      }),
    };
  };
}

test('checkUpdate: 系统代理被限流时，直连兜底能救回来', async () => {
  const res = await checkUpdate({
    currentVersion: '0.7.1',
    fetcher: rateLimitedFetcher(),      // 走"代理"的通道：403
    directFetcher: okReleaseFetcher(),  // 直连兜底：成功
  });
  assert.equal(res.ok, true);
  assert.equal(res.hasUpdate, true);
  assert.equal(res.latestVersion, '0.8.1');
  assert.equal(res.viaDirectFallback, true, '应当标记这次是直连兜底成功');
  assert.equal(res.assetName, 'catwhale-pet-v0.8.1-win-x64.zip');
  assert.equal(res.expectedSha256, '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
});

test('checkUpdate: 直连也被限流时，给出人话而不是裸 403', async () => {
  const res = await checkUpdate({
    currentVersion: '0.7.1',
    fetcher: rateLimitedFetcher(),
    directFetcher: rateLimitedFetcher(),
  });
  assert.equal(res.ok, false);
  assert.equal(res.rateLimited, true);
  assert.match(res.error, /限流/);
  assert.match(res.reason, /60 次/);
  assert.match(res.reason, /手动下载/);
  assert.equal(res.canAutoUpdate, false);
});

test('checkUpdate: 500 之类的其它错误不受兜底影响（不误判成限流）', async () => {
  const errFetcher = async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) });
  const res = await checkUpdate({ currentVersion: '0.7.1', fetcher: errFetcher, directFetcher: okReleaseFetcher() });
  assert.equal(res.ok, false);
  assert.match(res.error, /HTTP 500/);
  assert.notEqual(res.rateLimited, true);
});
