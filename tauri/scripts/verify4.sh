#!/usr/bin/env bash
# 第四轮验收：原版四列 SAO + 左右侧角色镜像 + 独立搜索/聊天浮窗 + 最终交付 exe。
# 真实右键/Esc/失焦/拖动走 Win32；菜单项操作用 DOM；前后端与截图交叉核对。
set -u
DIR="H:/Hermes交付/猫鲸桌宠-体积瘦身/tauri-pet"
EXE="$DIR/catwhale-poc.exe"
P="$DIR/sao_probe.py"
cd "$DIR" || exit 1
FAIL=0
M() { python "$DIR/ev.py" M "$1"; }
S() { python "$DIR/ev.py" S "$1"; }
PANEL() { python "$DIR/ev.py" P "$1"; }
F() { python "$DIR/ev.py" F "$1"; }
C() { python "$DIR/ev.py" C "$1"; }
chk() {
  case "$2" in
    *'"ok":true'*|*'"ok": true'*) echo "PASS $1 $2" ;;
    *) echo "FAIL $1 $2"; FAIL=1 ;;
  esac
}
trychk() {
  local label="$1" n="$2"; shift 2
  local i j
  for ((i=0; i<n; i++)); do
    j=$("$@")
    case "$j" in
      *'"ok":true'*|*'"ok": true'*) echo "PASS $label $j"; return 0 ;;
    esac
    sleep 0.5
  done
  echo "FAIL $label $j"; FAIL=1
}

