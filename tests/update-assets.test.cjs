// 升级「选哪个包」与「清单解析」的单元测试（规格 §2.1 / §3）
// 重点：同一个 release 里同时有对端的包时，绝不能按顺序取第一个 zip。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compareVersions, pickAsset, findSumsAsset, parseSums, evaluateAutoUpdate, isAllowedAssetUrl, checkUpdate,
} = require('../app/updater.js');

const A = (name, url) => ({ name, size: 12345, browser_download_url: url || `https://example.invalid/${name}` });

// 验收台假 release 的形状：第一项永远是对端的垃圾 zip
const RELEASE_BOTH = [
  A('catwhale-poc-v0.7.2-win-x64.zip', 'https://example.invalid/DECOY'),
  A('catwhale-pet-v0.7.2-win-x64.zip', 'https://example.invalid/OWN'),
  A('SHA256SUMS.txt', 'https://example.invalid/SHA256SUMS.txt'),
];

test('compareVersions：语义化比较的基础行为', () => {
  assert.equal(compareVersions('0.7.2', '0.7.1'), 1);
  assert.equal(compareVersions('v0.7.1', '0.7.1'), 0);
  assert.equal(compareVersions('0.7.1', '0.7.2'), -1);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);   // 不能按字符串比
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('', '0.0.1'), -1);
});

test('pickAsset：Electron 端不会被排在前面的 Tauri 包骗走', () => {
  const r = pickAsset(RELEASE_BOTH, 'electron');
  assert.equal(r.count, 1);
  assert.equal(r.asset.name, 'catwhale-pet-v0.7.2-win-x64.zip');
  assert.notEqual(r.asset.browser_download_url, 'https://example.invalid/DECOY');
  assert.equal(r.used, 'primary');
});

test('pickAsset：Tauri 端同样只认自己的包', () => {
  const r = pickAsset(RELEASE_BOTH, 'tauri');
  assert.equal(r.count, 1);
  assert.equal(r.asset.name, 'catwhale-poc-v0.7.2-win-x64.zip');
});

test('pickAsset：只有对端的包时匹配 0 个（必须报错，不许回落）', () => {
  const onlyOther = [A('catwhale-poc-v0.7.2-win-x64.zip'), A('SHA256SUMS.txt')];
  const r = pickAsset(onlyOther, 'electron');
  assert.equal(r.count, 0);
  assert.equal(r.asset, null);
  const v = evaluateAutoUpdate({ assetCount: r.count, sumsAsset: true, expectedSha256: 'a'.repeat(64) });
  assert.equal(v.canAutoUpdate, false);
  assert.match(v.reason, /本端/);
});

test('pickAsset：匹配到多个 zip 时拒绝（宁可不升，也不升错）', () => {
  const two = [A('catwhale-pet-v0.7.2-win-x64.zip'), A('catwhale-electron-v0.7.2-win-x64.zip')];
  const r = pickAsset(two, 'electron');
  assert.equal(r.count, 2);
  assert.equal(r.asset, null);
  const v = evaluateAutoUpdate({ assetCount: r.count, sumsAsset: true, expectedSha256: 'a'.repeat(64) });
  assert.equal(v.canAutoUpdate, false);
  assert.match(v.reason, /多个升级包/);
});

test('pickAsset：SHA256SUMS.txt 不会被当成升级包', () => {
  const r = pickAsset([A('SHA256SUMS.txt')], 'electron');
  assert.equal(r.count, 0);
});

test('pickAsset：兜底正则接得住历史命名的包（catwhale-pet-*）', () => {
  const legacy = [A('catwhale-pet-legacy-win.zip')];   // 名字里没有紧跟数字，主正则不匹配
  const r = pickAsset(legacy, 'electron');
  assert.equal(r.count, 1);
  assert.equal(r.used, 'fallback');
});

