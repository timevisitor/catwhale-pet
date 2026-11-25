const http=require('http');
const want=process.argv[2], expr=process.argv[3];
http.get('http://127.0.0.1:9224/json/list',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{
  const t=JSON.parse(d).find(x=>(x.title||'').includes(want));
  if(!t){console.log('NO-TARGET '+want);return;}
  const ws=new WebSocket(t.webSocketDebuggerUrl);let id=0;const pend=new Map();
  ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}});
  const send=(method,params)=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method,params}))});
  ws.addEventListener('open',async()=>{
    const r2=await send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});
    console.log(JSON.stringify(r2.result&&r2.result.result?r2.result.result.value:r2.result).slice(0,600));
    ws.close();
  });
});});
