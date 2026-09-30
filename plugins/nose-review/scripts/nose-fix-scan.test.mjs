import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, realpathSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { install } from './install-pre-push.mjs';
import { duplicateSource as source, gitFixture } from './test-helpers.mjs';
import { register, stateRoot, hash } from './review-runtime.mjs';

test('skill scan permits its own session and preserves registration, but refuses another session', t=>{
  const fixture=mkdtempSync(join(tmpdir(),'nose-skill-scan-'));
  t.after(()=>rmSync(fixture,{recursive:true,force:true}));
  const previous=process.env.NOSE_REVIEW_STATE_ROOT;
  process.env.NOSE_REVIEW_STATE_ROOT=join(fixture,'state');
  try {
    // Canonical root is important on macOS /tmp aliases.
    const root=realpathSync(fixture);
    register(root,'owner');
    const file=join(stateRoot(root),hash('owner')+'.json');
    const before=readFileSync(file,'utf8');
    const run=id=>spawnSync(process.execPath,[new URL('./nose-fix-scan.mjs',import.meta.url).pathname,root],{encoding:'utf8',env:{...process.env,CODEX_THREAD_ID:id}});
    const own=run('owner');
    assert.equal(own.status,0,own.stderr);
    assert.equal(JSON.parse(own.stdout).status,'scanned');
    assert.equal(readFileSync(file,'utf8'),before);
    assert.equal(run('stranger').status,1);
    register(root,'second');
    assert.equal(run('owner').status,1);
  } finally {
    if(previous===undefined) delete process.env.NOSE_REVIEW_STATE_ROOT;
    else process.env.NOSE_REVIEW_STATE_ROOT=previous;
  }
});

for (const change of ['clean','installed-clean','installed-linked-clean','modified','added','deleted','ignored-untracked','assume-unchanged','staged','crlf','internal-link']) test(`fix scan followed by pre-push preserves commit coverage with ${change} working inputs`, t=>{
  const fixture=gitFixture(t,'nose-fix-reuse-');
  const {git}=fixture;
  let {root}=fixture;
  const installed=change.startsWith('installed-');
  writeFileSync(join(root,'a.js'),source('alpha'));
  writeFileSync(join(root,'b.js'),source('beta'));
  writeFileSync(join(root,'.gitignore'),'b.js\nignored.js\n.nose-review/\n');
  git('add','a.js','.gitignore');git('add','-f','b.js');git('commit','-qm','duplicates');
  if(change==='internal-link') { symlinkSync('a.js',join(root,'linked.js'));git('add','linked.js');git('commit','-qm','internal link'); }
  if(change==='assume-unchanged') { git('update-index','--assume-unchanged','a.js');writeFileSync(join(root,'a.js'),'export const unique=1;\n'); }
  if(change==='staged') { writeFileSync(join(root,'a.js'),'export const unique=1;\n');git('add','a.js');writeFileSync(join(root,'a.js'),source('alpha')); }
  if(change==='crlf') { git('config','core.autocrlf','true');writeFileSync(join(root,'a.js'),source('alpha').replaceAll('\n','\r\n')); }
  if(change==='modified') writeFileSync(join(root,'a.js'),'export const unique=1;\n');
  if(change==='added') writeFileSync(join(root,'c.js'),source('gamma'));
  if(change==='deleted') rmSync(join(root,'a.js'));
  if(change==='ignored-untracked') writeFileSync(join(root,'ignored.js'),source('gamma'));
  const env={...process.env,NOSE_REVIEW_STATE_ROOT:mkdtempSync(join(tmpdir(),'nose-fix-cache-'))};
  t.after(()=>rmSync(env.NOSE_REVIEW_STATE_ROOT,{recursive:true,force:true}));
  if(change==='installed-linked-clean') {
    root=join(env.NOSE_REVIEW_STATE_ROOT,'linked');
    git('worktree','add','--detach',root,'HEAD');
  }
  if(installed) {
    const remote=join(env.NOSE_REVIEW_STATE_ROOT,'remote.git');
    git('init','--bare','-q',remote);git('remote','add','origin',remote);install(root);
  }
  const nativePush=()=>spawnSync('git',['push','origin','HEAD:refs/heads/main'],{cwd:root,encoding:'utf8',env});
  const initialPush=change==='installed-linked-clean' ? nativePush() : null;
  if(initialPush) assert.equal(initialPush.status,1,initialPush.stderr);
  const fix=spawnSync(process.execPath,[new URL('./nose-fix-scan.mjs',import.meta.url).pathname,root],{encoding:'utf8',env});
  assert.equal(fix.status,0,fix.stderr);
  if(change==='crlf') git('config','core.autocrlf','false');
  const report=JSON.parse(readFileSync(join(root,'.nose-review/report.json'),'utf8'));
  const push=installed ? nativePush() : spawnSync(process.execPath,[new URL('./nose-pre-push.mjs',import.meta.url).pathname,'origin','fixture'],{cwd:root,encoding:'utf8',env,input:`refs/heads/main ${git('rev-parse','HEAD')} refs/heads/main ${'0'.repeat(40)}\n`});
  assert.equal(push.status,1,push.stderr);
  const pushed=JSON.parse(readFileSync(join(root,'.nose-review/report.json'),'utf8'));
  assert.ok(pushed.candidates.some(family=>family.locations.some(location=>location.file==='b.js')));
  if(['clean','installed-clean','installed-linked-clean','ignored-untracked','internal-link'].includes(change)) {
    assert.ok(report.candidates.some(family=>family.locations.some(location=>location.file==='b.js')));
    assert.ok(report.candidates.every(family=>family.locations.every(location=>!location.file.startsWith('/'))));
    assert.equal((((initialPush?.stderr??'')+fix.stderr+push.stderr).match(/scanner finished/g)??[]).length,1);
    if(initialPush) assert.match(fix.stderr,/verified result cache hit/);
    assert.match(push.stderr,/verified result cache hit/);
  } else {
    assert.equal(((fix.stderr+push.stderr).match(/scanner finished/g)??[]).length,2);
    assert.doesNotMatch(push.stderr,/verified result cache hit/);
  }
});
