#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 / 校验 SHA256SUMS.txt（GNU sha256sum 格式：`<64位小写hex><两个空格><文件名>`）。

在线升级的两端都按同 release 的 `SHA256SUMS.txt` 校验下载回来的整包，
清单对不上就拒绝安装，所以**以后发版必须带它**（详见 README 第八节）。

用法
----
    # 1) 给整个交付目录生成（包内自证清单，会被 updater 逐文件校验）
    python scripts/gen-sha256sums.py "H:/Hermes交付/.../交付/tauri-round4"

    # 2) 只给要上传的 zip 生成（GitHub Release 的 assets 里那份）
    python scripts/gen-sha256sums.py out/ --only "*.zip" -o out/SHA256SUMS.txt

    # 3) 打印到 stdout（不落盘）
    python scripts/gen-sha256sums.py out/ --only "*.zip" -o -

    # 4) 校验已有清单（谁改了一个字节就报出来）
    python scripts/gen-sha256sums.py "交付/tauri-round4" --verify

注意
----
* 输出文件自身总被排除，否则清单会自引用、永远对不上。
* 路径统一用 `/`，清单里的名字是**相对给定目录**的路径。
* `--only` 之后若一个文件都没有，退出码 2（避免发一个空清单上去）。
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import os
import sys

DEFAULT_NAME = "SHA256SUMS.txt"


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def walk_files(root: str, out_path: str | None):
    out_abs = os.path.abspath(out_path) if out_path else None
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            if out_abs and os.path.abspath(full) == out_abs:
                continue
            rel = os.path.relpath(full, root).replace("\\", "/")
            yield full, rel


def main() -> int:
    ap = argparse.ArgumentParser(description="生成 / 校验 SHA256SUMS.txt")
    ap.add_argument("directory", help="要处理的目录（交付目录或只放 zip 的 out 目录）")
    ap.add_argument("-o", "--output", default=None,
                    help=f"输出路径，默认 <目录>/{DEFAULT_NAME}；传 - 表示打印到 stdout")
    ap.add_argument("--only", action="append", default=None, metavar="GLOB",
                    help="只收录匹配的文件（相对路径，可用多次）；不传则全部收录")
    ap.add_argument("--verify", action="store_true", help="校验已有清单而不是生成")
    args = ap.parse_args()

    root = os.path.abspath(args.directory)
    if not os.path.isdir(root):
        print(f"不是目录：{root}", file=sys.stderr)
        return 2

    to_stdout = args.output == "-"
    out_path = None if to_stdout else os.path.abspath(args.output or os.path.join(root, DEFAULT_NAME))

    if args.verify:
        path = out_path or os.path.join(root, DEFAULT_NAME)
        if not os.path.isfile(path):
            print(f"没有清单：{path}", file=sys.stderr)
            return 2
        bad = 0
        total = 0
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split(None, 1)
                if len(parts) != 2:
                    print(f"格式不对：{line}", file=sys.stderr)
                    bad += 1
                    continue
                expect, name = parts[0].lower(), parts[1].lstrip("*").strip()
                total += 1
                full = os.path.join(root, name.replace("/", os.sep))
                if not os.path.isfile(full):
                    print(f"MISSING {name}")
                    bad += 1
                elif sha256(full) != expect:
                    print(f"CHANGED {name}")
                    bad += 1
        print(f"校验 {total} 条，异常 {bad} 条")
        return 0 if bad == 0 else 1

    lines = []
    for full, rel in walk_files(root, out_path):
        if args.only and not any(fnmatch.fnmatch(rel, pat) for pat in args.only):
            continue
        lines.append(f"{sha256(full)}  {rel}")

    if not lines:
        print("没有可收录的文件（检查 --only 或缺文件）", file=sys.stderr)
        return 2

    text = "\n".join(lines) + "\n"
    if to_stdout:
        sys.stdout.write(text)
    else:
        assert out_path is not None
        with open(out_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        print(f"写入 {out_path}（{len(lines)} 条）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
