#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, shellQuote } from './review-runtime.mjs';

function setting(root, key, boolean = false) {
  const args = boolean
    ? ['config', '--type=bool', '--default=true', '--get', key]
    : ['config', '--get', key];
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 });
  if (result.error || (result.status !== 0 && (boolean || result.status !== 1)))
    throw new Error('Cannot read Git setting ' + key);
  return boolean ? result.stdout.trim() === 'true' : result.stdout.trim();
}

export function disabledSetting(root) {
  return ['hook.nose-review.enabled', 'hook.pre-push.enabled'].find(key => !setting(root, key, true));
}

function registration(root) {
  const hook = join(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(), 'nose-review', 'pre-push');
  const command = setting(root, 'hook.nose-review.command');
  const event = setting(root, 'hook.nose-review.event');
  if ((command && command !== shellQuote(hook)) || (event && event !== 'pre-push'))
    throw new Error('Nose Review registration belongs to another hook; its settings were preserved.');
  return { hook, command, event };
}

export function status(root) {
  const disabledBy = disabledSetting(root);
  if (disabledBy) return { state: 'off', root, disabledBy };
  const { hook, command, event } = registration(root);
  const file = lstatSync(hook, { throwIfNoEntry: false });
  if (!command || !event || !file?.isFile() || !(file.mode & 0o111))
    throw new Error('Nose Review is not ready; run $nose-review on to register or repair it.');
  if (!git(root, ['hook', 'list', '-z', 'pre-push']).split('\0').includes('nose-review'))
    throw new Error('Git does not list Nose Review as an active pre-push hook.');
  for (const [tool, args] of [['nose', ['--version']], ['gitleaks', ['version']]]) {
    const probe = spawnSync(tool, args, { cwd: root, encoding: 'utf8', timeout: 10000 });
    if (probe.error || probe.status !== 0) throw new Error(tool + ' is unavailable; install it and retry $nose-review status.');
  }
  return { state: 'on', root, hook };
}

export function configure(cwd, action) {
  if (!['on', 'off', 'status'].includes(action)) throw new Error('Usage: project-settings.mjs PROJECT on|off|status');
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  if (action !== 'status') {
    registration(root);
    git(root, ['config', '--local', '--replace-all', 'hook.nose-review.enabled', String(action === 'on')]);
  }
  if (action === 'on') {
    const disabledBy = disabledSetting(root);
    if (disabledBy) throw new Error(disabledBy + ' still disables this worktree; its override was preserved.');
    const setup = spawnSync(process.execPath, [fileURLToPath(new URL('./install-pre-push.mjs', import.meta.url)), root],
      { cwd: root, encoding: 'utf8', timeout: 30000 });
    if (setup.error || setup.status !== 0) throw new Error('Nose Review setup failed: ' + (setup.stdout?.trim() || setup.error?.message || 'see installation prerequisites.'));
  }
  const result = status(root);
  if (action === 'on' && result.state !== 'on') throw new Error('Nose Review was disabled during setup; run status before retrying.');
  if (action === 'off' && result.state !== 'off') throw new Error('A worktree or command-scope override keeps Nose Review enabled.');
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: project-settings.mjs PROJECT on|off|status');
    console.log(JSON.stringify(configure(process.argv[2], process.argv[3])));
  } catch (error) {
    console.log(JSON.stringify({ state: 'error', reason: error.message }));
    process.exitCode = 2;
  }
}
