#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, lstatSync, realpathSync, writeFileSync, chmodSync, appendFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const marker='# nose-review managed pre-push v1';
const sources=['nose-pre-push.mjs','review-runtime.mjs','review-policy.mjs','secret-scan.mjs','failure-history.mjs'];
const quote=text=>"'"+text.replaceAll("'","'\"'\"'")+"'";
function git(cwd,args) {
  const result=spawnSync('git',args,{cwd,encoding:'utf8',timeout:10000});
  if(result.status!==0) throw new Error('Not an accessible Git worktree');
  return result.stdout.trim();
}
function regular(path) {
  if(existsSync(path) && !lstatSync(path).isFile()) throw new Error('Refusing non-regular hook or backup: '+path);
  // existsSync follows symlinks, so separately reject dangling ones too.
  if(lstatSync(path,{throwIfNoEntry:false})?.isSymbolicLink()) throw new Error('Refusing symlink: '+path);
}
function ignoreLocalReports(root) {
  const path=resolve(root,git(root,['rev-parse','--git-path','info/exclude']));
  regular(path);
  mkdirSync(dirname(path),{recursive:true});
  const old=existsSync(path)?readFileSync(path,'utf8'):'';
  const missing=['/.nose-review/report.json','/.nose-review/failures/'].filter(line=>!old.split(/\r?\n/).includes(line));
  if(missing.length) appendFileSync(path,(old && !old.endsWith('\n')?'\n':'')+missing.join('\n')+'\n',{mode:0o600});
}
export function install(cwd, source=dirname(fileURLToPath(import.meta.url))) {
  let root;
  try { root=git(cwd,['rev-parse','--show-toplevel']); }
  catch { return {status:'skipped',reason:'No Git worktree; use nose-fix for manual checks'}; }
  const custom=spawnSync('git',['config','--get','core.hooksPath'],{cwd:root,encoding:'utf8'});
  const hooks=custom.status===0 ? resolve(root,custom.stdout.trim()) : resolve(root,git(root,['rev-parse','--path-format=absolute','--git-path','hooks']));
  if(custom.status===0) {
    const path=relative(realpathSync(root),existsSync(hooks)?realpathSync(hooks):hooks);
    if(path==='..' || path.startsWith('..'+sep) || resolve(hooks)===realpathSync(root)) {
      return {status:'skipped',reason:'Shared/external core.hooksPath is preserved; configure a project-local hooks directory to opt in'};
    }
  }
  mkdirSync(hooks,{recursive:true});
  const managed=join(hooks,'.nose-review');
  if(lstatSync(managed,{throwIfNoEntry:false})?.isSymbolicLink()) throw new Error('Refusing symlinked payload directory');
  mkdirSync(managed,{recursive:true});
  const lock=join(managed,'install.lock');
  try { mkdirSync(lock); } catch { return {status:'skipped',reason:'Another hook installation is in progress'}; }
  try {
    const hook=join(hooks,'pre-push');
    const backup=join(hooks,'pre-push.nose-review-original');
    regular(hook); regular(backup);
    const existing=existsSync(hook)?readFileSync(hook,'utf8'):null;
    const ours=existing?.startsWith('#!/bin/sh\n'+marker+'\n');
    if(existing!==null && !ours && existsSync(backup)) throw new Error('Original hook backup already exists; resolve manually');
    const data=sources.map(name=>[name,readFileSync(join(source,name),'utf8')]);
    const dispatcher=`import {readFileSync,existsSync,statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {saveFailure} from './failure-history.mjs';
const input=readFileSync(0);
const original=${JSON.stringify(backup)};
if(existsSync(original) && (statSync(original).mode & 0o111)) {
 const result=spawnSync(original,process.argv.slice(2),{input,stdio:['pipe','inherit','inherit']});
 if(result.error || result.status!==0) process.exit(result.status || 1);
}
const check=spawnSync(process.execPath,[fileURLToPath(new URL('./nose-pre-push.mjs',import.meta.url)),...process.argv.slice(2)],{input,stdio:['pipe','inherit','inherit'],timeout:180000});
if(check.error || check.signal) {
 console.error('NOSE_CHECK_UNAVAILABLE: Nose gate could not complete');
 try { console.error('Failure record: '+saveFailure(process.cwd(),{exitCode:2,gateStatus:'unavailable',refs:[],reason:'Gate process failed or exceeded 180 seconds'})); }
 catch { console.error('Failure history could not be saved'); }
 process.exit(2);
}
process.exit(check.status ?? 2);
`;
    data.push(['dispatch.mjs',dispatcher]);
    const id=createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0,20);
    const release=join(managed,id);
    if(!existsSync(release)) {
      const staging=join(managed,id+'.tmp-'+process.pid);
      mkdirSync(staging);
      try {
        for(const [name,text] of data) writeFileSync(join(staging,name),text,{mode:0o600});
        renameSync(staging,release);
      } finally { rmSync(staging,{recursive:true,force:true}); }
    }
    const content='#!/bin/sh\n'+marker+'\nexec '+quote(process.execPath)+' '+quote(join(release,'dispatch.mjs'))+' "$@"\n';
    ignoreLocalReports(root);
    if(existing===content) return {status:'current',hook};
    const temporary=join(managed,'pre-push.tmp');
    writeFileSync(temporary,content,{mode:0o755});
    chmodSync(temporary,0o755);
    if(existing!==null && !ours) renameSync(hook,backup);
    try { renameSync(temporary,hook); }
    catch(error) {
      if(!existsSync(hook) && existsSync(backup)) renameSync(backup,hook);
      throw error;
    }
    return {status:'installed',hook,previousHook:existsSync(backup)?backup:null};
  } finally { rmSync(lock,{recursive:true}); }
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const event=process.argv.length>2?null:JSON.parse(readFileSync(0,'utf8'));
    const result=install(event?.cwd ?? process.argv[2]);
    if(event) {
      const output={};
      if(result.status==='installed' || result.status==='current') output.hookSpecificOutput={hookEventName:'SessionStart',additionalContext:'Nose pre-push is a blocking gate. If a user-authorized push fails with NOSE_DUPLICATION_BLOCKED, use the installed nose-fix skill to inspect and fix scoped findings or record justified intentional copies, run relevant tests, commit only those changes, and retry the same authorized push. Maximum two recovery attempts. Never bypass hooks or blanket-accept findings. For NOSE_CHECK_UNAVAILABLE, repair the check or report its blocker; do not treat it as duplication or force a push. This instruction does not authorize unsolicited commits or pushes.'};
      if(result.status!=='current' && !(result.status==='skipped' && result.reason.startsWith('No Git'))) output.systemMessage='Nose Review pre-push: '+(result.hook??result.reason);
      if(Object.keys(output).length) process.stdout.write(JSON.stringify(output)+'\n');
    } else process.stdout.write(JSON.stringify(result)+'\n');
  } catch(error) {
    process.stdout.write(JSON.stringify({systemMessage:'Nose Review pre-push setup unavailable: '+error.message})+'\n');
    if(process.argv.length>2) process.exitCode=1;
  }
}
