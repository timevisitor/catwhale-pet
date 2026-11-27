// 解包器 + 升级状态机的单元测试
//   · zip 结构（带包裹目录 / 扁平 / 缺主程序 / Zip Slip）
//   · 下载 → sha256 校验 → 解包 → staging 的真实流水线（本地 http，node 传输）
// 临时目录用 os.tmpdir()（系统临时区），跑完即删；不碰任何交付目录。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');
const crypto = require('node:crypto');

const { extractZip, safeRelPath } = require('../app/zip-extract.js');
const { UpdateEngine, findPackageRoot, validatePackage } = require('../app/update-engine.js');

/* ---------------- 极简 zip 写器（deflate），只为造测试包 ---------------- */
function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data === undefined ? '' : e.data);
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(e.name, 'utf8');
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x800, 6);              // UTF-8 名称标志
    lfh.writeUInt16LE(8, 8);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    const local = Buffer.concat([lfh, nameBuf, comp]);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([c, nameBuf]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'catwhale-upd-'));
function tmpDir(name) {
  const p = path.join(TMP, name + '-' + crypto.randomBytes(3).toString('hex'));
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function writeZip(name, entries) {
  const p = path.join(tmpDir('zip'), name);
  fs.writeFileSync(p, makeZip(entries));
  return p;
}
const EXE = '桌宠.exe';

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

/* ---------------- 解包 ---------------- */

test('extractZip：带单层包裹目录（Electron 现状）能解，包根可定位', async () => {
  const zip = writeZip('wrapped.zip', [
    { name: '桌宠/桌宠.exe', data: Buffer.alloc(4096, 1) },
    { name: '桌宠/resources/app/package.json', data: '{"version":"0.7.2"}' },
    { name: '桌宠/说明.txt', data: '中文内容' },
  ]);
  const out = tmpDir('ex');
  const r = await extractZip(zip, out);
  assert.equal(r.files, 3);
  assert.ok(fs.existsSync(path.join(out, '桌宠', '桌宠.exe')));
  const root = findPackageRoot(out, EXE);
  assert.equal(path.basename(root), '桌宠');
  assert.equal(validatePackage(root, EXE, 'electron'), true);
  assert.equal(fs.readFileSync(path.join(out, '桌宠', '说明.txt'), 'utf8'), '中文内容');
});

test('extractZip：扁平结构（Tauri 现状）包根就是解包根', async () => {
  const zip = writeZip('flat.zip', [
    { name: '桌宠.exe', data: Buffer.alloc(4096, 2) },
    { name: 'resources/app/package.json', data: '{}' },
  ]);
  const out = tmpDir('ex');
  await extractZip(zip, out);
  assert.equal(findPackageRoot(out, EXE), out);
});

test('extractZip：缺主程序 → 定位包根时拒绝（U7 的失败点）', async () => {
  const zip = writeZip('noexe.zip', [
    { name: '桌宠/说明.txt', data: '没有 exe' },
    { name: '桌宠/resources/app/package.json', data: '{}' },
  ]);
  const out = tmpDir('ex');
  await extractZip(zip, out);
  assert.throws(() => findPackageRoot(out, EXE), /没有找到本端主程序/);
});

test('extractZip：缺 resources/app/package.json → 结构校验拒绝', async () => {
  const zip = writeZip('nopkg.zip', [{ name: '桌宠.exe', data: Buffer.alloc(4096, 3) }]);
  const out = tmpDir('ex');
  await extractZip(zip, out);
  assert.throws(() => validatePackage(out, EXE, 'electron'), /resources/);
});

test('extractZip：Zip Slip（.. 与绝对路径）整包拒绝', async () => {
  for (const bad of ['../evil.txt', '/abs.txt', 'a/../../evil.txt', 'C:/evil.txt']) {
    const zip = writeZip('slip.zip', [{ name: bad, data: 'x' }, { name: 'ok.txt', data: 'y' }]);
    const out = tmpDir('ex');
    await assert.rejects(() => extractZip(zip, out), /非法路径|越出解包目录/, bad + ' 必须被拒');
  }
  assert.equal(safeRelPath('a/b.txt'), 'a/b.txt');
  assert.equal(safeRelPath('../x'), null);
  assert.equal(safeRelPath('/x'), null);
  assert.equal(safeRelPath('x/../../y'), null);
});

/* ---------------- 状态机流水线 ---------------- */

function makeInstall(dir) {
  fs.mkdirSync(path.join(dir, 'resources', 'app'), { recursive: true });
  fs.writeFileSync(path.join(dir, EXE), Buffer.alloc(4096, 7));
  fs.writeFileSync(path.join(dir, 'resources', 'app', 'package.json'), '{"version":"0.7.1"}');
  return dir;
}

function serve(buf) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/assets/pkg.zip')) {
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': buf.length });
        res.end(buf);
      } else { res.writeHead(404); res.end('no'); }
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

async function runToDone(engine, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (['ready', 'error'].includes(engine.state.phase)) return engine.state;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('超时，停在 ' + engine.state.phase);
}

