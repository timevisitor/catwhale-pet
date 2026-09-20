#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
打"发布版"：可以直接发给别人用的版本。

与 pack_portable.py（自己用的便携版）的区别：
  1. **剔除个人信息**：开发文档(README)、开发工具(tools/)、我在 app/harness-sdk 下留的探针脚本
     一律不进包；并且**打包前后各扫一遍**，扫到 API key / 用户名 / 个人路径 / 私事关键词就直接拒绝出包。
  2. **精简体积**：Electron 的 locales 只留 zh-CN + en-US（省约 40MB）。
  3. **首用说明**：写一份零基础的使用说明（含 DeepSeek API key 填在哪、Everything 要求）。

重要设计（发布版怎么做到"集成 harness 但不要我的 key"）：
  · API key / 网址由**用户自己在桌宠的设置面板里填**，只存本机（Windows 凭据加密），
    运行时用环境变量 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL 注入给 harness ——
    既不改用户 harness 配置，也**不会**有任何 key 进入发布包。
  · harness 仓库位置：配置 → 环境变量 DSH_HARNESS_REPO → 常见位置自动探测。

用法:
  python pack_release.py            # 打包 + 扫描 + 出 zip（扫到个人信息则失败退出）
  python pack_release.py --scan-only dist/桌宠_发布版   # 只扫描已存在的目录
"""
import os, sys, shutil, zipfile, time, re

ROOT = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(ROOT, "app")
ELECTRON_DIST = os.path.join(APP, "node_modules", "electron", "dist")
OUT_DIR = os.path.join(ROOT, "dist")
OUT = os.path.join(OUT_DIR, "桌宠_发布版")
EXE_NEW = "桌宠.exe"
FILES = ["main.js", "preload.js", "harness-client.js", "package.json"]
DIRS = ["renderer", "assets", "tools"]
KEEP_LOCALES = {"zh-CN.pak", "en-US.pak"}

# ---- 个人信息/密钥扫描规则（发布版硬门禁）----
# 通用规则（与开发机无关，可以随仓库公开）
FORBIDDEN = [
    (r"sk-[A-Za-z0-9_\-]{12,}", "疑似 API key"),
]
# 本机专有规则：**不入库**，一行一个正则（# 开头为注释），例如开发机用户名、
# 项目绝对路径、本机 Hermes 目录、城市/客户/人名。放私有文件里，词表本身就不进公开仓库。
PRIVATE_PATTERNS = os.path.join(ROOT, "release-private-patterns.txt")
if os.path.exists(PRIVATE_PATTERNS):
    with open(PRIVATE_PATTERNS, encoding="utf-8") as _fp:
        for _line in _fp.read().splitlines():
            _line = _line.strip()
            if _line and not _line.startswith("#"):
                FORBIDDEN.append((_line, "本机专有敏感词(私有词表)"))
MUST_NOT_EXIST = ["chat-history.json", "pet-state.json", "settings.json", "README.md"]
SCAN_EXT = {".js", ".mjs", ".cjs", ".html", ".htm", ".json", ".yml", ".yaml", ".txt", ".css", ".md", ".bat", ".ps1", ".py"}


def scan_personal_info(root):
    """返回 [(文件, 规则说明, 命中片段)]；空列表 = 干净"""
    hits = []
    for bad in MUST_NOT_EXIST:                     # 本机状态/开发文档不允许进包
        for dp, _dn, fn in os.walk(root):
            if bad in fn:
                hits.append((os.path.relpath(os.path.join(dp, bad), root), "不该出现在发布包里的文件", bad))
    for dp, _dn, fn in os.walk(root):
        for f in fn:
            ext = os.path.splitext(f)[1].lower()
            if ext not in SCAN_EXT:
                continue
            full = os.path.join(dp, f)
            try:
                txt = open(full, "r", encoding="utf-8", errors="ignore").read()
            except Exception as e:
                hits.append((full, "无法读取：" + str(e), ""))
                continue
            for pat, why in FORBIDDEN:
                for m in re.finditer(pat, txt):
                    s = max(0, m.start() - 40)
                    hits.append((os.path.relpath(full, root), why, txt[s:m.end() + 40].replace("\n", " ")))
                    break          # 每个文件每类规则只报一次
            # 文件名本身也别带个人信息
            for pat, why in FORBIDDEN:
                if re.search(pat, f):
                    hits.append((os.path.relpath(full, root), "文件名含" + why, f))
                    break
    return hits


def write_readme(path):
    with open(path, "w", encoding="utf-8") as fp:
        fp.write("""DeepSeek-猫鲸 · 使用说明
