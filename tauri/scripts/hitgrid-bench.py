"""B 项验收：命中网格成本优化（新实现 vs 改造前）。

用法（在仓库 tauri/ 目录下）：
    python scripts/hitgrid-bench.py \
        --old-exe H:/_rust/catwhale-perf/run/b-old --old-port 9224 \
        --new-exe H:/_rust/catwhale-perf/run/b-new --new-port 9223 \
        --rounds 5 --samples 16 \
        --out H:/Hermes交付/.../evidence/hitgrid.json

两件事：
  1) 等价性：在新实现的运行实例里，同一帧上分别跑 legacy（改造前原样拷贝）
     与 fast（生产实现），逐格比对 + 在 ≥200 个采样点上比对命中结论；
  2) 耗时：老 exe 与新 exe **交替**启动（单实例互斥，不能并行），各测 N 次，
     每次都在页面里用 performance.now 打点，同时用 GetSystemTimes 记系统总 CPU，
     因为这台机器上有别的 agent 在跑测量，负载会漂。

计时口径：页面里 `performance.now()` 包住一次完整的 window.sampleHitGrid()
（含 drawImage / getImageData / alpha 扫描 / 打包 / invoke 提交）。
"""
import argparse
import ctypes
import json
import os
import statistics
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CDP_JS = os.path.join(HERE, "cdp.js")


# ---------------------------------------------------------------- 系统 CPU
class _FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", ctypes.c_uint32), ("dwHighDateTime", ctypes.c_uint32)]


def _ft_value(ft):
    return (ft.dwHighDateTime << 32) | ft.dwLowDateTime


def cpu_times():
    idle, kernel, user = _FILETIME(), _FILETIME(), _FILETIME()
    ctypes.windll.kernel32.GetSystemTimes(
        ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user))
    return (_ft_value(idle), _ft_value(kernel), _ft_value(user))


def cpu_busy_pct(before, after):
    """全机 CPU 占用率（所有核心合计）。"""
    idle = after[0] - before[0]
    total = (after[1] - before[1]) + (after[2] - before[2])
    if total <= 0:
        return None
    return round(100.0 * (total - idle) / total, 2)


# ---------------------------------------------------------------- CDP
def cdp_eval(expr, port, timeout=180, url_filter="tauri.localhost/$"):
    env = dict(os.environ, CDP_BASE=f"http://127.0.0.1:{port}", CDP_URL=url_filter)
    proc = subprocess.run(["node", CDP_JS, "eval", expr], capture_output=True, text=True,
                          encoding="utf-8", errors="replace", env=env, timeout=timeout)
    text = (proc.stdout or "").strip()
    if not text:
        raise RuntimeError(f"CDP 无输出: {(proc.stderr or '').strip()[:300]}")
    if text.startswith("EXCEPTION"):
        raise RuntimeError(text[:400])
    return json.loads(text)


def wait_ready(port, deadline_s=40):
    end = time.time() + deadline_s
    while time.time() < end:
        try:
            if cdp_eval("window.__petReady === true", port, timeout=10) is True:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def launch(exe_dir, port, tag):
    exe = os.path.join(exe_dir, "catwhale-poc.exe")
    iso = os.path.join(exe_dir, "iso-" + tag)
    cfg = os.path.join(iso, "config")
    eb = os.path.join(iso, "eb")
    os.makedirs(cfg, exist_ok=True)
    os.makedirs(eb, exist_ok=True)
    env = dict(os.environ, CATWHALE_CONFIG_DIR=cfg, WEBVIEW2_USER_DATA_FOLDER=eb)
    proc = subprocess.Popen([exe], cwd=exe_dir, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ok = wait_ready(port)
    return proc, ok


def shutdown(proc, port):
    try:
        cdp_eval("window.__TAURI__.core.invoke('quit').then(()=>'ok')", port, timeout=15)
    except Exception:
        pass
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)
    time.sleep(1.5)


# ---------------------------------------------------------------- JS 片段
MEASURE_JS = """
(async () => {
  const N = %d;
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const out = [];
  for (let i = 0; i < N; i++) {
    await wait(110);
    const a = performance.now();
    window.sampleHitGrid();
    out.push(+(performance.now() - a).toFixed(3));
  }
  return {samples: out, state: (window.__hitGridDiag && window.__hitGridDiag.state)
    ? window.__hitGridDiag.state() : null};
})()
"""

# 同一实例内 legacy / fast 交替（共用同一支视频、同一套负载，控制变量最严）
PAIR_JS = """
(async () => {
  const D = window.__hitGridDiag;
  const N = %d;
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const leg = [], fas = [];
  for (let i = 0; i < N; i++) {
    await wait(110);
    let a = performance.now(); D.legacy(); leg.push(+(performance.now() - a).toFixed(3));
    await wait(110);
    a = performance.now(); D.fast(); fas.push(+(performance.now() - a).toFixed(3));
  }
  return {legacy: leg, fast: fas};
})()
"""

