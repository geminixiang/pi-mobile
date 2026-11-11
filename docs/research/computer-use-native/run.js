import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

const out=new URL('./runs/',import.meta.url);await mkdir(out,{recursive:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const config=JSON.parse(await readFile(process.env.HOME+'/.pi/agent/cliproxyapi.json','utf8'));
const platform=process.env.PLATFORM;
const model=process.env.BENCH_MODEL??'gpt-6.1-sol',prefix=process.env.RUN_PREFIX??platform,repeats=Number(process.env.REPEATS??1);

const tasks={
 editor:'編輯器裡開著 note.txt。把第一行的 beta 改成 BETA，然後在檔案最後加上兩行：「會議改到週四 15:30」和「Room 7B, bring the Q3 deck」。存檔，檔名和格式不變。',
 files:'檔案管理員開著 files 資料夾。在 files 裡新增一個叫「封存」的資料夾，把 報價單.txt、合約.txt、收據.txt 搬進封存，再把封存裡的 收據.txt 改名成 收據-2025.txt。備忘.txt 留在原處。',
 crossapp:'檔案管理員開著 inbox 資料夾，編輯器開著 list.txt。把 inbox 裡每個資料夾的名稱寫進 list.txt，一行一個，然後存檔。',
};
const system='You operate the visible computer using ONLY the provided computer screenshot, mouse and keyboard tools. Use screenshots to ground coordinates. You may batch known actions, including multiple tool calls per response; they execute in order. Screenshot images follow tool results as user messages. Do not open a terminal or any app the task does not need, and leave other windows alone. If the needed window is not visible, look for it before reporting blocked. Complete and visually verify the requested change, then answer briefly. All files are synthetic test data.';

const seed=`
rm -rf "$B"; mkdir -p "$B/files" "$B/inbox/2025 預算" "$B/inbox/客戶 林安" "$B/inbox/Q3 deck" "$B/inbox/舊照片"
printf 'alpha beta gamma\\n' > "$B/note.txt"; : > "$B/list.txt"
for f in 報價單 合約 收據 備忘; do printf '%s 的內容\\n' "$f" > "$B/files/$f.txt"; done
`;
const snapshot=`cd "$B" && find . -mindepth 1 | LC_ALL=C sort | while IFS= read -r p; do if [ -d "$p" ]; then printf 'D\\t%s\\n' "$p"; else printf 'F\\t%s\\t%s\\n' "$p" "$(base64 < "$p" | tr -d '\\n')"; fi; done`;

const desktops={
 mac:{
  home:'B="$HOME/pi-bench"',
  close:'pkill -x TextEdit; sleep 1',
  editor:f=>`open -F -a TextEdit "$B/${f}"; sleep 2`,
  folder:d=>`open "$B/${d}"; sleep 1`,
  settle:[{action:'key',keys:'cmd+alt+h'}],
  clear:{shell:'open -a Finder; sleep 1',steps:[{action:'key',keys:'cmd+alt+w'}]},
 },
 windows:{
  home:'B="$HOME/pi-bench"; NP="$(cygpath -u "$LOCALAPPDATA")/Packages/Microsoft.WindowsNotepad_8wekyb3d8bbwe/LocalState"',
  close:'taskkill //IM notepad.exe //F >/dev/null 2>&1; sleep 1; rm -rf "$NP/TabState"/* "$NP/WindowState"/*; printf %b "$FRONT_PS1" > "$HOME/pi-bench-front.ps1"; powershell -NoProfile -Command \'(New-Object -ComObject Shell.Application).Windows() | Where-Object { $_.LocationURL -like "*pi-bench*" } | ForEach-Object { $_.Quit() }; (New-Object -ComObject Shell.Application).MinimizeAll()\'; sleep 1',
  editor:f=>`(notepad.exe "$(cygpath -w "$B/${f}")" &) ; sleep 2`,
  folder:d=>`(explorer.exe "$(cygpath -w "$B/${d}")" &) ; sleep 2`,
  wake:[{action:'key',keys:'shift'},{action:'wait',ms:1500}],
  front:names=>'powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$HOME/pi-bench-front.ps1")" '+names.map(n=>JSON.stringify(n)).join(' '),
 },
 linux:{
  home:'B="$HOME/pi-bench"; . /work/env.sh',
  close:'pkill -f gnome-text-editor; pkill -f nautilus; rm -rf "$HOME/.local/share/gnome-text-editor"; [ -z "$WAYLAND_DISPLAY" ] || gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "imports.gi.St.Clipboard.get_default().set_text(imports.gi.St.ClipboardType.CLIPBOARD, \\"使用者先前複製的文字\\"); null" >/dev/null; sleep 0.5',
  editor:f=>`setsid gnome-text-editor --standalone "$B/${f}" >/dev/null 2>&1 &`,
  folder:d=>`setsid nautilus --new-window "$B/${d}" >/dev/null 2>&1 & sleep 5`,
 },
}[platform==='x11'||platform==='wayland'?'linux':platform];
const FRONT_PS1=[
 '$sig = \'[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);\'',
 'Add-Type -Name W -Namespace P -MemberDefinition $sig',
 'foreach ($t in $args) {',
 ' $h = [IntPtr]::Zero',
 ' for ($i = 0; $i -lt 40 -and $h -eq [IntPtr]::Zero; $i++) {',
 '  $w = (New-Object -ComObject Shell.Application).Windows() | Where-Object { $_.LocationName -eq $t } | Select-Object -First 1',
 '  if ($w) { $h = [IntPtr]$w.HWND } else { $p = Get-Process | Where-Object { $_.MainWindowTitle -like "$t*" } | Select-Object -First 1; if ($p) { $h = $p.MainWindowHandle } }',
 '  if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 250 }',
 ' }',
 ' if ($h -ne [IntPtr]::Zero) { [P.W]::ShowWindowAsync($h, 9) | Out-Null; Start-Sleep -Milliseconds 300; [P.W]::SetForegroundWindow($h) | Out-Null }',
 '}',
].join('\n');
const fronts={editor:['note.txt'],files:['files'],crossapp:['inbox','list.txt']};
const opens=Object.fromEntries(Object.entries({editor:[desktops.editor('note.txt')],files:[desktops.folder('files')],crossapp:[desktops.folder('inbox'),'sleep 2',desktops.editor('list.txt')]}).map(([task,steps])=>[task,desktops.front?[...steps,desktops.front(fronts[task])]:steps]));

function link(command){
 if(process.env.BENCH_HOST){
  const ws=new WebSocket('ws://'+process.env.BENCH_HOST+':4790/exec?command='+encodeURIComponent(command)+'&key='+encodeURIComponent(process.env.BENCH_KEY??''));ws.binaryType='arraybuffer';
  return {opened:new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;}),send:text=>ws.send(new TextEncoder().encode(text)),end:()=>ws.send('eof'),close:()=>ws.close(),listen:(out,err,closed)=>{ws.onmessage=({data})=>{if(typeof data==='string')return;const bytes=new Uint8Array(data);const s=new TextDecoder().decode(bytes.subarray(1));bytes[0]===1?out(s):err(s);};ws.onclose=closed;}};
 }
 const child=spawn('sh',['-c',command],{stdio:['pipe','pipe','pipe']});
 return {opened:Promise.resolve(),send:text=>child.stdin.write(text),end:()=>child.stdin.end(),close:()=>child.kill(),listen:(out,err,closed)=>{child.stdout.setEncoding('utf8').on('data',out);child.stderr.setEncoding('utf8').on('data',err);child.on('close',closed);}};
}

