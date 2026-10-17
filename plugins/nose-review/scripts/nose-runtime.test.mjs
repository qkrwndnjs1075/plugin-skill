import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {ensureNose, resolveNose} from './nose-runtime.mjs';
import {install} from './install-pre-push.mjs';
import {gitFixture, preserveEnvironment, testDirectory} from './test-helpers.mjs';

const licenseText='MIT License\nCopyright fixture authors\nPermission is hereby granted for this test fixture.\n';
function fixture(t) {
  const root=testDirectory(t,'nose-runtime-');
  const env={...process.env,NOSE_REVIEW_RUNTIME_ROOT:join(root,'cache'),PATH:''};
  function release(version) {
    const stem='nose-cli-fixture', dir=join(root,version), folder=join(dir,stem);
    mkdirSync(folder,{recursive:true});
    writeFileSync(join(folder,'nose'),`#!/bin/sh\necho 'nose ${version.slice(1)}'\n`,{mode:0o755});
    writeFileSync(join(folder,'LICENSE'),licenseText);
    const archive=join(dir,stem+'.tar.xz');
    execFileSync('tar',['-cJf',archive,'-C',dir,stem]);
    const manifest={version,repository:'fixture/nose',assets:{[`${process.platform}-${process.arch}`]:{name:stem+'.tar.xz',sha256:createHash('sha256').update(readFileSync(archive)).digest('hex')}}};
    return {env,manifest,fetchArchive:(_url,path)=>copyFileSync(archive,path)};
  }
  return {root,env,release};
}
test('installs pinned executable and validates offline without downloading again',t=>{
  const f=fixture(t),options=f.release('v0.21.0');
  const installed=ensureNose(options);
  assert.equal(installed.status,'installed');
  assert.equal(readFileSync(join(dirname(installed.binary),'LICENSE'),'utf8'),licenseText);
  assert.equal(execFileSync(installed.binary,['--version'],{encoding:'utf8'}).trim(),'nose 0.21.0');
  assert.equal(resolveNose(options),installed.binary);
  assert.equal(ensureNose({...options,fetchArchive:()=>{throw Error('unexpected network');}}).status,'current');
  writeFileSync(installed.binary,'corrupted');
  assert.throws(()=>resolveNose(options),/integrity/);
});
test('license tampering is rejected by both setup and runtime resolution',t=>{
  const options=fixture(t).release('v0.21.0'),installed=ensureNose(options);
  writeFileSync(join(dirname(installed.binary),'LICENSE'),'tampered');
  assert.throws(()=>resolveNose(options),/license integrity/);
  assert.throws(()=>ensureNose(options),/license integrity/);
});
test('legacy receipt without a license is skipped and migrated by a fresh verified install',t=>{
  const f=fixture(t),options=f.release('v0.21.0');
  const oldPin={repository:options.manifest.repository,version:options.manifest.version,target:`${process.platform}-${process.arch}`,archiveSha256:options.manifest.assets[`${process.platform}-${process.arch}`].sha256};
  const old=join(f.env.NOSE_REVIEW_RUNTIME_ROOT,`${oldPin.version}-${oldPin.target}-${createHash('sha256').update(JSON.stringify(oldPin)).digest('hex').slice(0,16)}`);
  mkdirSync(old,{recursive:true});
  const data=Buffer.from('#!/bin/sh\necho nose 0.21.0\n');
  writeFileSync(join(old,'nose'),data,{mode:0o755});
  writeFileSync(join(old,'receipt.json'),JSON.stringify({...oldPin,binarySha256:createHash('sha256').update(data).digest('hex')}));
  assert.throws(()=>resolveNose(options),/unavailable/);
  assert.throws(()=>ensureNose({...options,fetchArchive:()=>{throw Error('offline');}}),/offline/);
  const installed=ensureNose(options);
  assert.equal(installed.status,'installed'); assert.notEqual(dirname(installed.binary),old);
  assert.equal(readFileSync(join(dirname(installed.binary),'LICENSE'),'utf8'),licenseText);
  assert.equal(resolveNose(options),installed.binary);
});
test('an older pin never falls forward to a newer cached runtime',t=>{
  const f=fixture(t),old=f.release('v0.21.0'); ensureNose(f.release('v0.22.0'));
  assert.throws(()=>resolveNose(old),/unavailable/);
  assert.throws(()=>ensureNose({...old,fetchArchive:()=>{throw Error('offline');}}),/offline/);
});
test('upgrades pin atomically; unavailable update retains verified previous managed binary',t=>{
  const f=fixture(t),old=f.release('v0.21.0'),next=f.release('v0.22.0');
  const first=ensureNose(old);
  const offline=ensureNose({...next,fetchArchive:()=>{throw Error('offline');}});
  assert.equal(offline.status,'offline'); assert.equal(offline.binary,first.binary);
  assert.equal(resolveNose(next),first.binary);
  const upgraded=ensureNose(next);
  assert.equal(upgraded.status,'installed'); assert.notEqual(upgraded.binary,first.binary);
  assert.equal(resolveNose(next),upgraded.binary); assert.ok(existsSync(first.binary));
});
test('checksum mismatch never falls back, and same-version checksum changes are not reused',t=>{
  const f=fixture(t),options=f.release('v0.21.0'); ensureNose(options);
  const manifest=structuredClone(options.manifest);
  manifest.assets[`${process.platform}-${process.arch}`].sha256='0'.repeat(64);
  assert.throws(()=>ensureNose({...options,manifest}),/checksum mismatch/);
  assert.throws(()=>ensureNose({...options,manifest,fetchArchive:()=>{throw Error('offline');}}),/offline/);
  assert.throws(()=>resolveNose({...options,manifest}),/unavailable/);
});
test('missing network falls back to PATH but absent fallback fails visibly',t=>{
  const f=fixture(t),options=f.release('v0.21.0');
  const failed={...options,fetchArchive:()=>{throw Error('offline');}};
  assert.throws(()=>ensureNose(failed),/offline/);
  const binary=join(f.root,'nose'); writeFileSync(binary,'#!/bin/sh\necho nose\n',{mode:0o755});
  const external=ensureNose({...failed,env:{...f.env,PATH:f.root}});
  assert.equal(external.status,'external'); assert.equal(external.binary,binary);
});
test('OFF skips setup callback entirely and preserves project setting',t=>{
  const f=gitFixture(t,'nose-runtime-off-');
  f.git('config','hook.nose-review.enabled','false');
  const result=install(f.root,undefined,{setupRuntime:()=>{throw Error('OFF must not install');}});
  assert.equal(result.status,'off');
  assert.equal(f.git('config','hook.nose-review.enabled'),'false');
});
test('session setup outside Git still installs the manual scan runtime',t=>{
  const root=testDirectory(t,'nose-runtime-plain-'); let called=false;
  const result=install(root,undefined,{setupRuntime:({cwd})=>{called=true; assert.equal(cwd,root); return {status:'current'};}});
  assert.equal(result.status,'skipped'); assert.equal(called,true);
});
test('a mismatched executable version is rejected before publication',t=>{
  const f=fixture(t),options=f.release('v0.21.0');
  const manifest={...options.manifest,version:'v0.22.0'};
  assert.throws(()=>ensureNose({...options,manifest}),/version verification/);
  assert.throws(()=>resolveNose({...options,manifest}),/unavailable/);
});
test('private release authentication failures explain the required login without disclosing stderr',t=>{
  const f=fixture(t),options=f.release('v0.21.0');
  writeFileSync(join(f.root,'gh'),'#!/bin/sh\necho sensitive-error >&2\nexit 1\n',{mode:0o755});
  preserveEnvironment(t,['PATH']); process.env.PATH=f.root;
  assert.throws(()=>ensureNose({env:options.env,manifest:options.manifest}),error=>{
    assert.match(error.message,/gh auth login/); assert.doesNotMatch(error.message,/sensitive-error/); return true;
  });
});
test('concurrent installer cannot publish or remove the owning installer lock',t=>{
  const f=fixture(t),options=f.release('v0.21.0');
  const result=ensureNose({...options,fetchArchive:(url,path)=>{
    assert.throws(()=>ensureNose(options),/Another managed Nose installation/);
    options.fetchArchive(url,path);
  }});
  assert.equal(result.status,'installed'); assert.equal(resolveNose(options),result.binary);
});
