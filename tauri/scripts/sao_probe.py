"""verify4 助手：主窗/菜单窗真实状态 + 右键开 / Esc 关 / 失焦关 / 几何 / 尺寸断言。
用法: python sao_probe.py <wins|precheck|opencheck|rclick|esc|escsub|blur|geom|size|bottom> [h_expect bottom_expect]
除 wins 外都输出一行带 ok 字段的 JSON。窗口可见性以 WS_VISIBLE 位为准
（Tauri hide() 后 IsWindowVisible 可能仍报 true，见 probe_user_scenario 注释）。"""
import ctypes, ctypes.wintypes as w, subprocess, json, time, sys, os

u = ctypes.windll.user32
u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
VK_ESCAPE = 0x1B
SPI_GETWORKAREA = 0x0030


def pids():
    # 纯 Win32 枚举进程，不用 powershell/tasklist —— 那些会闪控制台窗口抢焦点，
    # 把失焦即关的菜单半路关掉（实测 2026-11-17，verify3 多处假 FAIL 的根因）。
    import ctypes.wintypes as wt
    arr = (wt.DWORD * 4096)()
    needed = wt.DWORD()
    psapi = ctypes.windll.psapi
    if not psapi.EnumProcesses(ctypes.byref(arr), ctypes.sizeof(arr), ctypes.byref(needed)):
        return set()
    k32 = ctypes.windll.kernel32
    out = set()
    for i in range(needed.value // ctypes.sizeof(wt.DWORD)):
        pid = arr[i]
        if pid == 0:
            continue
        h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            continue
        buf = ctypes.create_unicode_buffer(1024)
        sz = wt.DWORD(1024)
        if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(sz)):
            if buf.value.lower().endswith("\\catwhale-poc.exe"):
                out.add(pid)
        k32.CloseHandle(h)
    return out


def wins(ps=None):
    if ps is None:
        ps = pids()
    res = {}

    @ctypes.WINFUNCTYPE(ctypes.c_bool, w.HWND, w.LPARAM)
    def cb(h, l):
        pid = w.DWORD()
        u.GetWindowThreadProcessId(h, ctypes.byref(pid))
        if pid.value in ps:
            n = ctypes.create_unicode_buffer(64)
            u.GetWindowTextW(h, n, 64)
            if n.value in ("catwhale-poc", "sao"):
                r = w.RECT()
                u.GetWindowRect(h, ctypes.byref(r))
                ex = u.GetWindowLongW(h, -20)
                sty = u.GetWindowLongW(h, -16)
                res[n.value] = {"hwnd": int(h), "vis": bool(sty & 0x10000000),
                                "rect": [r.left, r.top, r.right - r.left, r.bottom - r.top],
                                "t": bool(ex & 0x20)}
        return True
    u.EnumWindows(cb, 0)
    return res


def poll_vis(expect, timeout=3.0):
    ps = pids()  # 进程集合在测试期间不变，缓存下来避免每拍重枚举
    t0 = time.time()
    while time.time() - t0 < timeout:
        if wins(ps).get("sao", {}).get("vis") == expect:
            return time.time() - t0
        time.sleep(0.03)
    return None


def body_point():
    m = wins()["catwhale-poc"]["rect"]
    return m[0] + m[2] // 2, m[1] + int(m[3] * 0.62)


