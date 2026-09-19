import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { commitAll, gitFixture, readReport } from './test-helpers.mjs';

const runner = new URL('./nose-pre-push.mjs', import.meta.url).pathname;

function fixture(t) {
  const {root, git} = gitFixture(t, 'nose-large-push-test-');
  writeFileSync(join(root, 'fixture.txt'), 'fixture\n');
  commitAll(git, 'initial fixture');
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
  return {root, git, run};
}

test('pre-push supports archives larger than the legacy memory buffer', t => {
  const {root, git, run} = fixture(t);
  const file = join(root, 'large.bin');
  const descriptor = openSync(file, 'w');
  try {
    ftruncateSync(descriptor, 130 * 1024 * 1024);
  } finally {
    closeSync(descriptor);
  }
  const remote = commitAll(git, 'large archive fixture');
  writeFileSync(join(root, 'app.js'), 'export const answer = 42;\n');
  const result = run(commitAll(git, 'source fixture'), remote);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readReport(root).gateStatus, 'passed');
});

test('pre-push supports more than twenty thousand tree entries', t => {
  const {root, git, run} = fixture(t);
  const directory = join(root, 'many');
  mkdirSync(directory);
  for (let index = 0; index < 20_001; index += 1) {
    writeFileSync(join(directory, `${index}.txt`), '');
  }
  const remote = commitAll(git, 'large tree fixture');
  writeFileSync(join(root, 'app.js'), 'export const answer = 42;\n');
  const result = run(commitAll(git, 'source fixture'), remote);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readReport(root).gateStatus, 'passed');
});
