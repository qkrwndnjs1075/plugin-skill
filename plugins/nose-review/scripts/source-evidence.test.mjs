import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import * as policy from './review-policy.mjs';
import { createMemberHasher, hash, isSourceFile, verifiedFamilies } from './source-evidence.mjs';
import {testDirectory} from './test-helpers.mjs';

function fixture(t) {
  const root = testDirectory(t, 'nose-source-evidence-');
  writeFileSync(join(root, 'a.js'), 'const value = 1;  \r\nreturn value;\t\r\n');
  writeFileSync(join(root, 'b.js'), '// moved\nconst value = 1;\nreturn value;\n');
  return root;
}

test('policy retains the same public source helper exports', () => {
  assert.equal(policy.hash, hash);
  assert.equal(policy.createMemberHasher, createMemberHasher);
});

test('source classification covers alternate suffixes, case folding and non-source files', () => {
  for (const file of ['directory/module.cjs','view.htm','component.TSX']) assert.equal(isSourceFile(file),true,file);
  for (const file of ['README.md', 'data.json', 'script.sh', 'source.ts.bak', 'no-extension', '.js']) {
    assert.equal(isSourceFile(file), false, file);
  }
});

test('source aliases resolve symlinks before parent components and reject outside bytes',t=>{
  const directory=testDirectory(t,'nose-alias-boundary-');
  const root=join(directory,'repo');
  mkdirSync(root);
  writeFileSync(join(root,'file'),'tracked\n');
  writeFileSync(join(directory,'file'),'external\n');
  symlinkSync('.',join(root,'a'));
  symlinkSync('a/../file',join(root,'x'));
  const hasher=createMemberHasher(root);
  for(const file of ['x','a/../file']) {
    assert.equal(readFileSync(`${root}/${file}`,'utf8'),'external\n');
    assert.throws(()=>hasher({locations:[{file,start:1,end:1}]}),/Source symlink is outside repository/);
  }
});

test('verified families normalize source and replace untrusted hashes without mutating reports', t => {
  const root = fixture(t);
  const locations = [{ file: 'b.js', start: 2, end: 3 }, { file: 'a.js', start: 1, end: 2 }];
  const family = { id: 'native-family', locations, memberHashes: ['untrusted'], fingerprint: 'untrusted' };
  const member = createHash('sha256').update('const value = 1;\nreturn value;').digest('hex');
  const memberHashes = [member, member];
  const fingerprint = createHash('sha256').update(JSON.stringify(memberHashes)).digest('hex');
  assert.deepEqual(verifiedFamilies({ families: [family] }, root), [{ ...family, memberHashes, fingerprint }]);
  assert.deepEqual(family.memberHashes, ['untrusted']);
  assert.equal(family.fingerprint, 'untrusted');
  assert.equal(family.locations, locations);
});

test('null regions are removed before reading source and only reduced families under two are dropped', t => {
  const root = fixture(t);
  const first = { file: 'a.js', start: 1, end: 2 };
  const second = { file: 'b.js', start: 2, end: 3, region: { kind: 'function' } };
  const excluded = { file: '../missing.js', start: 0, end: 99, region: null };
  const families = [
    { id: 'retained', locations: [excluded, first, second] },
    { id: 'reduced-singleton', locations: [first, excluded] },
    { id: 'all-excluded', locations: [excluded] },
    { id: 'original-singleton', locations: [first] },
  ];
  const verified = verifiedFamilies({ families }, root);
  assert.deepEqual(verified.map(family => family.id), ['retained', 'original-singleton']);
  assert.deepEqual(verified[0].locations, [first, second]);
  assert.deepEqual(verified[1].locations, [first]);
  assert.equal(families[0].locations.length, 3);
});

test('report and source-span validation remain strict for unfiltered families', t => {
  const root = fixture(t);
  for (const families of [undefined, null, {}, 'families']) {
    assert.throws(() => verifiedFamilies({ families }, root), /Unsupported Nose report/);
  }
  for (const family of [null, {}, { locations: [] }]) {
    assert.throws(() => verifiedFamilies({ families: [family] }, root), /Family must contain source locations/);
  }
  assert.throws(() => verifiedFamilies({ families: [{ locations: [{ file: 'a.js', start: 1, end: 3 }] }] }, root), /exceeds file/);
});
