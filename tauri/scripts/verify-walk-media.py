#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""走动素材文件级回验（不看中间产物，直接解码仓库里那两个 webm）。

判据与「素材成品/QA_walk.json」同源，但在**本仓库内的副本**上重算一遍：
 - 规格：576×960 / 24fps / 32 帧 / ~1.333s
 - alpha：必须能解出 alpha 平面，且逐帧都有透明像素（全不透明帧 = 0）
 - 基准：鞋底中位 ≈927、头顶 ≈200（与 idle.webm 对齐，切换时不跳）
 - 朝向：脸部肤色块质心相对头部中线，left 必须为负、right 必须为正

解码必须点名 `-c:v libvpx-vp9`：ffmpeg 原生 vp9 解码器不输出 alpha side data，
用错解码器会得到 alpha 恒 255，得出「占满整幅画面」的假结论。

用法：
  python verify-walk-media.py [--assets <dir>] [--out <json>]
退出码 0 = 全通过。
"""
import argparse
import json
import subprocess
import sys
import os

import numpy as np

W, H = 576, 960


def decode(path):
    """逐帧解成 RGBA；返回 (frames, fps, duration)。"""
    p = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-c:v", "libvpx-vp9", "-i", path,
         "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
        stdout=subprocess.PIPE)
    fsz = W * H * 4
    frames = []
    while True:
        b = p.stdout.read(fsz)
        if len(b) < fsz:
            break
        frames.append(np.frombuffer(b, np.uint8).reshape(H, W, 4).copy())
    p.stdout.close()
    p.wait()
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=r_frame_rate,duration,width,height,nb_frames",
         "-of", "json", path],
        capture_output=True, text=True)
    st = json.loads(probe.stdout or "{}").get("streams", [{}])[0]
    num, _, den = (st.get("r_frame_rate") or "0/1").partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 0.0
    return frames, fps, float(st.get("duration") or 0.0), st


def head_top(solid):
    """首行「够宽」的不透明像素行 = 头顶（与 QA 脚本同判据）。"""
    for y in range(solid.shape[0]):
        xs = np.nonzero(solid[y])[0]
        if len(xs) and (xs.max() - xs.min() + 1) >= 40 and len(xs) >= 16:
            return y
    return None


def sole_row(a):
    """鞋是深蓝、alpha 实心；取该掩码最靠下的行（腾空帧也有鞋）。"""
    al = a[:, :, 3].astype(np.int16)
    R = a[:, :, 0].astype(np.int16)
    B = a[:, :, 2].astype(np.int16)
    V = a[:, :, :3].max(axis=2).astype(np.int16)
    m = (al > 150) & (B - R >= 8) & (V < 175)
    ys, _ = np.nonzero(m)
    return int(ys.max()) if len(ys) else None


def facing(a):
    """脸部肤色块质心 − 头顶带中线。负 = 朝左，正 = 朝右。"""
    R = a[:, :, 0].astype(np.int16)
    G = a[:, :, 1].astype(np.int16)
    B = a[:, :, 2].astype(np.int16)
    al = a[:, :, 3].astype(np.int16)
    solid = al > 200
    ht = head_top(solid)
    if ht is None:
        return None
    band = solid[ht:ht + 150]
    _, xx = np.nonzero(band)
    if not len(xx):
        return None
    head_cx = (xx.min() + xx.max()) / 2.0
    sk = (al > 200) & (R > 195) & (G > 150) & (G < 230) & (B > 135) & (B < 220) \
        & ((R - B) > 20) & ((R - G) > 10)
    sk[:ht] = False
    sk[ht + 150:] = False
    ys, xs = np.nonzero(sk)
    if not len(xs):
        return None
    return float(xs.mean()) - float(head_cx), head_cx, float(xs.mean())


def measure(path):
    frames, fps, dur, st = decode(path)
    alphas = [f[:, :, 3] for f in frames]
    cover = [float((a > 32).mean()) for a in alphas]
    soles = [r for r in (sole_row(f) for f in frames) if r]
    heads = [r for r in (head_top(f[:, :, 3] > 200) for f in frames) if r]
    # 朝向：均匀抽 4 帧，取中位偏移
    deltas = []
    for i in range(0, len(frames), max(1, len(frames) // 4))[:4]:
        r = facing(frames[i])
        if r:
            deltas.append(r[0])
    opaque_frames = sum(1 for a in alphas if (a > 250).mean() > 0.95)
    return {
        "file": os.path.basename(path),
        "frames": len(frames),
        "fps": round(fps, 3),
        "duration": round(dur, 4),
        "width": st.get("width"),
        "height": st.get("height"),
        "alpha_cover_mean": round(float(np.mean(cover)), 4),
        "alpha_cover_min": round(float(np.min(cover)), 4),
        "alpha_cover_max": round(float(np.max(cover)), 4),
        "alpha_fully_opaque_frames": opaque_frames,
        "sole_median": round(float(np.median(soles)), 1) if soles else None,
        "head_median": round(float(np.median(heads)), 1) if heads else None,
        "facing_deltas": [round(d, 1) for d in deltas],
        "facing_delta_median": round(float(np.median(deltas)), 1) if deltas else None,
        "facing_sign": ("left" if np.median(deltas) < 0 else "right") if deltas else None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets", default=os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "frontend", "assets"))
    ap.add_argument("--out", default="")
    a = ap.parse_args()

    checks = []
    out = {"assets_dir": os.path.abspath(a.assets), "files": {}}
    for name, want in (("walk_left.webm", "left"), ("walk_right.webm", "right")):
        path = os.path.join(a.assets, name)
        if not os.path.isfile(path):
            checks.append({"check": f"{name} exists", "ok": False, "detail": path})
            out["files"][name] = {"missing": True}
            continue
        m = measure(path)
        out["files"][name] = m
        checks += [
            {"check": f"{name} 尺寸 576x960", "ok": (m["width"], m["height"]) == (576, 960),
             "detail": f'{m["width"]}x{m["height"]}'},
            {"check": f"{name} 32 帧 / 24fps", "ok": m["frames"] == 32 and abs(m["fps"] - 24) < 0.2,
             "detail": f'{m["frames"]} 帧 {m["fps"]}fps {m["duration"]}s'},
            {"check": f"{name} alpha 保留（无全不透明帧）",
             "ok": m["alpha_fully_opaque_frames"] == 0 and m["alpha_cover_mean"] < 0.5,
             "detail": f'cover={m["alpha_cover_mean"]} opaque_frames={m["alpha_fully_opaque_frames"]}'},
            {"check": f"{name} 鞋底对齐 927±6",
             "ok": m["sole_median"] is not None and abs(m["sole_median"] - 927) <= 6,
             "detail": m["sole_median"]},
            {"check": f"{name} 头顶对齐 200±6",
             "ok": m["head_median"] is not None and abs(m["head_median"] - 200) <= 6,
             "detail": m["head_median"]},
            {"check": f"{name} 朝向 = {want}",
             "ok": m["facing_sign"] == want,
             "detail": f'sign={m["facing_sign"]} delta={m["facing_delta_median"]}'},
        ]

    out["checks"] = checks
    out["pass"] = all(c["ok"] for c in checks)
    print(json.dumps(out, ensure_ascii=False, indent=1))
    if a.out:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
    return 0 if out["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
