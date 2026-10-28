#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
绿幕视频抠像成带 alpha 的 PNG 序列。
用法: python key_clips.py [素材目录] [输出目录]

原理:
  1. 逐帧从画面外圈 8px 采样，估计该帧的背景绿度 gbg = median(G - max(R,B))
  2. 逐像素绿度 g = G - max(R,B)，归一化 t = g / gbg
  3. alpha = 1 - clamp((t - T0)/(T1 - T0), 0, 1)   # t<T0 完全不透明, t>T1 全透明
  4. 去溢色: G = min(G, max(R,B))  —— 只影响被绿幕污染的边缘像素，主体不受影响
"""
import os, sys, subprocess, time
import numpy as np
from PIL import Image

T0, T1 = 0.15, 0.55          # 绿度归一化阈值
RING = 8                     # 背景采样边框宽度

# ── 深色区绿染修正（2026-10 新素材实测出的问题）──────────────────────────────
# H3 在 1024×1792 下重渲染时，角色最暗的部分（玛丽珍鞋、裙摆内侧、发尾）会被绿幕
# 逐步染绿：实测「看书」末帧鞋区从 (53,57,93) 漂到 (16,81,56)，G 超过 B 还进了
# alpha 过渡带（t≈0.24 → alpha 0.78），抠像后鞋子半透明、边缘发绿。
# 角色身上不存在"深绿色"的部位（只有藏青/蓝/白），所以在深色区把 G、B 对调即可
# 还原藏青，而且不影响任何真正的绿色（背景本身 G≈210，远在阈值之外）。
SPILLFIX = os.environ.get("SPILLFIX", "1") != "0"
SPILL_DARK = 110             # 三通道最大值低于它算"深色区"


def probe_size(path):
    p = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                        "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    w, h = p.stdout.strip().split(",")[:2]
    return int(w), int(h)


def iter_frames(path, w, h):
    """逐帧产出 (idx, HxWx3 uint8)"""
    proc = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path,
                             "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                            stdout=subprocess.PIPE)
    fsz = w * h * 3
    i = 0
    while True:
        buf = proc.stdout.read(fsz)
        if len(buf) < fsz:
            break
        yield i, np.frombuffer(buf, np.uint8).reshape(h, w, 3)
        i += 1
    proc.stdout.close()
    proc.wait()


def key_frame(rgb):
    """rgb uint8 HxWx3 -> rgba uint8 HxWx4"""
    f = rgb.astype(np.float32)
    R, G, B = f[:, :, 0], f[:, :, 1], f[:, :, 2]
    if SPILLFIX:
        v = np.maximum(np.maximum(R, G), B)
        swap = (v < SPILL_DARK) & (G > B + 2)      # 深色且偏绿的像素：把 G/B 换回来
        if swap.any():
            G2 = np.where(swap, B, G)
            B2 = np.where(swap, G, B)
            G, B = G2, B2
    g = G - np.maximum(R, B)                                     # 绿度
    ring = np.concatenate([g[:RING].ravel(), g[-RING:].ravel(),
                           g[:, :RING].ravel(), g[:, -RING:].ravel()])
    gbg = max(float(np.median(ring)), 1.0)                       # 本帧背景绿度
    t = g / gbg
    alpha = 1.0 - np.clip((t - T0) / (T1 - T0), 0.0, 1.0)
    Gc = np.minimum(G, np.maximum(R, B))                         # 去溢色
    out = np.empty((*rgb.shape[:2], 4), np.uint8)
    out[:, :, 0] = R.astype(np.uint8)
    out[:, :, 1] = Gc.astype(np.uint8)
    out[:, :, 2] = B.astype(np.uint8)
    out[:, :, 3] = (alpha * 255.0 + 0.5).astype(np.uint8)
    return out, gbg


def main(src_dir, out_root, only=None):
    clips = sorted(f for f in os.listdir(src_dir) if f.lower().endswith((".mp4", ".mov", ".webm")))
    if only:
        want = set(only)
        clips = [c for c in clips if os.path.splitext(c)[0] in want]
        missing = want - {os.path.splitext(c)[0] for c in clips}
        if missing:
            print("[警告] 这些名字在素材目录里没找到: %s" % "、".join(sorted(missing)))
    report = []
    for clip in clips:
        name = os.path.splitext(clip)[0]
        path = os.path.join(src_dir, clip)
        w, h = probe_size(path)
        dst = os.path.join(out_root, name)
        os.makedirs(dst, exist_ok=True)
        t0 = time.time()
        gbgs, bboxes, n = [], [], 0
        for i, rgb in iter_frames(path, w, h):
            rgba, gbg = key_frame(rgb)
            Image.fromarray(rgba, "RGBA").save(os.path.join(dst, "f%03d.png" % i), compress_level=3)
            gbgs.append(gbg)
            al = rgba[:, :, 3] > 127
            ys, xs = np.nonzero(al)
            if len(ys):
                bboxes.append((xs.min(), xs.max(), ys.min(), ys.max()))
            n += 1
        bb = np.array(bboxes)
        ux0, ux1, uy0, uy1 = bb[:, 0].min(), bb[:, 1].max(), bb[:, 2].min(), bb[:, 3].max()
        info = dict(clip=clip, w=w, h=h, frames=n, gbg_min=round(min(gbgs), 1), gbg_max=round(max(gbgs), 1),
                    union_bbox=[int(ux0), int(uy0), int(ux1), int(uy1)],
                    per_frame_bbox_range=[int(bb[:, 0].min()), int(bb[:, 0].max()), int(bb[:, 1].min()),
                                          int(bb[:, 1].max()), int(bb[:, 2].min()), int(bb[:, 2].max()),
                                          int(bb[:, 3].min()), int(bb[:, 3].max())],
                    seconds=round(time.time() - t0, 1))
        report.append(info)
        print(f"[OK] {clip}  {w}x{h} {n}帧  bg绿度{info['gbg_min']}~{info['gbg_max']}  "
              f"union bbox={info['union_bbox']}  {info['seconds']}s", flush=True)
    print("\n=== 汇总 ===")
    for r in report:
        print(r)
    np.save(os.path.join(out_root, "_bbox_report.npy"), np.array(report, dtype=object), allow_pickle=True)


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "素材"
    out = sys.argv[2] if len(sys.argv) > 2 else "build/alpha"
    only = sys.argv[3:] if len(sys.argv) > 3 else None
    main(src, out, only)
