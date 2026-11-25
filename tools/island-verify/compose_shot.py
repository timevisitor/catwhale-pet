"""Electron 版合成验收图：桌宠页 + 灵动岛页按真实窗口位置拼在一起。
两个 webview 都是 GPU 合成层，GDI 截不到，各自走 CDP 拿渲染输出（带 alpha），
再按 GetWindowRect 的物理坐标贴到同一张画布上。
"""
import io, json, re, subprocess, urllib.request
from PIL import Image

PORT = 9224
OUT = r"<本地输出目录>\shots\island-above-pet.png"

NODE = r'''
const http=require('http'),fs=require('fs');
const port=process.argv[2],want=process.argv[3],out=process.argv[4];
http.get('http://127.0.0.1:'+port+'/json/list',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{
  const t=JSON.parse(d).find(x=>(x.title||'').includes(want));
  if(!t){console.log('NO-TARGET '+want);return;}
  const ws=new WebSocket(t.webSocketDebuggerUrl);let id=0;const pend=new Map();
  ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}});
  const send=(m,p)=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}))});
  ws.addEventListener('open',async()=>{
    const s=await send('Page.captureScreenshot',{format:'png',omitBackground:true});
    if(!s.result){console.log('SHOT-FAIL');ws.close();return;}
    fs.writeFileSync(out,Buffer.from(s.result.data,'base64'));console.log('ok '+out);ws.close();
  });
});});
'''


def shot(title, path):
    js = r"<仓库根>\_shot_tmp.js"
    io.open(js, "w", encoding="utf-8").write(NODE)
    r = subprocess.run(["node", js, str(PORT), title, path], capture_output=True, text=True, timeout=90)
    print(title, "->", (r.stdout or r.stderr).strip()[:120])


def rects():
    """复用 eb_windows.ps1（已验证可用）：输出每行 '<w>x<h> @x,y ...'"""
    f = r"<仓库根>\eb_windows.ps1"
    r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f],
                       capture_output=True, text=True, timeout=90, encoding="utf-8", errors="replace")
    stdout = r.stdout or ""
    out = {}
    for line in stdout.splitlines():
        m = re.search(r"(\d+)x(\d+) @(-?\d+),(-?\d+)", line)
        if not m:
            continue
        w, h, x, y = (int(v) for v in m.groups())
        if w == 640 and h == 150:
            out["island"] = (x, y, w, h)
        elif h > 800:
            out.setdefault("pet", (x, y, w, h))
    return [out.get("island"), out.get("pet")]


def main():
    import os
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    pet_png = r"<本地输出目录>\shots\cdp-pet.png"
    isl_png = r"<本地输出目录>\shots\cdp-isl.png"
    shot("DeepSeek-猫鲸", pet_png)
    shot("island", isl_png)
    rs = rects()
    print("rects", rs)
    if len(rs) != 2:
        print("窗口矩形没拿到")
        return
    (ix, iy, iw, ih), (px, py, pw, ph) = rs[0], rs[1]
    pet = Image.open(pet_png).convert("RGBA")
    isl = Image.open(isl_png).convert("RGBA")
    pet = pet.resize((pw, ph), Image.Resampling.LANCZOS)
    isl = isl.resize((iw, ih), Image.Resampling.LANCZOS)
    # 只取角色附近的区域，别把整块 2560 桌面拼进来
    x0 = max(0, min(ix, px + int(pw * 0.55)) - 80)
    y0 = max(0, iy - 60)
    x1 = min(px + pw, ix + iw + 80)
    y1 = min(py + ph, iy + ih + int(ph * 0.45))
    W, H = x1 - x0, y1 - y0
    canvas = Image.new("RGBA", (W, H), (26, 30, 38, 255))
    canvas.alpha_composite(pet.crop((x0 - px, y0 - py, x1 - px, y1 - py)), (0, 0))
    canvas.alpha_composite(isl.crop((max(0, x0 - ix), max(0, y0 - iy), min(iw, x1 - ix), min(ih, y1 - iy))),
                           (max(0, ix - x0), max(0, iy - y0)))
    canvas.convert("RGB").save(OUT)
    print("saved", OUT, canvas.size)


main()