====================

【怎么启动】
  双击 桌宠.exe。托盘（右下角小图标）会出现图标，角色出现在屏幕右下角。

【鼠标怎么用】
  拖动角色        = 抓着状态，松开 = 落下接待机
  单击角色        = 互动一下（摇尾巴）
  右键角色        = 打开菜单（菜单从抬手指的方向弹出）
  屏幕其它地方    = 点击穿透，跟你平时一样操作，不受影响
  托盘图标        = 控制面板 / 大小 / 开机自启 / 设置 / 退出

【全局快捷键】
  Ctrl+Shift+D    = 打开 DeepSeek 聊天
  Ctrl+Shift+F    = 打开文件搜索
  Esc             = 关闭当前面板（面板开着时窗口失焦也能关）

【一、DeepSeek 聊天（需要自己准备）】
  桌宠不附带任何 API key，请用自己的：
    1. 右键桌宠 → “⚙ 设置…”（或托盘 → 设置，或控制面板里的 ⚙ 设置）
    2. 填 DeepSeek API Key（sk- 开头），网址默认 https://api.deepseek.com，不用改
    3. 点“测试连接”，出现“连接正常 ✔”就可以了
  key 只保存在你自己的电脑上（%APPDATA%\\桌宠\\settings.json，用 Windows 凭据加密），
  不会上传、也不会写进任何随包分发的文件。

  聊天背后用的是 DeepSeek Harness（开源 agent 运行时），所以要它在本机可用：
    · 需要本机已安装 Node.js（20 或更高）
    · 需要一份 DeepSeek Harness 仓库：https://github.com/deepseek-ai/deepseek-harness
      设置面板里的“DeepSeek Harness 仓库路径”填仓库根目录（就是含 apps\\cli\\src\\bin.ts 的那一层）；
      填对了会自动探测，不用每次填。
    · 桌宠首次聊天要启动这个运行时，约 5~10 秒，之后就快了。
  （如果暂时没有 harness，桌宠其它功能照常可用，聊天面板会提示“未找到运行时”。）

【二、文件搜索（需要自己准备）】
  需要本机装有 Everything（voidtools 的免费搜索工具，https://www.voidtools.com）。
  桌宠用 Everything 官方的命令行工具 es.exe 查询（已随包附带），不改动你 Everything 的任何设置。
  打开方式：Ctrl+Shift+F，或托盘/右键菜单里的“文件搜索”。
  用法：输入关键字（支持 Everything 语法，如 ext:pdf 报告），↑↓ 选择，Enter 打开，
        Ctrl+Enter 打开所在文件夹，Ctrl+C 复制路径，Esc 关闭。

【三、其它】
  · 角色位置和大小会自动记住（%APPDATA%\\桌宠\\pet-state.json）。
  · 开机自启：托盘菜单里勾选“开机自启”。
  · 聊天记录存在 %APPDATA%\\桌宠\\chat-history.json，可在聊天面板里“清空对话”。
  · 退出：托盘图标右键 → 退出桌宠。

【常见问题】
  聊天一直显示“harness 启动中…”
      → 首次启动要 5~10 秒；若一直不出结果，到设置里点“测试连接”看具体报错。
  “未找到 DeepSeek Harness 运行时”
      → 设置里把仓库路径填对（含 apps\\cli\\src\\bin.ts 的那一层），或设置环境变量 DSH_HARNESS_REPO。
  聊天报“API request to … failed”
      → key 或网址不对：到设置里点“测试连接”，按提示修正。
  文件搜索没结果
      → 确认 Everything 正在运行（托盘里能看到它的图标）。
