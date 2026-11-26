'use strict';
/* 跑「灵动岛跟随」对比冒烟。
 *
 *   node tests/island-follow/run.cjs                 # 新版一套
 *   node tests/island-follow/run.cjs --compare       # 祖先版 vs 新版，同一条轨迹
 *   node tests/island-follow/run.cjs --compare --base ../某处（祖先树导出目录，含 web/ 与 app/island.js）
 *
 * 祖先树可以是任意 e9a9f77 的导出：git archive e9a9f77 | tar -x -C <base>
 * 结果写到 --outdir（默认 <repo>/../_logs/island-follow）。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
const ENVROOT = path.resolve(REPO, '..', '_env');

function electronBin() {
  const local = path.join(REPO, 'app', 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(local)) return local;
  try {
    const p = require(path.join(REPO, 'app', 'node_modules', 'electron'));
    if (typeof p === 'string' && fs.existsSync(p)) return p;
  } catch (e) {}
  throw new Error('找不到 Electron 运行时：先在 ' + path.join(REPO, 'app') + ' 下 `npm install electron`');
}

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const flag = (n) => process.argv.includes('--' + n);

function runOnce(o) {
  const bin = electronBin();
  const out = path.join(o.outdir, o.tag + '.json');
  fs.mkdirSync(o.outdir, { recursive: true });
  const env = Object.assign({}, process.env, {
    TEMP: path.join(ENVROOT, 'TEMP'), TMP: path.join(ENVROOT, 'TMP'), TMPDIR: path.join(ENVROOT, 'TMP'),
  });
  const args = [path.join(HERE, 'main.cjs'),
    '--web', o.web, '--island', o.island, '--impl', o.impl, '--label', o.tag,
    '--out', out, '--userdata', path.join(ENVROOT, 'userData', 'smoke-' + o.tag)];
  if (flag('visible')) args.push('--visible');
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', (c) => { stdout += c; });
    p.stderr.on('data', (c) => { stderr += c; });
    p.on('close', (code) => {
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith('SMOKE_RESULT '));
      if (!line) {
        console.log('[' + o.tag + '] 失败 code=' + code + ' 用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
        console.log((stdout + stderr).slice(-2000));
        return resolve(null);
      }
      const r = JSON.parse(line.slice('SMOKE_RESULT '.length));
      r.elapsedSec = +((Date.now() - t0) / 1000).toFixed(1);
      fs.writeFileSync(out, JSON.stringify(r, null, 1));
      resolve(r);
    });
  });
}

function fmt(r) {
  const pad = (s, n) => String(s).padEnd(n);
  const lines = [];
  lines.push('  ' + pad('指标', 22) + pad('祖先版 e9a9f77', 22) + 'v0.7.1 事件驱动');
  const row = (name, a, b) => lines.push('  ' + pad(name, 22) + pad(a, 22) + b);
  row('运动误差 均值/最大', r.a.errMotion.mean + ' / ' + r.a.errMotion.max + ' DIP', r.b.errMotion.mean + ' / ' + r.b.errMotion.max + ' DIP');
  const ph = (k) => r.a.errByPhase[k].mean + ' / ' + r.a.errByPhase[k].max;
  const phB = (k) => r.b.errByPhase[k].mean + ' / ' + r.b.errByPhase[k].max;
  row('  慢走段(130px/s)', ph('walk_right') + ' DIP', phB('walk_right') + ' DIP');
  row('  快拖段(500px/s)', ph('grabbed') + ' DIP', phB('grabbed') + ' DIP');
  row('运动误差 p95', r.a.errMotion.p95 + ' DIP', r.b.errMotion.p95 + ' DIP');
  row('误差>2px 采样数', r.a.errOver2px + '/' + r.a.motionSamples, r.b.errOver2px + '/' + r.b.motionSamples);
  row('误差>6px 采样数', r.a.errOver6px + '/' + r.a.motionSamples, r.b.errOver6px + '/' + r.b.motionSamples);
  row('运动期落位次数', r.a.motionUpdates, r.b.motionUpdates);
  row('  其中真实位移', r.a.motionMoves, r.b.motionMoves);
  row('更新间隔 均值/最大', r.a.updateGapMs.mean + ' / ' + r.a.updateGapMs.max + ' ms', r.b.updateGapMs.mean + ' / ' + r.b.updateGapMs.max + ' ms');
  row('静止期落位次数', r.a.idleUpdates, r.b.idleUpdates);
  row('  其中真实位移', r.a.idleMoves, r.b.idleMoves);
  row('静止期抖动(横/纵)', r.a.idleXRange + '/' + r.a.idleYRange + ' px', r.b.idleXRange + '/' + r.b.idleYRange + ' px');
  row('静止期误差 均值', r.a.errIdle.mean + ' DIP', r.b.errIdle.mean + ' DIP');
  row('停步后归位耗时', r.a.recoveryMs + ' ms', r.b.recoveryMs + ' ms');
  row('页面锚点上报数', r.a.anchorSends, r.b.anchorSends);
  row('亮起时误差/可见样本', r.a.firstShownErr + ' DIP / ' + r.a.shownSamples, r.b.firstShownErr + ' DIP / ' + r.b.shownSamples);
  const bt = (x) => x && x.boot ? ('@' + x.boot.firstVisibleAt + 'ms ' + x.boot.firstVisibleErr + ' DIP, 可见但错位 ' + x.boot.visibleButWrong + ' 帧') : '—';
  row('启动窗口期可见性', bt(r.a), bt(r.b));
  if (r.a.anchorSendStats && r.b.anchorSendStats) row('  其中头顶像素扫描', r.a.anchorSendStats.headScans, r.b.anchorSendStats.headScans);
  return lines.join('\n');
}

(async () => {
  const outdir = path.resolve(arg('outdir', path.join(REPO, '..', '_logs', 'island-follow')));
  const base = path.resolve(arg('base', path.join(ENVROOT, 'base')));
  const newRun = { tag: 'new', impl: 'event', web: path.join(REPO, 'web'), island: path.join(REPO, 'app', 'island.js'), outdir };
  if (!flag('compare')) {
    const r = await runOnce(newRun);
    if (!r) process.exit(1);
    console.log(JSON.stringify(r, null, 1));
    console.log('\n结果：' + path.join(outdir, 'new.json'));
    return;
  }
  if (!fs.existsSync(path.join(base, 'web')) || !fs.existsSync(path.join(base, 'app', 'island.js'))) {
    console.error('祖先树不在 ' + base + '：先 git archive e9a9f77 | tar -x -C ' + base);
    process.exit(2);
  }
  const baseRun = { tag: 'base', impl: 'legacy', web: path.join(base, 'web'), island: path.join(base, 'app', 'island.js'), outdir };
  const a = await runOnce(baseRun);
  const b = await runOnce(newRun);
  if (!a || !b) process.exit(1);
  const table = fmt({ a, b });
  console.log('\n=== 灵动岛跟随：祖先版 vs v0.7.1（同一条轨迹）===\n' + table + '\n');
  fs.writeFileSync(path.join(outdir, 'compare.txt'), table + '\n');
  console.log('结果：' + outdir);
})();
