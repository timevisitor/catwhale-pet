#!/usr/bin/env bash
# Tauri PoC 构建：GNU 工具链 + H 盘安装，不落 C 盘
set -u
T="H:/_rust/catwhale-poc/toolchain"
TM="/h/_rust/catwhale-poc/toolchain"
export RUSTUP_HOME="$T/rustup"
export CARGO_HOME="$T/cargo"
export CARGO_TARGET_DIR="$T/target"
export PATH="$TM/mingw64/bin:$PATH"
CARGO="$T/cargo/bin/cargo.exe"
# cargo.exe 是指向 rustup.exe 的符号链接 → 必须全路径调用
# 路径必须是纯 ASCII：mingw 的 ld 处理中文路径会报 cannot open output file（见 README）
# 只把 HTML 交给 Tauri 内嵌；26 个回落 WebM 必须外置，否则 PE .rdata 增加约 65 MB。
EMBED="H:/_rust/catwhale-poc/frontend-embed"
mkdir -p "$EMBED" || exit 1
cp "H:/_rust/catwhale-poc/frontend/index.html" "H:/_rust/catwhale-poc/frontend/sao.html" "H:/_rust/catwhale-poc/frontend/panel.html" "H:/_rust/catwhale-poc/frontend/search.html" "H:/_rust/catwhale-poc/frontend/chat.html" "$EMBED/" || exit 1
cd "H:/_rust/catwhale-poc/src-tauri" || exit 1
echo "=== $(date +%H:%M:%S) 开始构建 ==="
"$CARGO" build --release 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then
  mkdir -p "$CARGO_TARGET_DIR/release/assets" "$CARGO_TARGET_DIR/release/frontend/assets"
  if ! cp "assets/es.exe" "$CARGO_TARGET_DIR/release/assets/es.exe"; then
    echo "复制 Everything 搜索组件失败"
    rc=1
  fi
  if ! cp -a "H:/_rust/catwhale-poc/frontend/assets/." "$CARGO_TARGET_DIR/release/frontend/assets/"; then
    echo "复制外置回落视频失败"
    rc=1
  fi
fi
echo "=== $(date +%H:%M:%S) 退出码 $rc ==="
ls -la "$CARGO_TARGET_DIR/release/"*.exe 2>/dev/null | awk '{printf "%.2f MB\t%s\n", $5/1048576, $9}'
exit $rc
