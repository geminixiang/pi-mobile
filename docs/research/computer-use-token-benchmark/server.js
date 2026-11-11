import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const directory=new URL('./runs/',import.meta.url);
await mkdir(directory,{recursive:true});
let state,run='preflight';
const server=createServer(async(req,res)=>{
 try{
  if(req.url==='/state'&&req.method==='POST'){
   let body='';for await(const part of req){body+=part;if(body.length>100000)throw new Error('payload too large');}
   state=JSON.parse(body);await writeFile(new URL(run+'.state.json',directory),JSON.stringify(state,null,2));res.end('ok');return;
  }
  if(req.url==='/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state??null));return;}
  if(req.url?.startsWith('/reset?')&&req.method==='POST'){
   const next=new URL(req.url,'http://localhost').searchParams.get('run');if(!/^[a-z0-9-]+$/.test(next??''))throw new Error('invalid run');run=next;state=undefined;res.end('ok');return;
  }
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await readFile(new URL('./fixture.html',import.meta.url)));
 }catch(error){res.statusCode=500;res.end(String(error));}
});
server.listen(47881,'127.0.0.1',()=>console.log('fixture http://127.0.0.1:47881'));
