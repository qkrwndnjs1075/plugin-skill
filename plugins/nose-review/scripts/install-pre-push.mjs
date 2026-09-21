#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, lstatSync, realpathSync, writeFileSync, chmodSync, appendFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const marker='# nose-review managed pre-push v1';
const sources=['nose-pre-push.mjs','review-runtime.mjs','review-policy.mjs','secret-scan.mjs','commit-secrets.mjs','failure-history.mjs'];
const quote=text=>"'"+text.replaceAll("'","'\"'\"'")+"'";
function hookContent(release,data) {
  const hashes=data.map(([name,text])=>[name,createHash('sha256').update(text).digest('hex')]);
  const bootstrap=`const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path'),url=require('node:url');
const root=${JSON.stringify(release)},expected=${JSON.stringify(hashes)};
(async()=>{try{
 for(const [name,digest] of expected){const file=path.join(root,name);if(!fs.lstatSync(file).isFile()||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==digest)throw new Error('Invalid payload');}
 process.argv.splice(1,0,path.join(root,'dispatch.mjs'));
 await import(url.pathToFileURL(path.join(root,'dispatch.mjs')).href);
}catch{
 console.error('NOSE_CHECK_UNAVAILABLE: Nose hook payload is damaged; rerun install-pre-push.mjs');
 try{const file=path.join(root,'failure-history.mjs'),digest=expected.find(([name])=>name==='failure-history.mjs')[1];if(!fs.lstatSync(file).isFile()||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==digest)throw new Error('Invalid history writer');const {saveFailure}=await import(url.pathToFileURL(file).href);console.error('Failure record: '+saveFailure(process.cwd(),{exitCode:2,gateStatus:'unavailable',refs:[],reason:'Hook payload integrity check failed'}));}catch{console.error('Failure history could not be saved');}
 process.exitCode=2;
}})();`;
  return '#!/bin/sh\n'+marker+'\nexec '+quote(process.execPath)+' -e '+quote(bootstrap)+' -- "$@"\n';
}
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
function payloadMatches(directory,data) {
  try {
    if(!lstatSync(directory,{throwIfNoEntry:false})?.isDirectory()) return false;
    return data.every(([name,text])=>{
      const path=join(directory,name),stat=lstatSync(path,{throwIfNoEntry:false});
      return stat?.isFile() && !stat.isSymbolicLink() && readFileSync(path,'utf8')===text;
    });
  } catch { return false; }
}
function ignoreLocalReports(root) {
  const path=resolve(root,git(root,['rev-parse','--git-path','info/exclude']));
  regular(path);
  mkdirSync(dirname(path),{recursive:true});
  const old=existsSync(path)?readFileSync(path,'utf8'):'';
  const missing=['/.nose-review/'].filter(line=>!old.split(/\r?\n/).includes(line));
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
const input=readFileSync(0);
const original=${JSON.stringify(backup)};
if(existsSync(original) && (statSync(original).mode & 0o111)) {
 const result=spawnSync(original,process.argv.slice(2),{input,stdio:['pipe','inherit','inherit']});
 if(result.error || result.status!==0) process.exit(result.status || 1);
}
const check=spawnSync(process.execPath,[fileURLToPath(new URL('./nose-pre-push.mjs',import.meta.url)),...process.argv.slice(2)],{input,stdio:['pipe','inherit','pipe'],encoding:'utf8',timeout:420000,maxBuffer:64*1024*1024});
if(check.stderr) process.stderr.write(check.stderr);
const expected=check.status===0
 || (check.status===1 && /NOSE_(?:DUPLICATION|SECRETS)_BLOCKED/.test(check.stderr??''))
 || (check.status===2 && /NOSE_CHECK_UNAVAILABLE/.test(check.stderr??''));
if(check.error || check.signal || !expected) {
 console.error('NOSE_CHECK_UNAVAILABLE: Nose gate could not complete');
 try { const {saveFailure}=await import('./failure-history.mjs'); console.error('Failure record: '+saveFailure(process.cwd(),{exitCode:2,gateStatus:'unavailable',refs:[],reason:'Gate process failed, returned an unexpected status, or exceeded 420 seconds'})); }
 catch { console.error('Failure history could not be saved'); }
 process.exit(2);
}
process.exit(check.status);
`;
    data.push(['dispatch.mjs',dispatcher]);
    ignoreLocalReports(root);
    if(ours) {
      const active=readdirSync(managed).map(name=>join(managed,name))
        .find(release=>existing===hookContent(release,data) && payloadMatches(release,data));
      if(active) {
        if(!(lstatSync(hook).mode & 0o100)){chmodSync(hook,0o755);return {status:'installed',hook};}
        return {status:'current',hook};
      }
    }
    const id=createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0,20);
    let release=join(managed,id);
    if(lstatSync(release,{throwIfNoEntry:false}) && !payloadMatches(release,data)) {
      do { release=join(managed,id+'-'+randomUUID()); }
      while(lstatSync(release,{throwIfNoEntry:false}));
    }
    if(!payloadMatches(release,data)) {
      const staging=join(managed,id+'.tmp-'+randomUUID());
      mkdirSync(staging);
      try {
        for(const [name,text] of data) writeFileSync(join(staging,name),text,{mode:0o600});
        renameSync(staging,release);
      } finally { rmSync(staging,{recursive:true,force:true}); }
    }
    const content=hookContent(release,data);
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
      if(result.status==='installed' || result.status==='current') output.hookSpecificOutput={hookEventName:'SessionStart',additionalContext:'Nose pre-push is a blocking gate. If a user-authorized push fails with NOSE_DUPLICATION_BLOCKED, use the installed nose-fix skill to inspect and fix scoped findings or record justified intentional copies, run relevant tests, commit scoped source fixes, keep source-bound review decisions in the locally excluded .nose-review baseline, and retry the same authorized push. Maximum two recovery attempts. Never bypass hooks or blanket-accept findings. For NOSE_CHECK_UNAVAILABLE, repair the check or report its blocker; do not treat it as duplication or force a push. This instruction does not authorize unsolicited commits or pushes.'};
      if(result.status!=='current' && !(result.status==='skipped' && result.reason.startsWith('No Git'))) output.systemMessage='Nose Review pre-push: '+(result.hook??result.reason);
      if(Object.keys(output).length) process.stdout.write(JSON.stringify(output)+'\n');
    } else process.stdout.write(JSON.stringify(result)+'\n');
  } catch(error) {
    process.stdout.write(JSON.stringify({systemMessage:'Nose Review pre-push setup unavailable: '+error.message})+'\n');
    if(process.argv.length>2) process.exitCode=1;
  }
}
