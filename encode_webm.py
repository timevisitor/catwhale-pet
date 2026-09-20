#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把对齐后的 sprite PNG 序列编码成带 alpha 的 VP9 WebM，并生成 web 需要的 states.json。

- WebM 用 yuva420p + libvpx-vp9：浏览器 <video> 直接播透明通道（Chrome/Edge/Firefox 均支持）。
- 文件名统一成 ASCII（idle.webm / stand_arms.webm ...），避免中文名在服务器/URL 上的坑。
- states.json 是桌宠状态机的配置：role 决定优先级角色，scale 是该状态的额外缩放。

用法: python encode_webm.py [sprite目录] [输出目录] [crf]
"""
import os, sys, subprocess, json, time

FPS = 24

# 末尾静止帧修剪：值为"保留多少帧"（缺省=全部）。
# 用途：有些片段结尾会定格若干帧（AI 生成素材常见）。循环播放时这段定格就是"卡一下"，
# 而帧间差能精确量出来——末尾连续帧的 |Δ| 掉到帧间中位的 10% 以下即为静止。
# 闭眼摇尾：末尾 90~96 共 7 帧完全静止（|Δ|≤0.1，中位 5.19），保留前 90 帧后
# 循环接缝 |f89→f0| = 0.93（= 0.18× 中位），既去掉 0.29s 定格又不产生跳变。
# 只改视频编码，不动 build/sprite 源帧（Hermes 图集那条线按帧号取样，不受影响）。
TRIM_TAIL = {
    "闭眼摇尾": 90,
    # 吃米饭：末尾 90~96 共 7 帧完全静止（帧间差 0.1~0.46，中位 2.53）。
    # 它是**一次性动作**（mode=once，不循环），所以不存在"循环接缝"问题，直接剪掉定格即可，
    # 动作在运动停止的那一刻结束，观感更利落。
    "吃米饭": 90,
}

# 中文素材名 -> 状态定义。改这里就能改状态机的角色/权重/缩放，不用重跑抠像与对齐。
# rate 是该状态在页面上的默认播放速率(会与速度滑块相乘)；scale 是【额外】缩放，保持 1.00：
#   素材之间的大小差异已经在 build_sprites.py 里归一化并烘进 sprite 了，
#   这里再写放大倍数会变成二次放大(例如烘 1.15 再乘 1.15 = 1.32 倍)。
STATE_MAP = {
    "待机":       dict(id="idle",        name="待机",       mode="loop", role="idle",    scale=1.00),
    "站立抬胳膊": dict(id="stand_arms",  name="站立抬胳膊", mode="loop", role="menu",    scale=1.00),
    "睁眼摇尾":   dict(id="tail_open",   name="睁眼摇尾",   mode="loop", role="lounge",  scale=1.00, weight=35, react=40),
    "闭眼摇尾":   dict(id="tail_closed", name="闭眼摇尾",   mode="loop", role="lounge",  scale=1.00, weight=40, react=60),
    "操作中":     dict(id="working",     name="操作中",     mode="loop", role="task",    scale=1.00, weight=25),
    "抓着":       dict(id="grabbed",     name="抓着",       mode="loop", role="drag",    scale=1.00),
    "松手落下":   dict(id="drop",        name="松手落下",   mode="once", role="release", scale=1.00, rate=2.0),
    # 空闲"小动作"：一次性播完回待机（由页面的空闲阶梯随机触发，不进循环池）。
    # 素材本身节奏慢，用户要求 2 倍速 → rate=2.0（与速度滑块相乘，和"松手落下"同一机制）。
    "吃米饭":     dict(id="eat",         name="吃米饭",     mode="once", role="idle_act", scale=1.00, rate=2.0),
}


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError("命令失败: %s\n%s" % (" ".join(cmd), p.stderr[-2000:]))
    return p


def main(sprite_root, out_dir, crf=24, scale=1.0, fps=FPS, only=()):
    os.makedirs(out_dir, exist_ok=True)
    states, unknown = {}, []
    for clip in sorted(os.listdir(sprite_root)):
        d = os.path.join(sprite_root, clip)
        if not os.path.isdir(d):
            continue
        if only and clip not in only:
            continue
        cfg = STATE_MAP.get(clip)
        if not cfg:
            unknown.append(clip)
            continue
        n = len([f for f in os.listdir(d) if f.endswith(".png")])
        keep = min(n, TRIM_TAIL.get(clip, n))          # 末尾静止帧修剪
        webm = os.path.join(out_dir, cfg["id"] + ".webm")
        t0 = time.time()
        # 缩放：解码开销≈与像素数成正比（VP9 alpha 只能软解，硬件解码器不支持透明通道），
        # 所以按显示上限降采样是省 CPU 最直接的一档。宽高都取偶数（yuva420p 要求）。
        vf = []
        if scale and abs(scale - 1.0) > 1e-6:
            vf = ["-vf", f"scale=trunc(iw*{scale}/2)*2:trunc(ih*{scale}/2)*2:flags=lanczos"]
        run(["ffmpeg", "-y", "-v", "error", "-framerate", str(fps), "-start_number", "0",
             "-i", os.path.join(d, "f%03d.png"), *vf,
             "-frames:v", str(keep),
             "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
             "-crf", str(crf), "-b:v", "0",
             "-auto-alt-ref", "0", "-lag-in-frames", "0",     # alpha 与 alt-ref 帧不兼容
             "-row-mt", "1", "-cpu-used", "2", "-threads", "8",
             "-an", webm])
        # 首帧预览(带透明通道)
        # ⚠ 必须指定 libvpx-vp9 解码器：ffmpeg 原生 vp9 解码器不读 alpha，抽出来会是全不透明的图
        run(["ffmpeg", "-y", "-v", "error", "-c:v", "libvpx-vp9", "-i", webm,
             "-frames:v", "1", "-pix_fmt", "rgba",
             os.path.join(out_dir, cfg["id"] + "_poster.png")])
        st = dict(cfg)
        st.update(file=cfg["id"] + ".webm", duration=round(keep / fps, 3),
                  frames=keep, bytes=os.path.getsize(webm))
        states[cfg["id"]] = st
        trim_note = f"  [末尾剪掉{n - keep}帧静止]" if keep < n else ""
        print(f"[OK] {clip} -> {cfg['id']}.webm  {keep}帧 {keep/fps:.2f}s "
              f"{os.path.getsize(webm)/1048576:.2f}MB  {time.time()-t0:.1f}s{trim_note}", flush=True)

    # 只编某几个片段时（only 非空），states.json 要**合并**而不是覆盖，否则会把其它状态记录写没
    states_path = os.path.join(out_dir, "states.json")
    if only and os.path.isfile(states_path):
        try:
            merged = json.load(open(states_path, encoding="utf-8"))
            merged.update(states)
            states = merged
        except Exception as exc:
            print("[警告] 合并已有 states.json 失败，将只写本次的片段: %s" % exc)
    with open(states_path, "w", encoding="utf-8") as fp:
        json.dump(states, fp, ensure_ascii=False, indent=2)
    # 页面读的是 assets/states.json（state.json 在 video/ 下只是编码目录）。
    # 这里自动同步一份，否则会出现"片段编好了但页面里没有这个状态"的静默坑（实测踩过）。
    sibling = os.path.join(os.path.dirname(os.path.normpath(out_dir)), "states.json")
    if os.path.normpath(sibling) != os.path.normpath(states_path):
        try:
            with open(sibling, "w", encoding="utf-8") as fp:
                json.dump(states, fp, ensure_ascii=False, indent=2)
            print(f"[同步] 页面读取的清单已更新: {sibling}")
        except Exception as exc:
            print("[警告] 同步页面清单失败: %s" % exc)
    if unknown:
        print("[警告] 这些片段没有在 STATE_MAP 里配置，已跳过: %s" % "、".join(unknown))
    print("\n状态共 %d 个，合计 %.2f MB" % (len(states), sum(s["bytes"] for s in states.values()) / 1048576))
    for k, v in states.items():
        print(f"  {k:12s} {v['name']:8s} role={v['role']:8s} mode={v['mode']:5s} "
              f"scale={v['scale']}  {v['duration']}s")


if __name__ == "__main__":
    s = sys.argv[1] if len(sys.argv) > 1 else "build/sprite"
    o = sys.argv[2] if len(sys.argv) > 2 else "web/assets/video"
    c = int(sys.argv[3]) if len(sys.argv) > 3 else 24
    sc = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
    fp = int(sys.argv[5]) if len(sys.argv) > 5 else FPS
    main(s, o, c, sc, fp, tuple(sys.argv[6:]))      # 第 6 个参数起=只编这些片段（中文名）
