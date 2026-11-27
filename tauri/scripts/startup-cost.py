# -*- coding: utf-8 -*-
"""启动代价：主窗首帧可见、SAO 菜单就绪、启动后 10 秒的进程树 CPU 与 RSS。

用法（在仓库 tauri/ 目录下）：
    python scripts/startup-cost.py --exe H:/_rust/catwhale-perf/run/r3-after --runs 3 \
        --out H:/Hermes交付/.../evidence-round3/startup-after.json

口径
----
* `main_visible_ms`：Popen 起 → 主窗（IsWindowVisible）首次为真，轮询 5ms。
* `pet_ready_ms`：Popen 起 → 页面 `window.__petReady === true`（视频元数据就绪，和上一轮的
  「启动到视频就绪」同口径）。
* `sao_ready_ms`：Popen 起 → sao 页 `window.__saoReady === true`（菜单预建完成且页面初始化完毕，
  这是「右键菜单能不能立刻出来」的真实就绪时刻）。
* `cpu_pct`：进程树（父子关系递归）用户+内核时间增量 / 墙钟，换算成**占单核百分比**。
  分三段记：0~2s（首帧+菜单预建）、2~6s（预热窗所在时段）、6~10s（稳态）。
* `rss_mb`：进程树各进程 WorkingSetSize 之和（=「工作集」，任务管理器显示的近似值），
  记 2s / 6s / 10s 三个时刻与最大值。
* 隔离：CATWHALE_CONFIG_DIR + WEBVIEW2_USER_DATA_FOLDER 都指向 exe 目录下的 iso-startup，
  不碰用户真实配置目录。
"""
import argparse
import ctypes
import ctypes.wintypes as wt
import json
import os
import statistics
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

k32 = ctypes.windll.kernel32
psapi = ctypes.windll.psapi
user32 = ctypes.windll.user32
user32.FindWindowW.restype = ctypes.c_void_p
user32.FindWindowW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p]
user32.IsWindowVisible.argtypes = [ctypes.c_void_p]
user32.IsWindowVisible.restype = ctypes.c_bool

TH32CS_SNAPPROCESS = 0x2
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wt.DWORD),
                ("cntThreads", wt.DWORD), ("th32ParentProcessID", wt.DWORD),
                ("pcPriClassBase", ctypes.c_long), ("dwFlags", wt.DWORD),
                ("szExeFile", ctypes.c_wchar * 260)]


class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
    _fields_ = [("cb", wt.DWORD), ("PageFaultCount", wt.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t),
                ("PrivateUsage", ctypes.c_size_t)]


k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
k32.OpenProcess.restype = wt.HANDLE


def tree(root):
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == INVALID_HANDLE_VALUE:
        return [root]
    entries = []
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(entry)
    ok = k32.Process32FirstW(snap, ctypes.byref(entry))
    while ok:
        entries.append((entry.th32ProcessID, entry.th32ParentProcessID))
        ok = k32.Process32NextW(snap, ctypes.byref(entry))
    k32.CloseHandle(snap)
    pids = {root}
    changed = True
    while changed:
        changed = False
        for pid, ppid in entries:
            if ppid in pids and pid not in pids:
                pids.add(pid)
                changed = True
    return sorted(pids)


def sample(root):
    """返回 (累计 CPU 秒, RSS MB)。"""
    cpu = 0.0
    rss = 0
    for pid in tree(root):
        handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            continue
        creation, exit_, kernel, user = (wt.FILETIME(), wt.FILETIME(), wt.FILETIME(), wt.FILETIME())
        if k32.GetProcessTimes(handle, ctypes.byref(creation), ctypes.byref(exit_),
                              ctypes.byref(kernel), ctypes.byref(user)):
            cpu += ((kernel.dwHighDateTime << 32 | kernel.dwLowDateTime)
                    + (user.dwHighDateTime << 32 | user.dwLowDateTime)) / 1e7
        counters = PROCESS_MEMORY_COUNTERS_EX()
        counters.cb = ctypes.sizeof(counters)
        if psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), ctypes.sizeof(counters)):
            rss += counters.WorkingSetSize
        k32.CloseHandle(handle)
    return cpu, rss / 1048576.0