powershell -NoProfile -Command "Stop-Process -Name catwhale-poc -Force -ErrorAction SilentlyContinue" 2>/dev/null
sleep 2
(WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" "$EXE" >/dev/null 2>&1 &)
sleep 8

echo "===== 1. 启动、独立聊天、综合面板事件权限 ====="
chk "main ready" "$(M '(()=>({ok:window.__petReady===true&&window.__listenOk==="ok"&&window.__listenMirror==="ok",listen:window.__listenOk,mirror:window.__listenMirror}))()')"
chk "sao prebuilt" "$(S '(()=>({ok:window.__saoReady===true,ready:window.__saoReady}))()')"
chk "sao hidden" "$(python "$P" precheck)"
M "window.__TAURI__.core.invoke('open_panel',{panel:'chat'})" >/dev/null
trychk "chat window and event ACL" 8 C "(async()=>{const un=await window.__TAURI__.event.listen('harness:status',()=>{});un();return {ok:window.__chatTest?.ready===true&&innerWidth===470&&innerHeight===570,width:innerWidth,height:innerHeight}})().catch(e=>({ok:false,error:String(e)}))"
trychk "chat mirror source" 6 M '(()=>({ok:!M.saoMirror&&M.floatMirror===M.petMirror,petMirror:M.petMirror,floatMirror:M.floatMirror}))()'
C "window.__TAURI__.core.invoke('close_float',{label:'chat'})" >/dev/null
trychk "chat close restores mirror" 6 M '(()=>({ok:!M.floatMirror&&!M.petMirror,petMirror:M.petMirror,floatMirror:M.floatMirror}))()'
M "window.__TAURI__.core.invoke('open_panel',{panel:'control'})" >/dev/null
trychk "panel event ACL" 6 PANEL "(async()=>{const un=await window.__TAURI__.event.listen('harness:status',()=>{});un();const pages=[...document.querySelectorAll('.nav [data-page]')].map(b=>b.dataset.page);return {ok:window.__panelReady===true&&!pages.includes('search')&&!pages.includes('chat'),pages}})().catch(e=>({ok:false,error:String(e)}))"
python - <<'PY'
import ctypes
u=ctypes.windll.user32
h=u.FindWindowW(None,'猫鲸 · 工具面板')
if h: u.PostMessageW(h,0x0010,0,0)
PY

echo "===== 2. 左右边缘 SAO 镜像、变换中轴与命中网格 ====="
MIRROR=$(python - <<'PY'
import sys,time,json,ctypes,ctypes.wintypes as w,subprocess
sys.path.insert(0,r'H:\Hermes交付\猫鲸桌宠-体积瘦身\tauri-pet')
import sao_probe
u=ctypes.windll.user32;u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
D=r'H:\Hermes交付\猫鲸桌宠-体积瘦身\tauri-pet'
def ev(mode,js):
  r=subprocess.run(['python',D+r'\ev.py',mode,js],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=30)
  try:return json.loads(r.stdout)
  except Exception:return {'ok':False,'raw':r.stdout,'error':r.stderr}
def cycle(side,x,expect):
  m=sao_probe.wins()['catwhale-poc']
  u.SetWindowPos(m['hwnd'],0,x,m['rect'][1],0,0,0x0001|0x0004|0x0010);time.sleep(.5)
  sao_probe.rclick(*sao_probe.find_hit())
  opened=sao_probe.poll_vis(True,2.5) is not None
  js='(()=>({ok:M.menuOpen===true&&M.petMirror==='+str(expect).lower()+'&&M.saoMirror==='+str(expect).lower()+'&&lastGridSig.startsWith("'+('mirror' if expect else 'normal')+'|")&&vids.every(v=>v.style.transformOrigin==="'+('45.8889% 96.67%' if expect else '50% 96.67%')+'")&&vids.every(v=>v.style.transform.includes("scaleX('+('-' if expect else '')+'")),menuOpen:M.menuOpen,petMirror:M.petMirror,saoMirror:M.saoMirror,grid:lastGridSig,transforms:vids.map(v=>v.style.transform),origins:vids.map(v=>v.style.transformOrigin)}))()'
  st={}
  for _ in range(20):
    st=ev('M',js)
    if st.get('ok'):break
    time.sleep(.2)
  geom=json.loads(subprocess.run(['python',D+r'\sao_probe.py','geom'],capture_output=True,text=True,encoding='utf-8',errors='replace').stdout)
  subprocess.run(['python',D+r'\ev.py','shotM',D+r'\shots\verify4_main_'+side+'.png'],capture_output=True,text=True,encoding='utf-8',errors='replace')
  subprocess.run(['python',D+r'\ev.py','shotS',D+r'\shots\verify4_sao_'+side+'.png'],capture_output=True,text=True,encoding='utf-8',errors='replace')
  u.keybd_event(0x1b,0,0,0);u.keybd_event(0x1b,0,2,0)
  closed=sao_probe.poll_vis(False,2.5) is not None;time.sleep(.25)
  restored=ev('M','(()=>({ok:!M.menuOpen&&!M.saoMirror&&!M.petMirror,menuOpen:M.menuOpen,saoMirror:M.saoMirror,petMirror:M.petMirror}))()')
  return {'side':side,'opened':opened,'geom':geom,'state':st,'closed':closed,'restored':restored}
wa=w.RECT();u.SystemParametersInfoW(0x30,0,ctypes.byref(wa),0)
m=sao_probe.wins()['catwhale-poc']['rect']
rows=[cycle('left',wa.left+8,True),cycle('right',wa.right-m[2]-8,False)]
ok=all(r['opened'] and r['closed'] and r['geom'].get('ok') and r['state'].get('ok') and r['restored'].get('ok') for r in rows)
print(json.dumps({'ok':ok,'results':rows},ensure_ascii=True))
PY
)
chk "SAO mirror both edges" "$MIRROR"

echo "===== 3. 真实右键、21 项、四列几何、真实硬件读数 ====="
chk "rclick open" "$(python "$P" rclick)"
chk "structure" "$(S '(()=>{const counts=Object.fromEntries(CATS.map(c=>[c.id,menuOf(c.id).length]));const total=Object.values(counts).reduce((a,b)=>a+b,0);return {ok:CATS.length===5&&total===21&&counts.interact===5&&counts.look===3&&counts.action===5&&counts.tools===4&&counts.system===4&&document.querySelectorAll("#saoCats .cat").length===5&&document.querySelectorAll("#saoList .row").length===5&&innerWidth===708&&innerHeight===374,counts,total}})()')"
trychk "main menuOpen" 6 M '(()=>({ok:M.menuOpen===true,menuOpen:M.menuOpen}))()'
chk "geometry" "$(python "$P" geom)"
trychk "hardware metrics" 12 S '(()=>{const m=[...document.querySelectorAll("#cdMarks .mk")];return {ok:m.length===4&&!document.querySelector("#cdMarks .empty")&&m.every(e=>e.textContent&&!e.textContent.includes("—")),rows:m.length}})()'
python "$DIR/ev.py" shotS "$DIR/shots/verify4_menu.png"

echo "===== 4. 分类、三级原位替换与键盘 ====="
chk "third level" "$(S '(()=>{document.querySelector("#saoList [data-cat=look]").click();document.querySelector("#saoSub [data-i=\"0\"]").click();return {ok:SAO.cat==="look"&&SAO.subRow===0&&SAO.subOpen&&document.querySelectorAll("#saoSub .row").length===4&&!!document.querySelector("#saoSub [data-back=branch]")&&document.querySelectorAll("#saoList .row").length===5,rows:document.querySelectorAll("#saoSub .row").length}})()')"
chk "keyboard" "$(S '(()=>{document.querySelector("#saoSub [data-i=\"0\"]").focus();const v=()=>document.activeElement?.dataset?.i??document.activeElement?.dataset?.back??"";document.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true}));const down=v();document.dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true,cancelable:true}));const end=v();document.dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true,cancelable:true}));const home=v();return {ok:down==="1"&&end==="3"&&home==="branch",down,end,home}})()')"

echo "===== 5. 四档尺寸、底边锚定、三级保持展开 ====="
BOT=$(python "$P" bottom)
S 'document.querySelector("#saoSub [data-i=\"2\"]").click()' >/dev/null
trychk "size 460" 12 python "$P" size 460 "$BOT"
S 'document.querySelector("#saoSub [data-i=\"1\"]").click()' >/dev/null
trychk "restore size 340" 12 python "$P" size 340 "$BOT"
trychk "third level stays open" 6 S '(()=>({ok:SAO.subOpen&&SAO.subRow===0,subOpen:SAO.subOpen,subRow:SAO.subRow}))()'

echo "===== 6. 真实 Esc 两级关闭 ====="
chk "esc first" "$(python "$P" escsub)"
trychk "third closed only" 6 S '(()=>({ok:SAO.subRow===-1&&!SAO.subOpen&&document.querySelectorAll("#saoSub .row").length===3,subRow:SAO.subRow}))()'
trychk "menu remains" 6 python "$P" opencheck
chk "esc second" "$(python "$P" esc)"
trychk "menu hidden" 6 python "$P" precheck
trychk "menu flag reset" 6 M '(()=>({ok:M.menuOpen===false,menuOpen:M.menuOpen}))()'

echo "===== 7. 失焦关闭与不抢前台 ====="
chk "reopen" "$(python "$P" rclick)"
chk "blur close" "$(python "$P" blur)"
trychk "blur flag reset" 6 M '(()=>({ok:M.menuOpen===false,menuOpen:M.menuOpen}))()'
FG=$(python - <<'PY'
import sys,ctypes,json
sys.path.insert(0,r'H:\Hermes交付\猫鲸桌宠-体积瘦身\tauri-pet')
import sao_probe
u=ctypes.windll.user32
before=u.GetForegroundWindow()
sao_probe.rclick(*sao_probe.find_hit())
lat=sao_probe.poll_vis(True,2.5)
after=u.GetForegroundWindow()
ours={v['hwnd'] for v in sao_probe.wins().values()}
print(json.dumps({'ok':lat is not None and after not in ours and before==after,'latency':round(lat,3) if lat is not None else None,'unchanged':before==after,'external':after not in ours}))
PY
)
chk "foreground unchanged" "$FG"
chk "close after foreground test" "$(python "$P" esc)"

echo "===== 8. Everything 与 Unicode 剪贴板 ====="
chk "everything search" "$(M "window.__TAURI__.core.invoke('everything_search',{query:'catwhale-poc.exe',limit:4}).then(r=>({ok:r.ok===true&&((r.results||r.items||[]).length>0),count:(r.results||r.items||[]).length,instance:r.instance||r.esVersion||''})).catch(e=>({ok:false,error:String(e)}))")"
M "window.__TAURI__.core.invoke('everything_copy',{text:'H:/_rust/catwhale-poc/验证-clip'})" >/dev/null
CLIP=$(python - <<'PY'
import ctypes,json
u=ctypes.windll.user32;k=ctypes.windll.kernel32
u.GetClipboardData.restype=ctypes.c_void_p;u.GetClipboardData.argtypes=[ctypes.c_uint]
k.GlobalLock.restype=ctypes.c_void_p;k.GlobalLock.argtypes=[ctypes.c_void_p];k.GlobalUnlock.argtypes=[ctypes.c_void_p]
ok=False;text=''
if u.OpenClipboard(None):
  try:
    h=u.GetClipboardData(13)
    p=k.GlobalLock(h) if h else None
    if p:
      try:text=ctypes.wstring_at(p)
      finally:k.GlobalUnlock(h)
    ok=text=='H:/_rust/catwhale-poc/验证-clip' and not text.startswith(chr(0xfeff))
  finally:u.CloseClipboard()
print(json.dumps({'ok':ok,'hasBom':text.startswith(chr(0xfeff)),'exact':text=='H:/_rust/catwhale-poc/验证-clip'},ensure_ascii=True))
PY
)
chk "unicode clipboard" "$CLIP"
chk "harness normal path" "$(M "window.__TAURI__.core.invoke('harness_detect',{force:true}).then(r=>({ok:r.status==='ok'&&r.repo==='F:\\\\deepseek-harness\\\\src'&&!r.repo.includes('\\\\\\\\?\\\\'),repo:r.repo,node:r.nodeVersion})).catch(e=>({ok:false,error:String(e)}))")"

echo "===== 9. 独立搜索 / 聊天浮窗与拖动跟随 ====="
M "window.__TAURI__.core.invoke('open_panel',{panel:'search'})" >/dev/null
trychk "search independent window" 8 F '(()=>({ok:window.__searchTest?.ready===true&&innerWidth===470,ready:window.__searchTest?.ready,width:innerWidth,height:innerHeight}))()'
trychk "search results and dynamic height" 8 F "(async()=>{const i=document.querySelector('#sinput');i.value='catwhale-poc.exe';i.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,1600));return {ok:window.__searchTest.results.length>0&&document.querySelectorAll('#slist .srow').length===window.__searchTest.results.length&&innerHeight>190,count:window.__searchTest.results.length,height:innerHeight}})()"
python "$DIR/ev.py" shotF "$DIR/shots/verify4_search.png"
SEARCH_KEYS=$(python - <<'PY'
import subprocess,json,ctypes,time
D=r'H:\Hermes交付\猫鲸桌宠-体积瘦身\tauri-pet'
def ev(mode,js):
  r=subprocess.run(['python',D+r'\ev.py',mode,js],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=30)
  return json.loads(r.stdout)
sel=ev('F',"(()=>{const i=document.querySelector('#sinput'),n=window.__searchTest.results.length;if(n>1)i.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));const idx=n>1?1:0;i.dispatchEvent(new KeyboardEvent('keydown',{key:'c',ctrlKey:true,bubbles:true,cancelable:true}));return {ok:n>0&&document.querySelector('#slist .srow.sel')?.dataset.i===String(idx),selected:idx,path:window.__searchTest.results[idx]?.path||''}})()")
time.sleep(.4)
u=ctypes.windll.user32;k=ctypes.windll.kernel32
u.GetClipboardData.restype=ctypes.c_void_p;u.GetClipboardData.argtypes=[ctypes.c_uint]
k.GlobalLock.restype=ctypes.c_void_p;k.GlobalLock.argtypes=[ctypes.c_void_p];k.GlobalUnlock.argtypes=[ctypes.c_void_p]
text=''
if u.OpenClipboard(None):
  try:
    h=u.GetClipboardData(13);p=k.GlobalLock(h) if h else None
    if p:
      try:text=ctypes.wstring_at(p)
      finally:k.GlobalUnlock(h)
  finally:u.CloseClipboard()
u.keybd_event(0x1b,0,0,0);u.keybd_event(0x1b,0,2,0);time.sleep(.6)
restored=ev('M','(()=>({ok:!M.petMirror&&!M.floatMirror,petMirror:M.petMirror,floatMirror:M.floatMirror}))()')
print(json.dumps({'ok':sel['ok'] and text==sel['path'] and not text.startswith(chr(0xfeff)) and restored['ok'],'keyboard':sel,'clipboardExact':text==sel['path'],'escRestore':restored},ensure_ascii=True))
PY
)
chk "search keyboard copy and Esc" "$SEARCH_KEYS"
M "window.__TAURI__.core.invoke('open_panel',{panel:'chat'})" >/dev/null
trychk "chat reopens independent" 8 C '(()=>({ok:window.__chatTest?.ready===true&&innerWidth===470&&innerHeight===570,width:innerWidth,height:innerHeight}))()'
CHAT=$(python - <<'PY'
import subprocess,json,time,ctypes
D=r'H:\Hermes交付\猫鲸桌宠-体积瘦身\tauri-pet'
def ev(mode,js):
  r=subprocess.run(['python',D+r'\ev.py',mode,js],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=30)
  return json.loads(r.stdout)
p=ev('C',"(async()=>{document.querySelector('#cPersona').click();await new Promise(r=>setTimeout(r,450));document.querySelector('#cinput').value='验收草稿（不发送）';document.querySelector('#cinput').dispatchEvent(new Event('input',{bubbles:true}));return {ok:!document.querySelector('#personaPane').hidden,personaOpen:!document.querySelector('#personaPane').hidden,cards:document.querySelectorAll('#pList .prow').length}})()")
u=ctypes.windll.user32
u.keybd_event(0x1b,0,0,0);u.keybd_event(0x1b,0,2,0);time.sleep(.3)
pclosed=ev('C','(()=>({ok:document.querySelector("#personaPane").hidden}))()')
u.keybd_event(0x1b,0,0,0);u.keybd_event(0x1b,0,2,0);time.sleep(.5)
closed=ev('M','(()=>({ok:!M.floatMirror&&!M.petMirror}))()')
ev('M',"window.__TAURI__.core.invoke('open_panel',{panel:'chat'}).then(()=>({ok:true})).catch(e=>({ok:false,error:String(e)}))")
time.sleep(.45)
reopened=ev('C','(()=>({ok:window.__chatTest.ready&&document.querySelector("#cinput").value==="验收草稿（不发送）"&&document.querySelector("#personaPane").hidden,draftPreserved:document.querySelector("#cinput").value==="验收草稿（不发送）",messages:window.__chatTest.messages.length}))()')
print(json.dumps({'ok':p['ok'] and pclosed['ok'] and closed['ok'] and reopened['ok'],'persona':p,'firstEsc':pclosed,'secondEsc':closed,'reopen':reopened},ensure_ascii=True))
PY
)
chk "chat persona Esc and retained draft" "$CHAT"
python "$DIR/ev.py" shotC "$DIR/shots/verify4_chat.png"
FLOAT_DRAG=$(python - <<'PY'
import sys,ctypes,ctypes.wintypes as w,time,json,subprocess
sys.path.insert(0,r'H:\Hermes交付\猫鲸桌宠-体积瘦身\tauri-pet')
import sao_probe
u=ctypes.windll.user32;u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
D=r'H:\Hermes交付\猫鲸桌宠-体积瘦身\tauri-pet'
def chat_rect():
  h=u.FindWindowW(None,'猫鲸 · DeepSeek 聊天');r=w.RECT();u.GetWindowRect(h,ctypes.byref(r))
  return [r.left,r.top,r.right-r.left,r.bottom-r.top]
def drag(dx,dy):
  b=sao_probe.wins()['catwhale-poc']['rect'];cb=chat_rect()
  x,y=sao_probe.find_hit();u.SetCursorPos(x,y);time.sleep(.05);u.mouse_event(0x0002,0,0,0,0);time.sleep(.12)
  for i in range(1,13):
    u.SetCursorPos(x+round(dx*i/12),y+round(dy*i/12));time.sleep(.08)
  u.SetCursorPos(x+dx,y+dy);time.sleep(.3);u.mouse_event(0x0004,0,0,0,0);time.sleep(.8)
  a=sao_probe.wins()['catwhale-poc']['rect'];ca=chat_rect()
  return b,a,cb,ca
b,a,cb,ca=drag(-120,-80)
_,r,_,cr=drag(b[0]-a[0],b[1]-a[1])
main_delta=[a[0]-b[0],a[1]-b[1]];chat_delta=[ca[0]-cb[0],ca[1]-cb[1]]
# 浮窗垂直坐标会被工作区上下边缘钳制；贴近底边拖动时不应机械要求与角色等量位移。
wa=w.RECT();u.SystemParametersInfoW(0x30,0,ctypes.byref(wa),0)
sf=b[3]/sao_probe.cfg()['h'];margin=round(8*sf)
min_y=wa.top+margin;max_y=wa.bottom-cb[3]-margin
expect_y=max(min_y,min(max_y,a[1]+int((a[3]-cb[3])/2)))
move_ok=abs(main_delta[0]+120)<=8 and abs(main_delta[1]+80)<=8 and chat_delta[0]==main_delta[0] and ca[1]==expect_y
restore_ok=abs(r[0]-b[0])<=8 and abs(r[1]-b[1])<=8 and abs(cr[0]-cb[0])<=8 and abs(cr[1]-cb[1])<=8
q=subprocess.run(['python',D+r'\ev.py','M','(()=>({ok:M.floatMirror===M.petMirror,floatMirror:M.floatMirror,petMirror:M.petMirror}))()'],capture_output=True,text=True,encoding='utf-8',errors='replace')
st=json.loads(q.stdout)
print(json.dumps({'ok':move_ok and restore_ok and st['ok'],'mainDelta':main_delta,'chatDelta':chat_delta,'expectChatY':expect_y,'restored':restore_ok,'mirror':st},ensure_ascii=True))
PY
)
chk "chat follows native drag" "$FLOAT_DRAG"
C "window.__TAURI__.core.invoke('close_float',{label:'chat'})" >/dev/null
trychk "float mirror reset" 6 M '(()=>({ok:!M.floatMirror&&!M.petMirror}))()'

echo "===== 10. 光标不离开角色的连续点击 ====="
US=$(python "$DIR/probe_user_scenario.py" 2>/dev/null)
echo "$US"
US_LAST="${US##*$'\n'}"
case "$US_LAST" in *PASS*) echo "PASS user scenario" ;; *) echo "FAIL user scenario"; FAIL=1 ;; esac

