import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { scanCommitSecrets, scanCommitsSecrets } from './commit-secrets.mjs';
import { commitAll, gitFixture } from './test-helpers.mjs';

test('changed-blob scans exclude inherited secrets and retain intermediate, merge, and symlink coverage', t => {
  const {root, git} = gitFixture(t, 'nose-changed-secrets-');
  const token = ['gh','p_'].join('') + randomBytes(18).toString('hex');
  writeFileSync(join(root, 'old.txt'), `token=${token}\n`);
  const initial = commitAll(git);
  assert.equal(scanCommitSecrets(root, initial).status, 'blocked');
  writeFileSync(join(root, 'README.md'), '# Documentation\n');
  const docs = commitAll(git);
  assert.equal(scanCommitSecrets(root, docs).status, 'passed');
  writeFileSync(join(root, 'new.txt'), `token=${token}\n`);
  const added = commitAll(git);
  git('rm', '-q', 'new.txt'); git('commit', '-qm', 'remove fixture');
  assert.equal(scanCommitSecrets(root, added).status, 'blocked');
  assert.equal(scanCommitSecrets(root, git('rev-parse', 'HEAD')).status, 'passed');
  symlinkSync(token, join(root, 'reference'));
  assert.equal(scanCommitSecrets(root, commitAll(git)).status, 'blocked');
  git('switch', '-qc', 'side', docs);
  writeFileSync(join(root, 'merge.txt'), `token=${token}\n`); commitAll(git);
  git('switch', '-qc', 'merge-target', docs);
  writeFileSync(join(root, 'other.txt'), 'safe\n'); commitAll(git);
  git('merge', '--no-ff', '-qm', 'merge fixture', 'side');
  const merged = scanCommitSecrets(root, git('rev-parse', 'HEAD'));
  assert.equal(merged.status, 'blocked');
  assert.ok(merged.findings.some(f => f.file === 'merge.txt'));
  assert.ok(!JSON.stringify(merged).includes(token));
});

function instrumentDetector(t, root, fail = false) {
  const directory = join(root, '.git', 'detector');
  mkdirSync(directory);
  const log = join(directory, 'calls.jsonl');
  writeFileSync(join(directory, 'gitleaks'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const args = process.argv.slice(2), directory = args[1];
const files = fs.readdirSync(directory).map(file => {
  const bytes = fs.readFileSync(path.join(directory, file));
  return {file, size: bytes.length, hash: crypto.createHash('sha256').update(bytes).digest('hex')};
});
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(files) + '\\n');
if (${fail}) process.exit(2);
fs.writeFileSync(args[args.indexOf('--report-path') + 1], JSON.stringify(files.map(item => ({File: item.file, RuleID: 'fixture', StartLine: 1}))));
process.exit(files.length ? 1 : 0);
`, {mode: 0o700});
  const previous = process.env.PATH;
  process.env.PATH = directory + ':' + previous;
  t.after(() => { process.env.PATH = previous; });
  return () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

test('shared blobs scan once and fan out to all historical paths with binary bytes intact', t => {
  const {root, git} = gitFixture(t, 'nose-batch-binary-');
  const calls = instrumentDetector(t, root);
  const bytes = Buffer.concat([Buffer.from('\0\nabcdef blob 100\n'), Buffer.from([255, 254, 128]), randomBytes(70000)]);
  writeFileSync(join(root, 'first\nfile.bin'), bytes);
  writeFileSync(join(root, 'second.bin'), bytes);
  const initial = commitAll(git);
  git('rm', '-q', 'first\nfile.bin', 'second.bin');
  const removed = commitAll(git);
  writeFileSync(join(root, 'third.bin'), bytes);
  const restored = commitAll(git);
  const results = scanCommitsSecrets(root, [initial, removed, restored]);
  assert.deepEqual(results.get(initial).findings.map(item => item.file).sort(), ['first\nfile.bin', 'second.bin']);
  assert.equal(results.get(removed).status, 'passed');
  assert.deepEqual(results.get(restored).findings, [{rule: 'fixture', line: 1, file: 'third.bin'}]);
  assert.deepEqual(calls(), [[{file: '0.blob', size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex')}]]);
  scanCommitsSecrets(root, [restored]);
  assert.equal(calls().length, 2, 'no cache survives another invocation');
});

test('detector batches obey file and byte budgets without skipping oversized blobs', t => {
  const {root, git} = gitFixture(t, 'nose-batch-bounds-');
  const calls = instrumentDetector(t, root);
  for (let index = 0; index < 257; index++) writeFileSync(join(root, `small-${index}.txt`), `unique ${index}`);
  const smallResult = scanCommitSecrets(root, commitAll(git));
  assert.equal(smallResult.findings.length, 257);
  assert.deepEqual(calls().map(batch => batch.length), [256, 1]);
  for (const [name, size, fill] of [['large-a', 17, 1], ['large-b', 17, 2], ['oversized', 33, 3]])
    writeFileSync(join(root, name), Buffer.alloc(size * 1024 * 1024, fill));
  const result = scanCommitSecrets(root, commitAll(git));
  assert.equal(result.status, 'blocked');
  assert.equal(result.findings.length, 3);
  const batches = calls().slice(2);
  assert.ok(batches.length > 1);
  assert.equal(batches.flat().length, 3);
  for (const batch of batches) {
    assert.ok(batch.length <= 256);
    assert.ok(batch.reduce((sum, file) => sum + file.size, 0) <= 32 * 1024 * 1024 || batch.length === 1);
  }
});

test('detector failure makes every requested commit unavailable and exposes no blob content', t => {
  const {root, git} = gitFixture(t, 'nose-batch-failed-');
  instrumentDetector(t, root, true);
  writeFileSync(join(root, 'first'), 'private fixture content');
  const first = commitAll(git);
  writeFileSync(join(root, 'second'), 'other private fixture');
  const second = commitAll(git);
  const results = scanCommitsSecrets(root, [first, second]);
  for (const result of results.values()) {
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.findings, []);
    assert.ok(!JSON.stringify(result).includes('private'));
  }
  assert.equal(scanCommitSecrets(root, 'missing-commit').status, 'unavailable');
  git('rm', '-q', 'first', 'second');
  assert.equal(scanCommitSecrets(root, commitAll(git)).status, 'unavailable', 'empty inventories still verify detector availability');
});
