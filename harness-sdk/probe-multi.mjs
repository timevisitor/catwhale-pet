
import { spawn } from 'node:child_process';
const REPO='F:\\deepseek-harness\\src', PATCH=process.argv[2], SID=process.argv[3];
const prompts = process.argv.slice(4);
const child = spawn(process.execPath, ['--import','tsx/esm','apps/cli/src/bin.ts','--profile','headless','--patch',PATCH],
  { cwd: REPO, stdio:['pipe','pipe','pipe'], windowsHide:true });
const rpc=(o)=>child.stdin.write(JSON.stringify(o)+'\n');
let buf='', idx=0, text='', idleWait=null;
const next = ()=>{ if(idx>=prompts.length){ rpc({jsonrpc:'2.0',id:9,method:'shutdown',params:{}}); setTimeout(()=>child.kill(),2500); return; }
  console.log(`\n>>> [${idx+1}/${prompts.length}] ${prompts[idx]}`);
  rpc({jsonrpc:'2.0',id:100+idx,method:'session/prompt',params:{sessionId:SID,contentBlocks:[{type:'text',text:prompts[idx++]}]}}); };
child.stdout.on('data', d=>{
  buf+=d; let i;
  while((i=buf.indexOf('\n'))>=0){ const line=buf.slice(0,i).trim(); buf=buf.slice(i+1); if(!line) continue;
    let m; try{ m=JSON.parse(line); }catch{ continue; }
    if(m.id===1){ next(); continue; }
    if(!m.method) continue;
    const ev=m.params.event||{}; const t=ev.type||''; const dta=ev.data||{};
    if(t==='assistant/chunk' && dta.chunk?.type==='text-delta') text+=dta.chunk.text;
    if(t==='assistant/message'){ console.log('  ✔ 回复:', JSON.stringify(dta.message?.content?.map(c=>c.text).join('')||'')); text=''; }
    if(t==='turn/end'){ console.log('  turn/end:', JSON.stringify(dta.reason)); if(dta.reason?.kind==='error') console.log('  ✘ 错误:', dta.reason.error?.message);
      if(dta.reason?.kind==='completed'||dta.reason?.kind==='error') setTimeout(next, 300); }
    if(/tool/i.test(t)) console.log('  🔧', t, JSON.stringify(dta).slice(0,200));
  }
});
child.stderr.on('data', d=>{ const s=String(d); if(!/Experimental|trace-warnings/.test(s)) process.stderr.write('[stderr] '+s.slice(0,300)); });
child.on('exit', c=>{ console.log('退出 code='+c); process.exit(0); });
rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{cwd:REPO, provider:'deepseek-official', model:'deepseek-v4-flash-vision-exp', maxTokens:2048}});
setTimeout(()=>{ try{child.kill();}catch(e){} process.exit(0); }, 150000);
