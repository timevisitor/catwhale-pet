#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成交付预览件：
  预览_四状态.mp4  —— 四个状态依次播放，棋盘格背景(表示透明)
  预览_对比图.png  —— 四状态同一画布对齐对比
用法: python make_preview.py [sprite目录] [输出目录]
"""
import os, sys, subprocess, shutil
import numpy as np
from PIL import Image, ImageDraw, ImageFont

SCALE = 0.55
CELL = 24
BG_A, BG_B = (238, 240, 245), (206, 210, 218)
FPS = 24
LABELS = [("待机", "idle"), ("站立抬胳膊", "stand_arms"), ("睁眼摇尾", "tail_open"),
          ("闭眼摇尾", "tail_closed"), ("操作中", "working"), ("抓着", "grabbed"), ("松手落下", "drop")]


def checker(w, h):
    ys, xs = np.mgrid[0:h, 0:w]
    m = ((ys // CELL + xs // CELL) % 2 == 0)
    out = np.zeros((h, w, 3), np.uint8)
    out[m] = BG_A
    out[~m] = BG_B
    return out


def font(size):
    for p in [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\simhei.ttf"]:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def main(sprite_root, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    tmp = os.path.join(out_dir, "_tmpframes")
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    f_big = font(34)
    f_small = font(22)

    sheet_items = []
    n_out = 0
    for cn, en in LABELS:
        d = os.path.join(sprite_root, cn)
        if not os.path.isdir(d):
            continue
        files = sorted(f for f in os.listdir(d) if f.endswith(".png"))
        for i, f in enumerate(files):
            im = Image.open(os.path.join(d, f)).convert("RGBA")
            # yuv420p 要求宽高为偶数，否则 libx264 直接报错
            w, h = int(im.width * SCALE) & ~1, int(im.height * SCALE) & ~1
            im = im.resize((w, h), Image.LANCZOS)
            bg = Image.fromarray(checker(w, h), "RGB").convert("RGBA")
            bg.alpha_composite(im)
            dr = ImageDraw.Draw(bg)
            tw = dr.textlength(cn, font=f_big)
            ew = dr.textlength(en, font=f_small)
            box_w = 32 + tw + 12 + ew + 20
            dr.rounded_rectangle([16, 16, 16 + box_w, 16 + 62], 12, fill=(25, 28, 36, 210))
            dr.text((32, 26), cn, font=f_big, fill=(235, 240, 250))
            dr.text((32 + tw + 12, 36), en, font=f_small, fill=(150, 200, 255))
            # 基线参考线（验证各状态脚底是否同一水平线；画布 900x1500，基线 y=1450）
            dr.line([0, int(1450 * SCALE), w, int(1450 * SCALE)], fill=(255, 90, 90, 130), width=1)
            bg.convert("RGB").save(os.path.join(tmp, "f%04d.png" % n_out))
            n_out += 1
            if i == 24:
                sheet_items.append((cn, en, bg.copy()))

    mp4 = os.path.join(out_dir, "预览_全状态.mp4")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-framerate", str(FPS), "-start_number", "0",
                    "-i", os.path.join(tmp, "f%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-crf", "20", "-preset", "medium", "-movflags", "+faststart", mp4], check=True)
    print("[OK] %s  %.2f MB" % (mp4, os.path.getsize(mp4) / 1048576))

    # 对比图
    if sheet_items:
        w, h = sheet_items[0][2].size
        cols = 4
        rows = (len(sheet_items) + cols - 1) // cols
        sheet = Image.new("RGB", (w * cols + 10 * (cols + 1), h * rows + 10 * (rows + 1)), (255, 255, 255))
        for i, (cn, en, im) in enumerate(sheet_items):
            sheet.paste(im.convert("RGB"),
                        (10 + (i % cols) * (w + 10), 10 + (i // cols) * (h + 10)))
        png = os.path.join(out_dir, "预览_对比图.png")
        sheet.save(png)
        print("[OK] %s" % png)

    shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    s = sys.argv[1] if len(sys.argv) > 1 else "build/sprite"
    o = sys.argv[2] if len(sys.argv) > 2 else "交付预览"
    main(s, o)
