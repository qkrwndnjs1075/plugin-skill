import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inventory, treeHash } from './inventory.mjs';
import { indexLogs, logFiles } from './log-index.mjs';
import { analyze, trash, restore, listTrash } from './eraser.mjs';
import { judge, judgmentModel, judgmentReasoningEffort } from './judge.mjs';

function fixture(t) {
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'eraser-test-'))); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const roots=[path.join(dir,'skills'),path.join(dir,'agents')],stateRoot=path.join(dir,'state'),logsRoot=path.join(dir,'logs');
 for(const p of [...roots,logsRoot])fs.mkdirSync(p);
 for(const name of ['one','two']){fs.mkdirSync(path.join(roots[0],name));fs.writeFileSync(path.join(roots[0],name,'SKILL.md'),`---\nname: ${name}\ndescription: Test\n---\n`);}
 return {dir,roots,stateRoot,logsRoot};
}
const now=new Date('2026-09-14T00:00:00Z'), timestamp='2026-09-13T12:00:00Z';
const record=payload=>JSON.stringify({timestamp,type:'response_item',payload})+'\n';
const user=text=>record({type:'message',role:'user',content:[{text}]});
const call=(p,id='call')=>record({type:'function_call',name:'exec_command',call_id:id,arguments:JSON.stringify({cmd:`cat ${p}/SKILL.md`})});
const validJudgments=evidence=>({judgments:evidence.skills.map(skill=>({id:skill.id,contentHash:skill.contentHash,decision:'observe',reason:'Insufficient version-scoped evidence.',confidence:'low'}))});
async function judgmentFixture(t) { const f=fixture(t),analysis=await analyze({...f,now}),evidence=JSON.parse(fs.readFileSync(analysis.evidenceFile,'utf8'));return {f,analysis,evidence}; }
const successfulRunner=(evidence,inspect=()=>{},afterWrite=()=>{})=>(binary,args,options)=>{inspect(binary,args,options);const output=args[args.indexOf('--output-last-message')+1];fs.writeFileSync(output,JSON.stringify(validJudgments(evidence)));afterWrite();return {status:0,stdout:'',stderr:''};};

