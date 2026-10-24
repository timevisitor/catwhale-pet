# -*- coding: utf-8 -*-
"""重启桌宠（让新版程序/新皮肤生效）。
只杀桌宠自己的进程（桌宠.exe / electron.exe 里命令行含"桌宠"的），不碰别的 Electron 应用。
用法：python restart_pet.py [--stop]   （--stop 只关不启）
"""
import os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
# 仓库布局：本文件在 <仓库>/skin-editor/ 下 → 上一级就是桌宠工程根；否则退回本机绝对路径
ROOT = os.path.dirname(HERE) if os.path.isfile(os.path.join(os.path.dirname(HERE), 'app', 'renderer', 'assets', 'states.json')) else r'H:\hermes project\桌宠'
CANDIDATES = [
    os.path.join(ROOT, 'dist', '桌宠', '桌宠.exe'),
    os.path.join(ROOT, 'dist', '桌宠.exe'),
    os.path.join(os.path.dirname(HERE), 'dist', '桌宠', '桌宠.exe'),
]

def list_procs():
    out = subprocess.run(['tasklist', '/FO', 'CSV', '/NH'], capture_output=True).stdout.decode('gbk', 'replace')
    rows = []
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2:
            rows.append((parts[0], parts[1]))
    return rows

def main():
    stop_only = '--stop' in sys.argv
    exe = next((p for p in CANDIDATES if os.path.isfile(p)), None)
    targets = [(n, p) for n, p in list_procs() if n.lower() in ('桌宠.exe', 'electron.exe')]
    if targets:
        for name, pid in targets:
            r = subprocess.run(['taskkill', '/PID', pid, '/F'], capture_output=True)
            print(('关闭 ' if r.returncode == 0 else '跳过 ') + '%s (pid %s)' % (name, pid))
        time.sleep(2)
    else:
        print('桌宠当前没在运行')
    if stop_only:
        return 0
    if not exe:
        print('找不到桌宠程序（dist\\桌宠\\桌宠.exe）。先跑 python pack_portable.py 打包。')
        return 1
    subprocess.Popen([exe], cwd=os.path.dirname(exe), close_fds=True)
    print('已启动：' + exe)
    return 0

if __name__ == '__main__':
    sys.exit(main())
