import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { sameDuplicateInputs } from './review-runtime.mjs';
import { install } from './install-pre-push.mjs';
import { commitAll, gitFixture, pushGit, readReport } from './test-helpers.mjs';

test('unchanged duplicate inputs use Git identity while secrets still gate a real push', t => {
  const {root, git} = gitFixture(t, 'nose-inputs-');
  writeFileSync(join(root, 'app.js'), 'export const answer = 42;');
  const base = commitAll(git);
  const remote = root + '-remote';
  t.after(() => rmSync(remote, {recursive:true, force:true}));
  git('init', '--bare', '-q', remote); git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'HEAD:main');
  writeFileSync(join(root, 'README.md'), '# Documentation');
  const docs = commitAll(git);
  assert.equal(sameDuplicateInputs(root, [base, docs]), true);
  install(root);
  const push = () => pushGit(root);
  assert.equal(push().status, 0);
  assert.equal(readReport(root).refs[0].duplication.status, 'unchanged');
  const token = ['gh','p_'].join('') + randomBytes(18).toString('hex');
  writeFileSync(join(root, 'README.md'), `token=${token}\n`); commitAll(git);
  assert.notEqual(push().status, 0);
  assert.equal(readReport(root).refs[0].secrets.status, 'blocked');
  for (const file of ['app.js', 'nose.config.json', '.gitattributes']) {
    const previous = git('rev-parse', 'HEAD');
    writeFileSync(join(root, file), 'changed');
    assert.equal(sameDuplicateInputs(root, [previous, commitAll(git)]), false);
  }
  const beforeBaseline = git('rev-parse', 'HEAD');
  mkdirSync(join(root, '.nose-review'), {recursive:true});
  writeFileSync(join(root, '.nose-review/baseline.json'), '{}');
  assert.equal(sameDuplicateInputs(root, [beforeBaseline, commitAll(git)]), false);
  const beforeSymlink = git('rev-parse', 'HEAD');
  symlinkSync('app.js', join(root, 'alias.md'));
  assert.equal(sameDuplicateInputs(root, [beforeSymlink, commitAll(git)]), false);
});
