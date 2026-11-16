import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
const git = (...args) => run('git', args);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = 'plugins/nose-review';
const runtimePath = `${directory}/scripts/nose-runtime.json`;
const plugin = JSON.parse(readFileSync(`${directory}/.codex-plugin/plugin.json`, 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(plugin.version)) throw new Error('Invalid plugin version');
const tag = `nose-review-v${plugin.version}`;
const archiveName = `nose-review-${plugin.version}.tar.gz`;
const repository = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY;
const command = process.argv[2];
if (!['pending', 'publish'].includes(command) || !repository) throw new Error('Usage: GH_REPO=owner/repo node scripts/publish-nose-plugin.mjs pending|publish');
const temporary = mkdtempSync(join(tmpdir(), 'nose-plugin-publish-'));
async function inspect() {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repository}/releases/tags/${tag}`, {
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (response.status !== 404 && !response.ok) throw new Error(`Release lookup failed: HTTP ${response.status}`);
  const release = response.status === 404 ? null : await response.json();
  const tagged = spawnSync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { encoding: 'utf8' });
  const recordedSource = release?.body?.match(/^Plugin source: ([0-9a-f]{40})$/m)?.[1];
  if (release && (!recordedSource || release.prerelease)) throw new Error('Unrelated release; refusing to overwrite');
  const source = recordedSource ?? (tagged.status === 0 ? tagged.stdout.trim() : git('rev-parse', 'HEAD'));
  if (tagged.status === 0 && tagged.stdout.trim() !== source) throw new Error('Release tag/source mismatch');
  if (release && release.target_commitish !== source) throw new Error('Release target/source mismatch');
  git('merge-base', '--is-ancestor', source, 'HEAD');
  git('diff', '--exit-code', source, '--', directory);
  const runtimeHash = digest(readFileSync(runtimePath));
  const tree = git('rev-parse', `${source}:${directory}`);
  const notes = `Plugin source: ${source}\nPlugin tree: ${tree}\nRuntime manifest SHA256: ${runtimeHash}`;
  if (release && ![...notes.split('\n')].every(line => release.body.split('\n').includes(line))) throw new Error('Release provenance mismatch');
  const archive = join(temporary, archiveName);
  git('archive', '--format=tar.gz', `--output=${archive}`, source, directory);
  const checksum = `${digest(readFileSync(archive))}  ${archiveName}\n`;
  writeFileSync(`${archive}.sha256`, checksum);
  const names = [archiveName, `${archiveName}.sha256`];
  const assets = release?.assets ?? [];
  if (assets.some(asset => !names.includes(asset.name)) || new Set(assets.map(asset => asset.name)).size !== assets.length) throw new Error('Unexpected release assets');
  for (const asset of assets) {
    const downloaded = execFileSync('gh', ['api', `repos/${repository}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream']);
    if (!downloaded.equals(readFileSync(join(temporary, asset.name)))) throw new Error(`Existing asset differs: ${asset.name}`);
  }
  return { release, source, notes, missing: names.filter(name => !assets.some(asset => asset.name === name)) };
}
try {
  // Updated manifests must pass checks before they are committed or released.
  const dirty = git('status', '--porcelain', '--', directory);
  if (command === 'pending' && dirty) {
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, 'release=true\n', { flag: 'a' });
    console.log('release=true');
  } else {
    if (dirty) throw new Error('Plugin tree must be committed before publication');
    const state = await inspect();
    const pending = !state.release || state.release.draft || state.missing.length !== 0;
    if (command === 'pending') {
      if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `release=${pending}\n`, { flag: 'a' });
      console.log(`release=${pending}`);
    } else if (pending) {
      if (!state.release) run('gh', ['release', 'create', tag, '--draft', '--target', state.source, '--title', `Nose Review ${plugin.version}`, '--notes', `${state.notes}\nAll runtime archive checksums, native clean/duplicate CLI smoke, and Nose Review regression tests passed. Local installation remains manual.`]);
      if (state.missing.length) run('gh', ['release', 'upload', tag, ...state.missing.map(name => join(temporary, name))]);
      const verified = await inspect();
      if (verified.missing.length) throw new Error('Release upload incomplete');
      if (verified.release.draft) run('gh', ['release', 'edit', tag, '--draft=false']);
      console.log(`Published verified ${tag}`);
    } else console.log(`Preserving complete ${tag}`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
