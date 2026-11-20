#!/usr/bin/env bash
# 将 tmp/dist 中的构建产物打成 v0.7.0 便携 ZIP。
# 不覆盖、不重命名旧文件：输出目录里已有同名条目会被先删后建，ZIP 名字带版本号。
# 只在本主题内操作，不推送。
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"        # .../tauri-src
THEME="$(cd "$ROOT/.." && pwd)"                     # .../猫鲸桌宠-走动功能
DIST="$ROOT/tmp/dist"
OUT="$THEME/交付-v0.7.0"
VER="0.7.0"
ZIP_CN="$THEME/猫鲸桌宠-Tauri-v${VER}-便携版.zip"
ZIP_EN="$THEME/catwhale-poc-v${VER}-win-x64.zip"

[ -f "$DIST/catwhale-poc.exe" ] || { echo "缺少 $DIST/catwhale-poc.exe，先跑 scripts/build-walk.sh"; exit 1; }
[ -d "$DIST/frontend/assets" ] || { echo "缺少外置素材目录"; exit 1; }
N=$(ls -1 "$DIST/frontend/assets"/*.webm 2>/dev/null | wc -l)
if [ "$N" -lt 28 ]; then echo "外置素材只有 $N 个 webm（应为 28）"; exit 1; fi

rm -rf "$OUT"; mkdir -p "$OUT/assets" "$OUT/frontend/assets" || exit 1
cp "$DIST/catwhale-poc.exe" "$OUT/" || exit 1
[ -f "$DIST/WebView2Loader.dll" ] && cp "$DIST/WebView2Loader.dll" "$OUT/" || true
if [ -f "$DIST/assets/es.exe" ]; then
  cp "$DIST/assets/es.exe" "$ROOT/tauri/src-tauri/assets/LICENSE-ES.txt" "$OUT/assets/" || exit 1
fi
cp "$DIST/frontend/assets/"*.webm "$OUT/frontend/assets/" || exit 1

EXE_SHA=$(sha256sum "$OUT/catwhale-poc.exe" | awk '{print $1}')
WALK_L=$(sha256sum "$OUT/frontend/assets/walk_left.webm" | awk '{print $1}')
WALK_R=$(sha256sum "$OUT/frontend/assets/walk_right.webm" | awk '{print $1}')

{
  echo "catwhale-poc.exe  $EXE_SHA"
  echo "walk_left.webm    $WALK_L"
  echo "walk_right.webm   $WALK_R"
} > "$OUT/SHA256SUMS.txt"

cd "$OUT" || exit 1
{
  echo "# 猫鲸桌宠 · Tauri 版 v${VER}（桌面走动）便携包"
  echo
  echo "构建时间：$(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "exe SHA-256：\`$EXE_SHA\`"
  echo
  echo "## 运行"
  echo
  echo "1. 解压到任意目录（路径可含中文）；"
  echo "2. 双击 \`catwhale-poc.exe\`；"
  echo "3. 需要系统已有 WebView2 运行时（Win11 自带；Win10 一般也已随 Edge 装好）。"
  echo
  echo "**目录结构必须保持**：\`catwhale-poc.exe\` 与 \`frontend/assets/\` 同级——"
  echo "28 个内置动作 WebM 走外置素材，\`builtin_asset_dir\` 按「exe 所在目录的 frontend」解析，"
  echo "单独把 exe 拖走会没有动作可播。"
  echo
  echo "## 走动素材（本版新增，真实入库）"
  echo
  echo "| 文件 | 规格 | 帧数 | SHA-256 |"
  echo "|---|---|---|---|"
  echo "| \`walk_left.webm\` | 576×960 VP9+alpha 24fps | 32（1.333s）| \`$WALK_L\` |"
  echo "| \`walk_right.webm\` | 同上 | 32（1.333s）| \`$WALK_R\` |"
  echo
  echo "## 走动怎么用"
  echo
  echo "- 设置 → 桌面走动：勾「开启自由巡游」；「框选活动范围」拖一个矩形（反向拖也行，Esc 取消）。"
  echo "- 聊天里直接说：\`向左走\`、\`往右走 200 像素\`、\`停下\`。这些指令由程序本地执行，不发给模型。"
  echo "- 范围比角色画布还小时：范围保留，巡游与行走指令暂停/拒绝并给出提示，不会越界、也不会偷偷改用整屏。"
  echo "- 手动拖动角色、开菜单、进游戏模式时，自动走动一律让位。"
  echo
  echo "## 本包验收（同一份 exe，路径见主题内 证据/）"
  echo
  echo "- \`tauri/scripts/verify-walk.sh\`：13 段 79 项断言全通过；其中走动视频为真实播放证据"
  echo "  （readyState=4、videoWidth=576、时长 1.334s、currentTime 连续推进、canvas 透明像素 0.30、"
  echo "  左右两片的画面重心相差 ≥6px/144 证明不是同一段镜像）。"
  echo "- 真实长按拖动（SendInput，非合成事件）：按住 1.65s 窗口位移 0px，巡游未抢控制；松手后拖动位移 +60px。"
  echo "- 范围小于角色画布：范围保留、巡游暂停、走动指令被拒并回原因，窗口零位移；清除范围后恢复。"
  echo "- 走动中改尺寸：范围装不下时目标立即作废（walking=false），范围保留。"
  echo "- \`cargo test --release\`：11 项通过（含素材目录解析、活动范围判定、指令解析）。"
  echo
} > "$OUT/README.md"

rm -f "$ZIP_CN" "$ZIP_EN"
# 传给原生 python 的必须是 Windows 路径（MSYS 的 /h/... 不会被翻译）
OUT_W="$(cygpath -w "$OUT")"
ZIP_W="$(cygpath -w "$ZIP_CN")"
python - <<PY
import os, zipfile
src = r"$OUT_W"
out = r"$ZIP_W"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for root, dirs, files in os.walk(src):
        for f in sorted(files):
            p = os.path.join(root, f)
            rel = os.path.join("猫鲸桌宠-Tauri-v${VER}", os.path.relpath(p, src))
            z.write(p, rel)
print("zip", out, os.path.getsize(out))
PY
[ -f "$ZIP_CN" ] || exit 1
cp "$ZIP_CN" "$ZIP_EN" || exit 1
echo "=== 交付目录 ==="
du -sh "$OUT" "$ZIP_CN" "$ZIP_EN" 2>/dev/null
sha256sum "$ZIP_CN" "$ZIP_EN"
