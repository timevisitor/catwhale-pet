#!/usr/bin/env bash
# Tauri 版构建入口：在仓库的 tauri/ 目录下执行 bash build.sh
# 需要 Rust stable + MinGW-w64（GNU target）。
# 可选环境变量：RUSTUP_HOME / CARGO_HOME / CARGO_TARGET_DIR / PATH（不设则用系统默认 cargo 与 src-tauri/target）
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE" || exit 1

# 回落视频不重复入库：首次构建前从主线复制
if [ ! -d "frontend/assets" ] || [ -z "$(ls -A frontend/assets 2>/dev/null)" ]; then
  echo "frontend/assets 为空，尝试从主线 web/assets/video 复制回落视频"
  mkdir -p frontend/assets || exit 1
  cp "$HERE/../web/assets/video/"*.webm frontend/assets/ || { echo "复制回落视频失败"; exit 1; }
fi
# 仓库里只入库了 walk_left/walk_right 两段，其余 26 段要补齐；
# 只补缺失的，不覆盖已有文件。
for f in "$HERE/../web/assets/video/"*.webm; do
  [ -e "$f" ] || continue
  base=$(basename "$f")
  [ -f "frontend/assets/$base" ] || cp "$f" "frontend/assets/$base" || exit 1
done

# 逐个核对 index.html 里引用的每个 assets/*.webm 是否真在 frontend/assets。
# 少了任何一个，前端只会静默 404（video error → 兜底动作），界面上不报错，
# v0.7.0 第一次验收就是这样把 walk_left/walk_right 漏掉的。
MISSING=$(grep -o "assets/[A-Za-z0-9_]*\.webm" frontend/index.html | sed 's#^assets/##' | sort -u |
  while read -r f; do [ -f "frontend/assets/$f" ] || echo "$f"; done)
if [ -n "$MISSING" ]; then
  echo "缺失内置素材（frontend/index.html 引用了但 frontend/assets 里没有）："
  echo "$MISSING" | sed 's/^/  - /'
  exit 1
fi
echo "内置素材齐全：$(ls -1 frontend/assets/*.webm | wc -l) 个 webm"

# Everything 搜索组件（不入库，发布时随包附带）
if [ ! -f "src-tauri/assets/es.exe" ]; then
  echo "提示：src-tauri/assets/es.exe 缺失（Everything 命令行组件，可从 voidtools.com 下载），搜索功能将不可用"
fi

# 只把六个 HTML 交给 Tauri 内嵌；26 个回落 WebM 必须外置，
# 否则 PE .rdata 增加约 65 MiB。构建路径必须是纯 ASCII，mingw 的 ld 处理中文路径会失败。
EMBED="$HERE/frontend-embed"
mkdir -p "$EMBED" || exit 1
cp frontend/index.html frontend/sao.html frontend/panel.html frontend/search.html frontend/chat.html frontend/walk-select.html frontend/island.html "$EMBED/" || exit 1

cd "$HERE/src-tauri" || exit 1
TARGET_DIR="${CARGO_TARGET_DIR:-$HERE/src-tauri/target}"
echo "=== $(date +%H:%M:%S) 开始构建 ==="
cargo build --release 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then
  mkdir -p "$TARGET_DIR/release/assets" "$TARGET_DIR/release/frontend/assets"
  if [ -f "assets/es.exe" ]; then
    cp "assets/es.exe" "$TARGET_DIR/release/assets/es.exe" || rc=1
  fi
  if ! cp -a "$HERE/frontend/assets/." "$TARGET_DIR/release/frontend/assets/"; then
    echo "复制外置回落视频失败"
    rc=1
  fi
fi
echo "=== $(date +%H:%M:%S) 退出码 $rc ==="
ls -la "$TARGET_DIR/release/"*.exe 2>/dev/null | awk '{printf "%.2f MB\t%s\n", $5/1048576, $9}'
exit $rc