echo "===== 11. 真实拖动并原位恢复 ====="
DRAG=$(python - <<'PY'
import sys,ctypes,time,json
sys.path.insert(0,r'H:\Hermes交付\猫鲸桌宠-体积瘦身\tauri-pet')
import sao_probe
u=ctypes.windll.user32;u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
def drag(dx,dy):
  b=sao_probe.wins()['catwhale-poc']['rect']
  for attempt in range(1,4):
    x,y=sao_probe.find_hit()
    # find_hit 经 CDP 读取当前帧，返回后应立即按下；长时间等待会让下一帧重新穿透。
    u.SetCursorPos(x,y);time.sleep(.05);u.mouse_event(0x0002,0,0,0,0);time.sleep(.12)
    for i in range(1,13):
      u.SetCursorPos(x+round(dx*i/12),y+round(dy*i/12));time.sleep(.08)
    u.SetCursorPos(x+dx,y+dy);time.sleep(.35);u.mouse_event(0x0004,0,0,0,0);time.sleep(.6)
    a=sao_probe.wins()['catwhale-poc']['rect']
    actual=[a[0]-b[0],a[1]-b[1]]
    if abs(actual[0]-dx)<=6 and abs(actual[1]-dy)<=6:return b,a,attempt,True
    if actual!=[0,0]:return b,a,attempt,False
  return b,a,3,False
b,a,attempt,moved_ok=drag(-120,-80)
moved=[a[0]-b[0],a[1]-b[1]]
if moved_ok:_,r,restore_attempt,restored=drag(120,80)
elif moved!=[0,0]:_,r,restore_attempt,restored=drag(-moved[0],-moved[1])
else:r,restore_attempt,restored=a,0,False
print(json.dumps({'ok':moved_ok and restored,'moved':moved,'restored':restored,'attempts':[attempt,restore_attempt]}))
PY
)
chk "drag and restore" "$DRAG"

echo "======================================"
if [ "$FAIL" = 0 ]; then echo "verify4 全部 PASS"; else echo "verify4 存在 FAIL"; fi
exit "$FAIL"
