#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""0.8.2 拖动分流验证：球态横拖=移动岛 / 球态上拖=隐藏 / 展开态横拖=切卡。

关键：验收机上 Hermes 自己的 Agent 看板会每 500ms 把一张 agent 卡塞进队列，
把岛钉在胶囊态。所以前半段先 freeze（只停推送，island:demo 直改状态仍有效），
造出球态再测；③ 再 unfreeze 造出多张卡。
"""
import asyncio, json, sys, urllib.request
import websockets

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9333

def http_json(path):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return json.loads(op.open(urllib.request.Request('http://127.0.0.1:%d%s' % (PORT, path)), timeout=10).read().decode())

async def run():
    targets = http_json('/json/list')
    isl = [t for t in targets if 'island.html' in t.get('url', '')]
    if not isl:
        print('没找到 island 页面'); return 1
    async with websockets.connect(isl[0]['webSocketDebuggerUrl'], max_size=16 << 20) as ws:
        mid = 0
        async def call(method, params=None):
            nonlocal mid
            mid += 1; my = mid
            await ws.send(json.dumps({'id': my, 'method': method, 'params': params or {}}))
            while True:
                m = json.loads(await asyncio.wait_for(ws.recv(), timeout=25))
                if m.get('id') == my:
                    return m
        async def ev(expr, await_promise=False):
            r = await call('Runtime.evaluate', {'expression': expr, 'returnByValue': True, 'awaitPromise': await_promise})
            if 'exceptionDetails' in r['result']:
                return {'__err': str(r['result']['exceptionDetails'].get('text'))}
            return r['result'].get('result', {}).get('value')
        async def mouse(kind, x, y, buttons=1):
            await call('Input.dispatchMouseEvent', {'type': kind, 'x': round(x), 'y': round(y), 'button': 'left',
                                                    'buttons': buttons, 'clickCount': 1})
        async def inv(name, cmd):
            return await ev("(function(){ try { return window.petHost.islandInvoke('%s', {cmd:'%s'}); } catch(e){ return 'throw:'+e.message; } })()" % (name, cmd), True)
        await call('Runtime.enable')

        fails = []
        def ok(name, cond, extra=None):
            if not cond: fails.append(name)
            print('%s  %s  %s' % ('PASS' if cond else 'FAIL', name,
                                  json.dumps(extra, ensure_ascii=False) if extra is not None else ''))

        async def state():
            return await ev('window.__islandState && window.__islandState()')
        async def get():
            return (await ev("window.petHost.islandInvoke('island_get', {})", True) or {}).get('data') or {}
        async def winpos():
            return await ev('({sx: window.screenX, sy: window.screenY})')

        async def reset_idle():
            await inv('island_cmd', 'dismiss')      # dismiss 顺手清 pinned，否则 clear 也掉不回球态
            await asyncio.sleep(0.3)
            await inv('island_cmd', 'expand')
            await inv('island_cmd', 'freeze')       # 停推送，外部 agent 活动不再入列
            await inv('island_demo', 'clear')       # demo 直接改状态并推一次空载荷
            await asyncio.sleep(1.6)                # 等弹簧收缩成球

        # ---------- ① 球态横向拖动 → 移动岛 ----------
        await reset_idle()
        s0 = await state(); p0 = await winpos()
        st_before = s0.get('steps')
        print('   ①起点:', json.dumps({'rect': s0['rect'], 'p': s0['motion']['p']['value'],
                                        'cls': await ev("document.getElementById('isl').className")}, ensure_ascii=False))
        cx = s0['rect'][0] + s0['rect'][2] / 2
        cy = s0['rect'][1] + s0['rect'][3] / 2
        await ev('window.__islandDrag = null')
        await mouse('mousePressed', cx, cy, 1)
        for i in range(1, 7):
            await mouse('mouseMoved', cx + i * 12, cy, 1)
            await asyncio.sleep(0.03)
        await mouse('mouseReleased', cx + 72, cy, 0)
        await asyncio.sleep(1.0)
        drag = await ev('window.__islandDrag') or {}
        p1 = await winpos(); d1 = await get()
        ok('① 球态横拖：页面确实发起移动岛（__islandDrag.moves > 0）', (drag.get('moves') or 0) > 0,
           {'moves': drag.get('moves'), 'start': drag.get('start')})
        ok('① 球态横拖：窗口真的被搬动了（screenX 变化）', abs((p1.get('sx') or 0) - (p0.get('sx') or 0)) >= 1,
           {'before': p0, 'after': p1})
        st_after = (await state()).get('steps')
        ok('① 球态横拖：没有被当成切卡（steps 没增加）', st_after == st_before,
           {'before': st_before, 'after': st_after})

        # ---------- ② 球态上拖 → 隐藏，且不搬窗 ----------
        await reset_idle()
        s0 = await state(); p0 = await winpos()
        cx = s0['rect'][0] + s0['rect'][2] / 2
        cy = s0['rect'][1] + max(6, s0['rect'][3] / 2)
        await ev('window.__islandDrag = null')
        await mouse('mousePressed', cx, cy, 1)
        for i in range(1, 6):
            await mouse('mouseMoved', cx, cy - i * 12, 1)
            await asyncio.sleep(0.03)
        await mouse('mouseReleased', cx, cy - 60, 0)
        await asyncio.sleep(0.9)
        drag = await ev('window.__islandDrag') or {}
        p1 = await winpos(); d1 = await get()
        ok('② 球态上拖：判成上拖隐藏（hidden=true）', d1.get('hidden') is True,
           {'hidden': d1.get('hidden'), 'mode': d1.get('mode')})
        ok('② 球态上拖：没有倒在移动岛这条路上（moves=0、窗口没动）',
           (drag.get('moves') or 0) == 0 and abs((p1.get('sx') or 0) - (p0.get('sx') or 0)) < 2,
           {'moves': drag.get('moves'), 'before': p0, 'after': p1})

        # ---------- ③ 展开态横拖 → 切卡，且不搬窗 ----------
        await inv('island_cmd', 'expand')
        await inv('island_cmd', 'unfreeze')
        await inv('island_demo', 'activities')
        await asyncio.sleep(1.6)
        s0 = await state(); p0 = await winpos()
        st0 = s0.get('steps')
        print('   ③起点:', json.dumps({'rect': s0['rect'], 'steps': st0,
                                        'cls': await ev("document.getElementById('isl').className")}, ensure_ascii=False))
        cx = s0['rect'][0] + s0['rect'][2] / 2
        cy = s0['rect'][1] + s0['rect'][3] / 2
        await ev('window.__islandDrag = null')
        await mouse('mousePressed', cx, cy, 1)
        for i in range(1, 7):
            await mouse('mouseMoved', cx - i * 14, cy, 1)
            await asyncio.sleep(0.06)
        await mouse('mouseReleased', cx - 84, cy, 0)
        await asyncio.sleep(1.0)
        s1 = await state(); p1 = await winpos()
        drag = await ev('window.__islandDrag') or {}
        ok('③ 展开态横拖：页面发起了切卡请求（steps 增加）', (s1.get('steps') or 0) > (st0 or 0),
           {'before': st0, 'after': s1.get('steps')})
        ok('③ 展开态横拖：没有搬窗（__islandDrag 无 moves、screenX 不变）',
           (drag.get('moves') or 0) == 0 and abs((p1.get('sx') or 0) - (p0.get('sx') or 0)) < 2,
           {'moves': drag.get('moves'), 'before': p0, 'after': p1})

        print('\n========== %s ==========' % ('全部通过' if not fails else ('失败: ' + ' | '.join(fails))))
        return 0 if not fails else 1

sys.exit(asyncio.run(run()))
