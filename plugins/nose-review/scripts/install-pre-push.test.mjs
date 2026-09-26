import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { install } from './install-pre-push.mjs';
import { refTimeoutMs, scanTimeoutMs } from './review-runtime.mjs';

function fixture(t) {
  const temp=mkdtempSync(join(tmpdir(),"nose-install ' "));
  t.after(()=>rmSync(temp,{recursive:true,force:true}));
  const repo=join(temp,'repo'),source=join(temp,'payload');
  mkdirSync(repo);mkdirSync(source);
  execFileSync('git',['init','-q'],{cwd:repo});
  for(const name of ['review-runtime.mjs','review-policy.mjs','scan-result-cache.mjs','secret-scan.mjs','commit-secrets.mjs','failure-history.mjs']) writeFileSync(join(source,name),'');
  writeFileSync(join(source,'failure-history.mjs'),'export function saveFailure() { return "fixture-history"; }');
  writeFileSync(join(source,'nose-pre-push.mjs'),"import {readFileSync,writeFileSync} from 'node:fs';writeFileSync(process.env.NOSE_TEST_OUTPUT,JSON.stringify({args:process.argv.slice(2),input:readFileSync(0,'utf8')}));");
  return {temp,repo,source,hooks:join(repo,'.git/hooks')};
}
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
function committedFixture(t) {
  const f=fixture(t);
  git(f.repo,'config','user.name','Fixture');
  git(f.repo,'config','user.email','fixture@example.invalid');
  git(f.repo,'commit','--allow-empty','-qm','seed');
  return f;
}
test('one installation blocks pushes from existing and future worktrees with a relative hooksPath',t=>{
  const f=committedFixture(t),remote=join(f.temp,'remote.git');
  git(f.repo,'config','core.hooksPath','git-hooks');
  git(f.temp,'init','--bare','-q',remote);
  git(f.repo,'remote','add','origin',remote);
  const existing=join(f.temp,'existing');
  git(f.repo,'worktree','add','-qb','existing',existing);
  const passing=readFileSync(join(f.source,'nose-pre-push.mjs'),'utf8');
  writeFileSync(join(f.source,'nose-pre-push.mjs'),'process.stderr.write("NOSE_DUPLICATION_BLOCKED: fixture\\n");process.exitCode=1;\n');
  const installed=install(f.repo,f.source);
  const future=join(f.temp,'future');
  git(f.repo,'worktree','add','-qb','future',future);
  for(const worktree of [existing,future]) {
    const pushed=spawnSync('git',['push','origin','HEAD:refs/heads/proof'],{cwd:worktree,encoding:'utf8'});
    assert.notEqual(pushed.status,0,'A worktree push must reach the blocking gate');
    assert.match(pushed.stderr,/NOSE_DUPLICATION_BLOCKED: fixture/);
    assert.equal(git(worktree,'config','--get','core.hooksPath'),'git-hooks');
  }
  assert.equal(spawnSync('git',['--git-dir',remote,'show-ref','--verify','--quiet','refs/heads/proof']).status,1);
  writeFileSync(join(f.source,'nose-pre-push.mjs'),passing);
  assert.equal(install(future,f.source).hook,installed.hook);
  assert.equal(git(future,'config','--local','--get-all','hook.nose-review.event'),'pre-push');
  const hooks=join(future,'git-hooks'),output=join(f.temp,'nose-input'),original=join(f.temp,'original-input');
  mkdirSync(hooks);
  writeFileSync(join(hooks,'pre-push'),'#!/bin/sh\ncat > "$NOSE_OLD_INPUT"\n',{mode:0o755});
  const pushed=spawnSync('git',['push','origin','HEAD:refs/heads/proof'],{
    cwd:future,encoding:'utf8',env:{...process.env,NOSE_TEST_OUTPUT:output,NOSE_OLD_INPUT:original},
  });
  assert.equal(pushed.status,0,pushed.stderr);
  const received=JSON.parse(readFileSync(output,'utf8'));
  assert.equal(received.input,readFileSync(original,'utf8'));
  assert.match(received.input,/refs\/heads\/proof/);
  assert.deepEqual(received.args,['origin',remote]);
});
test('registration retires only owned legacy wrappers and preserves each worktree original',t=>{
  const f=committedFixture(t),linked=join(f.temp,'linked');
  git(f.repo,'config','core.hooksPath','git-hooks');
  git(f.repo,'worktree','add','-qb','linked',linked);
  const legacy='#!/bin/sh\n# nose-review managed pre-push v1\nexit 91\n';
  const original='#!/bin/sh\nexit 0\n';
  writeFileSync(join(f.hooks,'pre-push'),legacy,{mode:0o755});
  for(const worktree of [f.repo,linked]) {
    const hooks=join(worktree,'git-hooks');mkdirSync(hooks);
    writeFileSync(join(hooks,'pre-push'),legacy,{mode:0o755});
    writeFileSync(join(hooks,'pre-push.nose-review-original'),original,{mode:0o755});
    writeFileSync(join(hooks,'pre-commit'),'#!/bin/sh\nexit 37\n',{mode:0o755});
  }
  install(linked,f.source);
  assert.equal(existsSync(join(f.hooks,'pre-push')),false);
  for(const worktree of [f.repo,linked]) {
    assert.equal(readFileSync(join(worktree,'git-hooks/pre-push'),'utf8'),original);
    assert.equal(existsSync(join(worktree,'git-hooks/pre-push.nose-review-original')),false);
    assert.notEqual(spawnSync('git',['commit','--allow-empty','-qm','blocked'],{cwd:worktree}).status,0);
  }
});
for(const key of ['hook.nose-review.enabled','hook.pre-push.enabled']) test(`installation reports a disabled gate: ${key}`,t=>{
  const f=fixture(t);
  execFileSync('git',['config',key,'false'],{cwd:f.repo});
  assert.throws(()=>install(f.repo,f.source),/disables the Nose gate/);
  assert.equal(execFileSync('git',['config','--get',key],{cwd:f.repo,encoding:'utf8'}).trim(),'false');
});
test('installation detects a disabled gate in another worktree without overwriting its choice',t=>{
  const f=committedFixture(t),linked=join(f.temp,'linked');
  git(f.repo,'config','extensions.worktreeConfig','true');
  git(f.repo,'worktree','add','-qb','linked',linked);
  git(linked,'config','--worktree','hook.nose-review.enabled','false');
  assert.throws(()=>install(f.repo,f.source),/disables the Nose gate/);
  assert.equal(git(linked,'config','--worktree','--get','hook.nose-review.enabled'),'false');
});
test('installation preserves an unrelated command occupying its registration name',t=>{
  const f=fixture(t);
  execFileSync('git',['config','hook.nose-review.command','unrelated-command'],{cwd:f.repo});
  assert.throws(()=>install(f.repo,f.source),/belongs to another installation/);
  assert.equal(execFileSync('git',['config','--get','hook.nose-review.command'],{cwd:f.repo,encoding:'utf8'}).trim(),'unrelated-command');
});
test('a stale worktree record does not block registration or remove its remaining directory',t=>{
  const f=committedFixture(t),stale=join(f.temp,'stale');
  git(f.repo,'worktree','add','-qb','stale',stale);
  rmSync(join(stale,'.git'));
  assert.equal(install(f.repo,f.source).status,'installed');
  assert.ok(existsSync(stale));
  assert.match(git(f.repo,'worktree','list','--porcelain'),/prunable/);
});
test('native registration preserves existing hook args/stdin and survives removal of plugin source',t=>{
  const f=fixture(t);
  const old='#!/bin/sh\ncat > "$NOSE_OLD_INPUT"\nprintf "%s\\n" "$@" > "$NOSE_OLD_ARGS"\n';
  writeFileSync(join(f.hooks,'pre-push'),old,{mode:0o755});
  const first=install(f.repo,f.source);
  assert.equal(first.status,'installed');
  const managed=join(dirname(first.hook),'.nose-review');
  const release=readdirSync(managed).find(name=>!name.endsWith('.tmp') && name!=='install.lock');
  const dispatcher=readFileSync(join(managed,release,'dispatch.mjs'),'utf8');
  assert.ok(refTimeoutMs > 2 * scanTimeoutMs);
  assert.ok(dispatcher.includes(`const timeoutMs=refCount*${refTimeoutMs};`));
  assert.match(dispatcher,/timeout:timeoutMs/);
  assert.match(dispatcher,/exceeded '\+timeoutMs\/1000/);
  const before=statSync(first.hook);
  assert.equal(install(f.repo,f.source).status,'current');
  assert.equal(statSync(first.hook).mtimeMs,before.mtimeMs);
  assert.equal(statSync(first.hook).ino,before.ino);
  assert.equal(readFileSync(join(f.hooks,'pre-push'),'utf8'),old);
  rmSync(f.source,{recursive:true});
  const output=join(f.temp,'out'),oldInput=join(f.temp,'stdin'),oldArgs=join(f.temp,'args');
  const input='refs/heads/main abc refs/heads/main def\n';
  const inputPath=join(f.temp,'input');writeFileSync(inputPath,input);
  const result=spawnSync('git',['hook','run',`--to-stdin=${inputPath}`,'pre-push','--','origin','/tmp/remote space'],{cwd:f.repo,encoding:'utf8',env:{...process.env,NOSE_TEST_OUTPUT:output,NOSE_OLD_INPUT:oldInput,NOSE_OLD_ARGS:oldArgs}});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output,'utf8')),{args:['origin','/tmp/remote space'],input});
  assert.equal(readFileSync(oldInput,'utf8'),input);
  assert.equal(readFileSync(oldArgs,'utf8'),'origin\n/tmp/remote space\n');
});
test('existing pre-push still rejects after the native Nose hook succeeds',t=>{
  const f=fixture(t),output=join(f.temp,'out');
  writeFileSync(join(f.hooks,'pre-push'),'#!/bin/sh\necho "original rejected" >&2\nexit 23\n',{mode:0o755});
  install(f.repo,f.source);
  const inputPath=join(f.temp,'input');writeFileSync(inputPath,'');
  const push=spawnSync('git',['hook','run',`--to-stdin=${inputPath}`,'pre-push'],{cwd:f.repo,encoding:'utf8',env:{...process.env,NOSE_TEST_OUTPUT:output}});
  assert.notEqual(push.status,0);
  assert.match(push.stderr,/original rejected/);
  assert.equal(existsSync(output),true);
});
test('reinstallation restores executable mode on an otherwise current hook',t=>{
  const f=fixture(t),first=install(f.repo,f.source);
  chmodSync(first.hook,0o644);
  install(f.repo,f.source);
  assert.ok(statSync(first.hook).mode & 0o100);
});
for(const damage of ['', 'invalid JavaScript {']) test(`bootstrap rejects damaged dispatcher ${JSON.stringify(damage)}`,t=>{
  const f=fixture(t),first=install(f.repo,f.source);
  const managed=join(dirname(first.hook),'.nose-review');
  const release=readdirSync(managed).find(name=>existsSync(join(managed,name,'dispatch.mjs')));
  writeFileSync(join(managed,release,'dispatch.mjs'),damage);
  const run=spawnSync(first.hook,[],{cwd:f.repo,input:'',encoding:'utf8'});
  assert.equal(run.status,2,run.stderr);
  assert.match(run.stderr,/NOSE_CHECK_UNAVAILABLE/);
  assert.match(run.stderr,/Failure record:/);
});
test('Nose gate failures propagate through the installed dispatcher',t=>{
  const f=fixture(t);
  writeFileSync(join(f.source,'nose-pre-push.mjs'),'process.stderr.write("NOSE_DUPLICATION_BLOCKED: fixture\\n");process.exit(1);\n');
  const result=install(f.repo,f.source);
  assert.equal(spawnSync(result.hook,[],{cwd:f.repo,input:''}).status,1);
});
test('installed dispatcher streams diagnostics before exit and recognizes a split status marker',async t=>{
  const f=fixture(t);
  writeFileSync(join(f.source,'nose-pre-push.mjs'),`
import {once} from 'node:events';
import {createConnection} from 'node:net';
const socket=createConnection({host:'127.0.0.1',port:Number(process.env.NOSE_TEST_ACK_PORT)});
await once(socket,'data');
async function diagnostic(text) {
  const ack=once(socket,'data');
  process.stderr.write(text);
  await ack;
}
await diagnostic('stage: scanning\\nNOSE_DUPLICATION_');
await diagnostic('BLOCKED: fixture\\n');
socket.end();
process.exitCode=1;
`);
  const installed=install(f.repo,f.source);
  const server=createServer();
  let socket;
  t.after(()=>{socket?.destroy();server.close();});
  const listening=once(server,'listening');
  server.listen(0,'127.0.0.1');
  await listening;
  const child=spawn(installed.hook,[],{cwd:f.repo,detached:true,env:{...process.env,NOSE_TEST_ACK_PORT:String(server.address().port)},stdio:['pipe','ignore','pipe']});
  const stop=()=>{try { process.kill(-child.pid,'SIGKILL'); } catch(error) { if(error.code!=='ESRCH') throw error; }};
  t.after(stop);
  let stderr='',acknowledgements=0;
  const result=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{stop();reject(new Error('Dispatcher did not stream diagnostics before child exit: '+stderr));},5000);
    server.once('connection',connection=>{
      socket=connection;
      socket.on('error',reject);
      socket.write('R');
    });
    child.on('error',error=>{clearTimeout(timeout);reject(error);});
    child.on('close',(status,signal)=>{clearTimeout(timeout);resolve({status,signal});});
    child.stderr.on('data',chunk=>{
      stderr+=chunk;
      if((acknowledgements===0 && stderr.includes('stage: scanning\nNOSE_DUPLICATION_')) || (acknowledgements===1 && stderr.includes('BLOCKED: fixture\n'))) {
        acknowledgements++;
        socket.write('A');
      }
    });
    child.stdin.end();
  });
  assert.equal(result.status,1,stderr);
  assert.equal(result.signal,null);
  assert.equal(stderr,'stage: scanning\nNOSE_DUPLICATION_BLOCKED: fixture\n');
  assert.equal(acknowledgements,2);
});
for(const [status,diagnostic,expected,recorded] of [
  [1,'NOSE_SECRETS_BLOCKED: fixture',1,false],
  [2,'NOSE_CHECK_UNAVAILABLE: fixture',2,false],
  [1,'unclassified failure',2,true],
  [2,'unclassified failure',2,true],
  [3,'NOSE_DUPLICATION_BLOCKED: fixture',2,true],
]) test(`installed dispatcher classifies status ${status} with ${diagnostic}`,t=>{
  const f=fixture(t);
  writeFileSync(join(f.source,'nose-pre-push.mjs'),`process.stderr.write(${JSON.stringify(diagnostic+'\n')});process.exitCode=${status};`);
  const installed=install(f.repo,f.source);
  const result=spawnSync(installed.hook,[],{cwd:f.repo,input:'',encoding:'utf8',timeout:5000});
  assert.equal(result.status,expected,result.stderr);
  assert.ok(result.stderr.startsWith(diagnostic+'\n'));
  assert.equal(result.stderr.includes('Failure record: fixture-history'),recorded);
});
test('installed dispatcher records a signaled child as unavailable',t=>{
  const f=fixture(t);
  writeFileSync(join(f.source,'nose-pre-push.mjs'),"process.kill(process.pid,'SIGTERM');");
  const installed=install(f.repo,f.source);
  const result=spawnSync(installed.hook,[],{cwd:f.repo,input:'',encoding:'utf8',timeout:5000});
  assert.equal(result.status,2,result.stderr);
  assert.match(result.stderr,/NOSE_CHECK_UNAVAILABLE: Nose gate could not complete/);
  assert.match(result.stderr,/Failure record: fixture-history/);
});
test('corrupted active payload is unavailable and is replaced on reinstall',t=>{
  const f=fixture(t),output=join(f.temp,'out');
  const first=install(f.repo,f.source);
  const firstContent=readFileSync(first.hook,'utf8');
  const managed=join(dirname(first.hook),'.nose-review');
  const release=readdirSync(managed).find(name=>!name.endsWith('.tmp') && name!=='install.lock');
  rmSync(join(managed,release,'nose-pre-push.mjs'));

  const broken=spawnSync(first.hook,[],{cwd:f.repo,input:'',encoding:'utf8'});
  assert.equal(broken.status,2,broken.stderr);
  assert.match(broken.stderr,/NOSE_CHECK_UNAVAILABLE/);

  const repaired=install(f.repo,f.source);
  assert.equal(repaired.status,'installed');
  assert.notEqual(readFileSync(repaired.hook,'utf8'),firstContent);
  const run=spawnSync(repaired.hook,['origin','remote'],{cwd:f.repo,input:'refs/heads/main abc refs/heads/main def\n',encoding:'utf8',env:{...process.env,NOSE_TEST_OUTPUT:output}});
  assert.equal(run.status,0,run.stderr);
  assert.ok(existsSync(output));
  assert.equal(install(f.repo,f.source).status,'current');
});
test('SessionStart supplies bounded authorized-push recovery even when hook is current',t=>{
  const f=fixture(t);
  for(let attempt=0;attempt<2;attempt++) {
    const result=spawnSync(process.execPath,[new URL('./install-pre-push.mjs',import.meta.url).pathname],{input:JSON.stringify({cwd:f.repo}),encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const output=JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName,'SessionStart');
    assert.match(output.hookSpecificOutput.additionalContext,/user-authorized push/);
    assert.match(output.hookSpecificOutput.additionalContext,/Maximum two recovery attempts/);
    assert.match(output.hookSpecificOutput.additionalContext,/NOSE_CHECK_UNAVAILABLE/);
    if(attempt===1) assert.equal(output.systemMessage,undefined);
  }
});
test('repo-local hooksPath is honored, outside hooksPath is not modified',t=>{
  const f=fixture(t);
  execFileSync('git',['config','core.hooksPath','.githooks'],{cwd:f.repo});
  assert.equal(install(f.repo,f.source).status,'installed');
  assert.equal(execFileSync('git',['config','--get','core.hooksPath'],{cwd:f.repo,encoding:'utf8'}).trim(),'.githooks');
  assert.equal(existsSync(join(f.repo,'.githooks/pre-push')),false);
  execFileSync('git',['config','core.hooksPath',join(f.temp,'shared-hooks')],{cwd:f.repo});
  assert.equal(install(f.repo,f.source).status,'current');
  assert.equal(existsSync(join(f.temp,'shared-hooks')),false);
});
test('non-Git project needs no hook and repeated install updates payload without losing original',t=>{
  const f=fixture(t);
  assert.equal(install(f.source,f.source).status,'skipped');
  writeFileSync(join(f.hooks,'pre-push'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const first=install(f.repo,f.source);
  const original=readFileSync(join(f.hooks,'pre-push'),'utf8');
  writeFileSync(join(f.source,'review-runtime.mjs'),'// new version\n');
  assert.equal(install(f.repo,f.source).status,'installed');
  assert.equal(readFileSync(join(f.hooks,'pre-push'),'utf8'),original);
});

test('installation preserves local exclusions and ignores all local review state',t=>{
  const f=fixture(t), exclude=join(f.repo,'.git/info/exclude');
  writeFileSync(exclude,'existing-local-rule\n');
  install(f.repo,f.source);
  const first=readFileSync(exclude,'utf8');
  install(f.repo,f.source);
  assert.equal(readFileSync(exclude,'utf8'),first);
  assert.match(first,/existing-local-rule/);
  assert.equal(spawnSync('git',['check-ignore','.nose-review/failures/run.json'],{cwd:f.repo}).status,0);
  assert.equal(spawnSync('git',['check-ignore','.nose-review/baseline.json'],{cwd:f.repo}).status,0);
});
