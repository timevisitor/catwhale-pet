# -*- coding: utf-8 -*-
"""按父子关系统计某个进程树的空闲 CPU（占单核百分比）。
用法：python cpupidle.py <根进程 pid> <秒数>
只用系统 API（CreateToolhelp32Snapshot / OpenProcess / GetProcessTimes），不依赖 wmic / CIM。
"""
import ctypes
import ctypes.wintypes as wt
import json
import sys
import time

k32 = ctypes.windll.kernel32
TH32CS_SNAPPROCESS = 0x2
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wt.DWORD), ("cntThreads", wt.DWORD),
                ("th32ParentProcessID", wt.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wt.DWORD),
                ("szExeFile", ctypes.c_wchar * 260)]


k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
k32.OpenProcess.restype = wt.HANDLE


def tree_cpu(root):
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == INVALID_HANDLE_VALUE:
        return None, 0, {}
    entries = []
    e = PROCESSENTRY32W()
    e.dwSize = ctypes.sizeof(e)
    ok = k32.Process32FirstW(snap, ctypes.byref(e))
    while ok:
        entries.append((e.th32ProcessID, e.th32ParentProcessID, e.szExeFile))
        ok = k32.Process32NextW(snap, ctypes.byref(e))
    k32.CloseHandle(snap)
    pids = {root}
    changed = True
    while changed:
        changed = False
        for pid, ppid, _ in entries:
            if ppid in pids and pid not in pids:
                pids.add(pid)
                changed = True
    total = 0
    per = {}
    for pid in pids:
        h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            continue
        c, x, kt, ut = (wt.FILETIME(), wt.FILETIME(), wt.FILETIME(), wt.FILETIME())
        if k32.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(x), ctypes.byref(kt), ctypes.byref(ut)):
            t = ((kt.dwHighDateTime << 32 | kt.dwLowDateTime) + (ut.dwHighDateTime << 32 | ut.dwLowDateTime)) / 1e7
            total += t
            name = next((n for p, _, n in entries if p == pid), "?")
            per[name] = round(per.get(name, 0) + t, 2)
        k32.CloseHandle(h)
    return total, len(pids), per


def main():
    root, secs = int(sys.argv[1]), float(sys.argv[2])
    a, n, pa = tree_cpu(root)
    time.sleep(secs)
    b, n2, pb = tree_cpu(root)
    if a is None or b is None:
        print(json.dumps({"error": "snapshot failed"}))
        return 1
    print(json.dumps({
        "processes": n2,
        "idleCpuPctOfOneCore": round((b - a) / secs * 100, 2),
        "perImagePct": {k: round((pb[k] - pa.get(k, 0)) / secs * 100, 2) for k in pb},
    }))


if __name__ == "__main__":
    sys.exit(main())
