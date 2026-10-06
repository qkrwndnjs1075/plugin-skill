import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installer = join(plugin, 'scripts/install-pre-commit.mjs');

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'file-checks-test-'));
  const root = join(directory, 'project');
  mkdirSync(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(directory, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']) delete env[key];
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const run = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 110000 });
    assert.ifError(result.error);
    return result;
  };
  const git = (...args) => run('git', args);
  assert.equal(git('-c', 'init.templateDir=', 'init', '-q').status, 0);
  assert.equal(git('config', 'user.name', 'File Checks Test').status, 0);
  assert.equal(git('config', 'user.email', 'file-checks@example.invalid').status, 0);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const install = (entry = installer) => {
    const result = run(process.execPath, [entry, root]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(['installed', 'current'].includes(JSON.parse(result.stdout).status));
    return result;
  };
  const stage = (name, content) => {
    writeFileSync(join(root, name), content);
    assert.equal(git('add', '--', name).status, 0);
  };
  const commit = () => git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'File Checks fixture');
  return { directory, root, env, run, git, install, stage, commit };
}

test('real commit accepts valid text, Markdown hard breaks, CRLF, tagged YAML, and configuration syntax', t => {
  const f = fixture(t);
  f.install();
  f.stage('valid.json', '{"ok": true}\n');
  f.stage('valid.toml', 'ok = true\n');
  f.stage('valid.yaml', 'value: !ApplicationTag hello\n---\nok: true\n');
  f.stage('readme.md', 'Intentional break  \nNext line\n');
  f.stage('windows.txt', 'first\r\nsecond\r\n');
  f.stage('binary.dat', Buffer.from([0, 255, 32, 32]));
  f.stage('comments.jsonc', '// JSONC is not parsed as JSON\n');
  symlinkSync('not-present.json', join(f.root, 'link.json'));
  assert.equal(f.git('add', 'link.json').status, 0);
  const result = f.commit();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git('status', '--porcelain').stdout, '');
});

for (const [name, content, rule] of [
  ['trailing.txt', 'text \n', 'trailing-whitespace'],
  ['newline.txt', 'text', 'end-of-file-fixer'],
  ['mixed.txt', 'first\r\nsecond\n', 'mixed-line-ending'],
  ['invalid.json', '{broken}\n', 'check-json'],
  ['invalid.yaml', 'values: [\n', 'check-yaml'],
  ['invalid.toml', 'value = [\n', 'check-toml'],
  ['invalid-encoding.json', Buffer.from([255, 10]), 'expected UTF-8 configuration text'],
]) {
  test(`real commit rejects ${rule} without altering the working file or index`, t => {
    const f = fixture(t);
    f.install();
    f.stage(name, content);
    const index = f.git('ls-files', '--stage', '-z').stdout;
    const staged = f.git('show', ':' + name).stdout;
    const result = f.commit();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /FILE_CHECKS_BLOCKED/);
    assert.ok(result.stderr.includes(rule), result.stderr);
    assert.deepEqual(readFileSync(join(f.root, name)), Buffer.from(content));
    assert.equal(f.git('show', ':' + name).stdout, staged);
    assert.equal(f.git('ls-files', '--stage', '-z').stdout, index);
    assert.notEqual(f.git('rev-parse', '--verify', 'HEAD').status, 0);
  });
}

test('partial staging rejects bad staged content even when the working copy is fixed', t => {
  const f = fixture(t);
  f.install();
  f.stage('config.json', '{invalid}\n');
  writeFileSync(join(f.root, 'config.json'), '{}\n');
  const result = f.commit();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /check-json/);
  assert.equal(f.git('show', ':config.json').stdout, '{invalid}\n');
  assert.equal(readFileSync(join(f.root, 'config.json'), 'utf8'), '{}\n');
});

test('partial staging commits good staged content and preserves bad unstaged edits', t => {
  const f = fixture(t);
  f.install();
  f.stage('config.json', '{}\n');
  writeFileSync(join(f.root, 'config.json'), '{unfinished}\n');
  const result = f.commit();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git('show', 'HEAD:config.json').stdout, '{}\n');
  assert.equal(readFileSync(join(f.root, 'config.json'), 'utf8'), '{unfinished}\n');
});