# 等价性：暂停视频逐帧 seek，两种实现各采一次，逐格 + 采样点比对
EQUALITY_JS = """
(async () => {
  const D = window.__hitGridDiag;
  const v = [].slice.call(document.querySelectorAll('video')).filter(function (x) {
    return x._stateId && x.readyState >= 2;
  })[0] || document.querySelector('video');
  if (!v) return {err: 'no video'};
  const P = window.__petMirrorForTest = (typeof M !== 'undefined' ? M : null);
  const origMirror = P ? P.petMirror : false;
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const seek = (t) => new Promise((res) => {
    let done = false;
    const h = () => { if (done) return; done = true; v.removeEventListener('seeked', h); res(); };
    v.addEventListener('seeked', h);
    try { v.currentTime = t; } catch (e) { h(); }
    setTimeout(h, 300);
  });
  const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 2;
  v.pause();
  const report = {poses: [], video: {w: v.videoWidth, h: v.videoHeight, dur: +dur.toFixed(3)}};
  let worst = {cells: 0, points: 0};
  let totalPoints = 0, diffPoints = 0, totalCells = 0, diffCells = 0;
  const diffs = [];
  const mirrors = [false, true];
  const fracs = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95];
  for (let mi = 0; mi < mirrors.length; mi++) {
    if (P) P.petMirror = mirrors[mi];
    for (let fi = 0; fi < fracs.length; fi++) {
      await seek(dur * fracs[fi]);
      await wait(40);
      const L = D.legacy();          /* 改造前实现 */
      const F = D.fast();            /* 生产实现（返回位打包） */
      if (!L || !F) { report.poses.push({mirror: mirrors[mi], frac: fracs[fi], skipped: 'empty'}); continue; }
      const bitsCopy = F.bits.slice(0);       /* 立刻拷贝：hitBits 是共享缓冲 */
      const unpacked = D.unpack(bitsCopy);
      let cellDiff = 0;
      for (let i = 0; i < unpacked.length; i++) if (unpacked[i] !== L.data[i]) cellDiff++;
      const gLegacy = {bbox: L.bbox, data: L.data};
      const gFast = {bbox: F.bbox, data: unpacked};
      /* ≥200 个采样点：21×13 网格覆盖窗口（含边界与透明区）+ 包围盒四条边中点 */
      const pts = [];
      for (let xi = 0; xi <= 20; xi++) for (let yi = 0; yi <= 12; yi++) pts.push([xi / 20, yi / 12]);
      const b = L.bbox;
      pts.push([b[0], (b[1] + b[3]) / 2], [b[2], (b[1] + b[3]) / 2],
               [(b[0] + b[2]) / 2, b[1]], [(b[0] + b[2]) / 2, b[3]],
               [b[0], b[1]], [b[2], b[3]], [b[0] + 1e-6, (b[1] + b[3]) / 2],
               [b[2] - 1e-6, (b[1] + b[3]) / 2]);
      let pDiff = 0;
      for (let pi = 0; pi < pts.length; pi++) {
        const x = pts[pi][0], y = pts[pi][1];
        const a = D.decide(gLegacy, x, y), c = D.decide(gFast, x, y);
        if (a !== c) { pDiff++; if (diffs.length < 40) diffs.push({x: x, y: y, legacy: a, fast: c, pose: {m: mirrors[mi], f: fracs[fi]}}); }
      }
      const opaque = L.data.reduce(function (s, x) { return s + x; }, 0);
      report.poses.push({mirror: mirrors[mi], frac: fracs[fi], cells: unpacked.length,
                         cell_diff: cellDiff, points: pts.length, point_diff: pDiff,
                         opaque_cells: opaque, bbox: L.bbox, bbox_fast: F.bbox});
      totalCells += unpacked.length; diffCells += cellDiff;
      totalPoints += pts.length; diffPoints += pDiff;
      if (cellDiff > worst.cells) worst.cells = cellDiff;
      if (pDiff > worst.points) worst.points = pDiff;
    }
  }
  if (P) P.petMirror = origMirror;
  v.play();
  report.total = {cells: totalCells, cell_diff: diffCells, points: totalPoints,
                  point_diff: diffPoints, poses: report.poses.length};
  report.diffs = diffs;
  return report;
})()
"""


