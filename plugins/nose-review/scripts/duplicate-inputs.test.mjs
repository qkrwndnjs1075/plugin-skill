import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sameDuplicateInputs } from './review-runtime.mjs';
import { install } from './install-pre-push.mjs';

test('unchanged duplicate inputs use Git identity while secrets still gate a real push', t => {
  const root = mkdtempSync(join(tmpdir(), 'nose-inputs-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const git = (...args) => execFileSync('git', args, {cwd:root, encoding:'utf8'}).trim();
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'app.js'), 'export const answer = 42;');
  const base = commit();
  const remote = root + '-remote';
  t.after(() => rmSync(remote, {recursive:true, force:true}));
  git('init', '--bare', '-q', remote); git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'HEAD:main');
  writeFileSync(join(root, 'README.md'), '# Documentation');
  const docs = commit();
  assert.equal(sameDuplicateInputs(root, [base, docs]), true);
  install(root);
  const push = () => spawnSync('git', ['push', 'origin', 'HEAD:main'], {cwd:root, encoding:'utf8'});
  assert.equal(push().status, 0);
  const report = () => JSON.parse(readFileSync(join(root, '.nose-review/report.json'), 'utf8'));
  assert.equal(report().refs[0].duplication.status, 'unchanged');
  const token = ['gh','p_'].join('') + randomBytes(18).toString('hex');
  writeFileSync(join(root, 'README.md'), `token=${token}\n`); commit();
  assert.notEqual(push().status, 0);
  assert.equal(report().refs[0].secrets.status, 'blocked');
  for (const file of ['app.js', 'nose.config.json', '.gitattributes']) {
    const previous = git('rev-parse', 'HEAD');
    writeFileSync(join(root, file), 'changed');
    assert.equal(sameDuplicateInputs(root, [previous, commit()]), false);
  }
  const beforeBaseline = git('rev-parse', 'HEAD');
  mkdirSync(join(root, '.nose-review'), {recursive:true});
  writeFileSync(join(root, '.nose-review/baseline.json'), '{}');
  assert.equal(sameDuplicateInputs(root, [beforeBaseline, commit()]), false);
  const beforeSymlink = git('rev-parse', 'HEAD');
  symlinkSync('app.js', join(root, 'alias.md'));
  assert.equal(sameDuplicateInputs(root, [beforeSymlink, commit()]), false);
});