test('commit --only checks its temporary index and preserves unrelated staged changes', t => {
  const f = fixture(t);
  f.stage('config.json', '{}\n');
  f.stage('selected.txt', 'before\n');
  assert.equal(f.commit().status, 0);
  f.install();
  f.stage('config.json', '{invalid}\n');
  writeFileSync(join(f.root, 'selected.txt'), 'after\n');
  const result = f.git('-c', 'commit.gpgsign=false', 'commit', '--only', '-qm', 'Selected fixture', '--', 'selected.txt');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git('show', 'HEAD:config.json').stdout, '{}\n');
  assert.equal(f.git('show', ':config.json').stdout, '{invalid}\n');
  assert.equal(f.git('show', 'HEAD:selected.txt').stdout, 'after\n');
});

test('configured hook preserves and invokes an existing hooksPath hook across repeated installation', t => {
  const f = fixture(t);
  const hooks = join(f.root, 'user-hooks');
  mkdirSync(hooks);
  const original = '#!/bin/sh\nprintf existing-hook > hook-ran\n';
  writeFileSync(join(hooks, 'pre-commit'), original, { mode: 0o755 });
  assert.equal(f.git('config', 'core.hooksPath', hooks).status, 0);
  f.install();
  assert.equal(JSON.parse(f.install().stdout).status, 'current');
  f.stage('valid.txt', 'valid\n');
  assert.equal(f.commit().status, 0);
  assert.equal(readFileSync(join(f.root, 'hook-ran'), 'utf8'), 'existing-hook');
  assert.equal(readFileSync(join(hooks, 'pre-commit'), 'utf8'), original);
  assert.equal(f.git('config', '--get', 'core.hooksPath').stdout.trim(), hooks);
});

test('linked worktree uses its own index and shares the installed gate', t => {
  const f = fixture(t);
  f.stage('base.txt', 'base\n');
  assert.equal(f.commit().status, 0);
  f.install();
  const linked = join(f.directory, 'linked');
  assert.equal(f.git('worktree', 'add', '-qb', 'linked', linked).status, 0);
  writeFileSync(join(linked, 'config.toml'), 'invalid = [\n');
  assert.equal(f.run('git', ['add', 'config.toml'], linked).status, 0);
  const result = f.run('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Rejected fixture'], linked);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /check-toml/);
  assert.equal(f.git('status', '--porcelain').stdout, '');
});

test('copied payload continues checking when the installed plugin cache disappears', t => {
  const f = fixture(t);
  const cache = join(f.directory, 'plugin-cache');
  cpSync(plugin, cache, { recursive: true });
  f.install(join(cache, 'scripts/install-pre-commit.mjs'));
  rmSync(cache, { recursive: true });
  f.stage('invalid.json', '{invalid}\n');
  const result = f.commit();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /check-json/);
});

test('installer leaves another registration and explicitly disabled hooks untouched', t => {
  const f = fixture(t);
  assert.equal(f.git('config', 'hook.file-checks.command', 'echo user-owned').status, 0);
  let result = f.run(process.execPath, [installer, f.root]);
  assert.notEqual(result.status, 0);
  assert.equal(f.git('config', '--get', 'hook.file-checks.command').stdout.trim(), 'echo user-owned');
  assert.equal(f.git('config', '--unset', 'hook.file-checks.command').status, 0);
  assert.equal(f.git('config', 'hook.pre-commit.enabled', 'false').status, 0);
  result = f.run(process.execPath, [installer, f.root]);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).status, 'off');
  assert.equal(f.git('config', '--get', 'hook.file-checks.command').status, 1);
});

test('missing uv is reported before a hook is registered', t => {
  const f = fixture(t);
  const bin = join(f.directory, 'bin');
  mkdirSync(bin);
  const gitPath = f.run('sh', ['-c', 'command -v git']).stdout.trim();
  symlinkSync(gitPath, join(bin, 'git'));
  f.env.PATH = bin;
  const result = f.run(process.execPath, [installer, f.root]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Install uv/);
  assert.equal(f.git('config', '--get', 'hook.file-checks.command').status, 1);
});

test('unusual filenames stay literal and parser source excerpts do not reach the output', t => {
  const f = fixture(t);
  f.install();
  const name = '-$(touch unintended)\nfile.yaml';
  const privateText = 'synthetic-sensitive-config-value';
  f.stage(name, `value: [${privateText}\n`);
  const result = f.commit();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /check-yaml/);
  assert.ok(result.stderr.includes(JSON.stringify(name)));
  assert.ok(!result.stderr.includes(privateText));
  assert.equal(existsSync(join(f.root, 'unintended')), false);
});
