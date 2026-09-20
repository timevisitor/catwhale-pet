#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把抠像后的 PNG 序列对齐到统一画布，输出可直接编码的 sprite 序列。

做三件事：
  1. 边缘色扩散(alpha bleed): 全透明像素的 RGB 用最近的不透明像素颜色填充。
     否则缩放/视频压缩时会把透明区域的绿色或暗色渗进边缘，造成绿边/黑边。
  2. 尺度统一: 站立类片段以"鞋底部 50 行内的横向宽度"为尺度不变量(双脚站立，跨片段最稳定)，
     全部缩放到同一鞋宽；被手提着、AI 生成时人物偏小的片段用标定倍率放大(见 ANCHORS)。
  3. 位置统一: 按锚点对齐到统一画布（默认"鞋底"对齐基线），片段内部的自然摆动全部保留。
     ⚠ 鞋底必须用颜色判据(深蓝 B-R>=6)测，不能把画在地上的接地阴影算进去，否则整体会偏高十几像素。

画布 900x1500、基线(鞋底) y=1450：上方留约 250px 给"抓着手"这类手臂要伸出画面的状态，
不留这个高度，手会被画布顶边切掉。

用法: python build_sprites.py [alpha目录] [输出目录] [只处理这些片段名...]
"""
import os, sys, json
import numpy as np
from PIL import Image
from scipy import ndimage

CANVAS_W, CANVAS_H = 900, 1500
BASE_Y = 1450              # 鞋底(默认锚点)所在的 y
CENTER_X = CANVAS_W // 2
TARGET_SHOE = 200.0        # 目标鞋宽(像素)
SHOE_BAND = 50             # 鞋区高度
WTHR = 60                  # 判定"角色主体"的行宽阈值，用来滤掉飘起的细发丝/软阴影尖
SOLE_NAVY = 6              # 鞋子是深蓝：像素满足 B-R >= 6 才算"鞋子墨迹"
SOLE_MIN_PX = 20           # 一整行至少这么多鞋子墨迹像素，才算踩到鞋底

# 特殊片段的对齐配置。mode:
#   sole  = 默认，鞋宽归一 + 鞋底对齐基线
#   crown = 头顶冠部对齐到"待机头顶位置"（被提起来的状态：脸不跳、脚下悬空）
#   mid   = 头顶与鞋底的中点对齐到"待机中点"（需要时用；当前"松手落下"改用 sole+ref_frame）
# 配置里额外可给 scale(固定倍率，不再按鞋宽算) 和 ref_frame(用哪一帧量锚点，-1=末帧)
# scale：两个新片段(AI 生成)的人物比站立素材小，按人工标定的倍率放大（用户实测定为 1.05）。
# 注意：缩放只在这里做一次并烘进 sprite；页面里 states.json 的 scale 是运行时微调，保持 1.00。
ANCHORS = {
    # 两段素材人物偏小：按用户实测放大到原尺寸的 1.2 倍，其余按常规"鞋底对齐基线"处理
    "抓着":     dict(mode="sole", scale=1.20, ref_frame=-1, exclude_right=470),
    "松手落下": dict(mode="sole", scale=1.20, ref_frame=-1),
}


def load_alpha(path):
    return np.asarray(Image.open(path))[:, :, 3]


def _cut(m, x):
    mm = m.copy()
    mm[:, x:] = False
    return mm


def robust_top(m, exclude_right=None):
    mm = m if exclude_right is None else _cut(m, exclude_right)
    rows = np.nonzero(mm.sum(1) >= WTHR)[0]
    return int(rows.min()) if len(rows) else 0


def robust_bottom(m, exclude_right=None):
    mm = m if exclude_right is None else _cut(m, exclude_right)
    rows = np.nonzero(mm.sum(1) >= WTHR)[0]
    return int(rows.max()) if len(rows) else m.shape[0] - 1


def sole_row(a, exclude_right=None, navy=SOLE_NAVY, min_px=SOLE_MIN_PX):
    """鞋底行：从下往上找第一行有 >=min_px 个"鞋子墨迹"像素的行。

    必须用**颜色**把鞋和画在地上的接地阴影分开：鞋子是深蓝(B-R>=6)，阴影是中性灰(B-R≈0)。
    不能只用 alpha 或亮度——阴影的核心可能又深(亮度20~50)又完全不透明，用亮度会把阴影当成鞋底，
    结果整个角色被抬高十几像素、看起来"浮在地面上"(实测差 14~18px)。
    """
    al = a[:, :, 3]
    br = a[:, :, 2] - a[:, :, 0]
    ink = (al > 127) & (br >= navy)
    if exclude_right:
        ink = ink.copy()
        ink[:, exclude_right:] = False
    rows = np.nonzero(ink.sum(1) >= min_px)[0]
    return int(rows.max()) if len(rows) else None


def body_center_x(m, exclude_right=None):
    """下半身质心的 x —— 角色身体中轴(避开抬起的胳膊)"""
    mm = m if exclude_right is None else _cut(m, exclude_right)
    lower = mm[mm.shape[0] // 2:]
    lys, lxs = np.nonzero(lower)
    if len(lxs) == 0:
        ys, xs = np.nonzero(mm)
        return int(np.median(xs))
    return int(np.median(lxs))


def measure(clip_dir, files, cfg):
    """返回 (缩放系数, 锚点参数)"""
    tops, bottoms, centers, shoes, soles = [], [], [], [], []
    ex = cfg.get("exclude_right")
    for f in files:
        a = np.asarray(Image.open(os.path.join(clip_dir, f)).convert("RGBA")).astype(np.float32)
        m = a[:, :, 3] > 127
        tops.append(robust_top(m, ex))
        b = robust_bottom(m, ex)          # 只用于旧口径的鞋宽带取样(保持尺寸结论不变)
        bottoms.append(b)
        centers.append(body_center_x(m, ex))
        sr = sole_row(a, ex)
        soles.append(sr if sr is not None else b)
        if cfg["mode"] == "sole":
            band = m[b - SHOE_BAND + 1:b + 1]
            cols = np.nonzero(band.sum(0))[0]
            shoes.append(cols.max() - cols.min() + 1)
    cx = int(np.median(centers))
    if cfg["mode"] == "sole":
        sw = float(np.median(shoes))
        # 默认按鞋宽归一、按所有帧的最低点(union)对齐；
        # 若配置里给了 scale / ref_frame，则用固定倍率、并用指定帧量锚点
        scale = float(cfg["scale"]) if cfg.get("scale") else TARGET_SHOE / sw
        ri = cfg.get("ref_frame")        # 不填=用第一帧(用户口径)，-1=末帧
        anchor_y = soles[ri] if ri is not None else soles[0]
        return scale, dict(shoe_w=sw, anchor_y=int(anchor_y), cx=cx, anchor="sole",
                           sole_src=int(anchor_y), legs_bottom=int(bottoms[ri if ri is not None else 0]))
    if cfg["mode"] == "crown":
        return float(cfg["scale"]), dict(crown=int(np.median(tops)), cx=cx, anchor="crown")
    idx = cfg.get("ref_frame", -1)
    m = load_alpha(os.path.join(clip_dir, files[idx])) > 127
    return float(cfg["scale"]), dict(crown=robust_top(m, ex), sole=robust_bottom(m, ex),
                                     cx=body_center_x(m, ex), anchor="mid", ref=files[idx])


def bleed_edges(rgba):
    """把不透明像素颜色扩散到透明区域(最近邻)，消除缩放时的彩色渗边"""
    al = rgba[:, :, 3]
    opaque = al > 8
    if opaque.all():
        return rgba
    _, idx = ndimage.distance_transform_edt(~opaque, return_indices=True)
    out = rgba.copy()
    out[:, :, :3] = rgba[idx[0], idx[1], :3]
    out[~opaque, 3] = 0                       # alpha 保持 0
    return out


def main(alpha_root, out_root, only=None):
    clips = [d for d in sorted(os.listdir(alpha_root)) if os.path.isdir(os.path.join(alpha_root, d))]
    if only:
        want = set(only)
        clips = [c for c in clips if c in want]
        missing = want - set(clips)
        if missing:
            print("[警告] 这些片段在 alpha 目录里没找到: %s" % "、".join(sorted(missing)))
    files_of = {c: sorted(f for f in os.listdir(os.path.join(alpha_root, c)) if f.endswith(".png")) for c in clips}
    plan, idle_crown, idle_mid = {}, None, None

    # 第一遍：常规片段(鞋宽归一)，顺手算出"待机"在画布中的头顶/中点，供特殊片段对齐
    for clip in clips:
        cfg = ANCHORS.get(clip)
        if cfg and cfg["mode"] != "sole":
            continue
        cfg = cfg or dict(mode="sole")
        scale, a = measure(os.path.join(alpha_root, clip), files_of[clip], cfg)
        plan[clip] = dict(scale=scale, **a,
                          off_x=CENTER_X - int(round(a["cx"] * scale)),
                          off_y=BASE_Y - int(round(a["anchor_y"] * scale)))
        if clip == "待机":
            m0 = load_alpha(os.path.join(alpha_root, clip, files_of[clip][0])) > 127
            idle_crown = int(round(robust_top(m0) * scale + plan[clip]["off_y"]))
            idle_mid = int(round((idle_crown + BASE_Y) / 2))

    # 第二遍：被手提起来的两个片段
    for clip in clips:
        cfg = ANCHORS.get(clip)
        if not cfg or cfg["mode"] == "sole":
            continue
        scale, a = measure(os.path.join(alpha_root, clip), files_of[clip], cfg)
        off_x = CENTER_X - int(round(a["cx"] * scale))
        if a["anchor"] == "crown":
            off_y = (idle_crown if idle_crown else BASE_Y - 1150) - int(round(a["crown"] * scale))
        else:
            off_y = (idle_mid if idle_mid else BASE_Y - 575) - int(round((a["crown"] + a["sole"]) / 2.0 * scale))
        plan[clip] = dict(scale=scale, off_x=off_x, off_y=off_y, **a)

    # 渲染
    meta = {}
    os.makedirs(out_root, exist_ok=True)
    for clip in clips:
        p = plan[clip]
        src = os.path.join(alpha_root, clip)
        files = files_of[clip]
        w, h = Image.open(os.path.join(src, files[0])).size
        nw, nh = int(round(w * p["scale"])), int(round(h * p["scale"]))
        outclip = os.path.join(out_root, clip)
        os.makedirs(outclip, exist_ok=True)
        for f in files:
            rgba = np.asarray(Image.open(os.path.join(src, f)).convert("RGBA"))
            if p.get("exclude_right"):
                rgba = rgba.copy()
                rgba[:, p["exclude_right"]:] = 0        # 裁掉伸到画面右侧外的手臂(画布上方已留白)
            rgba = bleed_edges(rgba)
            im = Image.fromarray(rgba, "RGBA").resize((nw, nh), Image.LANCZOS)
            canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
            canvas.alpha_composite(im, (p["off_x"], p["off_y"]))
            canvas.save(os.path.join(outclip, f), compress_level=3)
        meta[clip] = {k: (round(v, 4) if isinstance(v, float) else v) for k, v in p.items()}
        meta[clip].update(frames=len(files), out_size=[nw, nh], src_size=[w, h])
        print(f"[OK] {clip}: 锚点={p['anchor']} 缩放={p['scale']:.3f} 偏移({p['off_x']},{p['off_y']}) "
              f"{len(files)}帧", flush=True)

    print(f"\n统一画布 {CANVAS_W}x{CANVAS_H}  基线y={BASE_Y}  中心x={CENTER_X}  "
          f"待机头顶y={idle_crown} 待机中点y={idle_mid}")
    with open(os.path.join(out_root, "meta.json"), "w", encoding="utf-8") as fp:
        json.dump(meta, fp, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    a = sys.argv[1] if len(sys.argv) > 1 else "build/alpha"
    o = sys.argv[2] if len(sys.argv) > 2 else "build/sprite"
    only = sys.argv[3:] if len(sys.argv) > 3 else None
    main(a, o, only)
