import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
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
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  const oldMac = lines.pop();
  const [header, ...records] = lines.map(line => JSON.parse(line));
  const payload = {...header, result: {...header.metadata, files: Object.fromEntries(records.filter(record => 'file' in record).map(({file, hash}) => [file, hash])), families: records.filter(record => 'family' in record).map(({family}) => family)}};
  mutate(payload);
  const {files, families, ...metadata} = payload.result;
  const text = [{schema: payload.schema, identity: payload.identity, metadata}, ...Object.entries(files).map(([file, hash]) => ({file, hash})), ...families.map(family => ({family}))].map(record => JSON.stringify(record) + '\n').join('');
  const mac = sign ? createHmac('sha256', readFileSync(join(options.directory, 'scan-results', 'key'))).update(text).digest('hex') : oldMac;
  writeFileSync(path, text + mac + '\n');
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

test('large verified results over 128 MiB round trip with bounded transient memory', t => {
  const options = fixture(t);
  const padding = 'large-record-'.repeat(6000);
  const family = {...result.families[0], padding};
  const large = {...result, families: Array(1900).fill(family)};
  assert.equal(writeScanResult({...options, result: large}), true);
  const bytes = statSync(entry(options)).size;
  assert.ok(bytes > 128 * 1024 * 1024);
  const loaded = readScanResult(options);
  assert.equal(loaded.families.length, 1900);
  assert.deepEqual(loaded.families[0], family);
  assert.deepEqual(loaded.families.at(-1), family);
  t.diagnostic(JSON.stringify({entryBytes: bytes, maxRssKiB: process.resourceUsage().maxRSS}));
});

test('events expose safe stable outcomes and callbacks cannot break storage', t => {
  const options = fixture(t);
  const events = [];
  const observed = {...options, onEvent: event => events.push(event)};
  assert.equal(readScanResult(observed), null);
  assert.equal(writeScanResult(observed), true);
  assert.deepEqual(readScanResult(observed), result);
  assert.deepEqual(events, [
    {operation: 'read', outcome: 'miss', reason: 'not-found'},
    {operation: 'write', outcome: 'stored', reason: 'verified-result'},
    {operation: 'read', outcome: 'hit', reason: 'verified-result'},
  ]);
  assert.equal(writeScanResult({...options, onEvent() { throw new Error('secret'); }}), true);
});

test('oversized records skip atomically and preserve a previous valid entry', t => {
  const options = fixture(t);
  assert.equal(writeScanResult(options), true);
  const events = [];
  assert.equal(writeScanResult({...options, result: {...result, families: [{...result.families[0], padding: 'a'.repeat(16 * 1024 * 1024)}]}, onEvent: event => events.push(event)}), false);
  assert.deepEqual(readScanResult(options), result);
  assert.equal(events[0].reason, 'record-too-large');
  assert.equal(readdirSync(join(options.directory, 'scan-results')).some(name => name.endsWith('.tmp')), false);
});

test('old envelopes, missing MAC, trailing data and corrupted MAC are misses', t => {
  const options = fixture(t);
  assert.equal(writeScanResult(options), true);
  const path = entry(options);
  const original = readFileSync(path, 'utf8');
  for (const value of [JSON.stringify({payload: '{}', mac: hash('old')}), original.slice(0, -65), original + '{}\n', original.slice(0, -65) + '0'.repeat(64) + '\n']) {
    writeFileSync(path, value);
    assert.equal(readScanResult(options), null);
  }
});

test('512 MiB entry budget rejects incremental writes and cleans temporary data', t => {
  const options = fixture(t);
  const events = [];
  const family = {...result.families[0], padding: 'x'.repeat(1024 * 1024)};
  assert.equal(writeScanResult({...options, result: {...result, families: Array(513).fill(family)}, onEvent: event => events.push(event)}), false);
  assert.deepEqual(events, [{operation: 'write', outcome: 'skipped', reason: 'entry-too-large'}]);
  assert.deepEqual(readdirSync(join(options.directory, 'scan-results')), ['key']);
});

test('retention enforces 2 GiB budget without following symlinks or deleting hardlinks', t => {
  const options = fixture(t);
  assert.equal(writeScanResult(options), true);
  const root = join(options.directory, 'scan-results');
  for (let index = 0; index < 5; index++) {
    const path = join(root, `${hash(String(index))}.json`);
    writeFileSync(path, '', {mode: 0o600});
    truncateSync(path, 512 * 1024 * 1024);
    utimesSync(path, 1, index + 1);
  }
  const outside = join(options.directory, 'outside');
  writeFileSync(outside, 'untouched', {mode: 0o600});
  const symbolic = join(root, `${hash('symlink')}.json`);
  const hard = join(root, `${hash('hardlink')}.json`);
  symlinkSync(outside, symbolic);
  linkSync(outside, hard);
  assert.equal(writeScanResult(options), true);
  const retained = readdirSync(root).filter(name => name.endsWith('.json') && ![symbolic, hard].includes(join(root, name)));
  assert.ok(retained.reduce((sum, name) => sum + statSync(join(root, name)).size, 0) <= 2 * 1024 * 1024 * 1024);
  assert.equal(retained.length, 4);
  assert.equal(readFileSync(symbolic, 'utf8'), 'untouched');
  assert.equal(readFileSync(hard, 'utf8'), 'untouched');
});

test('hardlinked cache entries are rejected for reads and replacement', t => {
  const options = fixture(t);
  assert.equal(writeScanResult(options), true);
  linkSync(entry(options), join(options.directory, 'linked'));
  assert.equal(readScanResult(options), null);
  assert.equal(writeScanResult(options), false);
});

test('missing source membership reports the precise safe rejection reason', t => {
  const options = fixture(t);
  const events = [];
  assert.equal(writeScanResult({...options, result: {...result, files: {}}, onEvent: event => events.push(event)}), false);
  assert.equal(writeScanResult(options), true);
  rewrite(options, payload => { payload.result.files = {}; }, true);
  assert.equal(readScanResult({...options, onEvent: event => events.push(event)}), null);
  assert.deepEqual(events, [
    {operation: 'write', outcome: 'skipped', reason: 'missing-source-member'},
    {operation: 'read', outcome: 'miss', reason: 'missing-source-member'},
  ]);
});
