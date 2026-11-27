"""A 项验收：Tauri 配置目录隔离。

用法（在仓库 tauri/ 目录下）：
    python scripts/check-config-isolation.py --exe H:/_rust/catwhale-perf/run/a1 \
        --runs 2 --out H:/.../evidence/config-isolation.json

做法：
  1. 记录用户真实配置目录（%APPDATA%\\com.hermes.catwhalepoc）每个文件的 sha256 + mtime；
  2. 每一轮用全新的隔离目录（CATWHALE_CONFIG_DIR + WEBVIEW2_USER_DATA_FOLDER）启动 exe，
     等页面就绪、再等 6 秒让 settings/看门狗/媒体探针都落盘，然后用 CDP 调 quit 正常退出；
  3. 重新记录真实目录 sha256，和启动前比对；
  4. 记录隔离目录自己生成了什么（文件 + settings.json 内容摘要）。

--exe 指向一个“运行时目录”（含 catwhale-poc.exe、WebView2Loader.dll、frontend/assets）。
脚本不会写真实配置目录；它只读。
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CDP_JS = os.path.join(HERE, "cdp.js")
PORT = os.environ.get("CDP_PORT", "9223")


def real_config_dir():
    appdata = os.environ.get("APPDATA") or os.path.expanduser("~")
    return os.path.join(appdata, "com.hermes.catwhalepoc")


def tree_state(root):
    """{相对路径: {sha256, size, mtime}}；目录不存在返回 {}。"""
    state = {}
    if not os.path.isdir(root):
        return state
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, root).replace("\\", "/")
            try:
                with open(path, "rb") as handle:
                    digest = hashlib.sha256(handle.read()).hexdigest()
                stat = os.stat(path)
            except OSError as error:
                state[rel] = {"error": str(error)}
                continue
            state[rel] = {
                "sha256": digest,
                "size": stat.st_size,
                "mtime": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(stat.st_mtime)),
            }
    return state


def cdp_eval(expr, timeout=15):
    env = dict(os.environ, CDP_BASE="http://127.0.0.1:" + PORT, CDP_URL="tauri.localhost/$")
    proc = subprocess.run(["node", CDP_JS, "eval", expr], capture_output=True, text=True,
                          encoding="utf-8", errors="replace", env=env, timeout=timeout)
    return proc.stdout.strip() or proc.stderr.strip()


def wait_ready(deadline_s=30):
    """等主窗 page ready（window.__petReady）与 CDP 口起来。"""
    end = time.time() + deadline_s
    while time.time() < end:
        try:
            value = cdp_eval("window.__petReady === true", timeout=8)
            if value.strip() == "true":
                return True
        except Exception:
            pass
        time.sleep(0.8)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", required=True, help="运行时目录（含 catwhale-poc.exe）")
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--out", default="")
    ap.add_argument("--settle", type=float, default=6.0)
    args = ap.parse_args()

    exe = os.path.join(args.exe, "catwhale-poc.exe")
    if not os.path.isfile(exe):
        sys.exit("找不到 exe: " + exe)
    real = real_config_dir()
    if not os.path.isdir(real):
        sys.exit("真实配置目录不存在，拒绝在未知状态下测试: " + real)

    before = tree_state(real)
    print(f"真实目录 {real}: {len(before)} 个文件（启动前已记录）")

    runs = []
    for index in range(1, args.runs + 1):
        iso = os.path.join(args.exe, "..", f"iso-run{index}")
        iso = os.path.abspath(iso)
        cfg = os.path.join(iso, "config")
        eb = os.path.join(iso, "eb")
        os.makedirs(cfg, exist_ok=True)
        os.makedirs(eb, exist_ok=True)
        env = dict(os.environ, CATWHALE_CONFIG_DIR=cfg, WEBVIEW2_USER_DATA_FOLDER=eb)
        print(f"第 {index} 轮启动：CATWHALE_CONFIG_DIR={cfg}")
        started = time.time()
        proc = subprocess.Popen([exe], cwd=args.exe, env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ready = wait_ready()
        time.sleep(args.settle)
        quit_out = cdp_eval("window.__TAURI__.core.invoke('quit').then(()=>'quit-sent')")
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
        elapsed = round(time.time() - started, 2)
        print(f"  第 {index} 轮：ready={ready} quit={quit_out!r} 用时 {elapsed}s")
        iso_state = tree_state(cfg)
        settings = ""
        settings_path = os.path.join(cfg, "settings.json")
        if os.path.isfile(settings_path):
            with open(settings_path, "r", encoding="utf-8", errors="replace") as handle:
                settings = handle.read()
        runs.append({
            "run": index,
            "ready": ready,
            "quit": quit_out,
            "elapsed_s": elapsed,
            "isolated_dir": cfg,
            "isolated_files": iso_state,
            "isolated_settings_json": settings,
        })

    after = tree_state(real)
    changed = {}
    for rel in sorted(set(before) | set(after)):
        b = before.get(rel)
        a = after.get(rel)
        if b != a:
            changed[rel] = {"before": b, "after": a}

    report = {
        "real_dir": real,
        "files_before": len(before),
        "files_after": len(after),
        "sha256_before": {k: v.get("sha256") for k, v in before.items()},
        "sha256_after": {k: v.get("sha256") for k, v in after.items()},
        "changed": changed,
        "untouched": not changed,
        "runs": runs,
    }
    text = json.dumps(report, ensure_ascii=False, indent=1)
    if args.out:
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
        print("写入 " + args.out)
    print("真实目录是否未被改动: " + ("是（sha256 全等）" if not changed else f"否，{len(changed)} 项变化"))
    for rel, diff in changed.items():
        print(f"  变化: {rel}")
    for run in runs:
        print(f"  隔离目录 {run['isolated_dir']} 文件: {sorted(run['isolated_files'])}")
    return 0 if not changed else 1


if __name__ == "__main__":
    sys.exit(main())
