import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runner = new URL('./nose-pre-push.mjs', import.meta.url).pathname;

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nose-large-push-test-')));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const git = (...args) => execFileSync('git', args, {cwd:root, encoding:'utf8'}).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  writeFileSync(join(root, 'fixture.txt'), 'fixture\n');
  git('add', 'fixture.txt');
  git('commit', '-qm', 'initial fixture');
  const run = (local, remote) => spawnSync(
    process.execPath,
    [runner, 'origin', 'local-fixture'],
    {
      cwd: root,
      input: `refs/heads/main ${local} refs/heads/main ${remote}\n`,
      encoding: 'utf8',
      timeout: 180_000,
    },
  );
  const report = () => JSON.parse(readFileSync(join(root, '.nose-review/report.json'), 'utf8'));
  return {root, git, run, report};
}

test('pre-push supports archives larger than the legacy memory buffer', t => {
  const {root, git, run, report} = fixture(t);
  const file = join(root, 'large.bin');
  const descriptor = openSync(file, 'w');
  try {
    ftruncateSync(descriptor, 130 * 1024 * 1024);
  } finally {
    closeSync(descriptor);
  }
  git('add', 'large.bin');
  git('commit', '-qm', 'large archive fixture');
  const remote = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'app.js'), 'export const answer = 42;\n');
  git('add', 'app.js');
  git('commit', '-qm', 'source fixture');
  const result = run(git('rev-parse', 'HEAD'), remote);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report().gateStatus, 'passed');
});

test('pre-push supports more than twenty thousand tree entries', t => {
  const {root, git, run, report} = fixture(t);
  const directory = join(root, 'many');
  mkdirSync(directory);
  for (let index = 0; index < 20_001; index += 1) {
    writeFileSync(join(directory, `${index}.txt`), '');
  }
  git('add', 'many');
  git('commit', '-qm', 'large tree fixture');
  const remote = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'app.js'), 'export const answer = 42;\n');
  git('add', 'app.js');
  git('commit', '-qm', 'source fixture');
  const result = run(git('rev-parse', 'HEAD'), remote);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report().gateStatus, 'passed');
});