def find_hit():
    """用 dbg_hit 找一个当前帧确定不透明的点。固定比例点会随 idle 动画帧相位
    落进透明区（点击穿透到下层窗口，右键开菜单时灵时不灵），必须实测命中。"""
    m = wins()["catwhale-poc"]["rect"]
    cands = [(0.5, 0.62), (0.5, 0.75), (0.5, 0.85), (0.42, 0.70),
             (0.58, 0.70), (0.5, 0.50), (0.5, 0.90)]
    env = dict(os.environ, CDP_URL="tauri.localhost/$",
               CDP_BASE="http://127.0.0.1:9223")
    cdp = os.environ.get("CDP_JS", os.path.join(os.path.dirname(os.path.abspath(__file__)), "cdp.js"))
    for fx, fy in cands:
        x, y = m[0] + int(m[2] * fx), m[1] + int(m[3] * fy)
        u.SetCursorPos(x, y)
        time.sleep(0.15)
        r = subprocess.run(["node", cdp, "eval",
                            "(async()=>{try{return await window.__TAURI__.core.invoke('dbg_hit')}catch(e){return null}})()"],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", env=env, timeout=20)
        try:
            d = json.loads(r.stdout.strip())
            if d and d.get("hit"):
                return x, y
        except Exception:
            pass
    return body_point()


def rclick(x, y):
    u.SetCursorPos(x, y); time.sleep(0.30)
    u.mouse_event(0x0008, 0, 0, 0, 0); time.sleep(0.07)
    u.mouse_event(0x0010, 0, 0, 0, 0)


def lclick(x, y):
    u.SetCursorPos(x, y); time.sleep(0.30)
    u.mouse_event(0x0002, 0, 0, 0, 0); time.sleep(0.07)
    u.mouse_event(0x0004, 0, 0, 0, 0)


def force_fg(hwnd):
    """非前台进程直接 SetForegroundWindow 会被前台锁拒绝；先按一下 Alt 放行。"""
    u.keybd_event(0x12, 0, 0, 0)
    u.keybd_event(0x12, 0, 2, 0)
    u.SetForegroundWindow(hwnd)


def cfg():
    return json.load(open(os.path.join(os.environ["APPDATA"],
                                       "com.hermes.catwhalepoc", "config.json"),
                          encoding="utf-8"))


def out(d):
    print(json.dumps(d, ensure_ascii=False))


# 被其他 probe import 时不跑 CLI（否则模块级分发会往 stdout 吐 JSON 污染调用方）
cmd = (sys.argv[1] if len(sys.argv) > 1 else "wins") if __name__ == "__main__" else None

if cmd == "wins":
    out(wins())

elif cmd == "precheck":
    st = wins()
    s = st.get("sao")
    out({"ok": bool(s) and s["vis"] is False, "sao_exists": bool(s),
         "sao_vis": s["vis"] if s else None})

elif cmd == "opencheck":
    st = wins()
    s = st.get("sao")
    out({"ok": bool(s) and s["vis"] is True, "sao_vis": s["vis"] if s else None})

elif cmd == "rclick":
    st = wins()
    if "catwhale-poc" not in st:
        out({"ok": False, "err": "no main window"}); raise SystemExit(0)
    pt = find_hit()
    rclick(*pt)
    lat = poll_vis(True, 2.5)
    st = wins()
    out({"ok": lat is not None, "latency": round(lat, 3) if lat is not None else None,
         "point": list(pt),
         "sao_rect": st.get("sao", {}).get("rect"), "main_t": st["catwhale-poc"]["t"]})

elif cmd == "esc":
    st = wins()
    sao = st.get("sao", {})
    fg = u.GetForegroundWindow()
    was = fg == sao.get("hwnd")
    # 正式菜单是 NOACTIVATE：真实 Esc 必须在外部应用持前台时仍可工作，
    # 探针不能为了发送按键而主动抢前台，否则会把输入法焦点链等待带进验收。
    u.keybd_event(VK_ESCAPE, 0, 0, 0)
    u.keybd_event(VK_ESCAPE, 0, 2, 0)
    lat = poll_vis(False, 2.5)
    out({"ok": lat is not None, "latency": round(lat, 3) if lat is not None else None,
         "fg_was_sao": was})

elif cmd == "escsub":
    # 发一次 ESC，不等菜单隐藏 —— 二级开着时第一下 Esc 只收二级（原版语义）
    st = wins()
    sao = st.get("sao", {})
    fg = u.GetForegroundWindow()
    was = fg == sao.get("hwnd")
    # 正式菜单是 NOACTIVATE：真实 Esc 必须在外部应用持前台时仍可工作，
    # 探针不能为了发送按键而主动抢前台，否则会把输入法焦点链等待带进验收。
    u.keybd_event(VK_ESCAPE, 0, 0, 0)
    u.keybd_event(VK_ESCAPE, 0, 2, 0)
    time.sleep(0.25)
    out({"ok": True, "fg_was_sao": was})

elif cmd == "blur":
    st = wins()
    wa = w.RECT()
    u.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(wa), 0)
    cands = [(wa.left + 40, wa.bottom - 40), (wa.left + 40, wa.top + 40),
             (wa.right - 40, wa.top + 40)]

    def inside(p, r):
        return r[0] <= p[0] <= r[0] + r[2] and r[1] <= p[1] <= r[1] + r[3]
    pt = next((p for p in cands
               if not any(inside(p, v["rect"]) for v in st.values() if v["vis"])), None)
    if pt is None:
        out({"ok": False, "err": "no outside point"}); raise SystemExit(0)
    lclick(*pt)
    # 点状态栏/工具条这类子窗口不一定激活顶层窗（实测 SOLIDWORKS 状态栏：
    # 点完前台抖一下又回到 sao，菜单永远等不到失焦）。0.6s 后菜单还开着的话，
    # 直接对别的进程的可见顶层窗 SetForegroundWindow —— 等价于用户 Alt+Tab 切走，
    # 失焦语义不变，只是把「点外面」这一步做确定。
    time.sleep(0.6)
    forced = None
    if wins().get("sao", {}).get("vis"):
        other = []

        @ctypes.WINFUNCTYPE(ctypes.c_bool, w.HWND, w.LPARAM)
        def cb2(h, l):
            pid = w.DWORD()
            u.GetWindowThreadProcessId(h, ctypes.byref(pid))
            sty = u.GetWindowLongW(h, -16)
            if pid.value not in pids() and (sty & 0x10000000):
                n = ctypes.create_unicode_buffer(64)
                u.GetWindowTextW(h, n, 64)
                if n.value:
                    other.append((h, n.value))
            return True
        u.EnumWindows(cb2, 0)
        if other:
            force_fg(other[0][0])
            forced = other[0][1]
    lat = poll_vis(False, 2.5)
    if lat is None:
        # 失败现场：前台是谁 + sao 是否还挂着
        fg = u.GetForegroundWindow()
        n = ctypes.create_unicode_buffer(128)
        u.GetWindowTextW(fg, n, 128)
        pid = w.DWORD()
        u.GetWindowThreadProcessId(fg, ctypes.byref(pid))
        out({"ok": False, "latency": None, "point": list(pt), "forced_fg": forced,
             "fg_title": n.value, "fg_pid": pid.value,
             "sao_vis": wins().get("sao", {}).get("vis")})
    else:
        out({"ok": True, "latency": round(lat, 3), "point": list(pt), "forced_fg": forced})

