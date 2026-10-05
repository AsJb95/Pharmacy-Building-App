const http = require('http');
const port = 9333;
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let body=''; res.on('data',(c)=>body+=c); res.on('end',()=>{try{resolve(JSON.parse(body))}catch(e){reject(e)}}); }).on('error',reject); }); }
function connect(url) { return new Promise((resolve,reject)=>{ const ws=new WebSocket(url),pending=new Map();let id=0;ws.onopen=()=>resolve({send(method,params={}){const rid=++id;ws.send(JSON.stringify({id:rid,method,params}));return new Promise((res,rej)=>pending.set(rid,{res,rej}))},close(){ws.close()}});ws.onerror=reject;ws.onmessage=(event)=>{const msg=JSON.parse(event.data),h=pending.get(msg.id);if(!h)return;pending.delete(msg.id);msg.error?h.rej(new Error(msg.error.message)):h.res(msg.result)}; }); }
(async()=>{const page=(await getJson(`http://127.0.0.1:${port}/json`)).find(x=>x.type==='page');const c=await connect(page.webSocketDebuggerUrl);await c.send('Runtime.enable');const r=await c.send('Runtime.evaluate',{expression:`(${async function(){
  const controls=Array.from(document.querySelectorAll('input,select,textarea'));
  const set=(index,value)=>{const el=controls[index];const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value').set;setter.call(el,String(value));el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
  set(1,'TEST-VHC UI Inventory Item'); set(3,'TEST-VHC-UI-BATCH'); set(4,'12/29'); set(5,'10'); set(6,'10'); set(7,'100'); set(9,'5'); set(10,'2'); set(11,'0'); set(13,'TEST-VHC Synthetic Stockist');
  await new Promise(r=>setTimeout(r,300));
  const save=Array.from(document.querySelectorAll('button')).find(e=>(e.textContent||'').trim()==='Save Item'); if(!save) throw new Error('Save Item button not found'); save.click();
  await new Promise(r=>setTimeout(r,2500));
  return {text:document.body.innerText,buttons:Array.from(document.querySelectorAll('button')).map((e,i)=>({i,text:(e.textContent||'').trim(),title:e.title,aria:e.getAttribute('aria-label')})).filter(x=>x.text||x.title||x.aria)};
}})()`,awaitPromise:true,returnByValue:true});c.close();if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));console.log(JSON.stringify(r.result.value,null,2))})().catch(e=>{console.error(e);process.exit(1)});
