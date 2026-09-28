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
