#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把桌宠打成"双击就能跑"的绿色便携版（不依赖 electron-builder，零额外下载）。

产物：dist/桌宠/  目录，里面 桌宠.exe 双击即用；同时打一个 zip 便于拷贝。
做法（等价于 electron-builder 的 dir/portable 目标）：
  1. 复制 Electron 运行时（app/node_modules/electron/dist）到 dist/桌宠/
  2. electron.exe 改名为 桌宠.exe
  3. 应用代码放到 resources/app/（Electron 会优先加载它）
用法: python pack_portable.py
"""
import os, sys, shutil, zipfile, time

ROOT = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(ROOT, "app")
ELECTRON_DIST = os.path.join(APP, "node_modules", "electron", "dist")
OUT_DIR = os.path.join(ROOT, "dist")
OUT = os.path.join(OUT_DIR, "桌宠")
EXE_NEW = "桌宠.exe"
FILES = ["main.js", "preload.js", "harness-client.js", "package.json"]
DIRS = ["renderer", "assets", "harness-sdk", "tools"]


def copy_app_tree(app_dir, APP):
    """整目录拷贝 app/（排除 node_modules/diag 等），并**校验必需文件都在**。
    用黑名单而不是白名单：白名单会让"新加的文件忘了加进列表"变成静默崩溃
    （本项目真发生过：漏了 sysinfo.js → 打包版 require 失败、连窗口都不建）。"""
    shutil.rmtree(app_dir, ignore_errors=True)
    os.makedirs(app_dir, exist_ok=True)
    SKIP_DIRS = {"node_modules", "diag", ".cache"}
    for name in os.listdir(APP):
        if name in SKIP_DIRS:
            continue
        src = os.path.join(APP, name)
        dst = os.path.join(app_dir, name)
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
    required = ["main.js", "preload.js", "harness-client.js", "sysinfo.js", "package.json",
                "renderer/index.html", "tools/sysinfo.ps1", "harness-sdk/pet-sdk.patch.yml"]
    missing = [f for f in required if not os.path.exists(os.path.join(app_dir, f))]
    if missing:
        sys.exit("打包失败：应用缺少必需文件 " + ", ".join(missing))


def main():
    if not os.path.isfile(os.path.join(ELECTRON_DIST, "electron.exe")):
        sys.exit("找不到 Electron 运行时：%s\n先跑 node tools/sync-renderer.js 与 electron 安装。" % ELECTRON_DIST)
    if not os.path.isdir(os.path.join(APP, "renderer")):
        sys.exit("app/renderer 不存在：先跑 node tools/sync-renderer.js")

    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT, exist_ok=True)
    shutil.copytree(ELECTRON_DIST, OUT, dirs_exist_ok=True)
    os.rename(os.path.join(OUT, "electron.exe"), os.path.join(OUT, EXE_NEW))

    res = os.path.join(OUT, "resources")
    for junk in ("default_app.asar",):
        p = os.path.join(res, junk)
        if os.path.exists(p):
            os.remove(p)
    copy_app_tree(os.path.join(res, "app"), APP)

    # 启动说明
    with open(os.path.join(OUT, "使用说明.txt"), "w", encoding="utf-8") as fp:
        fp.write("""DeepSeek-猫鲸 · 便携版
====================
双击 桌宠.exe 启动。启动后托盘(右下角小图标)出现桌宠图标。

操作：
  拖动角色        = 抓着状态，松开 = 落下接待机
  单击角色        = 互动一下
  右键角色        = 打开菜单（菜单从抬手指的方向弹出）
  单击空白处      = 关闭当前面板
  鼠标在角色以外  = 点击穿透，正常操作桌面
  托盘图标        = 显示/隐藏控制面板、调大小、聊天/搜索/设置、开机自启、退出

快捷键：Ctrl+Shift+D 聊天 · Ctrl+Shift+F 文件搜索 · Esc 关面板
DeepSeek 聊天要自己在“设置”里填 API key；文件搜索需要本机装 Everything。

退出：托盘图标右键 → 退出桌宠（或任务管理器结束 桌宠.exe）。
配置：位置/大小会自动记住，存在 %APPDATA%\\桌宠\\pet-state.json。
""")

    # 打包 zip
    zpath = os.path.join(OUT_DIR, "桌宠_便携版.zip")
    t0 = time.time()
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for dp, _dn, fn in os.walk(OUT):
            for f in fn:
                full = os.path.join(dp, f)
                z.write(full, os.path.relpath(full, OUT_DIR))
    size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(OUT) for f in fs)
    print("[OK] 便携版目录: %s  (%.0f MB)" % (OUT, size / 1048576))
    print("[OK] 压缩包:     %s  (%.0f MB, %.0fs)" % (zpath, os.path.getsize(zpath) / 1048576, time.time() - t0))


if __name__ == "__main__":
    main()