def main_hwnd():
    handle = user32.FindWindowW("Tauri Window", "catwhale-poc")
    return handle if handle else None


def window_visible(handle):
    return bool(handle) and bool(user32.IsWindowVisible(handle))


def cdp_targets(port):
    for base in ("http://127.0.0.1:%s" % port, "http://[::1]:%s" % port):
        try:
            with urllib.request.urlopen(base + "/json/list", timeout=3) as response:
                return json.load(response)
        except Exception:
            continue
    return []


def target_value(port, url_part, expression, deadline):
    """轮询某个 page target 里的表达式，返回 (True, t) / (False, None)。"""
    from websockets.sync.client import connect
    while time.perf_counter() < deadline:
        for target in cdp_targets(port):
            if target.get("type") != "page" or url_part not in target.get("url", ""):
                continue
            try:
                with connect(target["webSocketDebuggerUrl"], open_timeout=2) as sock:
                    sock.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                                          "params": {"expression": expression, "returnByValue": True}}))
                    while True:
                        message = json.loads(sock.recv())
                        if message.get("id") == 1:
                            value = message.get("result", {}).get("result", {}).get("value")
                            if value is True:
                                return True, time.perf_counter()
                            break
            except Exception:
                pass
        time.sleep(0.02)
    return False, None


def one_run(exe_dir, port, tag, prewarm="1", samples_s=10.0):
    import threading

    iso = os.path.join(exe_dir, "iso-startup")
    os.makedirs(os.path.join(iso, "config"), exist_ok=True)
    os.makedirs(os.path.join(iso, "eb"), exist_ok=True)
    # 隔离目录跨轮复用，日志会累积；每轮清掉 startup.log，才能看清本轮到底预建了没有
    log_path = os.path.join(iso, "config", "startup.log")
    if os.path.exists(log_path):
        try:
            os.remove(log_path)
        except OSError:
            pass
    env = dict(os.environ,
               CATWHALE_CONFIG_DIR=os.path.join(iso, "config"),
               WEBVIEW2_USER_DATA_FOLDER=os.path.join(iso, "eb"),
               WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=" + port,
               CATWHALE_PREWARM=prewarm)
    result = {"tag": tag, "prewarm_env": prewarm}
    marks = {}
    started = time.perf_counter()
    proc = subprocess.Popen([os.path.join(exe_dir, "catwhale-poc.exe")], cwd=exe_dir, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def wait_main():
        deadline = started + 40.0
        while time.perf_counter() < deadline:
            if window_visible(main_hwnd()):
                marks["main"] = (time.perf_counter() - started) * 1000.0
                return
            time.sleep(0.005)

    def wait_page(url_part, expression, key):
        deadline = started + 45.0
        while time.perf_counter() < deadline:
            ok, stamp = target_value(port, url_part, expression, min(deadline, time.perf_counter() + 0.4))
            if ok and stamp is not None:
                marks[key] = (stamp - started) * 1000.0
                return
            time.sleep(0.05)

    threads = [threading.Thread(target=wait_main, daemon=True),
               threading.Thread(target=wait_page, args=("tauri.localhost/", "window.__petReady === true", "pet"), daemon=True),
               threading.Thread(target=wait_page, args=("sao.html", "window.__saoReady === true", "sao"), daemon=True)]
    for thread in threads:
        thread.start()

    try:
        # 0~10s 采样：每 250ms 记一次累计 CPU / RSS（从 Popen 时刻起，含首帧阶段）
        timeline = []
        next_sample = 0.0
        while True:
            elapsed = time.perf_counter() - started
            if elapsed > samples_s:
                break
            if elapsed >= next_sample:
                cpu, rss = sample(proc.pid)
                timeline.append({"t": round(elapsed, 3), "cpu_s": round(cpu, 3), "rss_mb": round(rss, 1)})
                next_sample = elapsed + 0.25
            time.sleep(0.01)
        for thread in threads:
            thread.join(timeout=1.0)

        result["main_visible_ms"] = round(marks["main"], 1) if "main" in marks else None
        result["pet_ready_ms"] = round(marks["pet"], 1) if "pet" in marks else None
        result["sao_ready_ms"] = round(marks["sao"], 1) if "sao" in marks else None

        def window_cpu(t0, t1):
            points = [p for p in timeline if t0 <= p["t"] <= t1]
            if len(points) < 2:
                return None
            span = points[-1]["t"] - points[0]["t"]
            if span <= 0:
                return None
            return round(100.0 * (points[-1]["cpu_s"] - points[0]["cpu_s"]) / span, 1)

        def rss_at(t0):
            points = [p for p in timeline if p["t"] >= t0]
            return points[0]["rss_mb"] if points else None

        result["cpu_pct"] = {"0-2s": window_cpu(0.0, 2.0), "2-6s": window_cpu(2.0, 6.0),
                             "6-10s": window_cpu(6.0, 10.0),
                             "0-10s": window_cpu(0.0, samples_s)}
        result["rss_mb"] = {"at_2s": rss_at(2.0), "at_6s": rss_at(6.0), "at_10s": rss_at(samples_s - 0.5),
                            "peak": max((p["rss_mb"] for p in timeline), default=None)}
        result["timeline"] = timeline

        # 收尾：走应用自己的 quit 命令（和探针脚本一致），超时再杀
        try:
            from websockets.sync.client import connect
            targets = [t for t in cdp_targets(port) if t.get("url", "").endswith("/")]
            if targets:
                with connect(targets[0]["webSocketDebuggerUrl"], open_timeout=3) as sock:
                    sock.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                                          "params": {"expression": "window.__TAURI__.core.invoke('quit')"}}))
                    sock.recv()
        except Exception:
            pass
    finally:
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
        time.sleep(1.0)
        result["log_tail"] = ""
        log = os.path.join(iso, "config", "startup.log")
        if os.path.exists(log):
            with open(log, encoding="utf-8", errors="replace") as handle:
                lines = [line for line in handle.read().splitlines()
                         if line.startswith("[prewarm]") or line.startswith("[sao]")]
                result["log_tail"] = lines[-6:]
    return result


