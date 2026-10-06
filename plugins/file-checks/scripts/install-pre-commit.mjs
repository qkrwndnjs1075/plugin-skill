#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, disabledSetting, registration, hookCommand } from './project-settings.mjs';

const source = dirname(fileURLToPath(import.meta.url));

export function install(cwd) {
  const location = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 10000 });
  if (location.error) throw new Error('Git is unavailable; install Git and retry.');
  if (location.status !== 0) return { status: 'skipped', reason: 'No Git worktree' };
  const root = location.stdout.trim();
  const disabledBy = disabledSetting(root);
  if (disabledBy) return { status: 'off', root, disabledBy };
  const capability = spawnSync('git', ['-c', 'hook.file-checks-probe.event=file-checks-probe',
    '-c', 'hook.file-checks-probe.command=true', 'hook', 'list', '--allow-unknown-hook-name', '-z', 'file-checks-probe'],
  { cwd: root, encoding: 'utf8', timeout: 10000 });
  if (capability.status !== 0 || !capability.stdout.split('\0').includes('file-checks-probe'))
    throw new Error('File Checks requires Git configured hooks (Git 2.54 or newer).');
  const { directory, command: existing, event } = registration(root);
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('File Checks state path must be a real directory.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const script = readFileSync(join(source, 'check-staged.py'));
  const lock = readFileSync(join(source, 'check-staged.py.lock'));
  const digest = createHash('sha256').update(script).update(lock).digest('hex');
  const payload = join(directory, 'check-staged-' + digest + '.py');
  for (const [path, bytes] of [[payload, script], [payload + '.lock', lock]]) {
    const prior = lstatSync(path, { throwIfNoEntry: false });
    if (prior && (!prior.isFile() || prior.isSymbolicLink() || !readFileSync(path).equals(bytes)))
      throw new Error('File Checks payload has changed; inspect ' + path);
    if (!prior) writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  }
  const uv = spawnSync('uv', ['python', 'find', '--no-config'], { cwd: directory, encoding: 'utf8', timeout: 10000 });
  if (uv.error || uv.status !== 0) throw new Error('Install uv and Python 3.10+ before enabling File Checks.');
  const runArgs = ['run', '--no-config', '--no-project', '--locked', '--script', payload];
  const prepared = spawnSync('uv', [...runArgs, '--probe'], { cwd: directory, encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024 });
  if (prepared.error || prepared.status !== 0) throw new Error('Could not prepare pre-commit-hooks; check uv, Python, and package access, then reopen the project.');
  const command = hookCommand(payload);
  if (event !== 'pre-commit') git(root, ['config', '--local', '--replace-all', 'hook.file-checks.event', 'pre-commit']);
  if (existing !== command) git(root, ['config', '--local', '--replace-all', 'hook.file-checks.command', command]);
  if (!git(root, ['hook', 'list', '-z', 'pre-commit']).split('\0').includes('file-checks'))
    throw new Error('Git configuration overrides the File Checks registration.');
  return { status: existing === command && event === 'pre-commit' ? 'current' : 'installed', root };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const automatic = process.argv.length === 2;
  try {
    const cwd = automatic ? JSON.parse(readFileSync(0, 'utf8')).cwd : process.argv[2];
    if (typeof cwd !== 'string' || !existsSync(cwd)) throw new Error('An existing project directory is required.');
    const result = install(cwd);
    if (automatic) {
      if (result.status === 'installed') process.stdout.write(JSON.stringify({ systemMessage: 'File Checks pre-commit installed. Staged files are checked without modifying working files or the index.' }) + '\n');
      if (result.status === 'off') process.stdout.write(JSON.stringify({ systemMessage: 'File Checks: OFF (' + result.disabledBy + '); project setting preserved.' }) + '\n');
    } else process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ systemMessage: 'File Checks setup unavailable: ' + error.message }) + '\n');
    if (!automatic) process.exitCode = 1;
  }
}