test('pickAsset：CATWHALE_UPDATE_ASSET 覆盖规则优先级最高', () => {
  const r = pickAsset(RELEASE_BOTH, 'electron', 'poc-v0\\.7\\.2');
  assert.equal(r.count, 1);
  assert.equal(r.asset.name, 'catwhale-poc-v0.7.2-win-x64.zip');
  assert.equal(r.used, 'override');
  const bad = pickAsset(RELEASE_BOTH, 'electron', '([unclosed');
  assert.equal(bad.count, 0);
  assert.match(bad.reason, /无效/);
});

test('findSumsAsset：按名字找 SHA256SUMS.txt', () => {
  const s = findSumsAsset(RELEASE_BOTH);
  assert.ok(s);
  assert.equal(s.name, 'SHA256SUMS.txt');
  assert.equal(findSumsAsset([A('sha256sums.txt'), A('catwhale-pet-v0.7.2.zip')]), null);
});

test('parseSums：GNU 两种格式都能吃，注释/空行忽略', () => {
  const hex = 'b'.repeat(64);
  const txt = [
    '# 这是注释',
    '',
    `${hex}  catwhale-pet-v0.7.2-win-x64.zip`,
    `${'C'.repeat(64)} *catwhale-poc-v0.7.2-win-x64.zip`,
    '  垃圾行  ',
    `${'d'.repeat(64)}\tcatwhale-pet-0.7.3.zip`,
  ].join('\r\n');
  const m = parseSums(txt);
  assert.equal(m['catwhale-pet-v0.7.2-win-x64.zip'], hex);
  assert.equal(m['catwhale-poc-v0.7.2-win-x64.zip'], 'c'.repeat(64), '大写 hex 统一转小写');
  assert.equal(m['catwhale-pet-0.7.3.zip'], 'd'.repeat(64), 'tab 分隔也要认（sha256sum 在 Windows 上会用 tab）');
  assert.equal(Object.keys(m).length, 3);
});

test('parseSums：空/垃圾输入不炸', () => {
  assert.deepEqual(Object.keys(parseSums('')), []);
  assert.deepEqual(Object.keys(parseSums(null)), []);
  assert.deepEqual(Object.keys(parseSums('abc  def.zip')), []);
});

test('isAllowedAssetUrl：https 放行，http 只在调试覆盖时放行 127.0.0.1', () => {
  assert.equal(isAllowedAssetUrl('https://github.com/x.zip'), true);
  assert.equal(isAllowedAssetUrl('http://127.0.0.1:8500/assets/x.zip'), false);
  assert.equal(isAllowedAssetUrl('http://127.0.0.1:8500/assets/x.zip', { debug: true }), true);
  assert.equal(isAllowedAssetUrl('http://example.com/x.zip', { debug: true }), false);
  assert.equal(isAllowedAssetUrl('file:///c:/x.zip', { debug: true }), false);
  assert.equal(isAllowedAssetUrl('not a url'), false);
});

test('checkUpdate：返回 §3 的字段（含 expectedSha256 / assetSize / sumsUrl）', async () => {
  const sha = 'e'.repeat(64);
  const fetch = async (url) => {
    if (String(url).endsWith('SHA256SUMS.txt')) {
      return { ok: true, status: 200, text: async () => `${sha}  catwhale-pet-v0.7.2-win-x64.zip\n` };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        tag_name: 'v0.7.2', name: 'v0.7.2', body: '说明', published_at: '2026-11-27T00:00:00Z',
        html_url: 'https://github.com/timevisitor/catwhale-pet/releases/tag/v0.7.2',
        assets: RELEASE_BOTH,
      }),
    };
  };
  const r = await checkUpdate({ currentVersion: '0.7.1', fetcher: fetch, end: 'electron' });
  assert.equal(r.ok, true);
  assert.equal(r.hasUpdate, true);
  assert.equal(r.latestVersion, '0.7.2');
  assert.equal(r.assetName, 'catwhale-pet-v0.7.2-win-x64.zip');
  assert.equal(r.assetUrl, 'https://example.invalid/OWN');
  assert.equal(r.assetSize, 12345);
  assert.equal(r.expectedSha256, sha);
  assert.ok(r.sumsUrl.endsWith('SHA256SUMS.txt'));
  assert.equal(r.assetCount, 1);
});

