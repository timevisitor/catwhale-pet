#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
镜像验收的**像素级**比对（独立于桌宠本体，只读自检产出的截图）。

配套：先跑 `桌宠.exe --mirrortest --exit-after-test`，它会
  1) 把左/右两侧的菜单翻面与镜像状态打印成 MIRRORTEST 的 JSON；
  2) 在**同一冻结帧**下，分别在"开镜像 / 关镜像 / 再开一次 / 关镜像但平移 40px"四种情况
     各截一张宠物框的裁剪图，路径写在 JSON 的 shots 里。

本脚本要证明的关系（核心）：
    开镜像的图  ==  关镜像的图 绕「站姿中轴」水平翻转
并且用两个对照否定"随便两张图都能算通过"：
    · 关镜像的图（不翻转）        → 差值必须明显大
    · 关镜像的图（平移 40px）     → 差值必须明显大
另外做轴位扫描：最优轴必须落在几何推算的轴上（±0.5px），否则说明翻转轴错了。

用法:
  python tools/check-mirror-pixels.py [MIRRORTEST输出文件] [--keep]
  不给文件时自动找最新的 mirrortest_out.txt（默认在 %LOCALAPPDATA%\\Temp\\）
"""
import os, sys, json, glob
import numpy as np
from PIL import Image

PASS_DIFF = 4.0        # 开镜像 vs 翻转后的关镜像：平均绝对差上限（/255）
REPRO_DIFF = 1.0       # 同一开关两次截图之间
DIFF_MUST_EXCEED = 15.0  # 对照与负例必须超过这个值，否则说明指标没有分辨力


def find_latest():
    cands = glob.glob(os.path.join(os.environ.get("LOCALAPPDATA", ""), "Temp", "mirrortest_out.txt"))
    cands += glob.glob(os.path.join(os.environ.get("TEMP", ""), "mirrortest_out.txt"))
    if not cands:
        return None
    return max(cands, key=os.path.getmtime)


def load_shots(d):
    """截图字典：支持面板场景的 p- 前缀文件名（把前缀归一掉，两种场景共用同一套判据）"""
    out = {}
    for s in d.get("shots", []):
        out[s["name"]] = s
        out[s["name"].replace("p-", "", 1)] = s
    return out


def load_json(path, prefix="MIRRORTEST "):
    for line in open(path, encoding="utf-8", errors="replace"):
        if line.startswith(prefix):
            return json.loads(line[len(prefix):])
    raise SystemExit("没找到 %s 那一行：%s" % (prefix.strip(), path))


def load_premul(path):
    """预乘 alpha 后返回 float 数组：边缘半透明像素在重采样时才不会偏色"""
    a = np.asarray(Image.open(path).convert("RGBA"), dtype=np.float32)
    al = a[:, :, 3:4] / 255.0
    return np.concatenate([a[:, :, :3] * al, a[:, :, 3:4]], axis=2)


def affine_flip(img, axis_px):
    """绕 x=axis_px 做亚像素水平翻转（x' = 2*axis - x）"""
    pil = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGBA")
    return np.asarray(pil.transform(pil.size, Image.AFFINE, (-1, 0, 2 * axis_px, 0, 1, 0),
                                    resample=Image.BILINEAR), dtype=np.float32)


def mean_abs_diff(x, y):
    m = (x[:, :, 3] > 24) | (y[:, :, 3] > 24)          # 只在任一图有内容处比较
    return (float(np.abs(x[m] - y[m]).mean()) if m.sum() else None), int(m.sum())