""")


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
    if len(sys.argv) >= 3 and sys.argv[1] == "--scan-only":
        target = sys.argv[2]
        hits = scan_personal_info(target)
        if hits:
            print("[!] 扫描到 %d 处可疑信息：" % len(hits))
            for f, why, m in hits[:40]:
                print("    %s  ← %s  「%s」" % (f, why, m))
            sys.exit(1)
        print("[OK] 扫描通过：%s 未发现个人信息/密钥" % target)
        return

    if not os.path.isfile(os.path.join(ELECTRON_DIST, "electron.exe")):
        sys.exit("找不到 Electron 运行时：%s" % ELECTRON_DIST)
    if not os.path.isdir(os.path.join(APP, "renderer")):
        sys.exit("app/renderer 不存在：先跑 node tools/sync-renderer.js")

    for name in ("桌宠.exe", "electron.exe"):
        os.system("taskkill /F /IM %s >nul 2>nul" % name)

    print("== 1/5 复制运行时 ==")
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT, exist_ok=True)
    shutil.copytree(ELECTRON_DIST, OUT, dirs_exist_ok=True)
    os.rename(os.path.join(OUT, "electron.exe"), os.path.join(OUT, EXE_NEW))
    for junk in ("default_app.asar",):
        p = os.path.join(OUT, "resources", junk)
        if os.path.exists(p):
            os.remove(p)

    print("== 2/5 精简 locales ==")
    loc = os.path.join(OUT, "locales")
    removed = 0
    if os.path.isdir(loc):
        for f in os.listdir(loc):
            if f.endswith(".pak") and f not in KEEP_LOCALES:
                os.remove(os.path.join(loc, f)); removed += 1
    print("    删掉 %d 个语言包，只留 %s" % (removed, ", ".join(sorted(KEEP_LOCALES))))

    print("== 3/5 放入应用代码（只放运行需要的）==")
    app_dir = os.path.join(OUT, "resources", "app")
    copy_app_tree(app_dir, APP)
    # 发布版不带走开发期的探针脚本与说明（harness-sdk 里只留补丁 yml）
    for f in os.listdir(os.path.join(app_dir, "harness-sdk")):
        if f != "pet-sdk.patch.yml":
            os.remove(os.path.join(app_dir, "harness-sdk", f))
    for junk in ("tools/sync-renderer.js",):
        jp = os.path.join(app_dir, junk)
        if os.path.exists(jp): os.remove(jp)
    write_readme(os.path.join(OUT, "使用说明.txt"))

    print("== 4/5 个人信息扫描（硬门禁）==")
    hits = scan_personal_info(OUT)
    if hits:
        print("[!] 扫到 %d 处个人信息/密钥，**拒绝出包**：" % len(hits))
        for f, why, m in hits[:40]:
            print("    %s  ← %s  「%s」" % (f, why, m))
        sys.exit(1)
    print("    干净：未发现 API key / 用户名 / 个人路径 / 业务敏感词")

    print("== 5/5 打 zip ==")
    zpath = os.path.join(OUT_DIR, "桌宠_发布版.zip")
    if os.path.exists(zpath):
        os.remove(zpath)
    t0 = time.time()
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for dp, _dn, fn in os.walk(OUT):
            for f in fn:
                full = os.path.join(dp, f)
                z.write(full, os.path.relpath(full, OUT_DIR))
    size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(OUT) for f in fs)
    print("[OK] 发布版目录: %s  (%.0f MB)" % (OUT, size / 1048576))
    print("[OK] 压缩包:     %s  (%.0f MB, %.0fs)" % (zpath, os.path.getsize(zpath) / 1048576, time.time() - t0))


if __name__ == "__main__":
    main()
