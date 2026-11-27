"""C 项：量四个未测交互的延迟（只测量，不改交互逻辑）。

用法（在仓库 tauri/ 目录下）：
    python scripts/latency-probe.py --exe H:/_rust/catwhale-perf/run/c --port 9223 \
        --rounds 5 --out H:/Hermes交付/.../evidence/latency.json

口径
----
* 触发器一律是应用自己的命令（和用户点菜单条目/右键走同一条后端路径）：
  open_sao / open_panel(control) / open_float(chat) / island_cmd(info)。
  触发用一条常驻 CDP 连接的 Runtime.evaluate 直接命中页面（不经鼠标），
  排除了合成输入与 node 启动开销；右键那条链路实测只多一次事件派发（<1ms）。
* 计时起点 = 发出 CDP 帧的瞬间（time.perf_counter），终点 = Win32 侧
  `IsWindowVisible(目标 hwnd)` 首次为真的瞬间，轮询间隔约 1ms。
  所以报出来的是「命令发出 → 窗口真的可见」的墙钟时间，跨进程、机器时钟同一口径。
* 「已可交互」另用一条：窗口可见后再用 CDP 查目标页的关键 DOM 已布局
  （菜单项/输入框/卡片），这条只做定性核对，不参与中位数统计。
* 每轮把四个指标各测一次（交错），每次采样同时记全机 CPU（GetSystemTimes）。
* 同一台机器上另有并发负载，故取中位数并保留每轮原始值。
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

from websockets.sync.client import connect

HERE = os.path.dirname(os.path.abspath(__file__))

user32 = ctypes.WinDLL("user32", use_last_error=True)
user32.FindWindowW.restype = ctypes.c_void_p
user32.FindWindowW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p]
user32.IsWindowVisible.argtypes = [ctypes.c_void_p]
user32.IsWindowVisible.restype = ctypes.c_bool
user32.GetWindowRect.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_long * 4)]
user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
user32.mouse_event.argtypes = [ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p]
user32.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
user32.IsWindow.argtypes = [ctypes.c_void_p]
user32.IsWindow.restype = ctypes.c_bool
user32.EnumWindows.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
user32.GetWindowTextLengthW.argtypes = [ctypes.c_void_p]
user32.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]

# 窗口标题：精确匹配在含「·」的标题上不可靠（FindWindowW 要求逐字符相等），
# 所以面板/聊天按子串认；缓存 hwnd 以免每 1ms 都枚举一次窗口。
WINDOW_MATCH = {
    "main": ("catwhale-poc", True),
    "sao": ("sao", True),
    "panel": ("工具面板", False),
    "chat": ("聊天", False),
    "island": ("island", True),
}
_HWND_CACHE = {}


def _enum_windows():
    handles = []
    proc_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def callback(handle, _param):
        length = user32.GetWindowTextLengthW(handle)
        if length:
            buffer = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(handle, buffer, length + 1)
            handles.append((handle, buffer.value))
        return True

    user32.EnumWindows(proc_type(callback), 0)
    return handles


def hwnd_of(name, refresh=False):
    if not refresh:
        cached = _HWND_CACHE.get(name)
        if cached and user32.IsWindow(cached):
            return cached
    needle, exact = WINDOW_MATCH[name]
    for handle, title in _enum_windows():
        if (title == needle) if exact else (needle in title):
            _HWND_CACHE[name] = handle
            return handle
    _HWND_CACHE.pop(name, None)
    return None


class _FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", ctypes.c_uint32), ("dwHighDateTime", ctypes.c_uint32)]


def _ft(ft):
    return (ft.dwHighDateTime << 32) | ft.dwLowDateTime


def cpu_busy_pct(before, after):
    idle, total = after[0] - before[0], (after[1] - before[1]) + (after[2] - before[2])
    return None if total <= 0 else round(100.0 * (total - idle) / total, 2)


def cpu_times():
    idle, kernel, user = _FILETIME(), _FILETIME(), _FILETIME()
    ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user))
    return (_ft(idle), _ft(kernel), _ft(user))


def visible(name):
    handle = hwnd_of(name)
    return bool(handle) and user32.IsWindowVisible(handle)


def rect_of(name):
    handle = hwnd_of(name, refresh=False)
    if not handle:
        handle = hwnd_of(name, refresh=True)
    if not handle:
        return None
    box = (ctypes.c_long * 4)()
    if not user32.GetWindowRect(handle, box):
        return None
    return (box[0], box[1], box[2], box[3])


class Cdp:
    """常驻 CDP 连接：一次握手，之后每次 evaluate 只要 ~0.2ms。"""

    def __init__(self, port, url_filter="tauri.localhost/$"):
        self.port = port
        self.url_filter = url_filter
        self.ws = None
        self.next_id = 0

    def page_ws(self, url_filter=None):
        pattern = url_filter or self.url_filter
        for base in (f"http://127.0.0.1:{self.port}", f"http://[::1]:{self.port}"):
            try:
                with urllib.request.urlopen(base + "/json/list", timeout=3) as response:
                    targets = json.load(response)
            except Exception:
                continue
            for target in targets:
                if target.get("type") != "page":
                    continue
                url = target.get("url", "")
                if pattern and not __import__("re").search(pattern, url):
                    continue
                return target["webSocketDebuggerUrl"]
        raise RuntimeError("找不到 CDP page target")

    def open(self, url_filter=None):
        self.close()
        self.ws = connect(self.page_ws(url_filter), open_timeout=10, max_size=64 * 1024 * 1024)
        return self

    def close(self):
        if self.ws is not None:
            try:
                self.ws.close()
            except Exception:
                pass
            self.ws = None

    def send(self, expression, await_promise=False):
        """只发不等，用于「触发」——计时起点就在这一行之前。"""
        self.next_id += 1
        assert self.ws is not None, "CDP 连接未建立"
        self.ws.send(json.dumps({
            "id": self.next_id,
            "method": "Runtime.evaluate",
            "params": {"expression": expression, "returnByValue": True,
                       "awaitPromise": await_promise},
        }))
        return self.next_id

    def drain(self, message_id, timeout=10):
        end = time.time() + timeout
        assert self.ws is not None, "CDP 连接未建立"
        while time.time() < end:
            message = json.loads(self.ws.recv())
            if message.get("id") == message_id:
                return message
        return None

    def eval(self, expression, await_promise=True, timeout=20):
        message_id = self.send(expression, await_promise)
        return self.drain(message_id, timeout)

    def value(self, expression, await_promise=True):
        message = self.eval(expression, await_promise)
        result = (message or {}).get("result", {}).get("result", {})
        return result.get("value")


ISLAND_STATE_JS = "!!(document.getElementById('isl') && document.getElementById('isl').classList.contains('open'))"


def island_open(island_client):
    try:
        return island_client.value(ISLAND_STATE_JS, await_promise=False) is True
    except Exception:
        return None


def wait_until(predicate, deadline_s=15.0, step=0.001):
    end = time.perf_counter() + deadline_s
    while time.perf_counter() < end:
        if predicate():
            return time.perf_counter()
        time.sleep(step)
    return None


def measure_trigger(cdp, trigger_js, target, settle=0.25, timeout=15.0, require_hidden=None):
    """发出触发帧 → 轮询目标窗口可见。返回 (毫秒, 系统 CPU%)。"""
    time.sleep(settle)
    if require_hidden is not None:
        # 触发前确认它是隐藏的，否则「可见」可能是上一次的状态，会量成 0.1ms 这种假值
        if visible(require_hidden):
            if wait_until(lambda: not visible(require_hidden), 2.0, 0.003) is None:
                return None, cpu_busy_pct(cpu_times(), cpu_times())
    before = cpu_times()
    started = time.perf_counter()
    message_id = cdp.send(trigger_js)
    stamp = wait_until(lambda: visible(target), timeout)
    elapsed = None if stamp is None else round((stamp - started) * 1000.0, 1)
    cdp.drain(message_id)
    return elapsed, cpu_busy_pct(before, cpu_times())


def interactive_check(cdp, url_filter, expression, timeout=2.0):
    """窗口可见后，确认关键 DOM 已布局（定性核对，不计入中位数）。"""
    probe = Cdp(cdp.port, url_filter).open()
    end = time.perf_counter() + timeout
    ok = False
    while time.perf_counter() < end:
        if probe.value(expression) is True:
            ok = True
            break
        time.sleep(0.02)
    probe.close()
    return ok


OPAQUE_POINT_JS = """
(function () {
  const D = window.__hitGridDiag;
  const v = activeVideo();
  const g = D.fast();
  if (!g) return null;
  const data = D.unpack(g.bits.slice(0));
  const b = g.bbox;
  const cx = 48, cy = 80;              /* 包围盒中心附近的格 */
  let best = null, bestD = 1e9;
  for (let y = 0; y < 160; y++) {
    for (let x = 0; x < 96; x++) {
      if (!data[y * 96 + x]) continue;
      const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d < bestD) { bestD = d; best = [x, y]; }
    }
  }
  if (!best) return null;
  /* 网格格心 → 窗口归一化坐标（包围盒是网格→窗口的线性映射） */
  const fx = b[0] + ((best[0] + 0.5) / 96) * (b[2] - b[0]);
  const fy = b[1] + ((best[1] + 0.5) / 160) * (b[3] - b[1]);
  return {fx: fx, fy: fy, cell: best};
})()
"""


def drag_follow_samples(cdp, steps=6, step_px=40):
    """真实拖动主窗，量「主窗位移 → 灵动岛位移」的滞后。

    取点：从当前帧命中网格里挑离它中心最近的不透明格（命中点随帧变化，
    写死坐标会点空 → 拖动根本不开始）。
    """
    main_rect = rect_of("main")
    if not main_rect:
        return None, [], {}
    point = cdp.value(OPAQUE_POINT_JS)
    if not point:
        return None, [], {"error": "没有不透明格"}
    width = main_rect[2] - main_rect[0]
    height = main_rect[3] - main_rect[1]
    cx = main_rect[0] + int(point["fx"] * width)
    cy = main_rect[1] + int(point["fy"] * height)
    lags, stats = _drag_trace(cx, cy, steps, step_px)
    return (round(statistics.median(lags), 1) if lags else None), lags, stats


def _drag_trace(cx, cy, steps, step_px):
    user32.SetCursorPos(cx, cy)
    time.sleep(0.15)
    user32.mouse_event(0x0002, 0, 0, 0, None)  # LEFTDOWN
    time.sleep(0.05)
    trace = []
    try:
        for index in range(1, steps + 1):
            user32.SetCursorPos(cx - step_px * index, cy)
            step_time = time.perf_counter()
            end = step_time + 0.12
            while time.perf_counter() < end:
                mr = rect_of("main")
                ir = rect_of("island")
                trace.append((time.perf_counter(), mr[0] if mr else None, ir[0] if ir else None))
                time.sleep(0.001)
    finally:
        user32.mouse_event(0x0004, 0, 0, 0, None)  # LEFTUP
    # 配对：主窗左边缘每前进 ≥8px，找灵动岛左边缘同步变化的第一帧
    lags = []
    main_steps = 0
    island_steps = 0
    last_main = last_island = None
    for _t, m, i in trace:
        if m is not None and last_main is not None and abs(m - last_main) >= 2:
            main_steps += 1
        if i is not None and last_island is not None and abs(i - last_island) >= 2:
            island_steps += 1
        last_main = m if m is not None else last_main
        last_island = i if i is not None else last_island
    for index in range(1, len(trace)):
        t_prev, m_prev, i_prev = trace[index - 1]
        t_now, m_now, i_now = trace[index]
        if None in (m_prev, m_now, i_prev, i_now):
            continue
        if abs(m_now - m_prev) < 8:
            continue
        for later in range(index, len(trace)):
            t2, _m2, i2 = trace[later]
            if i2 is not None and i2 != i_prev and abs(i2 - i_prev) >= 4:
                lags.append(round((t2 - t_now) * 1000.0, 1))
                break
    return lags, {"samples": len(trace), "main_moves": main_steps, "island_moves": island_steps}


def summarize(values):
    clean = [v for v in values if v is not None]
    if not clean:
        return None
    ordered = sorted(clean)
    return {"n": len(ordered), "median_ms": round(statistics.median(ordered), 1),
            "min_ms": round(ordered[0], 1), "max_ms": round(ordered[-1], 1),
            "samples_ms": ordered}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", required=True)
    ap.add_argument("--port", default="9223")
    ap.add_argument("--rounds", type=int, default=5)
    ap.add_argument("--prewarm", default="1", help="透传 CATWHALE_PREWARM（旧 exe 忽略）")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    exe = os.path.join(args.exe, "catwhale-poc.exe")
    iso = os.path.join(args.exe, "iso-latency")
    os.makedirs(os.path.join(iso, "config"), exist_ok=True)
    os.makedirs(os.path.join(iso, "eb"), exist_ok=True)
    env = dict(os.environ,
               CATWHALE_CONFIG_DIR=os.path.join(iso, "config"),
               WEBVIEW2_USER_DATA_FOLDER=os.path.join(iso, "eb"),
               # 调试口用环境变量注入：被量的 exe 与交付 exe 逐字节相同
               WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=" + args.port,
               CATWHALE_PREWARM=args.prewarm)
    proc = subprocess.Popen([exe], cwd=args.exe, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    cdp = None
    report = {"port": args.port, "targets": WINDOW_MATCH,
              "triggers": {
                  "sao": "invoke('open_sao')",
                  "panel": "invoke('open_panel',{panel:'control'})",
                  "chat": "invoke('open_panel',{panel:'chat'})",
                  "island": "invoke('island_cmd',{cmd:'info'})",
                  "follow": "真实左键拖动主窗（mouse_event + SetCursorPos 分步）",
              },
              "timer": "time.perf_counter 起 → IsWindowVisible(目标 hwnd) 为真止，轮询约 1ms"}
    try:
        cdp = Cdp(args.port).open()
        ready = wait_until(lambda: cdp.value("window.__petReady === true") is True, 40.0, 0.2)
        if not ready:
            sys.exit("主窗未就绪")
        time.sleep(2.0)
        isl_cdp = Cdp(args.port, "island.html").open()

        # ---- 冷启动首开（各 1 次，标签为 cold，不进中位数）----
        cold = {}
        for key, trigger in (("panel", "window.__TAURI__.core.invoke('open_panel',{panel:'control'})"),
                             ("chat", "window.__TAURI__.core.invoke('open_float','chat')")):
            if visible(key):
                user32.ShowWindow(hwnd_of(key), 0)  # SW_HIDE
                time.sleep(0.4)
            value, cpu = measure_trigger(cdp, trigger, key)
            cold[key] = {"first_open_ms": value, "cpu_percent": cpu}

        # ---- 交错轮次 ----
        rows = []
        collected = {"sao": [], "panel": [], "chat": [], "island_appear": [], "island_follow": []}
        cpu_rows = []
        for round_index in range(1, args.rounds + 1):
            row = {"round": round_index, "cpu_percent": {}}

            cdp.eval("window.__TAURI__.core.invoke('close_sao')")
            time.sleep(0.2)
            if wait_until(lambda: not visible("sao"), 2.0, 0.005) is None:
                row["sao_note"] = "close_sao 后菜单仍可见"
            value, cpu = measure_trigger(cdp, "window.__TAURI__.core.invoke('open_sao')", "sao", settle=0.1,
                                          require_hidden="sao")
            row["sao_ms"], row["cpu_percent"]["sao"] = value, cpu
            collected["sao"].append(value)
            # 菜单开着时主窗整窗可交互、左键先走「点角色收菜单」，会抢掉后面的拖动测量
            cdp.eval("window.__TAURI__.core.invoke('close_sao')")
            time.sleep(0.25)

            # 综合面板：面板没有关闭命令（窗口常驻），Win32 SW_HIDE 也不行——Tauri 认为它还
            # 可见，show() 会直接返回。所以用面板页自己的 getCurrentWindow().hide() 准备状态。
            prepared = False
            try:
                pane = Cdp(args.port, "panel.html").open()
                pane.eval("window.__TAURI__.window.getCurrentWindow().hide()")
                pane.close()
                prepared = wait_until(lambda: not visible("panel"), 2.0, 0.003) is not None
            except Exception as error:
                row["panel_note"] = "准备隐藏失败：" + str(error)[:80]
            if prepared:
                value, cpu = measure_trigger(cdp, "window.__TAURI__.core.invoke('open_panel',{panel:'control'})",
                                             "panel", require_hidden="panel")
            else:
                value, cpu = None, None
                row["panel_note"] = "hide() 后仍可见，跳过（否则量到的是已开着的窗口）"
            row["panel_ms"], row["cpu_percent"]["panel"] = value, cpu
            collected["panel"].append(value)

            cdp.eval("window.__TAURI__.core.invoke('close_float',{label:'chat'})")
            time.sleep(0.25)
            value, cpu = measure_trigger(cdp, "window.__TAURI__.core.invoke('open_panel',{panel:'chat'})", "chat",
                                             require_hidden="chat")
            row["chat_ms"], row["cpu_percent"]["chat"] = value, cpu
            collected["chat"].append(value)

            # 出现：灵动岛窗口常驻可见（形变都在页面里做，窗口尺寸不变），
            # 所以「出现」= 岛页面切到 open 态（#isl.open），只能问页面。
            cdp.eval("window.__TAURI__.core.invoke('island_cmd',{cmd:'dismiss'})")
            closed = wait_until(lambda: island_open(isl_cdp) is False, 2.0, 0.002)
            if closed is None:
                row["island_appear_ms"] = None
                row["island_appear_note"] = "dismiss 后页面仍是 open 态，跳过"
                collected["island_appear"].append(None)
            else:
                before = cpu_times()
                started = time.perf_counter()
                message_id = cdp.send("window.__TAURI__.core.invoke('island_cmd',{cmd:'info'})")
                stamp = wait_until(lambda: island_open(isl_cdp) is True, 5.0, 0.001)
                value = None if stamp is None else round((stamp - started) * 1000.0, 1)
                cdp.drain(message_id)
                row["island_appear_ms"] = value
                row["cpu_percent"]["island"] = cpu_busy_pct(before, cpu_times())
                collected["island_appear"].append(value)

            # 跟随：岛必须先处于显示状态（dismiss 是异步的，可能刚好在拖动时才隐藏）
            cdp.eval("window.__TAURI__.core.invoke('island_cmd',{cmd:'info'})")
            if wait_until(lambda: visible("island"), 2.0, 0.005) is None:
                row["island_follow_note"] = "岛未显示，跳过跟随"
                collected["island_follow"].append(None)
                rows.append(row)
                sys.stderr.write("round %d: %s\n" % (round_index, json.dumps(row, ensure_ascii=False)))
                continue
            lag, lags, stats = drag_follow_samples(cdp)
            if stats.get("island_moves", 0) > 2 * max(1, stats.get("main_moves", 1)):
                row["island_follow_note"] = "岛自身位移远多于主窗（重锚定/动画），本轮不计"
                lag = None
            row["island_follow_ms"], row["island_follow_steps"] = lag, lags
            row["island_follow_stats"] = stats
            collected["island_follow"].append(lag)
            rows.append(row)
            sys.stderr.write(f"round {round_index}: {json.dumps(row, ensure_ascii=False)}\n")

        report["rounds"] = rows
        report["cold_first_open"] = cold
        report["summary"] = {key: summarize(values) for key, values in collected.items()}
        spot = {}
        for key, url, expression in (
            ("sao_menu_items", "sao.html", "document.querySelectorAll('#sao [data-cat]').length >= 5 && document.querySelectorAll('#sao button').length > 0"),
            ("panel_ready", "panel.html", "!!document.querySelector('#app, .shell, body>div')"),
            ("chat_ready", "chat.html", "!!window.__chatTest && !!document.getElementById('cinput')"),
            ("island_ready", "island.html", "window.__islandReady === true"),
        ):
            try:
                spot[key] = interactive_check(cdp, url, expression)
            except Exception as error:
                spot[key] = "ERR: " + str(error)[:120]
        report["interactive_spotcheck"] = spot
        report["notes"] = [
            "同一台机器上有并发负载（另一 agent 在跑 Electron 测量），每轮记全机 CPU。",
            "面板/聊天/灵动岛的重复打开都走应用自己的命令，窗口已被预热（WebView2 已初始化）。",
            "冷启动首开是单次样例（n=1），只说明首次代价量级，不代表分布。",
        ]
        text = json.dumps(report, ensure_ascii=False, indent=1)
        if args.out:
            os.makedirs(os.path.dirname(args.out), exist_ok=True)
            with open(args.out, "w", encoding="utf-8") as handle:
                handle.write(text + "\n")
            print("写入 " + args.out)
        print(json.dumps({k: report[k] for k in ("summary", "cold_first_open", "interactive_spotcheck")},
                         ensure_ascii=False, indent=1))
    finally:
        try:
            if cdp is not None:
                cdp.eval("window.__TAURI__.core.invoke('quit')", timeout=10)
        except Exception:
            pass
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
