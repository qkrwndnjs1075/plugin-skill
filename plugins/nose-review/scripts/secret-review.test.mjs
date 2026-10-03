import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitAll, gitFixture } from './test-helpers.mjs';
import { scanCommitSecrets } from './commit-secrets.mjs';
import { recordNonSecretBatch } from './review-secrets.mjs';
import { findingKey, secretReviewFilename } from './secret-review.mjs';
import { install } from './install-pre-push.mjs';
import { pushGit, readReport } from './test-helpers.mjs';
import { execFileSync } from 'node:child_process';

function fixture(t) {
  const {root, git} = gitFixture(t, 'nose-non-secret-policy-');
  const publicHash = createHash('sha256').update('independently reproducible public fixture').digest('hex');
  const contents = `const cache_key = "${publicHash}"; const other_api_key = "${publicHash}";\n`;
  writeFileSync(join(root, 'public.js'), contents);
  const commit = commitAll(git);
  const raw = scanCommitSecrets(root, commit);
  assert.equal(raw.status, 'blocked');
  assert.equal(raw.findings.length, 2);
  const finding = raw.findings[0];
  const entry = {commit, file: finding.file, sourceHash: finding.sourceHash,
    kind: 'derived-public-data', reason: 'The first SHA-256 value hashes an independently reproduced public fixture.',
    findings: [{rule: finding.rule, line: finding.line, span: finding.span}]};
  mkdirSync(join(root, '.nose-review'));
  const inputPath = join(root, '.nose-review/decisions.json');
  const input = {schemaVersion: 1, detectorIdentity: raw.detectorIdentity, decisions: [entry]};
  const save = () => writeFileSync(inputPath, JSON.stringify(input));
  save();
  const policyPath = join(root, '.nose-review', secretReviewFilename);
  return {root, git, commit, raw, entry, input, inputPath, policyPath, save, contents};
}

test('recording validates full committed evidence and permits only reviewed spans on the same line', t => {
  const f = fixture(t);
  assert.deepEqual(recordNonSecretBatch(f.root, f.inputPath), {status: 'recorded', files: 1, findings: 1});
  const result = scanCommitSecrets(f.root, f.commit);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reviewedNonSecrets, 1);
  assert.equal(result.findings.length, 1);
  assert.notEqual(findingKey(result.findings[0]), findingKey(f.entry.findings[0]));
  assert.ok(!readFileSync(f.policyPath, 'utf8').includes(f.contents));
});

test('stale hashes, positions, commits, and detector versions reject the whole batch without changing prior decisions', t => {
  const f = fixture(t);
  recordNonSecretBatch(f.root, f.inputPath);
  const prior = readFileSync(f.policyPath);
  for (const mutate of [
    entry => { entry.sourceHash = '0'.repeat(64); },
    entry => { entry.findings[0].span.endColumn++; },
    entry => { entry.commit = '0'.repeat(40); },
    entry => { entry.reason = 'unknown'; },
  ]) {
    const original = JSON.parse(JSON.stringify(f.entry));
    mutate(f.input.decisions[0]); f.save();
    assert.throws(() => recordNonSecretBatch(f.root, f.inputPath));
    assert.deepEqual(readFileSync(f.policyPath), prior);
    f.input.decisions[0] = original;
  }
  f.input.detectorIdentity = 'gitleaks/0.0.0/default-rules-v1'; f.save();
  assert.throws(() => recordNonSecretBatch(f.root, f.inputPath));
  assert.deepEqual(readFileSync(f.policyPath), prior);
});

test('malformed or symlinked policy is unavailable and detector upgrades rescan all candidates', t => {
  const f = fixture(t);
  recordNonSecretBatch(f.root, f.inputPath);
  const valid = JSON.parse(readFileSync(f.policyPath, 'utf8'));
  valid.detectorIdentity = 'gitleaks/0.0.0/default-rules-v1';
  writeFileSync(f.policyPath, JSON.stringify(valid));
  assert.equal(scanCommitSecrets(f.root, f.commit).findings.length, 2);
  writeFileSync(f.policyPath, '{');
  assert.equal(scanCommitSecrets(f.root, f.commit).status, 'unavailable');
  rmSync(f.policyPath); symlinkSync(f.inputPath, f.policyPath);
  assert.equal(scanCommitSecrets(f.root, f.commit).status, 'unavailable');
  assert.throws(() => recordNonSecretBatch(f.root, f.inputPath));
  assert.ok(readFileSync(f.inputPath, 'utf8').includes('derived-public-data'));
});

test('moving a reviewed blob and adding then deleting credentials still block the historical occurrence', t => {
  const f = fixture(t);
  f.input.decisions[0].findings = f.raw.findings.map(({rule, line, span}) => ({rule, line, span})); f.save();
  recordNonSecretBatch(f.root, f.inputPath);
  assert.equal(scanCommitSecrets(f.root, f.commit).status, 'passed');
  f.git('mv', 'public.js', 'moved.js');
  const moved = commitAll(f.git);
  assert.equal(scanCommitSecrets(f.root, moved).findings.length, 2);
  const secret = ['gh', 'p_'].join('') + randomBytes(18).toString('hex');
  writeFileSync(join(f.root, 'public.js'), f.contents + `token=${secret}\n`);
  const leaked = commitAll(f.git);
  f.git('rm', 'public.js'); commitAll(f.git);
  const result = scanCommitSecrets(f.root, leaked);
  assert.equal(result.status, 'blocked');
  assert.equal(result.findings.length, 3);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('the installed hook applies exact public-data decisions and still blocks new source and tag credentials', t => {
  const f = fixture(t);
  f.input.decisions[0].findings = f.raw.findings.map(({rule, line, span}) => ({rule, line, span})); f.save();
  recordNonSecretBatch(f.root, f.inputPath);
  const remote = join(f.root, '.git', 'remote.git');
  execFileSync('git', ['init', '--bare', '-q', remote]);
  f.git('remote', 'add', 'origin', remote);
  assert.equal(install(f.root).status, 'installed');
  const first = pushGit(f.root);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readReport(f.root).refs[0].secrets.reviewedNonSecrets, 2);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], f.commit);
  const secret = ['gh', 'p_'].join('') + randomBytes(18).toString('hex');
  writeFileSync(join(f.root, 'public.js'), f.contents + `token=${secret}\n`);
  commitAll(f.git);
  const changed = pushGit(f.root);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /NOSE_SECRETS_BLOCKED/);
  f.git('tag', '-a', 'secret-tag', '-m', `token=${secret}`);
  const tag = pushGit(f.root, 'refs/tags/secret-tag');
  assert.equal(tag.status, 1);
  assert.ok(readReport(f.root).refs[0].secrets.findings.some(finding => finding.file.startsWith('git-metadata/')));
  assert.ok(!(changed.stderr + tag.stderr + JSON.stringify(readReport(f.root))).includes(secret));
});
