#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真实鼠标拖动探针（供 verify-walk.sh 用）。

为什么要真实输入：桌宠的原生拖动在 Rust 里靠 `GetAsyncKeyState(VK_LBUTTON)` 判断
按键是否还按着；CDP 合成的 PointerEvent 只改 DOM，操作系统按键状态仍是抬起，
拖动线程立刻退出 —— 用合成事件测「长按 2.6 秒不出走」会得到假 PASS/假 FAIL。

用法：
  python drag-hold.py --x 1200 --y 1400 --hold 2.6 --move 60
流程：把光标移到 (x,y) → 按下左键 → 静止 hold 秒 → 可选水平拖动 move 像素 → 松开。
退出码 0 表示动作完整执行（判定由调用方的位置采样做）。
"""
import argparse
import ctypes
import sys
import time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--x", type=int, required=True)
    ap.add_argument("--y", type=int, required=True)
    ap.add_argument("--hold", type=float, default=2.6)
    ap.add_argument("--move", type=int, default=0)
    a = ap.parse_args()

    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass

    u = ctypes.windll.user32
    if not u.SetCursorPos(a.x, a.y):
        print("SetCursorPos failed", file=sys.stderr)
        return 1
    time.sleep(0.15)
    u.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
    t0 = time.time()
    while time.time() - t0 < a.hold:
        time.sleep(0.05)
    if a.move:
        step = 6
        sign = 1 if a.move > 0 else -1
        done = 0
        while done < abs(a.move):
            done = min(done + step, abs(a.move))
            u.SetCursorPos(a.x + sign * done, a.y)
            time.sleep(0.04)
        time.sleep(0.25)
    u.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
    print("released")
    return 0


if __name__ == "__main__":
    sys.exit(main())