def content(img):
    return float((img[:, :, 3] > 24).mean())


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    prefix = "MIRRORTEST "
    for a in sys.argv[1:]:
        if a.startswith("--prefix="):
            prefix = a.split("=", 1)[1]
    path = args[0] if args else find_latest()
    if not path or not os.path.exists(path):
        raise SystemExit("找不到自检输出；先跑: 桌宠.exe --mirrortest --exit-after-test")
    d = load_json(path, prefix)
    shots = load_shots(d)
    need = ["mirror-on.png", "mirror-off.png", "mirror-on2.png", "mirror-off-shift.png"]
    missing = [n for n in need if n not in shots]
    if missing:
        raise SystemExit("自检输出里缺截图：%s" % missing)
    print("自检文件:", path)
    print("本体自检:", d.get("verdict"), "(%s/%s 项通过)" % (d.get("passed"), d.get("total")))

    a = shots["mirror-on.png"]
    crop, img, pad = a["crop"], a["img"], a.get("pad", 8)
    scale = img["width"] / crop["width"]                      # 截图是设备像素，可能是 1.5×
    pet = a.get("pet") or {}
    pet_w = crop["width"] - pad * 2
    pet_x = pet.get("x", crop["x"] + pad)
    axis_norm = d["axis"]
    axis_px = (pet_x - crop["x"]) * scale + axis_norm * pet_w * scale
    print(f"宠物 rect.x={pet_x:.1f} 宽={pet_w}  裁剪 x={crop['x']}  截图缩放={scale:g}×")
    print(f"站姿中轴：归一化 {axis_norm:.5f} → 截图内 x={axis_px:.2f}px")

    on = load_premul(shots["mirror-on.png"]["file"])
    off = load_premul(shots["mirror-off.png"]["file"])
    on2 = load_premul(shots["mirror-on2.png"]["file"])
    offsh = load_premul(shots["mirror-off-shift.png"]["file"])
    if not (on.shape == off.shape == on2.shape == offsh.shape):
        raise SystemExit("四张截图尺寸不一致：%s" % [x.shape for x in (on, off, on2, offsh)])

    d_flip, n_flip = mean_abs_diff(on, affine_flip(off, axis_px))
    d_repro, _ = mean_abs_diff(on, on2)
    d_nomir, _ = mean_abs_diff(on, off)
    d_shift, _ = mean_abs_diff(on, offsh)
    c_on, c_off = content(on), content(off)

    print(f"\n内容占比：开镜像 {c_on:.3f} / 关镜像 {c_off:.3f}（都要有实质内容，防空图假通过）")
    print(f"  开镜像 vs 绕轴翻转的关镜像 : {d_flip:6.2f} /255  ← 核心关系，期望最小（{n_flip} 像素参与）")
    print(f"  开镜像 vs 再开一次          : {d_repro:6.2f} /255")
    print(f"  开镜像 vs 关镜像(不翻转)     : {d_nomir:6.2f} /255  ← 对照")
    print(f"  开镜像 vs 关镜像(平移40px)   : {d_shift:6.2f} /255  ← 负例")

    # 轴位扫描：最优轴必须落在几何推算处
    best, best_ax = 1e9, None
    for off_px in np.arange(-4, 4.01, 0.25):
        v, _ = mean_abs_diff(on, affine_flip(off, axis_px + off_px))
        if v < best:
            best, best_ax = v, axis_px + off_px
    print(f"  轴位扫描：最优轴 {best_ax:.2f}px（几何推算 {axis_px:.2f}px，偏移 {best_ax-axis_px:+.2f}px）→ 差值 {best:.2f}")

    checks = [
        ("开镜像 == 关镜像绕站姿中轴翻转", d_flip is not None and d_flip < PASS_DIFF, "%.2f < %.1f" % (d_flip, PASS_DIFF)),
        ("翻转后的差异远小于不翻转", d_nomir is not None and d_flip < d_nomir / 3, "%.2f vs %.2f" % (d_flip, d_nomir)),
        ("对照(不翻转)差异足够大", d_nomir is not None and d_nomir > DIFF_MUST_EXCEED, "%.2f > %.1f" % (d_nomir, DIFF_MUST_EXCEED)),
        ("负例(平移40px)差异足够大", d_shift is not None and d_shift > DIFF_MUST_EXCEED, "%.2f > %.1f" % (d_shift, DIFF_MUST_EXCEED)),
        ("两次截图可复现", d_repro is not None and d_repro < REPRO_DIFF, "%.2f < %.1f" % (d_repro, REPRO_DIFF)),
        ("两图都有实质内容", c_on > 0.05 and c_off > 0.05, "%.3f / %.3f" % (c_on, c_off)),
        ("镜像是绕站姿中轴翻（轴位偏移 ≤0.5px）", abs(best_ax - axis_px) <= 0.5, "%+.2fpx" % (best_ax - axis_px)),
    ]
    print("\n=== 像素级判定 ===")
    bad = 0
    for name, ok, det in checks:
        print(("  ✓ " if ok else "  ✗ ") + name + f"  [{det}]")
        bad += (not ok)
    print("\n结论:", "通过 ✅" if bad == 0 else "不通过 ❌（%d 项失败）" % bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
