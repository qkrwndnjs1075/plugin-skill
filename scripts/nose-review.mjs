#!/usr/bin/env node
import { readFileSync, mkdirSync, rmSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJson, projectRoot, hash, register, scan, snapshot, withRegistry } from './review-runtime.mjs';
import { filterReviewed } from './review-policy.mjs';

export function selectChangedFamilies(families, changedPaths, limit = 3) {
  return families.filter(f=>f.locations.some(l=>changedPaths.has(l.file)))
    .sort((a,b)=>priority(a.witness)-priority(b.witness) || (b.value??0)-(a.value??0)).slice(0,limit);
}
function priority(witness) { return ['exact','copy-paste'].includes(witness)?0:1; }
export function buildStopOutput(candidates, active, root) {
  if (active || candidates.length===0) return {};
  return {decision:'block',reason:[
    'Nose found new or changed duplication relative to the prompt-start scan.',
    'Review only. Do not edit or refactor code in this follow-up; explain findings and suggest scoped changes. Ownership is not inferred.',
    ...candidates.map(f=>'- '+f.witness+' id='+f.id+' fingerprint='+f.fingerprint+': '+f.locations.slice(0,4).map(l=>l.file+':'+l.start).join(', ')),
    'Read source locations directly. Report: '+join(root,'.nose-review/report.json'),
    'Intentional decisions require an explicit reason via review-policy.mjs accept. Do not accept automatically.',
  ].join('\n')};
}
function recordPath(directory, session) { return join(directory,hash(session)+'.json'); }
function reviewDirectory(root) {
  const directory=join(root,'.nose-review');
  mkdirSync(directory,{recursive:true});
  if (realpathSync(directory)!==join(realpathSync(root),'.nose-review')) throw new Error('Review directory must not redirect outside the repository');
  return directory;
}
function finish(root, session, operation) {
  return withRegistry(root,directory=>{
    const path=recordPath(directory,session);
    try {
      if (!existsSync(path)) return {systemMessage:'Nose Review deferred: no successful prompt-start baseline.'};
      const record=JSON.parse(readFileSync(path,'utf8'));
      if (record.overlap || existsSync(join(directory,'collision'))) return {systemMessage:'Nose Review deferred: overlapping sessions in this worktree. All overlapping turns are excluded.'};
      return operation(record);
    } finally {
      rmSync(path,{force:true});
      if (!readdirSync(directory).some(file=>file.endsWith('.json'))) rmSync(join(directory,'collision'),{force:true});
    }
  });
}
function main(input) {
  if (!['UserPromptSubmit','Stop'].includes(input.hook_event_name)) return {};
  if (typeof input.session_id!=='string' || !input.session_id) throw new Error('Missing session identity');
  const root=projectRoot(input.cwd);
  const session=input.session_id;
  if (input.hook_event_name==='UserPromptSubmit') {
    const initial=register(root,session);
    if (initial.overlap) return {systemMessage:'Nose Review: overlapping sessions; automatic review deferred for all overlapping turns.'};
    try {
      const result=scan(root);
      withRegistry(root,directory=>{
        const path=recordPath(directory,session);
        const current=JSON.parse(readFileSync(path,'utf8'));
        atomicJson(path,{...current,ready:true,...result});
      });
    } catch(error) { finish(root,session,()=>({})); throw error; }
    return {};
  }
  if (input.stop_hook_active) {
    // The first Stop already released the registry entry.
    return {};
  }
  const before=withRegistry(root,directory=>{
    const path=recordPath(directory,session);
    return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
  });
  if (!before?.ready || before.overlap) return finish(root,session,()=>({}));
  let current;
  try {
    if (JSON.stringify(before.files)===JSON.stringify(snapshot(root))) return finish(root,session,()=>({}));
    current=scan(root);
  } catch(error) { finish(root,session,()=>({})); throw error; }
  return finish(root,session,baseline=>{
    if (baseline.noseVersion!==current.noseVersion) throw new Error('Nose version changed during turn; review deferred');
    if (JSON.stringify(current.files)!==JSON.stringify(snapshot(root))) throw new Error('Code changed after scan; review deferred');
    const old=new Set(baseline.families.map(f=>f.fingerprint));
    const changed=new Set(Object.keys(current.files).filter(file=>baseline.files[file]!==current.files[file]));
    const directory=reviewDirectory(root);
    const policyPath=join(directory,'baseline.json');
    const policy=existsSync(policyPath)?JSON.parse(readFileSync(policyPath,'utf8')):null;
    if (policy && (policy.schemaVersion!==1 || policy.noseVersion!==current.noseVersion)) throw new Error('Review baseline schema or Nose version mismatch; update decisions explicitly');
    const fresh=filterReviewed(current.families.filter(f=>!old.has(f.fingerprint)),policy,current.noseVersion);
    const candidates=selectChangedFamilies(fresh,changed);
    mkdirSync(directory,{recursive:true});
    atomicJson(join(directory,'report.json'),{schemaVersion:1,noseVersion:current.noseVersion,candidates});
    return buildStopOutput(candidates,false,root);
  });
}
function command(args) {
  const [action, path, confirmation]=args;
  const root=projectRoot(path??process.cwd());
  if (action==='reset-state' && confirmation==='--confirm-idle') {
    return withRegistry(root,directory=>{
      for (const file of readdirSync(directory)) {
        if (file.endsWith('.json') || file==='collision') rmSync(join(directory,file));
      }
      return {status:'reset',repoRoot:root};
    });
  }
  if (action==='scan' && args.length===2) {
    const session='manual-'+process.pid;
    const initial=register(root,session);
    try {
      if (initial.overlap) throw new Error('An active session exists; scan after all turns finish');
      const result=scan(root);
      return finish(root,session,()=>{
        const directory=reviewDirectory(root);
        mkdirSync(directory,{recursive:true});
        atomicJson(join(directory,'report.json'),{schemaVersion:1,noseVersion:result.noseVersion,candidates:result.families});
        return {status:'scanned',families:result.families.length,report:join(directory,'report.json')};
      });
    } catch(error) { finish(root,session,()=>({})); throw error; }
  }
  throw new Error('Usage: nose-review.mjs scan <repo> | reset-state <repo> --confirm-idle');
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length>2) {
      process.stdout.write(JSON.stringify(command(process.argv.slice(2)))+'\n');
    } else {
    const input=JSON.parse(readFileSync(0,'utf8'));
    const output=main(input);
    if (input.hook_event_name!=='UserPromptSubmit' || Object.keys(output).length) process.stdout.write(JSON.stringify(output)+'\n');
    }
  } catch(error) {
    process.stdout.write(JSON.stringify({systemMessage:'Nose Review unavailable: '+error.message})+'\n');
    if (process.argv.length>2) process.exitCode=1;
  }
}