def summarize(values):
    if not values:
        return None
    ordered = sorted(values)
    return {
        "n": len(ordered),
        "median": round(statistics.median(ordered), 3),
        "mean": round(statistics.fmean(ordered), 3),
        "p10": round(ordered[max(0, int(len(ordered) * 0.1))], 3),
        "p90": round(ordered[min(len(ordered) - 1, int(len(ordered) * 0.9))], 3),
        "min": round(ordered[0], 3),
        "max": round(ordered[-1], 3),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old-exe", default="")
    ap.add_argument("--old-port", default="9224")
    ap.add_argument("--new-exe", required=True)
    ap.add_argument("--new-port", default="9223")
    ap.add_argument("--rounds", type=int, default=5)
    ap.add_argument("--samples", type=int, default=16)
    ap.add_argument("--out", default="")
    ap.add_argument("--skip-equality", action="store_true")
    args = ap.parse_args()

    report = {"methods": {
        "sampler_ms": "页面内 performance.now 包住一次 window.sampleHitGrid()",
        "cpu": "Win32 GetSystemTimes 差值，全机所有核心合计占用率",
        "equality": "同一帧上 legacy/fast 逐格 + 21x13 采样点比对（Rust Grid::hit 复刻）",
        "interleave": "old/new 交替整轮启动（单实例互斥），逐轮记系统 CPU",
    }, "rounds": []}

    # ---- 1) 等价性（新实现实例）----
    if not args.skip_equality:
        proc, ok = launch(args.new_exe, args.new_port, "eq")
        if not ok:
            proc.kill()
            sys.exit("新实例未就绪")
        try:
            time.sleep(2.0)
            report["equality"] = cdp_eval(EQUALITY_JS, args.new_port, timeout=240)
            # Rust 侧收到的网格：不透明格数应与页面一致
            try:
                report["dbg_hit"] = cdp_eval("window.__TAURI__.core.invoke('dbg_hit')", args.new_port, timeout=20)
            except Exception as error:
                report["dbg_hit_error"] = str(error)[:200]
        finally:
            shutdown(proc, args.new_port)

    # ---- 2) 交替计时 ----
    variants = []
    if args.old_exe:
        variants.append(("old", args.old_exe, args.old_port))
    variants.append(("new", args.new_exe, args.new_port))

    series = {name: [] for name, _d, _p in variants}
    pair = {"legacy": [], "fast": []}
    cpu_by_round = []

    for round_index in range(1, args.rounds + 1):
        row = {"round": round_index, "variants": {}}
        for name, exe_dir, port in variants:
            before = cpu_times()
            started = time.time()
            proc, ok = launch(exe_dir, port, f"{name}-r{round_index}")
            if not ok:
                proc.kill()
                row["variants"][name] = {"error": "not ready"}
                continue
            try:
                time.sleep(3.0)  # 预热：解码器/JIT
                before2 = cpu_times()
                data = cdp_eval(MEASURE_JS % args.samples, port, timeout=180)
                after2 = cpu_times()
                samples = [s for s in data["samples"]]
                series[name].extend(samples)
                row["variants"][name] = {
                    "samples": samples,
                    "summary": summarize(samples),
                    "cpu_percent_during_sampling": cpu_busy_pct(before2, after2),
                    "launch_to_quit_s": round(time.time() - started, 2),
                    "cheap_samples_lt_0.05ms": sum(1 for s in samples if s < 0.05),
                }
                if name == "new":
                    try:
                        pair_data = cdp_eval(PAIR_JS % max(6, args.samples // 2), port, timeout=180)
                        pair["legacy"].extend(pair_data["legacy"])
                        pair["fast"].extend(pair_data["fast"])
                        row["variants"][name]["pair"] = {
                            "legacy": summarize(pair_data["legacy"]),
                            "fast": summarize(pair_data["fast"]),
                        }
                    except Exception as error:
                        row["variants"][name]["pair_error"] = str(error)[:200]
            finally:
                shutdown(proc, port)
            row["variants"][name]["cpu_percent_whole_round"] = cpu_busy_pct(before, cpu_times())
        cpu_by_round.append(row["variants"])
        report["rounds"].append(row)
        sys.stderr.write(f"round {round_index}/{args.rounds} done\n")

    report["series_summary"] = {name: summarize(values) for name, values in series.items()}
    report["pair_summary"] = {name: summarize(values) for name, values in pair.items()}
    report["notes"] = [
        "同一台机器、同一位用户会话；采样期间另有并发负载，按轮交替并记录系统 CPU。",
        "单实例互斥（CreateMutexW）使 old/new 无法并行，只能整轮交替。",
        "旧 exe 的窗口尺寸/缩放与视频素材与新 exe 相同（同一份 frontend/assets）。",
    ]

    text = json.dumps(report, ensure_ascii=False, indent=1)
    if args.out:
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
        print("写入 " + args.out)
    print(json.dumps({k: report[k] for k in ("series_summary", "pair_summary") if k in report},
                     ensure_ascii=False, indent=1))
    if "equality" in report:
        eq = report["equality"]
        print("等价性: " + json.dumps(eq.get("total", eq.get("err")), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
