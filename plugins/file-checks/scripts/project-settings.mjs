#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const hookArgs = ['uv', 'run', '--offline', '--no-config', '--no-project', '--locked', '--script'];
const groups = ['whitespace', 'syntax'];
export const hookCommand = payload => [...hookArgs, payload].map(quote).join(' ');

export function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 });
  if (result.error || result.status !== 0) throw new Error('Git could not complete File Checks settings.');
  return result.stdout.trim();
}

export function config(root, key, boolean = false) {
  const args = boolean ? ['--type=bool', '--default=true', '--get'] : ['--get-all'];
  const result = spawnSync('git', ['config', ...args, key], { cwd: root, encoding: 'utf8', timeout: 10000 });
  if (result.error || (result.status !== 0 && (boolean || result.status !== 1))) throw new Error('Cannot read ' + key);
  return boolean ? result.stdout.trim() === 'true' : result.stdout.trim();
}

export function disabledSetting(root) {
  return ['hook.file-checks.enabled', 'hook.pre-commit.enabled'].find(key => !config(root, key, true));
}

export function registration(root) {
  const directory = join(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'file-checks');
  const command = config(root, 'hook.file-checks.command');
  const event = config(root, 'hook.file-checks.event');
  const prefix = hookArgs.map(quote).join(' ') + ' ' + quote(join(directory, 'check-staged-')).slice(0, -1);
  const suffix = command.startsWith(prefix) ? command.slice(prefix.length) : '';
  if ((event && event !== 'pre-commit') || (command && !/^[0-9a-f]{64}\.py'$/.test(suffix)))
    throw new Error('File Checks registration belongs to another hook; its settings were preserved.');
  return { directory, command, event, payload: command ? join(directory, 'check-staged-' + suffix.slice(0, -1)) : null };
}

export function status(root) {
  const checks = Object.fromEntries(groups.map(group => [group, config(root, 'file-checks.' + group, true)]));
  const disabledBy = disabledSetting(root);
  if (disabledBy) return { state: 'off', root, disabledBy, checks };
  const { payload, command, event } = registration(root);
  if (!command || !event || !payload || !lstatSync(payload, { throwIfNoEntry: false })?.isFile()
    || !lstatSync(payload + '.lock', { throwIfNoEntry: false })?.isFile())
    throw new Error('File Checks is not ready; run $file-checks on to register or repair it.');
  if (!git(root, ['hook', 'list', '-z', 'pre-commit']).split('\0').includes('file-checks'))
    throw new Error('Git does not list File Checks as an active pre-commit hook.');
  const probe = spawnSync('uv', [...hookArgs.slice(1, -1), '--no-sync', '--script', payload, '--probe'], {
    cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
  });
  if (probe.error || probe.status !== 0) throw new Error('File Checks dependencies are unavailable; run $file-checks on to prepare them.');
  return { state: 'on', root, checks };
}

export function configure(cwd, args) {
  const [action, value] = args;
  const whole = args.length === 1 && ['on', 'off', 'status'].includes(action);
  const group = args.length === 2 && groups.includes(action) && ['on', 'off'].includes(value);
  if (!whole && !group) throw new Error('Usage: project-settings.mjs PROJECT on|off|status|whitespace on|off|syntax on|off');
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  if (action !== 'status') {
    registration(root);
    const key = group ? 'file-checks.' + action : 'hook.file-checks.enabled';
    git(root, ['config', '--local', '--replace-all', key, String((group ? value : action) === 'on')]);
  }
  if (action === 'on') {
    const disabledBy = disabledSetting(root);
    if (disabledBy) throw new Error(disabledBy + ' still disables this worktree; its override was preserved.');
    const setup = spawnSync(process.execPath, [fileURLToPath(new URL('./install-pre-commit.mjs', import.meta.url)), root],
      { cwd: root, encoding: 'utf8', timeout: 110000, maxBuffer: 1024 * 1024 });
    if (setup.error || setup.status !== 0) throw new Error('File Checks setup failed: ' + (setup.stdout?.trim() || setup.error?.message || 'see installation prerequisites.'));
  }
  const result = status(root);
  if (action === 'on' && result.state !== 'on') throw new Error('File Checks was disabled during setup; run status before retrying.');
  if (action === 'off' && result.state !== 'off') throw new Error('A worktree or command-scope override keeps File Checks enabled.');
  if (group && result.checks[action] !== (value === 'on')) throw new Error('A worktree or command-scope override keeps ' + action + ' unchanged.');
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    console.log(JSON.stringify(configure(process.argv[2], process.argv.slice(3))));
  } catch (error) {
    console.log(JSON.stringify({ state: 'error', reason: error.message }));
    process.exitCode = 2;
  }
}