test('引擎：下载 → sha256 校验 → 解包 → ready，staging 内容就是包根', async () => {
  const pkg = makeZip([
    { name: '桌宠/桌宠.exe', data: Buffer.alloc(8192, 9) },
    { name: '桌宠/resources/app/package.json', data: '{"version":"0.7.2"}' },
  ]);
  const sha = crypto.createHash('sha256').update(pkg).digest('hex');
  const { srv, port } = await serve(pkg);
  try {
    const local = tmpDir('la');
    const install = makeInstall(tmpDir('inst'));
    const engine = new UpdateEngine({
      env: { LOCALAPPDATA: local, CATWHALE_UPDATE_TRANSPORT: 'node' },
      installDir: install, exeName: EXE, currentVersion: '0.7.1',
      relaunchArgs: [], quit: () => {}, log: () => {},
    });
    engine.release = {
      ok: true, hasUpdate: true, canAutoUpdate: true, latestVersion: '0.7.2',
      assetName: 'catwhale-pet-v0.7.2-win-x64.zip',
      assetUrl: `http://127.0.0.1:${port}/assets/pkg.zip`,
      assetSize: pkg.length, expectedSha256: sha,
    };
    const r = engine.download();
    assert.equal(r.ok, true);
    const st = await runToDone(engine);
    assert.equal(st.phase, 'ready', st.error);
    const staging = path.join(local, 'catwhale-update', 'v0.7.2', 'staging');
    assert.ok(fs.existsSync(path.join(staging, EXE)), 'staging 里必须直接有主程序');
    assert.ok(fs.existsSync(path.join(staging, 'resources', 'app', 'package.json')));
    assert.ok(!fs.existsSync(path.join(local, 'catwhale-update', 'v0.7.2', 'extract')), 'extract 临时目录要清掉');
    assert.ok(fs.existsSync(path.join(local, 'catwhale-update', 'v0.7.2', 'package.sha256')));
    assert.equal(fs.readFileSync(path.join(local, 'catwhale-update', 'v0.7.2', 'package.sha256'), 'utf8').slice(0, 64), sha);
  } finally { srv.close(); }
});

test('引擎：sha256 不匹配 → error，且包被删掉、不清 staging', async () => {
  const pkg = makeZip([
    { name: '桌宠/桌宠.exe', data: Buffer.alloc(8192, 5) },
    { name: '桌宠/resources/app/package.json', data: '{"version":"0.7.2"}' },
  ]);
  const { srv, port } = await serve(pkg);
  try {
    const local = tmpDir('la');
    const install = makeInstall(tmpDir('inst'));
    const engine = new UpdateEngine({
      env: { LOCALAPPDATA: local, CATWHALE_UPDATE_TRANSPORT: 'node' },
      installDir: install, exeName: EXE, currentVersion: '0.7.1',
      relaunchArgs: [], quit: () => {}, log: () => {},
    });
    engine.release = {
      ok: true, hasUpdate: true, canAutoUpdate: true, latestVersion: '0.7.2',
      assetName: 'catwhale-pet-v0.7.2-win-x64.zip',
      assetUrl: `http://127.0.0.1:${port}/assets/pkg.zip`,
      assetSize: pkg.length, expectedSha256: 'f'.repeat(64),
    };
    engine.download();
    const st = await runToDone(engine);
    assert.equal(st.phase, 'error');
    assert.match(st.error, /sha256/);
    assert.ok(!fs.existsSync(path.join(local, 'catwhale-update', 'v0.7.2', 'package.zip')), '校验失败必须删包');
  } finally { srv.close(); }
});

test('引擎：没检查过就 apply → 明确拒绝；阶段串绝不能乱跳', () => {
  const install = makeInstall(tmpDir('inst'));
  const engine = new UpdateEngine({
    env: { LOCALAPPDATA: tmpDir('la') }, installDir: install, exeName: EXE,
    currentVersion: '0.7.1', relaunchArgs: [], quit: () => {}, log: () => {},
  });
  const r = engine.apply();
  assert.equal(r.ok, false);
  assert.match(r.error, /还没准备好/);
  const d = engine.download();
  assert.equal(d.ok, false);
  assert.equal(engine.state.phase, 'idle');
});

test('引擎：startupReport 读 last-result.json（ok 才有「已升级到」）', () => {
  const local = tmpDir('la');
  const dir = path.join(local, 'catwhale-update');
  fs.mkdirSync(dir, { recursive: true });
  const install = makeInstall(tmpDir('inst'));
  const engine = new UpdateEngine({
    env: { LOCALAPPDATA: local }, installDir: install, exeName: EXE,
    currentVersion: '0.7.2', relaunchArgs: [], quit: () => {}, log: () => {},
  });
  fs.writeFileSync(path.join(dir, 'last-result.json'),
    '{"from":"0.7.1","to":"0.7.2","result":"ok","at":1764231154,"log":"apply-x.log"}', 'utf8');
  const r = engine.startupReport();
  assert.equal(r.kind, 'ok');
  assert.match(r.text, /已升级到 v0\.7\.2/);
  fs.writeFileSync(path.join(dir, 'last-result.json'),
    '{"from":"0.7.1","to":"0.7.2","result":"failed","at":1764231154,"log":"apply-y.log","error":"swap-failed"}', 'utf8');
  const f = engine.startupReport();
  assert.equal(f.kind, 'failed');
  assert.match(f.text, /apply-y\.log/);
});
