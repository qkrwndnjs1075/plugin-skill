import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function gitFixture(t, prefix, {subdirectory} = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  const root = subdirectory ? join(directory, subdirectory) : directory;
  if (subdirectory) mkdirSync(root);
  const git = (...args) => execFileSync('git', args, {cwd:root, encoding:'utf8'}).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  return {root, git, directory};
}

export function countRecordedCalls(path) {
  return readFileSync(path, 'utf8').trim().split('\n').length;
}

export function commitAll(git, message = 'fixture') {
  git('add', '.');
  git('commit', '-qm', message);
  return git('rev-parse', 'HEAD');
}

export function readReport(root) {
  return JSON.parse(readFileSync(join(root, '.nose-review/report.json'), 'utf8'));
}

export function pushGit(root, refspec = 'HEAD:main') {
  return spawnSync('git', ['push', 'origin', refspec], {cwd:root, encoding:'utf8'});
}
