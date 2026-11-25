/**
 * app/infohub/music.js — 音乐：读当前曲目 + 控制播放（信息中枢的一个源）
 *
 * 桌宠本来就有 media-detect.js（SMTC 元数据 + WASAPI 谁在出声）在做"演什么动作"，
 * 这里不重复那套判定，只补两件事：
 *   1) 给面板一个"当前曲目"快照（点开面板时按需探一次，不常驻轮询）；
 *   2) 给几个按钮：播放/暂停、上一首、下一首、停止、进度、音量。
 *
 * 为什么按需探：media_probe.ps1 每次要起 PowerShell（约 0.6~1.2s），
 * 常驻轮询会在桌宠空闲时白烧 CPU；面板打开时探一次、操作后探一次足够。
 *
 * @module infohub/music
 */
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runPs(script, args, timeoutMs) {
  const r = spawnSync('powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script].concat(args || []),
    { timeout: timeoutMs || 12000, encoding: 'utf8', windowsHide: true });
  return { stdout: String((r && r.stdout) || ''), stderr: String((r && r.stderr) || ''), status: r ? r.status : -1 };
}

module.exports = function create(ctx) {
  const appDir = ctx.appDir;
  const probe = path.join(appDir, 'media-probe', 'media_probe.ps1');
  const ctl = path.join(appDir, 'media-probe', 'media_control.ps1');
  let ready = false;
  let detail = '未探测';

  /** 探一次当前媒体状态；失败返回 {ok:false, error} */
  function probeOnce() {
    const r = runPs(probe, ['-Once'], 12000);
    const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.startsWith('{'));
    if (!lines.length) return { ok: false, error: '探针没有输出' + (r.stderr ? ('（' + r.stderr.slice(0, 120) + '）') : '') };
    let data = null;
    try { data = JSON.parse(lines[lines.length - 1]); } catch (e) { return { ok: false, error: '探针输出不是 JSON' }; }
    const sessions = Array.isArray(data.smtc) ? data.smtc : [];
    // 选曲目：优先 Playing，其次有 title 的
    const playing = sessions.find((s) => s.status === 'Playing' && s.title);
    const anyTitle = sessions.find((s) => s.title);
    const s = playing || anyTitle || null;
    return {
      ok: true,
      playing: !!(s && s.status === 'Playing'),
      title: s ? String(s.title || '') : '',
      artist: s ? String(s.artist || '') : '',
      app: s ? String(s.app || '') : '',
      pos: s && Number.isFinite(s.pos) ? Number(s.pos) : 0,
      end: s && Number.isFinite(s.end) ? Number(s.end) : 0,
      hasSession: !!s,
      audible: (Array.isArray(data.wasapi) ? data.wasapi : []).map((w) => ({ proc: w.proc, peak: w.peak })),
    };
  }

  return {
    name: 'music',
    label: '音乐控制',
    defaults: { enabled: true },

    async start() {
      try {
        const r = probeOnce();
        ready = !!r.ok;
        detail = r.ok ? (r.hasSession ? ('当前：' + (r.title || '未知曲目') + (r.playing ? '（播放中）' : '（暂停）')) : '没有可控制的播放器') : ('探针失败：' + r.error);
        ctx.snapshot('music', r.ok ? r : { ok: false, error: r.error });
      } catch (e) {
        ready = false; detail = '启动失败：' + e.message;
      }
    },
    async stop() { },
    status() { return { ready, detail }; },
    async refresh() { const r = probeOnce(); ctx.snapshot('music', r); detail = r.ok ? (r.hasSession ? r.title : '没有可控制的播放器') : r.error; return r; },

    async state() {
      const r = probeOnce();
      ctx.snapshot('music', r);
      ready = !!r.ok;
      return r;
    },

    /** verb: play_pause | next | prev | stop | seek | vol_up | vol_down | mute */
    async control(verb, arg) {
      const v = String(verb || '');
      const allowed = ['play_pause', 'next', 'prev', 'stop', 'seek', 'vol_up', 'vol_down', 'mute'];
      if (!allowed.includes(v)) return { ok: false, error: '不支持的操作: ' + v };
      const args = ['-Action', v];
      if (v === 'seek') args.push('-Seconds', String(Math.max(0, Math.round(Number((arg && arg.seconds) || 0)))));
      const r = runPs(ctl, args, 12000);
      const out = (r.stdout || '').trim().split(/\r?\n/).pop() || '';
      const ok = out === 'ok';
      if (!ok) ctx.log('控制 ' + v + ' 失败: ' + (out || r.stderr.slice(0, 120)));
      // 操作后刷新一次快照，让面板立刻反映新状态
      setTimeout(() => { try { const s = probeOnce(); ctx.snapshot('music', s); } catch (e) {} }, 350);
      return { ok, detail: out };
    },
  };
};