def median(values):
    clean = [v for v in values if v is not None]
    return round(statistics.median(clean), 1) if clean else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", required=True)
    ap.add_argument("--port", default="9223")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--prewarm", default="1", help="透传 CATWHALE_PREWARM（旧 exe 忽略）")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    runs = [one_run(args.exe, args.port, str(i), args.prewarm) for i in range(1, args.runs + 1)]
    summary = {
        "main_visible_ms": {"median": median([r.get("main_visible_ms") for r in runs]),
                            "samples": [r.get("main_visible_ms") for r in runs]},
        "pet_ready_ms": {"median": median([r.get("pet_ready_ms") for r in runs]),
                         "samples": [r.get("pet_ready_ms") for r in runs]},
        "sao_ready_ms": {"median": median([r.get("sao_ready_ms") for r in runs]),
                         "samples": [r.get("sao_ready_ms") for r in runs]},
        "cpu_pct": {key: median([(r.get("cpu_pct") or {}).get(key) for r in runs])
                    for key in ("0-2s", "2-6s", "6-10s", "0-10s")},
        "cpu_pct_samples": {key: [(r.get("cpu_pct") or {}).get(key) for r in runs]
                            for key in ("0-2s", "2-6s", "6-10s", "0-10s")},
        "rss_mb": {key: median([(r.get("rss_mb") or {}).get(key) for r in runs])
                   for key in ("at_2s", "at_6s", "at_10s", "peak")},
        "rss_mb_samples": {key: [(r.get("rss_mb") or {}).get(key) for r in runs]
                           for key in ("at_2s", "at_6s", "at_10s", "peak")},
    }
    report = {"exe": args.exe, "prewarm_env": args.prewarm, "runs": runs, "summary": summary,
              "timing": "全部以 Popen 时刻为 0；CPU 为进程树累计增量/墙钟，占单核百分比"}
    text = json.dumps(report, ensure_ascii=False, indent=1)
    if args.out:
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
        print("写入 " + args.out)
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
