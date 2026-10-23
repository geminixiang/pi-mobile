import {writeFile,mkdir,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const output=new URL('./runs/',import.meta.url);await mkdir(output,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function connect(port,match){
 const targets=await(await fetch(`http://127.0.0.1:${port}/json`)).json();const target=targets.find(t=>t.type==='page'&&(!match||t.url.startsWith(match)));if(!target)throw new Error('missing target '+port);
 const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});let next=0;const pending=new Map();
 ws.onmessage=({data})=>{const m=JSON.parse(String(data));const p=pending.get(m.id);if(p){pending.delete(m.id);if(m.error)p.reject(new Error(JSON.stringify(m.error)));else p.resolve(m.result);}};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result?.value;};
 return {call,evaluate,close:()=>ws.close(),target};
}
const tasks={
 orders:'在訂單頁只看待處理訂單，找到「青禾工作室」的訂單（不是青禾設計）。把收件人改成「林安」、電話改成 0912345678、配送改成隔日、備註改成「請於下午送達，先電話聯絡」。完成核對與確認頁，真正儲存。不要更動其他訂單。最後回報訂單編號。',
 expense:'到費用報銷，修改現有草稿：用途改「台北客戶拜訪」、部門工程、申請人林安，日期保留。把車票改成560元、住宿改成1080元，刪掉餐費，新增計程車190元。核對總額、勾選單據齊全並送出，不要只停在草稿。最後回報總額。',
 projects:'到專案任務，篩選 Pilot。跨頁選取所有 Pilot 任務，批次改成進行中；Core 專案完全不要動。再把「通知重試」的負責人改張晴、優先度低、到期日2026-11-18並儲存，其餘欄位不變。最後回報 Pilot 任務數量。'
};
const rules='Use only the connected computer MCP screenshot, mouse and keyboard tools to operate the visible local benchmark web app. Codemode may orchestrate these tools and display their screenshots; both implementations may batch known steps. Do not use shell, filesystem, network requests, DOM, accessibility trees, browser automation APIs, developer tools, JavaScript URLs, or other services to solve or inspect the task. Do not interact with any other website, application, OS settings or permissions. If the benchmark page is not visible, stop and report blocked. Verify the result visually and finish concisely. You may submit and confirm forms in this isolated synthetic fixture.';
const phone=await connect(9334),browser=await connect(9444,'http://127.0.0.1:47881');
const bound=await browser.call('Browser.getWindowForTarget',{targetId:browser.target.id});await browser.call('Browser.setWindowBounds',{windowId:bound.windowId,bounds:{left:0,top:25,width:1920,height:990,windowState:'normal'}});
function judge(task,before,after){
 const expected=structuredClone(before);
 if(task==='orders')Object.assign(expected.orders.find(o=>o.customer==='青禾工作室'),{recipient:'林安',phone:'0912345678',shipping:'隔日',note:'請於下午送達，先電話聯絡',confirmed:true});
 if(task==='expense')Object.assign(expected.expense,{title:'台北客戶拜訪',department:'工程',owner:'林安',items:[{name:'車票',amount:560},{name:'住宿',amount:1080},{name:'計程車',amount:190}],receipt:true,submitted:true});
 if(task==='projects'){for(const t of expected.tasks)if(t.project==='Pilot')t.status='進行中';Object.assign(expected.tasks.find(t=>t.name==='通知重試'),{owner:'張晴',priority:'低',due:'2026-11-18'});}
 return {success:JSON.stringify(expected)===JSON.stringify(after),expected};
}
const repeats=Number(process.env.REPEATS??1),prefix=process.env.RUN_PREFIX??'pilot';
const selected=process.env.TASKS?.split(',')??Object.keys(tasks);
try{
 for(let rep=1;rep<=repeats;rep++)for(const task of selected)for(const arm of rep%2?['own','upstream']:['upstream','own']){
  const run=`${prefix}-${task}-${rep}-${arm}`;await fetch(`http://127.0.0.1:47881/reset?run=${run}`,{method:'POST'});
  await browser.call('Page.navigate',{url:'http://127.0.0.1:47881/'});await sleep(500);await browser.call('Page.bringToFront');
  const before=await browser.evaluate('window.state');if(!before)throw new Error('fixture not ready');
  const created=await phone.evaluate(`(async()=>{const r=window.piRuntime;const id=await r.createBot({name:'test GUI benchmark',job:${JSON.stringify(rules)},avatar:'helper'});await r.setComputer(id,'phone');for(const t of await r.toolsets(id))await r.setToolset(id,t.id,t.id==='mcp-bench_${arm}');const c=await r.openConversation(id);await c.setModel('custom','gpt-6.1-sol');await c.setThinking('low');window.bench={id,c,view:null};window.bench.stop=c.subscribe(v=>window.bench.view=v);return {id,cost:await r.toolCost(id)};})()`);
  await writeFile(new URL(run+'.start.json',output),JSON.stringify({run,task,arm,rep,created,prompt:tasks[task],rules,model:'custom/gpt-6.1-sol',thinking:'low',limitSeconds:240,limitModelCalls:40,before},null,2));
  const start=Date.now();let status,limited=false;
  await phone.evaluate(`window.bench.c.send([{type:'text',text:${JSON.stringify(tasks[task])}}])`);
  for(;;){await sleep(1000);status=await phone.evaluate(`(()=>{const v=window.bench.view;const models=v?.entries.flatMap(e=>e.model??[]).filter(m=>m.role==='assistant')??[];return {busy:!!v?.docs['pi.live']?.run,calls:models.length,last:models.at(-1)?.content?.filter(c=>c.type==='text').map(c=>c.text).join('')};})()`);if(status.calls>0&&!status.busy)break;if(Date.now()-start>240000||status.calls>=40){limited=true;await phone.evaluate('window.bench.c.stop()');break;}}
  await sleep(300);
  const trace=await phone.evaluate(`(()=>{const v=window.bench.view;return {entries:v.entries.map(e=>({kind:e.kind,model:(e.model??[]).filter(m=>m.role==='assistant'||m.role==='toolResult').map(m=>({...m,content:(m.content??[]).map(c=>c.type==='image'?{type:c.type,mimeType:c.mimeType,base64Length:c.data?.length}:c)}))})),live:v.docs['pi.live']};})()`);
  const after=await browser.evaluate('window.state');const scored=judge(task,before,after);const seconds=(Date.now()-start)/1000;
  const models=trace.entries.flatMap(e=>e.model).filter(m=>m.role==='assistant');
  const usage=models.reduce((sum,m)=>{for(const k of ['input','output','cacheRead','cacheWrite','totalTokens'])sum[k]+=(m.usage?.[k]??0);return sum;},{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0});
  const result={run,task,arm,rep,seconds,limited,modelCalls:models.length,usage,...scored,after,trace};
  await writeFile(new URL(run+'.json',output),JSON.stringify(result,null,2));console.log(JSON.stringify({run,seconds,success:scored.success,limited,modelCalls:models.length,usage}));
  const screenshot=await browser.call('Page.captureScreenshot',{format:'png'});await writeFile(new URL(run+'.png',output),Buffer.from(screenshot.data,'base64'));
  await phone.evaluate('(async()=>{window.bench.stop();window.bench.c.dispose();await window.piRuntime.removeBot(window.bench.id);delete window.bench;})()');
 }
}finally{phone.close();browser.close();}
