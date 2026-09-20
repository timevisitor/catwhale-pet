
// 最小 SDK JSON-RPC 客户端：验证"桌宠能不能流式驱动 harness"
import { spawn } from 'node:child_process';
const REPO = 'F:\\deepseek-harness\\src';
const PROFILE = process.argv[2] || 'headless';
const PATCH = process.argv[3];
const PROMPT = process.argv[4] || '1+1=?只回答数字';
const t0 = Date.now();
const child = spawn(process.execPath, ['--import','tsx/esm','apps/cli/src/bin.ts','--profile',PROFILE,'--patch',PATCH],
  { cwd: REPO, stdio:['pipe','pipe','pipe'], windowsHide:true });
const rpc = (o)=> child.stdin.write(JSON.stringify(o) + '\n');
let buf='', nEvents=0, kinds={}, assistantText='', toolCalls=[], done=false;
const tag = (ms)=> '+' + ((ms)/1000).toFixed(1) + 's';
child.stdout.on('data', d=>{
  buf += d;
  let i;
  while((i = buf.indexOf('\n')) >= 0){
    const line = buf.slice(0,i).trim(); buf = buf.slice(i+1);
    if(!line) continue;
    let m; try{ m = JSON.parse(line); }catch(e){ console.log('  [非JSON]', line.slice(0,120)); continue; }
    const t = tag(Date.now()-t0);
    if(m.id === 1 && !m.error){ console.log(t, '✔ initialize(' + PROFILE + ') →', JSON.stringify(m.result).slice(0,160));
      rpc({jsonrpc:'2.0',id:2,method:'session/prompt',params:{sessionId: (process.env.PROBE_SID || ('pet-' + Date.now().toString(36))),contentBlocks:[{type:'text',text:PROMPT}]}});
      console.log(t, '→ session/prompt 已发送');
      continue; }
    if(m.id === 2){ console.log(t, '✔ prompt 回执:', JSON.stringify(m.result)); continue; }
    if(m.id === 9){ console.log(t, '✔ shutdown'); continue; }
    if(m.method){
      nEvents++;
      const p = m.params || {};
      const k = p.event?.type || p.event?.kind || m.method + ':' + (p.status || '');
      kinds[k] = (kinds[k]||0)+1;
      const ev = p.event || p;
      const s = JSON.stringify(ev);
      // 抓助手文本与工具调用
      const txt = ev?.message?.content?.map?.(c=>c.text).filter(Boolean).join('') || ev?.text || '';
      if(txt && (ev.type||'').includes('assistant')) assistantText += txt;
      if(/tool/i.test(ev.type||'') && ev.type) toolCalls.push(ev.type + ' ' + (ev.name||ev.toolName||''));
      console.log(t, '  ←', k, s.slice(0, 1600));   // 全量
      continue; }
    console.log(t, '  ?', JSON.stringify(m).slice(0,200));
  }
});
child.stderr.on('data', d=>{ const s=String(d); process.stderr.write('  [stderr] ' + s.slice(0,900)); });
child.on('exit', (c)=>{ const ms=Date.now()-t0; console.log(`\n进程退出 code=${c} 用时=${(ms/1000).toFixed(1)}s`);
  console.log('事件总数:', nEvents, '| 类型分布:', JSON.stringify(kinds).slice(0,400));
  console.log('助手文本累计:', JSON.stringify(assistantText).slice(0,300));
  console.log('工具调用事件:', toolCalls.slice(0,10));
  process.exit(0); });
rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{cwd: REPO, provider:'deepseek-official', model:'deepseek-v4-flash-vision-exp', maxTokens: 2048}});
setTimeout(()=>{ if(!done){ done=true; rpc({jsonrpc:'2.0',id:9,method:'shutdown',params:{}}); setTimeout(()=>child.kill(), 4000); } }, 90000);
