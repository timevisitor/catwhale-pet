const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('fs'),path=require('path'),http=require('http'),vm=require('vm');
const root=path.resolve(process.env.PET_WEB_DIR||path.join(__dirname,'../web'));
const out=path.resolve(process.env.PET_TEST_OUTPUT || path.join(__dirname,'../work/sao-verification'));fs.mkdirSync(out,{recursive:true});
const results=[], errors=[];
function check(ok,name,detail){results.push({name,ok:!!ok,...(ok?{}:{detail})});console.log((ok?'PASS ':'FAIL ')+name+(ok?'':' '+JSON.stringify(detail)));}
const mime={'.html':'text/html; charset=utf-8','.css':'text/css','.json':'application/json','.webm':'video/webm','.png':'image/png'};
const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');const file=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}fs.readFile(file,(e,b)=>{if(e){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(b);});});
(async()=>{
  const source=fs.readFileSync(path.join(root,'index.html'),'utf8');
  for(const match of source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
  check(true,'Renderer JavaScript parses');
  for(const name of ['saoRunSub','saoSelectCat','refreshSaoStatus','positionSao'])check((source.match(new RegExp('function '+name+'\\(','g'))||[]).length===1,'Single implementation: '+name);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({executablePath:process.env.PET_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/?auto=0&controls=0&size=340');await page.waitForFunction(()=>window.__petInitOK);
    const state=()=>page.evaluate(()=>petAPI.saoState());
    const settle=()=>page.waitForTimeout(280);
    const open=async()=>{await page.evaluate(()=>petAPI.openMenu());await settle();};
    await page.evaluate(()=>petAPI.setPos(1140,480));await open();
    await page.locator('#saoList [data-cat="look"]').click();await settle();
    check((await state()).open&&(await state()).cat==='look','Real pointer click changes category without dismissing');
    await page.locator('#saoSub .row').filter({hasText:'显示大小'}).click();await settle();
    check((await state()).subRow===0,'Size branch opens by real click');
    await page.locator('#saoSub .row').filter({hasText:'大 460'}).click();await settle();
    check(await page.evaluate(()=>petAPI.getSize()===460&&petAPI.saoState().open),'Size applies and menu stays open');
    check(await page.evaluate(()=>document.getElementById('size').value==='460'&&document.getElementById('sizeVal').textContent==='460'),'Size menu and control panel stay in sync');
    check(await page.locator('#saoSub [aria-checked="true"]').count()===1,'Exactly one persistent size selection');
    await page.keyboard.press('Escape');await settle();check((await state()).open&&(await state()).subRow===-1,'Esc returns one level only');
    const old=await page.locator('#saoSub .row').filter({hasText:'脚下阴影'}).innerText();
    await page.locator('#saoSub .row').filter({hasText:'脚下阴影'}).click();await settle();
    check(old!==await page.locator('#saoSub .row').filter({hasText:'脚下阴影'}).innerText()&&(await state()).open,'Toggle updates live without closing');
    await page.locator('#saoList [data-cat="interact"]').click();await settle();
    await page.locator('#saoSub .row').filter({hasText:'打个招呼'}).click();await settle();
    check(!(await state()).open&&await page.evaluate(()=>petAPI.getMode().react==='tail_open'),'Action executes and closes menu');
    await open();await page.locator('#saoList [data-cat="tools"]').click();await settle();
    await page.locator('#saoSub .row').filter({hasText:'文件搜索'}).click();await settle();
    check(await page.evaluate(()=>petAPI.getMode().searchOpen&&!petAPI.saoState().open),'Search entry opens existing search panel');
    await page.evaluate(()=>petAPI.closeSearch());await open();
    await page.locator('#saoList [data-cat="tools"]').click();await settle();
    await page.locator('#saoSub .row').filter({hasText:'DeepSeek 聊天'}).click();await settle();
    check(await page.evaluate(()=>petAPI.chatState().open&&!petAPI.saoState().open),'Chat entry opens existing chat panel without sending');
    await page.evaluate(()=>petAPI.closeChat());await open();await page.locator('#saoList [data-cat="tools"]').click();await settle();
    await page.locator('#saoSub .row').filter({hasText:'设置'}).click();await settle();
    const input=page.locator('#settings input').first();await input.click();
    check(await page.evaluate(()=>document.getElementById('settings').classList.contains('show')),'Clicking settings input no longer dismisses it');
    await page.evaluate(()=>petAPI.closeSettings());await open();
    await page.locator('#saoList [data-cat="look"]').focus();await page.keyboard.press('ArrowLeft');await settle();
    check(await page.evaluate(()=>!!document.activeElement.closest('#saoSub')),'Mirror-aware keyboard enters function list');
    await page.keyboard.press('Enter');await settle();check((await state()).subRow===0,'Enter activates real focused item');
    await page.keyboard.press('Escape');await settle();check((await state()).open&&(await state()).subRow===-1,'Keyboard branch Escape does not bubble and close everything');
    await page.keyboard.press('Escape');check(!(await state()).open,'Second Escape closes menu');
    await open();await page.mouse.click(5,5);check(!(await state()).open,'Outside click dismisses');
    await page.evaluate(()=>{window.petHost={workArea:()=>new Promise(r=>setTimeout(()=>r({x:0,y:0,width:innerWidth,height:innerHeight}),120))};petAPI.openMenu();petAPI.closeMenu();});
    await settle();check(await page.evaluate(()=>!petAPI.saoState().open&&!document.getElementById('sao').classList.contains('show')),'Late work-area response cannot reopen a closed menu');
    await page.evaluate(()=>delete window.petHost);
    for(const [width,height] of [[1920,1080],[1366,768],[800,600],[480,640],[320,480],[640,280]]){
      await page.setViewportSize({width,height});await page.evaluate(()=>{petAPI.closeMenu();petAPI.setSize(240);});
      for(const corner of ['tl','tr','bl','br']){
        await page.evaluate(({width,height,corner})=>{petAPI.closeMenu();petAPI.setPos(corner.endsWith('r')?width-150:0,corner.startsWith('b')?height-240:0);petAPI.openMenu();petAPI.saoSelectCat('system');},{width,height,corner});await settle();
        const geometry=await page.evaluate(()=>['sao','saoCats','saoList','saoSub'].flatMap(id=>{const e=document.getElementById(id),r=e.getBoundingClientRect();if(!r.width||!r.height)return[];return[{id,l:r.left,t:r.top,r:r.right,b:r.bottom,ok:r.left>=-1&&r.top>=-1&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1}];}));
        check(geometry.every(r=>r.ok),`Visible modules fit ${width}×${height} ${corner}`,geometry);
      }
    }
    await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>{petAPI.closeMenu();petAPI.setSize(340);petAPI.setPos(1140,470);petAPI.openMenu();petAPI.saoSelectCat('look');});await settle();
    const hits=await page.evaluate(()=>{const r=document.querySelector('#saoList .row').getBoundingClientRect(),b=document.getElementById('saoBridge').getBoundingClientRect();return{blank:uiHitAt(4,4),row:uiHitAt(r.left+10,r.top+10),bridge:uiHitAt(b.left+b.width/2,b.top+b.height/2)};});
    check(!hits.blank&&hits.row&&hits.bridge,'Hit testing distinguishes blank desktop, row and bridge',hits);
    await page.emulateMedia({reducedMotion:'reduce'});check(await page.locator('#saoCard').evaluate(e=>getComputedStyle(e).animationName==='none'),'Reduced-motion preference disables menu animations');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.screenshot({path:path.join(out,'01-SAO菜单.png'),clip:{x:360,y:380,width:980,height:480}});
    await page.locator('#saoSub .row').filter({hasText:'显示大小'}).click();await settle();
    await page.screenshot({path:path.join(out,'02-大小子菜单.png'),clip:{x:360,y:380,width:980,height:480}});
    await page.setViewportSize({width:800,height:600});await page.evaluate(()=>{petAPI.closeMenu();petAPI.setSize(240);petAPI.setPos(650,360);petAPI.openMenu();petAPI.saoSelectCat('tools');});await settle();
    await page.screenshot({path:path.join(out,'03-小屏边缘适配.png')});
    for(const scale of [1.25,1.5,2]){
      const c=await browser.newContext({viewport:{width:1024,height:700},deviceScaleFactor:scale});const p=await c.newPage();await p.goto(base+'/?auto=0&controls=0&menu=1');await p.waitForFunction(()=>window.__petInitOK);await p.waitForTimeout(350);
      check(await p.evaluate(()=>{const r=document.getElementById('sao').getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth;}),'Menu fits device scale '+scale);await c.close();
    }
    check(errors.length===0,'No uncaught browser errors',errors);
    await page.evaluate(()=>{petAPI.closeMenu();petAPI.openMenu();petAPI.saoSelectCat('action');});await settle();
    await page.locator('#saoSub .row').filter({hasText:'陪它忙起来'}).click();
    check(await page.evaluate(()=>petAPI.getMode().taskCount===1),'Demo task starts once');
    check(await page.locator('#saoSub .row').filter({hasText:'陪它忙起来'}).isDisabled(),'Running demo cannot stack unbounded tasks');
    await page.waitForTimeout(10300);
    check(await page.evaluate(()=>petAPI.getMode().taskCount===0),'Demo task automatically finishes');
    const regression=await browser.newPage();await regression.goto(base+'/_interaction_test.html');
    await regression.waitForFunction(()=>document.title.includes('STATEMACHINE-'),{},{timeout:90000});
    const report=await regression.locator('#out').innerText();fs.writeFileSync(path.join(out,'原有交互回归.txt'),report);
    check((await regression.title())==='STATEMACHINE-PASS','Existing state-machine and chat/search regression suite',report.split('\n').filter(l=>l.includes('✘')));
  }finally{await browser.close();server.close();fs.writeFileSync(path.join(out,'验证结果.json'),JSON.stringify(results,null,2));}
  if(results.some(r=>!r.ok))process.exitCode=1;
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
