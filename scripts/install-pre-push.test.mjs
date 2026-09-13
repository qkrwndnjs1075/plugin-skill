import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { install } from './install-pre-push.mjs';

function fixture(t) {
  const temp=mkdtempSync(join(tmpdir(),"nose-install ' "));
  t.after(()=>rmSync(temp,{recursive:true,force:true}));
  const repo=join(temp,'repo'),source=join(temp,'payload');
  mkdirSync(repo);mkdirSync(source);
  execFileSync('git',['init','-q'],{cwd:repo});
  for(const name of ['review-runtime.mjs','review-policy.mjs']) writeFileSync(join(source,name),'');
  writeFileSync(join(source,'nose-pre-push.mjs'),"import {readFileSync,writeFileSync} from 'node:fs';writeFileSync(process.env.NOSE_TEST_OUTPUT,JSON.stringify({args:process.argv.slice(2),input:readFileSync(0,'utf8')}));");
  return {temp,repo,source,hooks:join(repo,'.git/hooks')};
}
test('installation chains existing hook with identical args/stdin and survives removal of plugin source',t=>{
  const f=fixture(t);
  const old='#!/bin/sh\ncat > "$NOSE_OLD_INPUT"\nprintf "%s\\n" "$@" > "$NOSE_OLD_ARGS"\n';
  writeFileSync(join(f.hooks,'pre-push'),old,{mode:0o755});
  const first=install(f.repo,f.source);
  assert.equal(first.status,'installed');
  const before=statSync(first.hook);
  assert.equal(install(f.repo,f.source).status,'current');
  assert.equal(statSync(first.hook).mtimeMs,before.mtimeMs);
  assert.equal(statSync(first.hook).ino,before.ino);
  assert.equal(readFileSync(first.previousHook,'utf8'),old);
  rmSync(f.source,{recursive:true});
  const output=join(f.temp,'out'),oldInput=join(f.temp,'stdin'),oldArgs=join(f.temp,'args');
  const input='refs/heads/main abc refs/heads/main def\n';
  const result=spawnSync(first.hook,['origin','/tmp/remote space'],{cwd:f.repo,input,encoding:'utf8',env:{...process.env,NOSE_TEST_OUTPUT:output,NOSE_OLD_INPUT:oldInput,NOSE_OLD_ARGS:oldArgs}});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output,'utf8')),{args:['origin','/tmp/remote space'],input});
  assert.equal(readFileSync(oldInput,'utf8'),input);
  assert.equal(readFileSync(oldArgs,'utf8'),'origin\n/tmp/remote space\n');
});
test('existing pre-push rejection is preserved and Nose is not run',t=>{
  const f=fixture(t),output=join(f.temp,'out');
  writeFileSync(join(f.hooks,'pre-push'),'#!/bin/sh\nexit 23\n',{mode:0o755});
  const result=install(f.repo,f.source);
  const push=spawnSync(result.hook,[],{cwd:f.repo,input:'',env:{...process.env,NOSE_TEST_OUTPUT:output}});
  assert.equal(push.status,23);
  assert.equal(existsSync(output),false);
});
test('Nose gate failures propagate through the installed dispatcher',t=>{
  const f=fixture(t);
  writeFileSync(join(f.source,'nose-pre-push.mjs'),'process.exit(1);\n');
  const result=install(f.repo,f.source);
  assert.equal(spawnSync(result.hook,[],{cwd:f.repo,input:''}).status,1);
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
  assert.ok(existsSync(join(f.repo,'.githooks/pre-push')));
  execFileSync('git',['config','core.hooksPath',join(f.temp,'shared-hooks')],{cwd:f.repo});
  assert.equal(install(f.repo,f.source).status,'skipped');
  assert.equal(existsSync(join(f.temp,'shared-hooks')),false);
});
test('non-Git project needs no hook and repeated install updates payload without losing original',t=>{
  const f=fixture(t);
  assert.equal(install(f.source,f.source).status,'skipped');
  writeFileSync(join(f.hooks,'pre-push'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const first=install(f.repo,f.source);
  const original=readFileSync(first.previousHook,'utf8');
  writeFileSync(join(f.source,'review-runtime.mjs'),'// new version\n');
  assert.equal(install(f.repo,f.source).status,'installed');
  assert.equal(readFileSync(first.previousHook,'utf8'),original);
});
