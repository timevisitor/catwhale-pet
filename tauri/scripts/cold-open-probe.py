"""冷启动首开延迟：面板 / 聊天（每次全新实例，WebView2 未预热）。

用法（在仓库 tauri/ 目录下）：
    python scripts/cold-open-probe.py --exe H:/_rust/catwhale-perf/run/b-new --port 9223 --runs 3

为什么单独一条：`open_panel` 首次调用要建窗口 + 初始化 WebView2，重复调用则是
show()（几十毫秒）。两者数量级不同，混在一起报中位数没有意义，所以冷热分开量。
计时口径与 latency-probe.py 一致：time.perf_counter 起 → IsWindowVisible 为真止。
"""
import argparse
import json
import os
import statistics
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import importlib.util

_spec = importlib.util.spec_from_file_location("latency_probe", os.path.join(HERE, "latency-probe.py"))
lp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lp)


def one_run(exe_dir, port, tag, settle=1.5, prewarm="1"):
    iso = os.path.join(exe_dir, "iso-cold-" + tag)
    os.makedirs(os.path.join(iso, "config"), exist_ok=True)
    os.makedirs(os.path.join(iso, "eb"), exist_ok=True)
    env = dict(os.environ,
               CATWHALE_CONFIG_DIR=os.path.join(iso, "config"),
               WEBVIEW2_USER_DATA_FOLDER=os.path.join(iso, "eb"),
               # 调试口用环境变量注入（对主窗与子窗同一条环境生效），
               # 这样被量的 exe 与交付 exe 逐字节相同，不用另建带调试口的构建。
               WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=" + port,
               CATWHALE_PREWARM=prewarm)
    proc = subprocess.Popen([os.path.join(exe_dir, "catwhale-poc.exe")], cwd=exe_dir, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    result = {"tag": tag}
    try:
        cdp = lp.Cdp(port).open()
        if lp.wait_until(lambda: cdp.value("window.__petReady === true") is True, 40.0, 0.2) is None:
            result["error"] = "主窗未就绪"
            return result
        # settle：主窗就绪后再等多久才「点开」。默认 1.5s 是上一轮的口径；
        # 预热版本在就绪后 2.0s/3.5s 才预建，要量「预热完成后的首开」得用 --settle 5。
        time.sleep(settle)
        result["settle_s"] = settle
        result["prewarm_env"] = prewarm
        for key, js, target in (
            ("panel", "window.__TAURI__.core.invoke('open_panel',{panel:'control'})", "panel"),
            ("chat", "window.__TAURI__.core.invoke('open_panel',{panel:'chat'})", "chat"),
        ):
            before = lp.cpu_times()
            started = time.perf_counter()
            message_id = cdp.send(js)
            stamp = lp.wait_until(lambda: lp.visible(target), 60.0, 0.002)
            value = None if stamp is None else round((stamp - started) * 1000.0, 1)
            cdp.drain(message_id)
            result[key + "_cold_ms"] = value
            result[key + "_cpu_percent"] = lp.cpu_busy_pct(before, lp.cpu_times())
            lp.wait_until(lambda: lp.visible(target), 30.0, 0.01)
        try:
            cdp.eval("window.__TAURI__.core.invoke('quit')", timeout=10)
        except Exception:
            pass
    finally:
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
        time.sleep(1.0)
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", required=True)
    ap.add_argument("--port", default="9223")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--settle", type=float, default=1.5,
                    help="主窗就绪后再等多久才触发打开（秒）；预热在就绪后 2.0/3.5s 才完成，量预热后首开用 5")
    ap.add_argument("--prewarm", default="1", help="透传 CATWHALE_PREWARM（旧 exe 忽略）")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    runs = [one_run(args.exe, args.port, str(index), args.settle, args.prewarm)
            for index in range(1, args.runs + 1)]
    summary = {}
    for key in ("panel", "chat"):
        values = [r.get(key + "_cold_ms") for r in runs if r.get(key + "_cold_ms") is not None]
        if values:
            summary[key] = {"n": len(values), "median_ms": round(statistics.median(values), 1),
                            "min_ms": min(values), "max_ms": max(values), "samples_ms": values}
    report = {
        "timer": "time.perf_counter 起 → IsWindowVisible(目标 hwnd) 为真止（每次全新实例）",
        "runs": runs,
        "summary": summary,
        "notes": ["冷首开含新建窗口 + WebView2 初始化；同一台机器有并发负载，逐次记 CPU。"],
    }
    text = json.dumps(report, ensure_ascii=False, indent=1)
    if args.out:
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
        print("写入 " + args.out)
    print(json.dumps({"summary": summary, "runs": runs}, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
