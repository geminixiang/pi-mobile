import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
const root=new URL('./runs/',import.meta.url);
const names=(await readdir(root)).filter(n=>/^fixed-/.test(n)&&n.endsWith('.json')&&!n.endsWith('.state.json'));
assert.equal(names.length,7,'expected seven post-fix attempts');
const counts=new Map();
for(const name of names){
 const r=JSON.parse(await readFile(new URL(name,root),'utf8'));
 const key=r.task+'/'+r.arm;counts.set(key,(counts.get(key)??0)+1);
 const models=r.trace.filter(t=>t.kind==='model');const tools=r.trace.filter(t=>t.kind==='tool');
 assert.equal(models.length,r.modelCalls);assert.equal(tools.length,r.toolCalls);
 assert.equal(r.usage.total,r.usage.input+r.usage.output);
 assert.equal(r.success,JSON.stringify(r.expected)===JSON.stringify(r.after)&&!r.error&&!r.limited);
 assert(r.success);
 assert(tools.some(t=>t.images.length>0),'model must receive screenshots');
 for(const m of models){
  assert.equal(m.model,'gpt-6.1-sol');
  assert(m.usage.prompt_tokens>0);
  assert.equal(m.usage.total_tokens,m.usage.prompt_tokens+m.usage.completion_tokens);
  assert((m.usage.prompt_tokens_details?.cached_tokens??0)<=m.usage.prompt_tokens);
  assert((m.message.tool_calls??[]).every(c=>['screenshot','act','computer'].includes(c.function.name)));
 }
}
assert.equal(counts.size,3);
assert.equal(counts.get('orders/own'),5);
assert.equal(counts.get('expense/own'),1);
assert.equal(counts.get('projects/own'),1);
for(const [label,expected] of [['before',''],['after','請於下午送達，先電話聯絡']]){
 const runs=JSON.parse(await readFile(new URL('./native-'+label+'.json',import.meta.url)));
 assert.equal(runs.length,10);
 for(const r of runs){assert.equal(r.observed.note,expected);assert.equal(r.observed.checked,label==='after');}
}
const error=JSON.parse(await readFile(new URL('./failure-screen.json',import.meta.url)));
assert(error.isError&&error.content.some(c=>c.type==='image'));
console.log('Verified: seven model attempts, ten before/after native probes, usage, images and full-state verdicts.');
