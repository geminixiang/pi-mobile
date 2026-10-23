import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const source=await readFile(root+'direct.mjs','utf8');
const cdp=Function(source.slice(source.indexOf('async function cdp()'),source.indexOf('async function mcp('))+'return cdp;')();
const mcp=Function(source.slice(source.indexOf('async function mcp('),source.indexOf('const commands='))+'return mcp;')();
const browser=await cdp(),client=await mcp((process.env.BINARY??'/tmp/pi-computer-token-bench/pi-mobile')+' mcp computer');
const results=[];
try{
 for(let trial=0;trial<Number(process.env.COUNT??10);trial++){
 await browser.call('Page.navigate',{url:'http://127.0.0.1:47881/'});await new Promise(r=>setTimeout(r,400));await browser.call('Page.bringToFront');
 const boxes=await browser.evaluate(`(()=>{selected='B1049';render();document.querySelector('form').autocomplete='off';window.events=[];for(const kind of ['pointerdown','focusin','keydown','input','change'])document.addEventListener(kind,e=>events.push({kind,t:performance.now(),name:e.target.name,tag:e.target.tagName,key:e.key,value:e.target.value}),true);const point=e=>{const r=e.getBoundingClientRect();return {x:(screenX+r.x+r.width/2)*1280/window.screen.width,y:(screenY+outerHeight-innerHeight+r.y+r.height/2)*1280/window.screen.width};};return {select:point(document.querySelector('select')),note:point(document.querySelector('textarea')),verified:point(document.querySelector('[name=verified]'))};})()`);
 await client.call('tools/call',{name:'screenshot',arguments:{}});
 await client.call('tools/call',{name:'act',arguments:{steps:[{action:'click',...boxes.select}]}});
 const steps=[{action:'key',keys:'down'},{action:'key',keys:'return'},...(process.env.MENU_WAIT?[{action:'wait',ms:Number(process.env.MENU_WAIT)}]:[]),{action:'click',...boxes.note},{action:'type',text:'請於下午送達，先電話聯絡'},{action:'click',...boxes.verified}];
 const result=await client.call('tools/call',{name:'act',arguments:{steps}});
 const observed=await browser.evaluate(`({note:document.querySelector('textarea').value,checked:document.querySelector('[name=verified]').checked,active:document.activeElement.name,events})`);
 const data={steps,isError:result.isError,content:(result.content??[]).filter(c=>c.type==='text'),images:(result.content??[]).filter(c=>c.type==='image').length,observed};
 results.push(data);
 console.log(JSON.stringify({trial,note:observed.note,checked:observed.checked}));
 }
 await writeFile(new URL('./native-'+(process.env.LABEL??'baseline')+'.json',import.meta.url),JSON.stringify(results,null,2));
 assert(results.every(r=>r.observed.note==='請於下午送達，先電話聯絡'&&r.observed.checked),'a batch silently lost text or its following click');
}finally{client.close();browser.close();}