test('inventory dedupes aliases and excludes plugin owned and system paths',t=>{
 const f=fixture(t); fs.symlinkSync(path.join(f.roots[0],'one'),path.join(f.roots[1],'alias'));
 const plugin=path.join(f.dir,'plugin');fs.mkdirSync(path.join(plugin,'.codex-plugin'),{recursive:true});fs.writeFileSync(path.join(plugin,'.codex-plugin/plugin.json'),'{}');fs.mkdirSync(path.join(plugin,'owned'));fs.writeFileSync(path.join(plugin,'owned/SKILL.md'),'name: owned');fs.symlinkSync(path.join(plugin,'owned'),path.join(f.roots[0],'owned'));
 fs.mkdirSync(path.join(f.roots[0],'.system'));
 const inv=inventory(f);assert.equal(inv.skills.length,2);assert.equal(inv.skills.find(s=>s.name==='one').aliases.length,2);assert.equal(inv.excluded.length,2);
});
test('log discovery combines live and archived roots without duplicates',t=>{
 const f=fixture(t),archived=path.join(f.dir,'archived');fs.mkdirSync(archived);fs.writeFileSync(path.join(f.logsRoot,'live.jsonl'),'');fs.writeFileSync(path.join(archived,'old.jsonl'),'');
 assert.deepEqual(logFiles([f.logsRoot,archived,f.logsRoot]).map(file=>path.basename(file)).sort(),['live.jsonl','old.jsonl']);
});
test('explicit and automatic uses dedupe; catalog ignored; quality only one primary; no raw content persisted',async t=>{
 const f=fixture(t),skills=inventory(f).skills,file=path.join(f.logsRoot,'session.jsonl'),one=skills.find(s=>s.name==='one');
 fs.writeFileSync(file,user('$one do work secret-user-text')+call(one.realPath)+record({type:'function_call_output',call_id:'call',output:'ok'})+call(one.realPath,'again')+record({type:'function_call_output',call_id:'again',output:'ok'})+user('되돌려')+call(skills.find(s=>s.name==='two').realPath)+record({type:'function_call_output',call_id:'call',output:'ok'})+user('what next?'));
 const index=await indexLogs({files:[file],skills,now});
 assert.equal(index.events.filter(e=>e.kind==='use').length,2);assert.equal(index.events.find(e=>e.kind==='rollback').skillId,one.id);assert.equal(index.events.find(e=>e.kind==='use').evidence,'explicit');assert.ok(!JSON.stringify(index).includes('secret-user-text'));
 assert.ok(index.events.every(e=>e.version==='unknown'));
 const repeat=await indexLogs({files:[file],skills,now,previous:index});assert.equal(repeat.events.length,index.events.length);assert.equal(repeat.coverage.bytesRead,0);
});
test('incomplete line waits; rewritten and truncated file invalidates prior events',async t=>{
 const f=fixture(t),skills=inventory(f).skills,file=path.join(f.logsRoot,'session.jsonl'),line=call(skills[0].realPath);
 fs.writeFileSync(file,user('work')+line.slice(0,-1));
 const a=await indexLogs({files:[file],skills,now});assert.equal(a.events.length,0);
 fs.appendFileSync(file,'\n'+record({type:'function_call_output',call_id:'call',output:'ok'}));const b=await indexLogs({files:[file],skills,now,previous:a});assert.equal(b.events.length,1);
 fs.writeFileSync(file,user('new task'));const c=await indexLogs({files:[file],skills,now,previous:b});assert.equal(c.events.length,0);
});
test('ambiguous primary is unassigned and old events expire',async t=>{
 const f=fixture(t),skills=inventory(f).skills,file=path.join(f.logsRoot,'s.jsonl');fs.writeFileSync(file,user('work')+call(skills[0].realPath)+record({type:'function_call_output',call_id:'call',output:'ok'})+call(skills[1].realPath,'two')+record({type:'function_call_output',call_id:'two',output:'ok'})+user('다시 해줘'));
 const a=await indexLogs({files:[file],skills,now});assert.equal(a.events.find(e=>e.kind==='rework').skillId,null);
 const b=await indexLogs({files:[file],skills,now:new Date('2027-09-14'),previous:a});assert.equal(b.events.length,0);
});
test('CRLF cursors, version provenance and linked explicit errors stay distinct',async t=>{
 const f=fixture(t),skills=inventory(f).skills,file=path.join(f.logsRoot,'s.jsonl'),s=skills[0];
 const content=user('work')+call(s.realPath)+record({type:'function_call_output',call_id:'call',output:{exit_code:1}})+record({type:'function_call_output',call_id:'unrelated',output:'Error: private-output'});
 fs.writeFileSync(file,content.replace(/\n/g,'\r\n'));
 const sources={skills:{[s.id]:{contentHash:s.contentHash,installedAt:'2026-09-01T00:00:00Z'}}};
 const a=await indexLogs({files:[file],skills,now,sources});assert.equal(a.events.filter(e=>e.kind==='error').length,1);assert.ok(a.events.every(e=>e.version===s.contentHash));assert.ok(!JSON.stringify(a).includes('private-output'));
 const b=await indexLogs({files:[file],skills,now,sources,previous:a});assert.equal(b.coverage.bytesRead,0);assert.equal(b.events.length,a.events.length);
});
test('structured command errors and object outputs are recognized without double counting',async t=>{
 const f=fixture(t),skills=inventory(f).skills,file=path.join(f.logsRoot,'s.jsonl'),s=skills[0];
 const structured=JSON.stringify({timestamp,type:'event_msg',payload:{type:'item_completed',item:{type:'CommandExecution',command:`node ${s.realPath}/scripts/check.mjs`,status:'failed',exit_code:2}}})+'\n';
 const objectOutput=record({type:'function_call_output',call_id:'call',output:{exit_code:2,content:[{text:'failed'}]}});
 fs.writeFileSync(file,user('work')+call(s.realPath)+objectOutput+structured);
 const index=await indexLogs({files:[file],skills,now});
 assert.equal(index.events.filter(e=>e.kind==='error').length,1);
 assert.equal(index.events.find(e=>e.kind==='error').skillId,s.id);
});
test('a submitted read counts only after a successful output and quoted Error text is not failure',async t=>{
 const f=fixture(t),skills=inventory(f).skills,file=path.join(f.logsRoot,'s.jsonl'),s=skills[0];
 fs.writeFileSync(file,user('work')+call(s.realPath,'pending')+call(s.realPath,'quoted')+record({type:'function_call_output',call_id:'quoted',output:'Documentation says Error: and Process exited with code 1 and exit_code: 1 are examples'}));
 const index=await indexLogs({files:[file],skills,now});
 assert.equal(index.events.filter(e=>e.kind==='use').length,1);assert.equal(index.events.filter(e=>e.kind==='error').length,0);
});
test('analysis is read-only; approved move and restore verify bytes and aliases',async t=>{
 const f=fixture(t);fs.symlinkSync(path.join(f.roots[0],'one'),path.join(f.roots[1],'alias'));
 const result=await analyze({...f,now});assert.ok(fs.existsSync(result.report));assert.ok(!fs.readFileSync(result.report,'utf8').includes('```'));assert.equal(inventory(f).skills.length,2);
 const s=result.skills.find(s=>s.name==='one');assert.throws(()=>trash({...f,skillId:s.id,expectedHash:'bad'}),/changed/);
 const moved=trash({...f,skillId:s.id,expectedHash:s.contentHash});assert.equal(moved.status,'verified');assert.equal(inventory(f).skills.length,1);assert.equal(treeHash(moved.target),s.contentHash);
 assert.equal(listTrash(f)[0].id,moved.id);
 const restored=restore({...f,transaction:moved.id});assert.equal(restored.status,'restored');assert.equal(inventory(f).skills.length,2);assert.ok(fs.lstatSync(path.join(f.roots[1],'alias')).isSymbolicLink());assert.equal(listTrash(f)[0].status,'restored');
});
test('analysis emits allowlisted evidence for Luna judgment',async t=>{
 const f=fixture(t),result=await analyze({...f,now}),judgeEvidence=fs.readFileSync(result.evidenceFile,'utf8');assert.ok(!judgeEvidence.includes(f.roots[0]));assert.ok(!judgeEvidence.includes(f.logsRoot));assert.ok(!judgeEvidence.includes('aliases'));
});
test('Luna judge pins model and effort, validates identities, and appends the report',async t=>{
 const {f,analysis,evidence}=await judgmentFixture(t);
 const runner=successfulRunner(evidence,(binary,args,options)=>{
  assert.equal(binary,'codex');assert.ok(args.includes('--ephemeral'));assert.ok(args.includes('--ignore-user-config'));assert.ok(args.includes('--ignore-rules'));assert.equal(args[args.indexOf('-m')+1],judgmentModel);assert.ok(args.includes(`model_reasoning_effort="${judgmentReasoningEffort}"`));assert.ok(options.input.includes('"inventoryErrorCount"'));assert.ok(!options.input.includes(f.roots[0]));
 });
 const result=judge({evidenceFile:analysis.evidenceFile,runner});assert.equal(result.model,'gpt-5.6-luna');assert.equal(result.reasoningEffort,'high');
 const report=fs.readFileSync(analysis.report,'utf8');assert.match(report,/Model: gpt-5\.6-luna/);assert.match(report,/Reasoning effort: high/);
});
test('Luna judge fails closed without changing a pending report',async t=>{
 const {analysis,evidence}=await judgmentFixture(t),before=fs.readFileSync(analysis.report,'utf8');
 assert.throws(()=>judge({evidenceFile:analysis.evidenceFile,runner(){return {status:2,stdout:'',stderr:'private failure'};}}),/failed with status 2/);
 assert.equal(fs.readFileSync(analysis.report,'utf8'),before);
 assert.throws(()=>judge({evidenceFile:analysis.evidenceFile,runner(binary,args){const output=args[args.indexOf('--output-last-message')+1];fs.writeFileSync(output,JSON.stringify({judgments:[{id:evidence.skills[0].id,contentHash:'wrong',decision:'retire',reason:'wrong',confidence:'high'}]}));return {status:0,stdout:'',stderr:''};}}),/cover every skill|identity/);
 assert.equal(fs.readFileSync(analysis.report,'utf8'),before);
 assert.throws(()=>judge({evidenceFile:analysis.evidenceFile,runner(){return {status:null,error:{code:'ETIMEDOUT'}};}}),/timed out/);assert.equal(fs.readFileSync(analysis.report,'utf8'),before);
 const unexpected=JSON.parse(fs.readFileSync(analysis.evidenceFile,'utf8'));unexpected.skills[0].rawLogPath='/private/example';fs.writeFileSync(analysis.evidenceFile,JSON.stringify(unexpected));
 let called=false;assert.throws(()=>judge({evidenceFile:analysis.evidenceFile,runner(){called=true;return {status:0};}}),/Invalid skill/);assert.equal(called,false);assert.equal(fs.readFileSync(analysis.report,'utf8'),before);
});
test('Luna judge never overwrites a report changed during inference',async t=>{
 const {analysis,evidence}=await judgmentFixture(t);
 const runner=successfulRunner(evidence,()=>{},()=>fs.appendFileSync(analysis.report,'\nConcurrent note.\n'));
 assert.throws(()=>judge({evidenceFile:analysis.evidenceFile,runner}),/changed during judgment/);const report=fs.readFileSync(analysis.report,'utf8');assert.match(report,/Concurrent note/);assert.ok(!report.includes('skill-eraser-luna-judgment'));
});
test('restore refuses collisions and external symlink targets cannot be moved',t=>{
 const f=fixture(t),s=inventory(f).skills[0],m=trash({...f,skillId:s.id,expectedHash:s.contentHash});fs.mkdirSync(s.realPath);assert.throws(()=>restore({...f,transaction:m.id}),/collision/);
 const external=path.join(f.dir,'external');fs.mkdirSync(external);fs.writeFileSync(path.join(external,'SKILL.md'),'name: external');fs.symlinkSync(external,path.join(f.roots[0],'external'));const e=inventory(f).skills.find(s=>s.name==='external');assert.throws(()=>trash({...f,skillId:e.id,expectedHash:e.contentHash}),/External/);
});
test('relative skill reads resolve against the command working directory',async t=>{
 const f=fixture(t),skills=inventory(f).skills,s=skills[0],file=path.join(f.logsRoot,'relative.jsonl');
 fs.writeFileSync(file,user('$'+s.name)+record({type:'function_call',name:'exec_command',call_id:'relative',arguments:JSON.stringify({cmd:'cat SKILL.md',workdir:s.realPath})})+record({type:'function_call_output',call_id:'relative',output:{exit_code:0}}));
 const index=await indexLogs({files:[file],skills,now});assert.equal(index.events.filter(e=>e.kind==='use').length,1);
});
test('terminal exit envelope is an error but quoted exit text remains ordinary output',async t=>{
 const f=fixture(t),skills=inventory(f).skills,file=path.join(f.logsRoot,'error.jsonl');
 const envelope='Chunk ID: fixture\nWall time: 0.01 seconds\nProcess exited with code 1\nFinal output:\nPermission denied';
 fs.writeFileSync(file,user('work')+call(skills[0].realPath)+record({type:'function_call_output',call_id:'call',output:envelope}));
 const index=await indexLogs({files:[file],skills,now});assert.equal(index.events.filter(e=>e.kind==='error').length,1);assert.equal(index.events.filter(e=>e.kind==='use').length,0);
 fs.writeFileSync(file,user('work')+call(skills[0].realPath)+record({type:'function_call_output',call_id:'call',output:'Chunk ID: ok\nWall time: 0.1 seconds\nProcess exited with code 0\nFinal output:\n'+envelope}));
 const quoted=await indexLogs({files:[file],skills,now});assert.equal(quoted.events.filter(e=>e.kind==='error').length,0);assert.equal(quoted.events.filter(e=>e.kind==='use').length,1);
});
test('relative skill mentions in echo are not executed reads',async t=>{
 const f=fixture(t),skills=inventory(f).skills,file=path.join(f.logsRoot,'mention.jsonl');
 fs.writeFileSync(file,user('work')+record({type:'function_call',name:'exec_command',call_id:'call',arguments:JSON.stringify({cmd:'echo "cat SKILL.md"',workdir:skills[0].realPath})})+record({type:'function_call_output',call_id:'call',output:{exit_code:0}}));
 assert.equal((await indexLogs({files:[file],skills,now})).events.length,0);
});
test('restore resumes after alias creation fails without losing the skill',t=>{
 const f=fixture(t),s=inventory(f).skills[0],alias=path.join(f.roots[1],'alias');fs.symlinkSync(s.realPath,alias);
 const moved=trash({...f,skillId:s.id,expectedHash:s.contentHash});
 const original=fs.symlinkSync;
 try {fs.symlinkSync=()=>{throw new Error('injected alias failure');};assert.throws(()=>restore({...f,transaction:moved.id}),/injected alias/);}finally{fs.symlinkSync=original;}
 assert.equal(treeHash(s.realPath),s.contentHash);
 assert.equal(restore({...f,transaction:moved.id}).status,'restored');
 assert.equal(fs.realpathSync(alias),s.realPath);
});
