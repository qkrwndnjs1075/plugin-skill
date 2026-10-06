import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { duplicateSource } from '../plugins/nose-review/scripts/test-helpers.mjs';

const plugins = resolve(dirname(fileURLToPath(import.meta.url)), '../plugins');
const packages = [
  { name: 'nose-review', event: 'pre-push', installer: 'install-pre-push.mjs' },
];

function fixture(t, name) {
  const temp = mkdtempSync(join(tmpdir(), 'project-controls-'));
  const root = join(temp, 'project');
  mkdirSync(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(temp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']) delete env[key];
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const run = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 110000, maxBuffer: 2 * 1024 * 1024 });
    assert.ifError(result.error);
    return result;
  };
  const git = (...args) => {
    const result = run('git', args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('-c', 'init.templateDir=', 'init', '-q');
  git('config', 'user.name', 'Project Controls Test');
  git('config', 'user.email', 'controls@example.invalid');
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const script = join(plugins, name, 'scripts/project-settings.mjs');
  const control = (...args) => {
    const result = run(process.execPath, [script, root, ...args]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const stage = (file, text) => { writeFileSync(join(root, file), text); git('add', '--', file); };
  const commit = () => run('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Control fixture']);
  return { root, temp, env, run, git, script, control, stage, commit };
}

for (const pkg of packages) {
  test(`${pkg.name}: OFF survives SessionStart and repeated installation without preparing dependencies`, t => {
    const f = fixture(t, pkg.name);
    assert.equal(f.control('off').state, 'off');
    const config = readFileSync(join(f.root, '.git/config'));
    const install = join(plugins, pkg.name, 'scripts', pkg.installer);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync(process.execPath, [install], { cwd: f.root, env: f.env, input: JSON.stringify({ cwd: f.root }), encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      const response = JSON.parse(result.stdout);
      assert.match(response.systemMessage, /OFF/);
      assert.equal(response.hookSpecificOutput, undefined);
    }
    assert.equal(f.control('status').state, 'off');
    assert.deepEqual(readFileSync(join(f.root, '.git/config')), config);
    assert.equal(existsSync(join(f.root, '.git', pkg.name)), false);
  });

  test(`${pkg.name}: status distinguishes an unregistered gate without installing it`, t => {
    const f = fixture(t, pkg.name);
    const config = readFileSync(join(f.root, '.git/config'));
    const result = f.run(process.execPath, [f.script, f.root, 'status']);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).state, 'error');
    assert.deepEqual(readFileSync(join(f.root, '.git/config')), config);
    assert.equal(existsSync(join(f.root, '.git', pkg.name)), false);
  });

  test(`${pkg.name}: toggles are isolated by repository and shared by linked worktrees`, t => {
    const f = fixture(t, pkg.name);
    const other = fixture(t, pkg.name);
    assert.equal(f.control('on').state, 'on');
    assert.equal(other.control('on').state, 'on');
    f.stage('seed.txt', 'seed\n');
    assert.equal(f.commit().status, 0);
    const linked = join(f.temp, 'linked');
    f.git('worktree', 'add', '-qb', 'linked', linked);
    assert.equal(f.control('off').state, 'off');
    const linkedStatus = f.run(process.execPath, [f.script, linked, 'status'], linked);
    assert.equal(JSON.parse(linkedStatus.stdout).state, 'off');
    assert.equal(other.control('status').state, 'on');
    assert.equal(f.control('on').state, 'on');
    const active = f.run('git', ['hook', 'list', '-z', pkg.event], linked);
    assert.ok(active.stdout.split('\0').includes(pkg.name));
  });

  test(`${pkg.name}: malformed settings are errors and event overrides are preserved`, t => {
    const f = fixture(t, pkg.name);
    f.git('config', 'hook.' + pkg.name + '.enabled', 'invalid');
    let result = f.run(process.execPath, [f.script, f.root, 'status']);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).state, 'error');
    f.git('config', 'hook.' + pkg.event + '.enabled', 'false');
    result = f.run(process.execPath, [f.script, f.root, 'on']);
    assert.equal(result.status, 2);
    assert.match(JSON.parse(result.stdout).reason, /override was preserved/);
    assert.equal(f.git('config', '--get', 'hook.' + pkg.event + '.enabled'), 'false');
    assert.equal(f.control('status').state, 'off');
  });

  test(`${pkg.name}: existing worktree overrides remain visible after a repository-local on request`, t => {
    const f = fixture(t, pkg.name);
    f.git('config', 'extensions.worktreeConfig', 'true');
    f.git('config', '--worktree', 'hook.' + pkg.name + '.enabled', 'false');
    const result = f.run(process.execPath, [f.script, f.root, 'on']);
    assert.equal(result.status, 2);
    assert.match(JSON.parse(result.stdout).reason, /override was preserved/);
    assert.equal(f.git('config', '--worktree', '--get', 'hook.' + pkg.name + '.enabled'), 'false');
    assert.equal(f.control('status').state, 'off');
  });
}

test('Nose Review: OFF permits a local push and ON restores duplication blocking', t => {
  const f = fixture(t, 'nose-review');
  f.stage('a.js', duplicateSource('alpha'));
  f.stage('b.js', duplicateSource('beta'));
  assert.equal(f.commit().status, 0);
  const remote = join(f.temp, 'remote.git');
  f.git('init', '--bare', '-q', remote);
  f.git('remote', 'add', 'origin', remote);
  f.control('on');
  let pushed = f.run('git', ['push', 'origin', 'HEAD:refs/heads/first']);
  assert.notEqual(pushed.status, 0);
  assert.match(pushed.stderr, /NOSE_DUPLICATION_BLOCKED/);
  f.control('off');
  pushed = f.run('git', ['push', 'origin', 'HEAD:refs/heads/first']);
  assert.equal(pushed.status, 0, pushed.stderr);
  f.control('on');
  f.stage('c.js', duplicateSource('gamma'));
  assert.equal(f.commit().status, 0);
  pushed = f.run('git', ['push', 'origin', 'HEAD:refs/heads/first']);
  assert.notEqual(pushed.status, 0);
  assert.match(pushed.stderr, /NOSE_DUPLICATION_BLOCKED/);
});