async function shell(script){
 const l=link(process.env.BENCH_SHELL??'bash -s');await l.opened;let stdout='',stderr='';
 const done=new Promise(r=>l.listen(s=>{stdout+=s;},s=>{stderr+=s;},r));
 l.send(desktops.home+'\nFRONT_PS1='+JSON.stringify(FRONT_PS1).replace(/\$/g,'\\$')+'\n'+script+'\n');l.end();await done;
 return {stdout,stderr};
}

async function mcp(){
 const l=link(process.env.BENCH_MCP);await l.opened;let id=0,buffer='',stderr='';const pending=new Map();
 l.listen(s=>{buffer+=s;for(let n;(n=buffer.indexOf('\n'))>=0;){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);if(!line.trim())continue;let m;try{m=JSON.parse(line);}catch{continue;}const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}},s=>{stderr+=s;},()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('MCP closed '+stderr.slice(-1000)));}pending.clear();});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(new Error('MCP timeout '+stderr.slice(-1000)));},30000);pending.set(n,{resolve,reject,timer});l.send(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n');});
 await call('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'native-benchmark',version:'1.0.0'}});l.send(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 return {call,close:l.close};
}

const IGNORED=new Set(['.DS_Store','desktop.ini','.localized']);
function parse(stdout){
 const entries={};
 for(const line of stdout.split('\n').filter(Boolean)){
  const [kind,path,data]=line.split('\t');const name=path.slice(2).normalize('NFC');
  if(IGNORED.has(name.split('/').pop()))continue;
  entries[name]=kind==='D'?null:Buffer.from(data??'','base64').toString('utf8').normalize('NFC');
 }
 return entries;
}
const text=s=>s?.replace(/\r\n?/g,'\n').replace(/\s+$/,'');
const others=(state,keep)=>Object.keys(state).filter(k=>!keep.some(p=>k===p||k.startsWith(p+'/')));

function judge(task,before,after){
 const same=paths=>paths.every(p=>after[p]===before[p]);
 if(task==='editor'){
  const expected='alpha BETA gamma\n會議改到週四 15:30\nRoom 7B, bring the Q3 deck';
  return {expected,success:text(after['note.txt'])===expected&&same(['files','inbox','list.txt'])&&others(after,['note.txt','files','inbox','list.txt']).length===0};
 }
 if(task==='files'){
  const expected={'files':null,'files/備忘.txt':before['files/備忘.txt'],'files/封存':null,'files/封存/報價單.txt':before['files/報價單.txt'],'files/封存/合約.txt':before['files/合約.txt'],'files/封存/收據-2025.txt':before['files/收據.txt']};
  const got=Object.fromEntries(Object.entries(after).filter(([k])=>k==='files'||k.startsWith('files/')));
  return {expected,success:JSON.stringify(Object.entries(got).sort())===JSON.stringify(Object.entries(expected).sort())&&same(['note.txt','list.txt','inbox'])};
 }
 const expected=['2025 預算','客戶 林安','Q3 deck','舊照片'];
 const lines=(text(after['list.txt'])??'').split('\n').map(l=>l.trim()).filter(Boolean);
 return {expected,success:JSON.stringify([...lines].sort())===JSON.stringify([...expected].sort())&&same(['note.txt','files',...Object.keys(before).filter(k=>k.startsWith('inbox'))])&&others(after,['note.txt','files','inbox','list.txt']).length===0};
}

const selected=process.env.TASKS?.split(',')??Object.keys(tasks);
const client=await mcp();
try{
 for(let rep=1;rep<=repeats;rep++)for(const task of selected){
  const run=`${prefix}-${task}-${rep}`;console.log('START '+run);
  if(desktops.clear){await shell(desktops.clear.shell);await client.call('tools/call',{name:'act',arguments:{steps:desktops.clear.steps}});}
  await shell(desktops.close+'\n'+seed+'\n'+opens[task].join('\n')+'\nsleep 3');
  if(desktops.wake)await client.call('tools/call',{name:'act',arguments:{steps:desktops.wake}});
  if(desktops.settle){await client.call('tools/call',{name:'act',arguments:{steps:desktops.settle}});await shell(opens[task].join('\n'));}
  const before=parse((await shell(snapshot)).stdout);
  const definitions=(await client.call('tools/list')).tools;const tools=definitions.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.inputSchema}}));
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
     const time=Date.now();const result=await client.call('tools/call',{name:call.function.name,arguments:args});
     const said=(result.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')||'Done.';
     messages.push({role:'tool',tool_call_id:call.id,content:(result.isError?'ERROR: ':'')+said});
     const media=[];for(const image of (result.content??[]).filter(c=>c.type==='image')){images.push({type:'image_url',image_url:{url:'data:'+image.mimeType+';base64,'+image.data,detail:'high'}});media.push({mimeType:image.mimeType,bytes:Buffer.byteLength(image.data,'base64'),sha256:createHash('sha256').update(Buffer.from(image.data,'base64')).digest('hex')});}
     trace.push({kind:'tool',name:call.function.name,args,text:said,isError:!!result.isError,images:media,ms:Date.now()-time});
    }
    if(images.length)messages.push({role:'user',content:[{type:'text',text:'Screenshots returned by the preceding tool calls, in call order:'},...images]});
    if(turn===79)limited=true;
   }
  }catch(e){error=String(e);}
  await delay(500);const after=parse((await shell(snapshot)).stdout);const score=judge(task,before,after);const calls=trace.filter(t=>t.kind==='model');
  const usage=calls.reduce((s,c)=>({input:s.input+(c.usage?.prompt_tokens??0),cached:s.cached+(c.usage?.prompt_tokens_details?.cached_tokens??0),output:s.output+(c.usage?.completion_tokens??0),total:s.total+(c.usage?.total_tokens??0)}),{input:0,cached:0,output:0,total:0});
  const result={run,platform,task,rep,model,system,prompt:tasks[task],seconds:(Date.now()-started)/1000,modelCalls:calls.length,toolCalls:trace.filter(t=>t.kind==='tool').length,usage,limited,error,answer,success:score.success&&!error&&!limited,before,after,expected:score.expected,trace};
  await writeFile(new URL(run+'.json',out),JSON.stringify(result,null,2));
  const shot=(await client.call('tools/call',{name:'screenshot',arguments:{}})).content?.find(c=>c.type==='image');if(shot)await writeFile(new URL(run+'.jpg',out),Buffer.from(shot.data,'base64'));
  console.log(JSON.stringify({run,seconds:result.seconds,success:result.success,error,limited,modelCalls:result.modelCalls,toolCalls:result.toolCalls,usage,answer}));
  if(error)throw new Error(error);
 }
 await shell(desktops.close);
}finally{client.close();}
