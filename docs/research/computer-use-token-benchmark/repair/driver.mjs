import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const out=new URL('./runs/',import.meta.url);await mkdir(out,{recursive:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const config=JSON.parse(await readFile(process.env.HOME+'/.pi/agent/cliproxyapi.json','utf8'));
const source=await readFile(new URL('../run.mjs',import.meta.url),'utf8');
const taskSource=source.slice(source.indexOf('const tasks='),source.indexOf('const rules='));
const tasks=Function(taskSource+'return tasks;')();
const judgeSource=source.slice(source.indexOf('function judge('),source.indexOf('const repeats='));
const judge=Function(judgeSource+'return judge;')();
const system='You operate the visible isolated local benchmark web app using ONLY the provided computer screenshot, mouse and keyboard tools. Use screenshots to ground coordinates. You may batch known actions, including multiple tool calls per response; they execute in order. Screenshot images follow tool results as user messages. Do not use terminal, files, network, DOM, accessibility APIs, browser automation, developer tools or JavaScript URLs. Do not interact with other apps, sites or system permissions. If the fixture is not visible, report blocked. Complete and visually verify the requested change, then answer briefly. All fixture data are synthetic and form submissions are authorized.';
async function cdp(){const target=(await(await fetch('http://127.0.0.1:9444/json')).json()).find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1:47881'));if(!target)throw new Error('no fixture');const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});let id=0;const pending=new Map();ws.onmessage=({data})=>{const m=JSON.parse(data);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}};const call=(method,params={})=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});return {call,close:()=>ws.close(),evaluate:async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result?.value;}};}
async function mcp(command){
 const host=process.env.BENCH_HOST??'geminixiangmac-mini.tail4f4249.ts.net';const ws=new WebSocket('ws://'+host+':4790/exec?command='+encodeURIComponent(command));ws.binaryType='arraybuffer';
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});let id=0,buffer='',stderr='';const pending=new Map();
 ws.onmessage=({data})=>{if(typeof data==='string')return;const bytes=new Uint8Array(data);const s=new TextDecoder().decode(bytes.subarray(1));if(bytes[0]!==1){stderr+=s;return;}buffer+=s;for(let n;(n=buffer.indexOf('\n'))>=0;){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);if(!line.trim())continue;let m;try{m=JSON.parse(line);}catch(error){for(const p of pending.values())p.reject(error);continue;}const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}};
 ws.onclose=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('MCP closed '+stderr.slice(-1000)));}pending.clear();};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(new Error('MCP timeout '+stderr.slice(-1000)));},30000);pending.set(n,{resolve,reject,timer});ws.send(new TextEncoder().encode(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n'));});
 const initialized=await call('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'gui-benchmark',version:'1.0.0'}});ws.send(new TextEncoder().encode(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n'));
 return {call,close:()=>ws.close(),initialized};
}
const commands={own:'/tmp/pi-computer-token-bench/pi-mobile-fixed mcp computer',upstream:'node /Users/geminixiang/.npm/_npx/f4783362991e8b05/node_modules/computer-use-mcp/dist/main.js'};
const browser=await cdp();const clients={};
const model=process.env.BENCH_MODEL??'gpt-6.1-sol',prefix=process.env.RUN_PREFIX??'direct-pilot',repeats=Number(process.env.REPEATS??1),selected=process.env.TASKS?.split(',')??Object.keys(tasks);
try{
 for(const arm of ['own'])clients[arm]=await mcp(commands[arm]);
 for(let rep=1;rep<=repeats;rep++)for(const task of selected)for(const arm of ['own']){
  const run=`${prefix}-${task}-${rep}-${arm}`;console.log('START '+run);
  await fetch('http://127.0.0.1:47881/reset?run='+run,{method:'POST'});await browser.call('Page.navigate',{url:'http://127.0.0.1:47881/'});await delay(500);await browser.call('Page.bringToFront');const before=await browser.evaluate('window.state');if(!before)throw new Error('fixture not loaded');
  const definitions=(await clients[arm].call('tools/list')).tools;const tools=definitions.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.inputSchema}}));
  const messages=[{role:'system',content:system},{role:'user',content:tasks[task]}];const trace=[];const started=Date.now();let limited=false,error,answer='';
  try{
   for(let turn=0;turn<80;turn++){
    if(Date.now()-started>480000){limited=true;break;}
    const response=await fetch(config.baseUrl.replace(/\/$/,'')+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+config.apiKey,'Content-Type':'application/json'},body:JSON.stringify({model,messages,tools,reasoning_effort:'low',max_completion_tokens:4096,stream:false}),signal:AbortSignal.timeout(90000)});
    if(!response.ok)throw new Error('model HTTP '+response.status+': '+(await response.text()).slice(0,1000));
    const completion=await response.json();const message=completion.choices?.[0]?.message;if(!message)throw new Error('missing assistant message');
    trace.push({kind:'model',usage:completion.usage,model:completion.model,message,elapsedMs:Date.now()-started});messages.push(message);
    if(!message.tool_calls?.length){answer=message.content??'';break;}
    const images=[];
    for(const call of message.tool_calls){
     const args=JSON.parse(call.function.arguments);if(!definitions.some(t=>t.name===call.function.name))throw new Error('unoffered tool');
     if(/javascript:|devtools|osascript|curl |fetch\(|document\.|window\./i.test(JSON.stringify(args)))throw new Error('prohibited script input');
     const time=Date.now();const result=await clients[arm].call('tools/call',{name:call.function.name,arguments:args});
     const text=(result.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')||'Done.';
     messages.push({role:'tool',tool_call_id:call.id,content:(result.isError?'ERROR: ':'')+text});
     const media=[];for(const image of (result.content??[]).filter(c=>c.type==='image')){images.push({type:'image_url',image_url:{url:'data:'+image.mimeType+';base64,'+image.data,detail:'high'}});media.push({mimeType:image.mimeType,bytes:Buffer.byteLength(image.data,'base64'),sha256:createHash('sha256').update(Buffer.from(image.data,'base64')).digest('hex')});}
     trace.push({kind:'tool',name:call.function.name,args,text,isError:!!result.isError,images:media,ms:Date.now()-time});
    }
    if(images.length)messages.push({role:'user',content:[{type:'text',text:'Screenshots returned by the preceding tool calls, in call order:'},...images]});
    if(turn===79)limited=true;
   }
  }catch(e){error=String(e);}
  await delay(200);const after=await browser.evaluate('window.state');const score=judge(task,before,after);const calls=trace.filter(t=>t.kind==='model');
  const usage=calls.reduce((s,c)=>({input:s.input+(c.usage?.prompt_tokens??0),cached:s.cached+(c.usage?.prompt_tokens_details?.cached_tokens??0),output:s.output+(c.usage?.completion_tokens??0),total:s.total+(c.usage?.total_tokens??0)}),{input:0,cached:0,output:0,total:0});
  const result={run,task,arm,rep,model,system,prompt:tasks[task],seconds:(Date.now()-started)/1000,modelCalls:calls.length,toolCalls:trace.filter(t=>t.kind==='tool').length,usage,limited,error,answer,success:score.success&&!error&&!limited,before,after,expected:score.expected,trace};
  await writeFile(new URL(run+'.json',out),JSON.stringify(result,null,2));const shot=await browser.call('Page.captureScreenshot',{format:'png'});await writeFile(new URL(run+'.png',out),Buffer.from(shot.data,'base64'));
  console.log(JSON.stringify({run,seconds:result.seconds,success:result.success,error,limited,modelCalls:result.modelCalls,toolCalls:result.toolCalls,usage,answer}));
  if(error)throw new Error(error);
 }
}finally{for(const c of Object.values(clients))c.close();browser.close();}
