"""CDP 包装：由 python 子进程起 node（继承控制台，不闪窗抢焦点）。
verify3 里所有 eval/shot 走这里，别在 bash 里直接起 node/powershell。
用法: python ev.py <M|S|P|F|C|shotM|shotS|shotP|shotF|shotC> <js表达式|png路径>

main 与预建 sao 是两个 page target，必须按 URL 选择。调试端口可能绑定在
IPv4 127.0.0.1:9223 或 IPv6 [::1]:9223，这里自动探测，避免绑定顺序影响验收。"""
import subprocess, os, sys, json, urllib.request

CDP = os.environ.get("CDP_JS", os.path.join(os.path.dirname(os.path.abspath(__file__)), "cdp.js"))
mode, arg = sys.argv[1], sys.argv[2]
if mode in ("M", "shotM"):
    pat = "tauri.localhost/$"
    want = "tauri.localhost/"          # 主窗 page URL（精确，避免匹配到 sao.html）
    exact = True
elif mode in ("S", "shotS"):
    pat = "sao.html"
    want = "sao.html"
    exact = False
elif mode in ("P", "shotP"):
    pat = "panel.html"
    want = "panel.html"
    exact = False
elif mode in ("F", "shotF"):
    pat = "search.html"
    want = "search.html"
    exact = False
elif mode in ("C", "shotC"):
    pat = "chat.html"
    want = "chat.html"
    exact = False
else:
    print("unknown mode " + mode)
    raise SystemExit(1)


def targets(base):
    try:
        with urllib.request.urlopen(base + "/json", timeout=3) as r:
            return json.load(r)
    except Exception:
        return []


def find_base():
    for base in ("http://127.0.0.1:9223", "http://[::1]:9223"):
        for t in targets(base):
            u = t.get("url", "")
            if exact:
                # 主窗 URL 形如 http://tauri.localhost/ （末尾斜杠，无 sao.html）
                if u.rstrip("/").endswith("tauri.localhost") and "sao.html" not in u:
                    return base
            elif want in u:
                return base
    return "http://127.0.0.1:9223"


base = find_base()
env = dict(os.environ, CDP_BASE=base, CDP_URL=pat)
cmd = ["node", CDP, "shot" if mode.startswith("shot") else "eval", arg]
r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                   errors="replace", env=env, timeout=30)
sys.stdout.write(r.stdout)
if r.returncode != 0:
    sys.stderr.write(r.stderr)
raise SystemExit(r.returncode)