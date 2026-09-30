import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync, rmSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {scan, stateRoot, cacheStateRoot} from './review-runtime.mjs';
import {gitFixture, countRecordedCalls, preserveEnvironment} from './test-helpers.mjs';

function fixture(t) {
  const {root,directory,git}=gitFixture(t,'nose-working-cache-',{subdirectory:'repo'});
  const bin=join(directory,'bin'),calls=join(directory,'calls');
  mkdirSync(bin);
  writeFileSync(join(root,'a.js'),'export const a = 1;\n');
  git('add','.');git('commit','-qm','fixture');
  writeFileSync(join(bin,'nose'),'#!'+process.execPath+'\n'+`
    const fs=require('node:fs');
    if(process.argv.includes('--version')) console.log('nose fixture');
    else if(process.argv.includes('--show-config')) {
      console.log(JSON.stringify({schema:'nose.query-config/v1',config_file:null,
        query:{'ignore-file':null,'semantic-pack-lock':null,'semantic-packs':[]}}));
    } else {
      fs.appendFileSync(${JSON.stringify(calls)},'query\\n');
      if(process.env.NOSE_TEST_MUTATE) fs.writeFileSync('.ignore','a.js\\n');
      console.log(JSON.stringify({families:[]}));
    }
  `,{mode:0o700});
  const keys=['PATH','NOSE_REVIEW_STATE_ROOT','NOSE_TEST_MUTATE'];
  preserveEnvironment(t,keys);
  Object.assign(process.env,{PATH:bin+':'+process.env.PATH,NOSE_REVIEW_STATE_ROOT:join(directory,'state')});
  const count=countRecordedCalls.bind(null,calls);
  return {root,directory,git,count};
}

test('working scans reuse unchanged results and invalidate edit, add, delete and ignore changes',t=>{
  const {root,count}=fixture(t);
  const first=scan(root);
  assert.deepEqual(scan(root),first);assert.equal(count(),1);
  writeFileSync(join(root,'a.js'),'export const a = 2;\n');scan(root);assert.equal(count(),2);
  writeFileSync(join(root,'b.js'),'export const b = 3;\n');scan(root);assert.equal(count(),3);
  rmSync(join(root,'a.js'));scan(root);assert.equal(count(),4);
  writeFileSync(join(root,'.ignore'),'b.js\n');scan(root);assert.equal(count(),5);
  writeFileSync(join(root,'.gitignore'),'b.js\n');scan(root);assert.equal(count(),6);
  scan(root);assert.equal(count(),6);
  mkdirSync(join(root,'.nose-review'));
  writeFileSync(join(root,'.nose-review','baseline.json'),'{}');scan(root);assert.equal(count(),6);
  writeFileSync(join(root,'.git','info','exclude'),'*.js\n');scan(root);assert.equal(count(),7);
});

test('linked worktrees share results but preserve separate edit registries',t=>{
  const {root,directory,git,count}=fixture(t);
  const other=join(directory,'other');git('worktree','add','--detach',other,'HEAD');
  assert.equal(cacheStateRoot(root),cacheStateRoot(other));
  assert.notEqual(stateRoot(root),stateRoot(other));
  const first=scan(root);assert.deepEqual(scan(other),first);assert.equal(count(),1);
  writeFileSync(join(other,'a.js'),'export const a = 9;\n');scan(other);assert.equal(count(),2);
  assert.deepEqual(scan(root),first);assert.equal(count(),2);
});

test('ignore control mutation during a working scan rejects the result',t=>{
  const {root}=fixture(t);
  process.env.NOSE_TEST_MUTATE='1';
  assert.throws(()=>scan(root),/inputs changed during scan/);
});

test('file and directory symlinks retain reuse while target edits invalidate it',t=>{
  const {root,directory,count}=fixture(t);
  const target=join(directory,'targets');mkdirSync(target);
  writeFileSync(join(target,'example.md'),'initial');
  symlinkSync(join(target,'example.md'),join(root,'CLAUDE.md'));
  symlinkSync(target,join(root,'skills'));
  scan(root);scan(root);assert.equal(count(),1);
  writeFileSync(join(target,'example.md'),'changed');scan(root);assert.equal(count(),2);
  writeFileSync(join(target,'added.md'),'new');scan(root);assert.equal(count(),3);
  symlinkSync(target,join(target,'cycle'));scan(root);scan(root);assert.equal(count(),5);
});

test('nose-fix CLI reuses a verified working result on its second invocation',t=>{
  const {root,count}=fixture(t);
  const run=()=>spawnSync(process.execPath,[new URL('./nose-fix-scan.mjs',import.meta.url).pathname,root],{env:process.env,encoding:'utf8'});
  const first=run(),second=run();
  assert.equal(first.status,0,first.stderr);assert.equal(second.status,0,second.stderr);
  assert.match(second.stderr,/verified result cache hit/);assert.equal(count(),1);
});
