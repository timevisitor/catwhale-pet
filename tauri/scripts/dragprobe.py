# -*- coding: utf-8 -*-
"""拖动探针：按住角色并以恒定速度水平拖动，同时高频采样光标与窗口位置。
用法：python dragprobe.py <cx> <cy> <dir 1/-1>
输出 JSON：窗口位移更新次数与间隔、窗口相对光标的滞后（均值/标准差/最大）。
"""
import ctypes
import json
import statistics
import sys
import time

ctypes.windll.shcore.SetProcessDpiAwareness(2)
u = ctypes.windll.user32
ctypes.windll.winmm.timeBeginPeriod(1)


class RECT(ctypes.Structure):
    _fields_ = [("l", ctypes.c_long), ("t", ctypes.c_long), ("r", ctypes.c_long), ("b", ctypes.c_long)]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def main():
    cx0, cy0, direction = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
    hwnd = u.FindWindowW(None, "catwhale-poc")
    if not hwnd:
        print(json.dumps({"error": "main window not found"}))
        return 1
    old = POINT()
    u.GetCursorPos(ctypes.byref(old))
    try:
        u.SetCursorPos(cx0, cy0)
        time.sleep(0.35)              # 先悬停：等穿透轮询（50ms）把窗口切回可交互
        u.SetCursorPos(cx0 + 2, cy0)
        time.sleep(0.2)
        u.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
        time.sleep(0.12)                   # 等角色进入「抓住」状态
        samples = []
        t_start = time.perf_counter()
        vx = 600.0 * direction             # 物理像素/秒
        last_t = t_start
        while time.perf_counter() - t_start < 1.2:
            t = time.perf_counter()
            dt = t - last_t
            last_t = t
            cx = cx0 + int(vx * (t - t_start))
            u.SetCursorPos(cx, cy0)
            c = POINT()
            r = RECT()
            u.GetCursorPos(ctypes.byref(c))
            u.GetWindowRect(hwnd, ctypes.byref(r))
            samples.append((t - t_start, c.x, r.l))
            time.sleep(0.002)
        time.sleep(0.2)
    finally:
        u.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
        time.sleep(0.1)
        u.SetCursorPos(old.x, old.y)
        ctypes.windll.winmm.timeEndPeriod(1)
    moving = [s for s in samples if 0.15 <= s[0] <= 1.15 and (s[1] - samples[0][1]) * direction > 30]
    if len(moving) < 20:
        print(json.dumps({"error": "no drag movement detected", "n": len(samples), "first": samples[:5]}))
        return 0
    # 只看光标在动的区间：窗口每次位置变化之间的时间间隔
    changes = [moving[0]]
    for prev, cur in zip(moving, moving[1:]):
        if cur[2] != prev[2]:
            changes.append(cur)
    intervals = [b[0] - a[0] for a, b in zip(changes, changes[1:])]
    base = moving[0][2] - moving[0][1]
    lags = [abs((s[2] - s[1]) - base) for s in moving[3:]]
    return {
        "samples": len(moving),
        "cursorTravelPx": moving[-1][1] - moving[0][1],
        "windowTravelPx": moving[-1][2] - moving[0][2],
        "updates": len(changes),
        "updateHz": round(len(changes) / (moving[-1][0] - moving[0][0]), 1),
        "intervalMs": {
            "avg": round(statistics.mean(intervals) * 1000, 2) if intervals else None,
            "min": round(min(intervals) * 1000, 2) if intervals else None,
            "max": round(max(intervals) * 1000, 2) if intervals else None,
            "stdev": round(statistics.pstdev(intervals) * 1000, 2) if intervals else None,
        },
        "lagPx": {
            "avg": round(statistics.mean(lags), 2) if lags else None,
            "stdev": round(statistics.pstdev(lags), 2) if lags else None,
            "max": round(max(lags), 2) if lags else None,
        },
    }


if __name__ == "__main__":
    out = main()
    if isinstance(out, dict):
        print(json.dumps(out))
    sys.exit(0 if isinstance(out, dict) else out)