elif cmd == "geom":
    st = wins()
    m, s = st.get("catwhale-poc"), st.get("sao")
    if not m or not s:
        out({"ok": False, "err": "missing window"}); raise SystemExit(0)
    c = cfg()
    sf = m["rect"][3] / c["h"] if c.get("h") else 1.5
    ew, eh = round(708 * sf), round(374 * sf)
    gap = round(10 * sf)
    mr, sr = m["rect"], s["rect"]
    size_ok = abs(sr[2] - ew) <= 3 and abs(sr[3] - eh) <= 3
    right = abs(sr[0] - (mr[0] + mr[2] + gap)) <= 3
    left = abs((sr[0] + sr[2]) - (mr[0] - gap)) <= 3
    out({"ok": size_ok and (right or left), "sao_rect": sr, "expect_wh": [ew, eh],
         "side": "right" if right else ("left(mirror)" if left else "??"), "sf": sf})

elif cmd == "bottom":
    m = wins()["catwhale-poc"]["rect"]
    print(m[1] + m[3])

elif cmd == "size":
    h_exp, bot_exp = int(sys.argv[2]), int(sys.argv[3])
    m = wins()["catwhale-poc"]["rect"]
    c = cfg()
    sf = m[3] / c["h"] if c.get("h") else 1.5
    ok = (c.get("h") == h_exp and abs(m[3] - h_exp * sf) <= 3
          and abs((m[1] + m[3]) - bot_exp) <= 3)
    out({"ok": ok, "cfg_h": c.get("h"), "physH": m[3], "bottom": m[1] + m[3],
         "expect_bottom": bot_exp})

elif cmd is not None:
    out({"ok": False, "err": "unknown cmd " + cmd})