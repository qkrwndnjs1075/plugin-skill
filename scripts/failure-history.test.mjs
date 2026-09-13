import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveFailure } from './failure-history.mjs';

test('failure records are unique, private, sanitized and survive a successful check',t=>{
  const root=mkdtempSync(join(tmpdir(),'failure-fixture-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const report={exitCode:1,gateStatus:'blocked',refs:[{localSha:'abc',warnings:[],candidates:[{fingerprint:'digest',source:'DO_NOT_STORE',locations:[{file:'a.js',start:1,end:4,source:'DO_NOT_STORE'}]}]}]};
  const first=saveFailure(root,report), second=saveFailure(root,report);
  assert.notEqual(first,second);
  assert.equal(saveFailure(root,{exitCode:0}),null);
  assert.equal(readdirSync(join(root,'.nose-review/failures')).length,2);
  assert.ok(!readFileSync(first,'utf8').includes('DO_NOT_STORE'));
  assert.equal(statSync(first).mode&0o777,0o600);
  assert.equal(statSync(join(root,'.nose-review/failures')).mode&0o777,0o700);
});

test('failure history refuses symlink destinations',t=>{
  const root=mkdtempSync(join(tmpdir(),'failure-link-'));
  const target=mkdtempSync(join(tmpdir(),'failure-outside-'));
  t.after(()=>{rmSync(root,{recursive:true,force:true});rmSync(target,{recursive:true,force:true});});
  symlinkSync(target,join(root,'.nose-review'));
  assert.throws(()=>saveFailure(root,{exitCode:2}),/symlink or file/);
  assert.deepEqual(readdirSync(target),[]);
});
