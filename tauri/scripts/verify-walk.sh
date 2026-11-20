#!/usr/bin/env bash
# v0.7.0 桌面走动验收：框选（含反向）、Esc 取消、范围持久化、本地聊天指令、
# 巡游开关、镜像不翻转、游戏模式/缩放夹边界。
#
# 隔离数据：CATWHALE_WALK_DIR 指到本主题 tmp/walk-profile，绝不写真实 %APPDATA% 档案。
# 注意 Windows KnownFolder：Tauri app_config_dir 走 RoamingAppData，不受 %APPDATA% 环境变量影响，
# 所以必须用本项目的 CATWHALE_WALK_DIR 显式隔离（只作用于 walk.json）。
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"          # .../tauri-src
WIN_ROOT="$(cygpath -w "$ROOT")"
EXE="${EXE:-$ROOT/tmp/dist/catwhale-poc.exe}"
EXE_WIN="$(cygpath -w "$EXE")"
PORT="${CDP_PORT:-9223}"
PROFILE_DIR="${WALK_PROFILE_DIR:-$ROOT/tmp/walk-profile}"
PROFILE="$(cygpath -w "$PROFILE_DIR")"
EV="$WIN_ROOT\\tauri\\scripts\\ev.py"
export CDP_PORT="$PORT"
FAIL=0
APP_PID=""

