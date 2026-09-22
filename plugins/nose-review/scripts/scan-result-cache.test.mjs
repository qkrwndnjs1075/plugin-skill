import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readScanResult, writeScanResult } from './scan-result-cache.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const identity = {commit: 'a'.repeat(40), scanner: {version: 'nose 1', binary: hash('binary')}, policy: hash('policy'), environment: hash('env')};
const memberHashes = [hash('source')];
const result = {noseVersion: 'nose 1', files: {'src/a.js': hash('source')}, families: [{locations: [{file: 'src/a.js', start: 1, end: 2}], memberHashes, fingerprint: hash(JSON.stringify(memberHashes)), retained: {metadata: true}}]};

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nose-result-cache-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  return {directory, identity, result};
}
function entry(options) {
  const root = join(options.directory, 'scan-results');
  return join(root, readdirSync(root).find(name => name.endsWith('.json')));
}
function rewrite(options, mutate, sign = false) {
  const path = entry(options);
  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  const payload = JSON.parse(envelope.payload);
  mutate(payload);
  envelope.payload = JSON.stringify(payload);
  if (sign) envelope.mac = createHmac('sha256', readFileSync(join(options.directory, 'scan-results', 'key'))).update(envelope.payload).digest('hex');
  writeFileSync(path, JSON.stringify(envelope));
}

test('complete verified results round trip without dropping metadata', t => {
  const options = fixture(t);
  assert.equal(readScanResult(options), null);
  assert.equal(writeScanResult(options), true);
  assert.deepEqual(readScanResult(options), result);
  assert.deepEqual(readScanResult({...options, identity: Object.fromEntries(Object.entries(identity).reverse())}), result);
});

test('all input identities invalidate cached scans', t => {
  const options = fixture(t);
  assert.equal(writeScanResult(options), true);
  for (const key of Object.keys(identity)) assert.equal(readScanResult({...options, identity: {...identity, [key]: 'changed'}}), null);
});

test('valid JSON tampering without the private key cannot remove families', t => {
  const options = fixture(t);
  writeScanResult(options);
  rewrite(options, payload => { payload.result.families = []; });
  assert.equal(readScanResult(options), null);
});

for (const [name, mutate] of [
  ['schema', payload => { payload.schema = 999; }],
  ['identity', payload => { payload.identity = hash('other'); }],
  ['fingerprint', payload => { payload.result.families[0].fingerprint = hash('other'); }],
  ['member count', payload => { payload.result.families[0].memberHashes = []; }],
  ['span', payload => { payload.result.families[0].locations[0].start = 0; }],
  ['missing source', payload => { payload.result.files = {}; }],
  ['traversal', payload => { payload.result.families[0].locations[0].file = '../a.js'; }],
  ['absolute source', payload => { payload.result.files['/etc/passwd'] = hash('source'); }],
]) test(`even authenticated ${name} corruption is rejected`, t => {
  const options = fixture(t);
  writeScanResult(options);
  rewrite(options, mutate, true);
  assert.equal(readScanResult(options), null);
});

test('truncated JSON is a miss and can be replaced by a completed scan', t => {
  const options = fixture(t);
  writeScanResult(options);
  writeFileSync(entry(options), '{');
  assert.equal(readScanResult(options), null);
  assert.equal(writeScanResult(options), true);
  assert.deepEqual(readScanResult(options), result);
});

test('failed and incomplete scan values are never persisted', t => {
  const options = fixture(t);
  for (const invalid of [null, {}, {...result, error: 'failed'}, {...result, complete: false}, {...result, families: null}, {...result, files: null}]) {
    assert.equal(writeScanResult({...options, result: invalid}), false);
    assert.equal(readScanResult(options), null);
  }
  assert.deepEqual(readdirSync(options.directory), []);
});

for (const target of ['directory', 'key', 'entry']) test(`symlink ${target} is rejected without changing its target`, t => {
  const options = fixture(t);
  writeScanResult(options);
  const path = target === 'directory' ? join(options.directory, 'scan-results') : target === 'key' ? join(options.directory, 'scan-results', 'key') : entry(options);
  const outside = join(options.directory, 'outside');
  if (target === 'directory') mkdirSync(outside, {mode: 0o700});
  else writeFileSync(outside, 'untouched', {mode: 0o600});
  rmSync(path, {recursive: true});
  symlinkSync(outside, path);
  assert.equal(readScanResult(options), null);
  assert.equal(writeScanResult(options), false);
  if (target === 'directory') assert.deepEqual(readdirSync(outside), []);
  else assert.equal(readFileSync(outside, 'utf8'), 'untouched');
});

test('nonregular entries and public keys are rejected', t => {
  const options = fixture(t);
  writeScanResult(options);
  const path = entry(options);
  rmSync(path);
  mkdirSync(path);
  assert.equal(readScanResult(options), null);
  assert.equal(writeScanResult(options), false);
  rmSync(path, {recursive: true});
  chmodSync(join(options.directory, 'scan-results', 'key'), 0o644);
  assert.equal(writeScanResult(options), false);
});

test('retention is bounded and atomic writes leave no temporary artifacts', t => {
  const options = fixture(t);
  for (let commit = 0; commit < 40; commit++) assert.equal(writeScanResult({...options, identity: {...identity, commit}}), true);
  const files = readdirSync(join(options.directory, 'scan-results'));
  assert.equal(files.filter(name => name.endsWith('.json')).length, 32);
  assert.equal(files.filter(name => name.endsWith('.tmp')).length, 0);
  assert.deepEqual(readScanResult({...options, identity: {...identity, commit: 39}}), result);
});
