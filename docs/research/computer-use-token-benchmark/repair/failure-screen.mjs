import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const source=await readFile(new URL('../direct.mjs',import.meta.url),'utf8');
const connect=Function(source.slice(source.indexOf('async function mcp('),source.indexOf('const commands='))+'return mcp;')();
const client=await connect((process.env.BINARY??'/tmp/pi-computer-token-bench/pi-mobile-fixed')+' mcp computer');
try{
 const result=await client.call('tools/call',{name:'act',arguments:{steps:[{action:'key',keys:'not-a-key'},{action:'type',text:'must not run'}]}});
 assert(result.isError);
 assert(result.content.some(c=>c.type==='image'));
 assert(result.content.some(c=>c.type==='text'&&c.text.includes('step 1 (key)')&&c.text.includes('later steps were not run')));
 const proof={...result,content:result.content.map(c=>c.type==='image'?{type:c.type,mimeType:c.mimeType,bytes:Buffer.byteLength(c.data,'base64')}:c)};
 await writeFile(new URL('./failure-screen.json',import.meta.url),JSON.stringify(proof,null,2));
 console.log('PASS: MCP error includes failed step, partial-execution warning, screenshot and screen context.');
}finally{client.close();}