M() { python "$EV" M "$1"; }
P() { python "$EV" P "$1"; }
C() { python "$EV" C "$1"; }
W() { python "$EV" W "$1"; }
chk() {
  local label="$1" out="$2" expr="$3"
  local v
  v=$(printf '%s' "$out" | python -c "import json,sys
try:
 d=json.loads(sys.stdin.read() or 'null')
 print('1' if ($expr) else '0')
except Exception as e:
 print('0')")
  if [ "$v" = "1" ]; then echo "PASS $label"; else echo "FAIL $label => $out"; FAIL=1; fi
}
retry() {
  local label="$1" n="$2" expr="$3"; shift 3
  local i out
  for ((i=0;i<n;i++)); do
    out=$("$@")
    if [ -n "$out" ] && printf '%s' "$out" | python -c "import json,sys
try:
 d=json.loads(sys.stdin.read() or 'null')
 sys.exit(0 if ($expr) else 1)
except Exception:
 sys.exit(1)" 2>/dev/null; then
      echo "PASS $label"; return 0
    fi
    sleep 0.35
  done
  echo "FAIL $label => $out"; FAIL=1; return 1
}
start_app() {
  ( CATWHALE_WALK_DIR="$PROFILE" \
    CATWHALE_CONFIG_DIR="$PROFILE\\config" \
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$PORT" \
    "$EXE_WIN" >/dev/null 2>&1 & echo $! > "$ROOT/tmp/walk.pid" )
  APP_PID=$(cat "$ROOT/tmp/walk.pid")
  sleep 8
}
stop_app() {
  # 脚本启动前已确认没有同名的用户实例；这里只清理本次验收实例。
  powershell -NoProfile -Command "Stop-Process -Name catwhale-poc -Force -ErrorAction SilentlyContinue" >/dev/null 2>&1 || true
  sleep 1
  APP_PID=""
}

if [ ! -f "$EXE" ]; then echo "缺少 $EXE，先运行 scripts/build-walk.sh"; exit 1; fi
if tasklist 2>/dev/null | grep -qi "catwhale-poc.exe"; then
  echo "检测到已有 catwhale-poc 在运行；本脚本不会杀用户进程，请先手动关闭再验收"; exit 1
fi
rm -rf "$PROFILE_DIR"; mkdir -p "$PROFILE_DIR/config" "$ROOT/tmp/shots"
REAL_CFG=""
if [ -n "${APPDATA:-}" ]; then
  REAL_CFG="$(cygpath -u "$APPDATA" 2>/dev/null)/com.hermes.catwhalepoc/config.json"
fi
REAL_BEFORE=$(stat -c %Y "$REAL_CFG" 2>/dev/null || echo none)
trap 'stop_app' EXIT

start_app
echo "===== 1. 启动与默认状态（巡游默认关、无范围）====="
retry "main ready" 10 "d.get('ready') is True" M '(()=>({ready:window.__petReady===true&&window.__listenWalk==="ok",listen:window.__listenWalk}))()'
chk "walk default off" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_get'))()")" "d.get('ok') and d.get('enabled') is False and d.get('bounds') is None"
chk "walk debug" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")" "d.get('ok') and d.get('walking') is False"

echo "===== 1b. 设置页开关与范围文案 ====="
M "window.__TAURI__.core.invoke('open_panel',{panel:'settings'})" >/dev/null
retry "panel ready" 12 "d.get('ok') is True" P "(()=>({ok:window.__panelReady===true&&document.getElementById('walkEnabled').checked===false&&document.getElementById('walkRange').textContent.includes('未设置'),text:document.getElementById('walkRange').textContent}))()"
P "(()=>{document.getElementById('walkEnabled').click();return 1})()" >/dev/null
retry "panel toggle on" 10 "d.get('enabled') is True" M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()"
P "(()=>{document.getElementById('walkEnabled').click();return 1})()" >/dev/null
retry "panel toggle off" 10 "d.get('enabled') is False" M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()"

echo "===== 2. 聊天本地指令：向右走 200 像素（不调用 API）====="
M "window.__TAURI__.core.invoke('open_panel',{panel:'chat'})" >/dev/null
retry "chat ready" 12 "d.get('ready') is True" C '(()=>({ready:window.__chatTest&&window.__chatTest.ready}))()'
# 初始窗口停在工作区右下角，先向左走 400 像素腾出右侧空间（同时验证左向指令）。
chk "left command works" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_command',{text:'向左走 400 像素'}))()")" "d.get('matched') is True and d.get('dir')=='left'"
sleep 2.8
START=$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")
SX=$(printf '%s' "$START" | python -c "import json,sys;print(json.load(sys.stdin)['pos']['x'])")
C "(()=>{window.__chatTest.calls=[];const i=document.getElementById('cinput');i.value='往右走 200 像素';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('cSend').click();return {sent:true};})()" >/dev/null
retry "walking event reaches main" 12 "d.get('walking') is True" M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()"
retry "chat local reply" 12 "d.get('ok') and '向右走 200 像素' in d.get('text','') and d.get('harness') is False" C "(()=>{const t=[...document.querySelectorAll('#cmsg .cline')].map(x=>x.textContent).join('|');return {ok:t.includes('向右走 200 像素')&&!document.querySelector('#cmsg .err'),text:t,harness:(window.__chatTest.calls||[]).includes('harness_chat')};})()"
chk "only walk_command called" "$(C "(()=>({ok:(window.__chatTest.calls||[]).includes('walk_command')&&!(window.__chatTest.calls||[]).includes('harness_chat'),calls:window.__chatTest.calls}))()")" "d.get('ok') is True"
sleep 2.2
END=$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")
python - "$SX" "$END" <<'PY'
import json,sys
sx=int(sys.argv[1]); d=json.loads(sys.argv[2]); ex=d['pos']['x']; sf=d.get('scale') or 1
logical=(ex-sx)/sf
ok=abs(logical-200)<=4
print(('PASS' if ok else 'FAIL')+f" displacement 200 logical px => physical dx={ex-sx}, scale={sf}")
sys.exit(0 if ok else 1)
PY
[ $? -eq 0 ] || FAIL=1

echo "===== 2b. 真实步态视频：请求路径 / readyState / currentTime / canvas 像素 ====="
# 路径约定：builtin_asset_dir 返回 frontend 目录，前端再拼 assets/<name>。
chk "builtin dir is frontend (not assets/)" \
  "$(M "(()=>({d:builtinDir}))()")" \
  "bool(d.get('d')) and d['d'].replace(chr(92),'/').rstrip('/').endswith('frontend')"
chk "walk urls point at single assets layer, not assets/assets" \
  "$(M "(()=>({l:states.walk_left.url,r:states.walk_right.url}))()")" \
  "d['l'] and d['r'] and 'walk_left.webm' in d['l'] and 'walk_right.webm' in d['r'] and 'assets%5cassets' not in d['l'].lower() and 'assets%5cassets' not in d['r'].lower()"
retry "walk videos fetch 200" 3 \
  "d.get('a')==200 and d.get('b')==200 and d.get('la',0)>300000 and d.get('lb',0)>300000" \
  M "(async()=>{const a=await fetch(states.walk_left.url);const b=await fetch(states.walk_right.url);return {a:a.status,b:b.status,la:(await a.arrayBuffer()).byteLength,lb:(await b.arrayBuffer()).byteLength}})()"

# 用户皮肤优先不变：装了皮肤时 idle 仍走 %APPDATA%\桌宠\skins\<slug>ideos，
# 走路两片则来自内置目录（本机皮肤里没有 walk 动作）。
chk "user skin still wins when present" "$(M "(()=>({name:skinName,idle:states.idle&&states.idle.url,walkSrc:states.walk_left.url}))()")"   "(d.get('name') in (None,'','内置') or 'skins' in d.get('idle','')) and 'skins' not in d.get('walkSrc','')"

# 采样：画进 canvas 读 alpha 与前景重心（canvas 被污染会直接抛异常，等于证明可采样）。
SAMP='const s=()=>{const v=activeVideo();if(!v)return{ok:false};const c=document.createElement("canvas");c.width=144;c.height=240;const x=c.getContext("2d");x.clearRect(0,0,144,240);x.drawImage(v,0,0,144,240);let d;try{d=x.getImageData(0,0,144,240).data}catch(e){return{ok:false,err:String(e)}}let op=0,sx=0;for(let i=0;i<d.length;i+=4){if(d[i+3]>32){op++;sx+=(i/4)%144}}return{ok:true,cur:cur,rs:v.readyState,vw:v.videoWidth,dur:v.duration,ct:v.currentTime,alpha:op/(144*240),cx:op?sx/op:0,err:v.error?v.error.code:0}};'
PAIR="(async()=>{$SAMP const a=s();await new Promise(r=>setTimeout(r,500));const b=s();return {a:a,b:b,adv:(b.ct-a.ct+(b.ct<a.ct?a.dur:0)),src:activeVideo().currentSrc}})()"

M "(async()=>await window.__TAURI__.core.invoke('walk_command',{text:'向左走 900 像素'}))()" >/dev/null
sleep 0.45
L=$(M "$PAIR")
echo "  left sample: $L"
chk "left clip loaded (walk_left, readyState 4, 576x960)" "$L" \
  "d['a']['cur']=='walk_left' and d['a']['rs']==4 and d['a']['vw']==576 and d['a']['err']==0 and abs(d['a']['dur']-1.334)<0.02"
chk "left clip currentTime advances" "$L" "0.3<=d['adv']<=0.72"
chk "left clip canvas has transparency (alpha 0.20~0.45)" "$L" "0.20<=d['a']['alpha']<=0.45"
chk "left clip foreground mass on right (faces left)" "$L" "d['a']['cx']>=70"

M "(async()=>await window.__TAURI__.core.invoke('walk_command',{text:'向右走 600 像素'}))()" >/dev/null
sleep 0.45
R=$(M "$PAIR")
echo "  right sample: $R"
chk "right clip loaded (walk_right, readyState 4, 576x960)" "$R" \
  "d['a']['cur']=='walk_right' and d['a']['rs']==4 and d['a']['vw']==576 and d['a']['err']==0 and abs(d['a']['dur']-1.334)<0.02"
chk "right clip currentTime advances" "$R" "0.3<=d['adv']<=0.72"
chk "right clip canvas has transparency (alpha 0.20~0.45)" "$R" "0.20<=d['a']['alpha']<=0.45"
chk "right clip foreground mass on left (faces right)" "$R" "d['a']['cx']<=70"
python - "$L" "$R" <<'PY'
import json, sys
a = json.loads(sys.argv[1]); b = json.loads(sys.argv[2])
dx = abs(a['a']['cx'] - b['a']['cx'])
ok = dx >= 6
print(('PASS' if ok else 'FAIL') + f" two clips are different frames (centroid dx={dx:.1f}px/144, need >=6)")
sys.exit(0 if ok else 1)
PY
[ $? -eq 0 ] || FAIL=1

# 结束走动后必须回到非走路动作（走动状态真的被撤销）。
M "(async()=>await window.__TAURI__.core.invoke('walk_stop'))()" >/dev/null
retry "idle restored after stop" 10 "d.get('cur') not in ('walk_left','walk_right')" \
  M "(()=>({cur:cur}))()"


C "(()=>{window.__chatTest.calls=[];const i=document.getElementById('cinput');i.value='停下';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('cSend').click();return 1})()" >/dev/null
retry "stop applied" 10 "d.get('enabled') is False and d.get('walking') is False" M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()"
chk "stop reply" "$(C "(()=>({ok:[...document.querySelectorAll('#cmsg .cline')].some(x=>x.textContent.includes('停下了')),calls:window.__chatTest.calls}))()")" "d.get('ok') is True"
# 普通对话：本地解析必须返回 false（随后 sendChat 才走原后端）。
chk "normal chat not intercepted" "$(C "(async()=>{window.__chatTest.calls=[];const matched=await window.__chatTest.walk('今天天气怎么样');return {ok:matched===false,calls:window.__chatTest.calls};})()")" "d.get('ok') is True"
M "window.__TAURI__.core.invoke('close_float',{label:'chat'})" >/dev/null

echo "===== 4. AI 输出/历史文本不会触发走动 ====="
BEFORE=$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")
M "window.__TAURI__.event.emit('harness:event',{kind:'message',text:'往右走 500 像素'})" >/dev/null
sleep 0.8
chk "AI text ignored" "$(M "(async()=>{const a=await window.__TAURI__.core.invoke('walk_debug');return {ok:a.walking===false,walking:a.walking}})()")" "d.get('ok') is True"

echo "===== 5. 巡游开关与二维移动 ====="
M "window.__TAURI__.core.invoke('walk_set_enabled',{enabled:true})" >/dev/null
retry "cruise starts" 15 "d.get('enabled') is True and d.get('walking') is True" M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()"
P1=$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")
sleep 1.2
P2=$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")
python - "$P1" "$P2" <<'PY'
import json,sys
a=json.loads(sys.argv[1])['pos']; b=json.loads(sys.argv[2])['pos']
ok=(a['x'],a['y'])!=(b['x'],b['y'])
print(('PASS' if ok else 'FAIL')+f" cruise moved {a} -> {b}")
sys.exit(0 if ok else 1)
PY
[ $? -eq 0 ] || FAIL=1
M "window.__TAURI__.core.invoke('walk_set_enabled',{enabled:false})" >/dev/null

echo "===== 5b. 手动交互优先（开菜单立即停止走动）====="
M "window.__TAURI__.core.invoke('walk_set_enabled',{enabled:true})" >/dev/null
retry "cruise before interaction" 12 "d.get('walking') is True" M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()"
M "window.__TAURI__.core.invoke('open_sao')" >/dev/null
sleep 0.5
chk "menu stops walking" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")" "d.get('walking') is False"
M "window.__TAURI__.core.invoke('close_sao')" >/dev/null
M "window.__TAURI__.core.invoke('walk_set_enabled',{enabled:false})" >/dev/null

echo "===== 6. 框选（反向拖拽）与持久化 ====="
M "window.__TAURI__.core.invoke('walk_begin_selection')" >/dev/null
retry "select window ready" 15 "d.get('ready') is True and d.get('ctx') is True" W '(()=>window.__walkTest.state())()'
W "(()=>{const cv=document.getElementById('cv');const ev=(t,x,y)=>cv.dispatchEvent(new PointerEvent(t,{bubbles:true,clientX:x,clientY:y,button:0,pointerId:1}));ev('pointerdown',700,600);ev('pointermove',200,150);ev('pointerup',200,150);return window.__walkTest.preview(700,600,200,150);})()" >/dev/null
sleep 1.5
chk "selection window closed" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_selection_context'))()")" "d.get('ok') is False"
B=$(M "(async()=>await window.__TAURI__.core.invoke('walk_get'))()")
chk "reverse selection normalized" "$B" "(lambda r: r and abs(r['x']-200)<=3 and abs(r['y']-150)<=3 and abs(r['w']-500)<=4 and abs(r['h']-450)<=4)(d.get('boundsRel'))"
if [ -f "$PROFILE_DIR/walk.json" ]; then echo "PASS bounds persisted file"; else echo "FAIL bounds persisted file"; FAIL=1; fi
WD=$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")
chk "window inside bounds" "$WD" "(lambda b,p,s: b and p and s and p['x']>=b['x'] and p['y']>=b['y'] and p['x']+s['w']<=b['x']+b['w']+1 and p['y']+s['h']<=b['y']+b['h']+1)(d.get('bounds'),d.get('pos'),d.get('size'))"
chk "panel range text" "$(P "(()=>({ok:document.getElementById('walkRange').textContent.includes('500×450'),text:document.getElementById('walkRange').textContent}))()")" "d.get('ok') is True"
# 命令与巡游都必须遵守选框（2000 像素会被边界截断）。
chk "command clamped to bounds" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_command',{text:'往右走 2000 像素'}))()")" "d.get('matched') is True and d.get('clamped') is True"
sleep 2.6
chk "after command still inside" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")" "(lambda b,p,s: b and p and s and p['x']>=b['x'] and p['y']>=b['y'] and p['x']+s['w']<=b['x']+b['w']+1 and p['y']+s['h']<=b['y']+b['h']+1)(d.get('bounds'),d.get('pos'),d.get('size'))"
M "window.__TAURI__.core.invoke('walk_set_enabled',{enabled:true})" >/dev/null
sleep 1.8
chk "cruise respects bounds" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")" "(lambda b,p,s: b and p and s and p['x']>=b['x'] and p['y']>=b['y'] and p['x']+s['w']<=b['x']+b['w']+1 and p['y']+s['h']<=b['y']+b['h']+1)(d.get('bounds'),d.get('pos'),d.get('size'))"
M "window.__TAURI__.core.invoke('walk_set_enabled',{enabled:false})" >/dev/null

echo "===== 7. Esc 取消框选并恢复穿透 ====="
M "window.__TAURI__.core.invoke('walk_begin_selection')" >/dev/null
retry "select reopened" 15 "d.get('ready') is True" W '(()=>window.__walkTest.state())()'
W "(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return 1})()" >/dev/null
sleep 0.8
chk "esc cancelled" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_selection_context'))()")" "d.get('ok') is False"
chk "main interactive again" "$(M "(async()=>await window.__TAURI__.core.invoke('dbg_hit'))()")" "d.get('grid_w',0)>=0"

echo "===== 7b. 失焦取消框选 ====="
M "window.__TAURI__.core.invoke('walk_begin_selection')" >/dev/null
retry "select for blur" 15 "d.get('ready') is True" W '(()=>window.__walkTest.state())()'
M "window.__TAURI__.core.invoke('open_panel',{panel:'settings'})" >/dev/null
sleep 1.2
chk "blur cancelled selection" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_selection_context'))()")" "d.get('ok') is False"

echo "===== 8. 镜像不翻反 walk 动画 + 缩放夹边界 ====="
M "(()=>{failed.delete('walk_right');if(states.walk_right){states.walk_right.url=states.run.url;}M.petMirror=true;M.walking=true;M.walkDir='right';tick(true);return 1})()" >/dev/null
sleep 0.8
chk "walk mirror ignored" "$(M "(()=>({cur:cur,mirror:effectiveMirror('walk_right'),tf:activeVideo().style.transform,grid:lastGridSig}))()")" "d.get('cur')=='walk_right' and d.get('mirror') is False and 'scaleX(-' not in d.get('tf','') and d.get('grid','').startswith('normal|')"
M "(()=>{M.walking=false;M.petMirror=false;tick(true);return 1})()" >/dev/null
M "window.__TAURI__.core.invoke('set_pet_size',{h:300})" >/dev/null
sleep 0.5
WD2=$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")
chk "resize clamped" "$WD2" "(lambda b,p,s: b and p and s and p['x']>=b['x'] and p['y']>=b['y'] and p['x']+s['w']<=b['x']+b['w']+1 and p['y']+s['h']<=b['y']+b['h']+1)(d.get('bounds'),d.get('pos'),d.get('size'))"
M "window.__TAURI__.core.invoke('set_pet_size',{h:340})" >/dev/null

echo "===== 9. 游戏模式优先 ====="
M "window.__TAURI__.core.invoke('walk_set_enabled',{enabled:true})" >/dev/null
retry "cruise enabled" 12 "d.get('enabled') is True" M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()"
# 巡游有 2~5 秒随机停顿，用一条明确指令保证进入行走态再测游戏模式。
chk "walk before gamemode" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_command',{text:'向左走 400 像素'}))()")" "d.get('matched') is True"
retry "walking before gamemode" 12 "d.get('walking') is True" M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()"
M "window.__TAURI__.core.invoke('gamemode_set_manual',{on:true})" >/dev/null
sleep 0.7
chk "game mode stops" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")" "d.get('gameMode') is True and d.get('walking') is False"
M "window.__TAURI__.core.invoke('gamemode_set_manual',{on:false})" >/dev/null
sleep 0.7
chk "game mode off restores" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")" "d.get('gameMode') is False"

echo "===== 10. 重启后范围/开关保留 ====="
M "window.__TAURI__.core.invoke('walk_set_enabled',{enabled:true})" >/dev/null
sleep 0.5
stop_app
start_app
retry "main ready after restart" 10 "d.get('ready') is True" M '(()=>({ready:window.__petReady===true}))()'
chk "persisted enabled+bounds" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_get'))()")" "d.get('enabled') is True and d.get('boundsRel') and abs(d['boundsRel']['w']-500)<=4 and abs(d['boundsRel']['h']-450)<=4"
M "window.__TAURI__.core.invoke('walk_set_enabled',{enabled:false})" >/dev/null

echo "===== 11. 真实长按拖动：按住期间巡游不得抢控制（真实 SendInput）====="
M "window.__TAURI__.core.invoke('walk_clear_bounds')" >/dev/null
M "window.__TAURI__.core.invoke('walk_set_enabled',{enabled:false})" >/dev/null
# 顺序很重要：先停在静止的窗口上按下，再**在按住期间**打开巡游。
# 反过来的话开启后 500ms 就开始走，按下点早飘走了（测出来只会是假失败）。
retry "idle before grab" 10 "d.get('walking') is False" M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()"
GB=$(M "(async()=>{const v=activeVideo();const c=document.createElement('canvas');c.width=144;c.height=240;const x=c.getContext('2d');x.drawImage(v,0,0,144,240);const d=x.getImageData(0,0,144,240).data;let op=0,sx=0,sy=0;for(let i=0;i<d.length;i+=4){if(d[i+3]>160){op++;const q=i/4;sx+=q%144;sy+=(q-q%144)/144;}}const w=await window.__TAURI__.core.invoke('walk_debug');return {fx:op?sx/op/144:0.5,fy:op?sy/op/240:0.5,pos:w.pos,size:w.size}})()")
read -r CX CY <<EOF
$(printf '%s' "$GB" | python -c "import json,sys;d=json.load(sys.stdin);print(int(d['pos']['x']+d['fx']*d['size']['w']), int(d['pos']['y']+d['fy']*d['size']['h']))")
EOF
echo "  grab at ($CX,$CY) size=$(printf '%s' "$GB" | python -c "import json,sys;print(json.load(sys.stdin)['size'])")"
python "$WIN_ROOT\tauri\scripts\drag-hold.py" --x "$CX" --y "$CY" --hold 3.4 --move 60 >/dev/null 2>&1 &
DRAGPID=$!
sleep 0.45
retry "hold registered as drag" 8 "d.get('dragging') is True" M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()"
# 按住期间打开巡游：500ms 后 tick 本会抽目标，必须被「手动交互优先」挡住。
M "window.__TAURI__.core.invoke('walk_set_enabled',{enabled:true})" >/dev/null
H0=$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")
sleep 0.55; H1=$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")
sleep 0.55; H2=$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")
sleep 0.55; H3=$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")
wait $DRAGPID 2>/dev/null
sleep 0.4
H4=$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")
python - "$H0" "$H1" "$H2" "$H3" "$H4" <<'PY'
import json, sys
h = [json.loads(x) for x in sys.argv[1:5]]
end = json.loads(sys.argv[5])
still = h[:3]   # 第 4 次采样已进入 drag-hold.py 的移动阶段
xs = [s['pos']['x'] for s in still]
ys = [s['pos']['y'] for s in still]
drift = max(max(xs) - min(xs), max(ys) - min(ys))
# 巡游速度 190 逻辑像素/秒：若被抢控制权，1.6 秒内至少位移 200+ 像素。
ok1 = drift <= 6
print(('PASS' if ok1 else 'FAIL') + f" held 1.65s without drifting (drift={drift}px, xs={xs})")
ok2 = not any(s['walking'] for s in h)
print(('PASS' if ok2 else 'FAIL') + f" cruise never started while held ({[s['walking'] for s in h]})")
moved = end['pos']['x'] - h[0]['pos']['x']
ok3 = 40 <= moved <= 80
print(('PASS' if ok3 else 'FAIL') + f" real drag moved window with cursor (dx={moved}px, expect +60)")
sys.exit(0 if (ok1 and ok2 and ok3) else 1)
PY
[ $? -eq 0 ] || FAIL=1
retry "cruise resumes after release" 25 "d.get('walking') is True" M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()"
M "window.__TAURI__.core.invoke('walk_set_enabled',{enabled:false})" >/dev/null

echo "===== 12. 范围小于角色画布：不越界、不静默改整屏、给反馈 ====="
SZ=$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")
read -r BX BY <<EOF
$(printf '%s' "$SZ" | python -c "import json,sys;d=json.load(sys.stdin);p=d['pos'];print(p['x'], p['y'])")
EOF
stop_app
printf '{"version":1,"enabled":false,"bounds":{"x":%s,"y":%s,"w":120,"h":160}}' "$BX" "$BY" > "$PROFILE_DIR/walk.json"
start_app
retry "main ready (tiny bounds)" 12 "d.get('ready') is True" M '(()=>({ready:window.__petReady===true}))()'
chk "tiny bounds kept, reported too_small" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_get'))()")" \
  "d.get('ok') and d.get('bounds') and d['bounds']['w']==120 and d['bounds']['h']==160 and d.get('boundsFit')=='too_small'"
chk "enable is accepted but flagged" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_set_enabled',{enabled:true}))()")" \
  "d.get('ok') and d.get('enabled') is True and d.get('boundsFit')=='too_small'"
sleep 3
chk "cruise stays paused with tiny bounds" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")" \
  "d.get('walking') is False and d.get('motion') is None"
chk "in-range command rejected with reason+reply" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_command',{text:'往右走 200 像素'}))()")" \
  "d.get('matched') is True and d.get('ok') is False and d.get('reason')=='bounds_too_small' and '小' in d.get('error','')"
PD=$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")
sleep 1.2
PD2=$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")
python - "$PD" "$PD2" <<'PY'
import json, sys
a = json.loads(sys.argv[1]); b = json.loads(sys.argv[2])
same = a['pos'] == b['pos']
print(('PASS' if same else 'FAIL') + f" window not moved by rejected command ({a['pos']} -> {b['pos']})")
sys.exit(0 if same else 1)
PY
[ $? -eq 0 ] || FAIL=1
M "window.__TAURI__.core.invoke('open_panel',{panel:'settings'})" >/dev/null
retry "panel warns about tiny bounds" 12 "d.get('ok') is True" P "(()=>({ok:document.getElementById('walkRange').textContent.includes('范围小于角色画布')&&document.getElementById('walkBadge').textContent.includes('范围太小'),text:document.getElementById('walkRange').textContent}))()"
chk "clearing bounds restores walking" "$(M "(async()=>{await window.__TAURI__.core.invoke('walk_clear_bounds');const r=await window.__TAURI__.core.invoke('walk_get');const c=await window.__TAURI__.core.invoke('walk_command',{text:'向左走 150 像素'});return {fit:r.boundsFit,bounds:r.bounds,cmd:c}})()")" \
  "d.get('bounds') is None and d.get('fit')=='ok' and d['cmd'].get('ok') is True"
M "window.__TAURI__.core.invoke('close_float',{label:'panel'})" >/dev/null
M "window.__TAURI__.core.invoke('walk_stop')" >/dev/null

echo "===== 13. 走动中改尺寸：目标夹界或立即停止，范围保留 ====="
stop_app
read -r RX RY <<EOF
$(printf '%s' "$SZ" | python -c "import json,sys;d=json.load(sys.stdin);p=d['pos'];print(p['x'], p['y'])")
EOF
printf '{"version":1,"enabled":false,"bounds":{"x":%s,"y":%s,"w":1400,"h":640}}' "$RX" "$RY" > "$PROFILE_DIR/walk.json"
start_app
retry "main ready (600 box)" 12 "d.get('ready') is True" M '(()=>({ready:window.__petReady===true}))()'
chk "box fits before resize" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_get'))()")" \
  "d.get('boundsFit')=='ok' and d['bounds']['w']==1400"
chk "long walk accepted" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_command',{text:'向右走 1200 像素'}))()")" \
  "d.get('ok') is True and d.get('matched') is True"
retry "walking inside box" 6 "d.get('walking') is True" M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()"
M "window.__TAURI__.core.invoke('set_pet_size',{h:620})" >/dev/null
sleep 0.8
chk "resize during walk stops motion, keeps bounds" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_debug'))()")" \
  "d.get('walking') is False and d.get('motion') is None and d['bounds']['w']==1400"
chk "too-small after resize reported" "$(M "(async()=>await window.__TAURI__.core.invoke('walk_get'))()")" \
  "d.get('boundsFit')=='too_small' and d['bounds']['w']==1400"
M "window.__TAURI__.core.invoke('set_pet_size',{h:340})" >/dev/null
M "window.__TAURI__.core.invoke('walk_clear_bounds')" >/dev/null
M "window.__TAURI__.core.invoke('walk_set_enabled',{enabled:false})" >/dev/null

stop_app
if [ -f "$PROFILE_DIR/config/config.json" ] || [ -f "$PROFILE_DIR/walk.json" ]; then
  echo "PASS isolated profile written"
else
  echo "FAIL isolated profile written"; FAIL=1
fi
REAL_AFTER=$(stat -c %Y "$REAL_CFG" 2>/dev/null || echo none)
if [ "$REAL_BEFORE" = "$REAL_AFTER" ]; then
  echo "PASS real profile untouched ($REAL_BEFORE)"
else
  echo "FAIL real profile changed ($REAL_BEFORE -> $REAL_AFTER)"; FAIL=1
fi
echo "===== 结果：$( [ $FAIL -eq 0 ] && echo ALL PASS || echo FAIL ) ====="
exit $FAIL
