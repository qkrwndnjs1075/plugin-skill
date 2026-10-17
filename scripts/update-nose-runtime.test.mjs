import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { releaseManifest } from './update-nose-runtime.mjs';

const data=Buffer.from('fixture archive');
const sha=createHash('sha256').update(data).digest('hex');
const current={version:'v1.0.0',repository:'owner/nose',assets:{'linux-x64':{name:'nose.tar.xz',sha256:sha}}};
const base='https://github.com/owner/nose/releases/download/v1.1.0/';
const release={tag_name:'v1.1.0',assets:['nose.tar.xz','nose.tar.xz.sha256'].map(name=>({name,browser_download_url:base+name}))};
const download=async url=>url.endsWith('.sha256')?Buffer.from(sha+'  nose.tar.xz\n'):data;
test('advances only to checksum-verified independent release',async()=>{
  assert.deepEqual(await releaseManifest(current,release,download),{...current,version:'v1.1.0'});
});
test('rejects corrupted artifacts',async()=>{
  await assert.rejects(releaseManifest(current,release,async url=>url.endsWith('.sha256')?download(url):Buffer.from('bad')),/Checksum mismatch/);
});
test('rejects missing, foreign and prerelease assets',async()=>{
  await assert.rejects(releaseManifest(current,{...release,assets:[]},download),/Missing/);
  await assert.rejects(releaseManifest(current,{...release,prerelease:true},download),/stable/);
  await assert.rejects(releaseManifest(current,{...release,tag_name:'v0.9.0'},download),/newer/);
  await assert.rejects(releaseManifest(current,{...release,assets:release.assets.map(a=>({...a,browser_download_url:a.browser_download_url.replace('owner','upstream')}))},download),/unexpected/);
});
