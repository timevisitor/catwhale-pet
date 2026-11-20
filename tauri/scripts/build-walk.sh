#!/usr/bin/env bash
# 构建 Tauri v0.7.0（桌面走动）。所有产物留在本主题内：
#   tmp/target/             cargo 构建缓存与 exe
#   tmp/dist/               exe + WebView2Loader.dll + assets 的便携目录
# 中文仓库路径用临时盘符映射成纯 ASCII（mingw ld 不支持中文输出路径），
# 退出时自动删除映射；不会在主题外创建目录。
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"          # .../tauri-src
TOOLCHAIN="${CATWHALE_TOOLCHAIN:-}"
if [ -z "$TOOLCHAIN" ]; then
  printf '%s\n' '请通过 CATWHALE_TOOLCHAIN 指定含 cargo、rustup 和 mingw64 的 GNU 工具链目录。' >&2
  exit 1
fi
WIN_ROOT="$(cygpath -w "$ROOT")"

pick_drive() {
  if [ -n "${CATWHALE_DRIVE:-}" ]; then echo "${CATWHALE_DRIVE}"; return; fi
  for d in Z Y X W V U T S R Q P O N M L K J I G F E D; do
    if [ ! -d "$d:/" ]; then echo "$d"; return; fi
  done
  echo ""; return
}
DRIVE="$(pick_drive)"
if [ -z "$DRIVE" ]; then echo "没有可用的临时盘符，可用 CATWHALE_DRIVE 指定"; exit 1; fi
if subst | grep -qi "^$DRIVE:"; then
  echo "盘符 $DRIVE: 已被占用，请换一个 CATWHALE_DRIVE"; exit 1
fi
subst "$DRIVE:" "$WIN_ROOT" || exit 1
trap 'subst "$DRIVE:" /d >/dev/null 2>&1' EXIT

export RUSTUP_HOME="$TOOLCHAIN/rustup"
export CARGO_HOME="$TOOLCHAIN/cargo"
export PATH="$(cygpath -u "$TOOLCHAIN")/cargo/bin:$(cygpath -u "$TOOLCHAIN")/mingw64/bin:$PATH"
# mingw ld 不能打开中文路径；target 必须落在纯 ASCII 目录。
# 复用工具链既有的 target 缓存（不是源码工作区），最终 exe 仍复制回本主题 tmp/dist。
export CARGO_TARGET_DIR="${CATWHALE_TARGET_DIR:-$TOOLCHAIN/target}"
CARGO="$TOOLCHAIN/cargo/bin/cargo.exe"

cd "$DRIVE:/tauri" || exit 1
echo "=== build $(date +%H:%M:%S) drive=$DRIVE: target=$CARGO_TARGET_DIR ==="
CARGO_TARGET_DIR="$CARGO_TARGET_DIR" bash build.sh
rc=$?
if [ "$rc" -ne 0 ]; then echo "构建失败 rc=$rc"; exit "$rc"; fi

DIST="$ROOT/tmp/dist"
mkdir -p "$DIST/frontend/assets" "$DIST/assets" || exit 1
cp "$CARGO_TARGET_DIR/release/catwhale-poc.exe" "$DIST/" || exit 1
if [ -f "$CARGO_TARGET_DIR/release/WebView2Loader.dll" ]; then
  cp "$CARGO_TARGET_DIR/release/WebView2Loader.dll" "$DIST/" || exit 1
fi
if [ -f "$ROOT/tauri/src-tauri/assets/es.exe" ]; then
  cp "$ROOT/tauri/src-tauri/assets/es.exe" "$DIST/assets/" || exit 1
fi
cp -a "$ROOT/tauri/frontend/assets/." "$DIST/frontend/assets/" || exit 1
echo "=== 产物 ==="
ls -la "$DIST/catwhale-poc.exe"
sha256sum "$DIST/catwhale-poc.exe"
exit 0
