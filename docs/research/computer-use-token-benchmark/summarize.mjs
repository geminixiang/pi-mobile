import {readdir,readFile,writeFile} from 'node:fs/promises';
const root=new URL('./runs/',import.meta.url);
const files=(await readdir(root)).filter(name=>/^(direct-pilot|confirm)-/.test(name)&&name.endsWith('.json')&&!name.endsWith('.state.json'));
const rows=await Promise.all(files.map(async name=>JSON.parse(await readFile(new URL(name,root),'utf8'))));
const median=xs=>{const a=[...xs].sort((x,y)=>x-y);return a.length?(a[Math.floor((a.length-1)/2)]+a[Math.ceil((a.length-1)/2)])/2:null;};
const aggregate=items=>{
 const sum=f=>items.reduce((n,r)=>n+f(r),0);
 return {attempts:items.length,successes:items.filter(r=>r.success).length,input:sum(r=>r.usage.input),cached:sum(r=>r.usage.cached),uncached:sum(r=>r.usage.input-r.usage.cached),output:sum(r=>r.usage.output),total:sum(r=>r.usage.total),modelCalls:sum(r=>r.modelCalls),toolCalls:sum(r=>r.toolCalls),screenshots:sum(r=>r.trace.filter(t=>t.kind==='tool').reduce((n,t)=>n+t.images.length,0)),steps:sum(r=>r.trace.filter(t=>t.kind==='tool').reduce((n,t)=>n+(t.name==='screenshot'||t.args.action==='get_screenshot'||t.args.action==='get_cursor_position'?0:t.args.steps?.length??1),0)),medianInput:median(items.map(r=>r.usage.input)),inputRange:items.length?[Math.min(...items.map(r=>r.usage.input)),Math.max(...items.map(r=>r.usage.input))]:null,medianSeconds:median(items.map(r=>r.seconds))};
};
const byArm=items=>Object.fromEntries(['own','upstream'].map(arm=>[arm,aggregate(items.filter(r=>r.arm===arm))]));
const pairs=new Map();for(const r of rows){const key=r.run.replace(/-(own|upstream)$/,'');const pair=pairs.get(key)??{};pair[r.arm]=r;pairs.set(key,pair);}
const successfulPairs=[...pairs.values()].filter(p=>p.own?.success&&p.upstream?.success);
const totals=byArm(rows),matched=byArm(successfulPairs.flatMap(p=>[p.own,p.upstream]));
const savings=(a,b)=>b?100*(1-a/b):null;
const summary={complete:rows.length===30,expectedAttempts:30,actualAttempts:rows.length,totals,inputReductionPercent:savings(totals.own.input,totals.upstream.input),totalReductionPercent:savings(totals.own.total,totals.upstream.total),byTask:Object.fromEntries(['orders','expense','projects'].map(t=>[t,byArm(rows.filter(r=>r.task===t))])),bothSuccessful:{pairs:successfulPairs.length,totals:matched,inputReductionPercent:savings(matched.own.input,matched.upstream.input)},failures:rows.filter(r=>!r.success).map(r=>({run:r.run,limited:r.limited,error:r.error,answer:r.answer})),attempts:rows.map(r=>({run:r.run,success:r.success,seconds:r.seconds,input:r.usage.input,cached:r.usage.cached,output:r.usage.output,total:r.usage.total,modelCalls:r.modelCalls,toolCalls:r.toolCalls}))};
await writeFile(new URL('./task-results.json',import.meta.url),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
if(!summary.complete&&!process.argv.includes('--partial'))process.exitCode=1;