test('checkUpdate：没有 SHA256SUMS.txt 时 expectedSha256 为空、hasSumsAsset=false', async () => {
  const fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ tag_name: 'v0.7.2', assets: [A('catwhale-pet-v0.7.2-win-x64.zip')] }),
  });
  const r = await checkUpdate({ currentVersion: '0.7.1', fetcher: fetch, end: 'electron' });
  assert.equal(r.expectedSha256, '');
  assert.equal(r.hasSumsAsset, false);
  assert.equal(r.assetCount, 1);
});

/* 国内直连 github.com 的下载域会被重置（实测 ECONNRESET），拉 SHA256SUMS.txt 失败。
   那种情况下 expectedSha256 原来会留空，evaluateAutoUpdate 就判「清单里没有这个升级包」
   → canAutoUpdate=false，一键升级在能连 GitHub API 的机器上反而整条废掉。
   GitHub API 的 assets[] 自带 digest(sha256:...)，用它兜底。 */
test('checkUpdate：拉不到 SHA256SUMS.txt 时用 API 的 asset.digest 兜底', async () => {
  const sha = 'f'.repeat(64);
  const fetch = async (url) => {
    if (String(url).endsWith('SHA256SUMS.txt')) throw new Error('read ECONNRESET');
    return {
      ok: true, status: 200,
      json: async () => ({
        tag_name: 'v0.8.2', name: 'v0.8.2', body: '', published_at: '2026-11-28T00:00:00Z',
        html_url: 'https://github.com/timevisitor/catwhale-pet/releases/tag/v0.8.2',
        assets: [
          { name: 'catwhale-pet-v0.8.2-win-x64.zip', size: 238420239,
            browser_download_url: 'https://github.com/timevisitor/catwhale-pet/releases/download/v0.8.2/catwhale-pet-v0.8.2-win-x64.zip',
            digest: 'sha256:' + sha },
          { name: 'SHA256SUMS.txt', size: 98,
            browser_download_url: 'https://github.com/timevisitor/catwhale-pet/releases/download/v0.8.2/SHA256SUMS.txt',
            digest: 'sha256:' + 'a'.repeat(64) },
        ],
      }),
    };
  };
  const r = await checkUpdate({ currentVersion: '0.8.1', fetcher: fetch, directFetcher: fetch });
  assert.equal(r.ok, true);
  assert.equal(r.hasUpdate, true);
  assert.equal(r.expectedSha256, sha);
  assert.equal(r.shaSource, 'api-digest');
  const v = evaluateAutoUpdate({ assetCount: r.assetCount, sumsAsset: r.hasSumsAsset, expectedSha256: r.expectedSha256 });
  assert.equal(v.canAutoUpdate, true, v.reason);
});

test('checkUpdate：digest 与 SHA256SUMS.txt 都在时以 API digest 为准（同一份响应，更可信）', async () => {
  const dig = 'b'.repeat(64), sum = 'c'.repeat(64);
  const fetch = async (url) => {
    if (String(url).endsWith('SHA256SUMS.txt')) {
      return { ok: true, status: 200, text: async () => `${sum}  catwhale-pet-v0.7.2-win-x64.zip\n` };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        tag_name: 'v0.7.2', name: 'v0.7.2', body: '', published_at: '2026-11-27T00:00:00Z',
        html_url: 'https://github.com/timevisitor/catwhale-pet/releases/tag/v0.7.2',
        assets: [
          { name: 'catwhale-pet-v0.7.2-win-x64.zip', size: 12345, browser_download_url: 'https://example.invalid/OWN', digest: 'sha256:' + dig },
          { name: 'SHA256SUMS.txt', size: 98, browser_download_url: 'https://example.invalid/SHA256SUMS.txt' },
        ],
      }),
    };
  };
  const r = await checkUpdate({ currentVersion: '0.7.1', fetcher: fetch, directFetcher: fetch });
  assert.equal(r.expectedSha256, dig);
  assert.equal(r.shaSource, 'api-digest');
});
