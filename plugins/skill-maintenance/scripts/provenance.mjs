import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { treeHash } from './inventory.mjs';

function command(binary, args, cwd) {
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.error || result.status !== 0) throw new Error(`${binary} remote query unavailable`);
  return result.stdout.trim();
}
const removeTree = directory => fs.rmSync(directory, { recursive: true, force: true });
export function semver(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag);
  return match && { numbers: match.slice(1, 4).map(Number), prerelease: match[4] || '', channel: (match[4] || '').split('.')[0] };
}
function versionCompare(a, b) {
  const av = semver(a), bv = semver(b);
  for (let i = 0; i < 3; i++) if (av.numbers[i] !== bv.numbers[i]) return av.numbers[i] - bv.numbers[i];
  if (!av.prerelease || !bv.prerelease) return !av.prerelease ? (bv.prerelease ? 1 : 0) : -1;
  return av.prerelease.localeCompare(bv.prerelease, 'en', { numeric: true });
}
export function selectTarget(source, refs) {
  const channel = source.channel;
  if (channel.kind === 'branch') {
    const ref = refs.branches.find(item => item.name === channel.ref);
    if (!ref) throw new Error('Tracked branch unavailable');
    return { ...ref, ref: ref.name };
  }
  if (channel.kind === 'release') {
    const release = refs.releases.filter(item => !item.draft && !item.prerelease).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
    if (!release) throw new Error('Published stable release unavailable');
    return { ...release, ref: release.tag };
  }
  if (channel.kind === 'tag') {
    const installed = semver(channel.ref);
    if (!installed) return { confirmationRequired: 'Non-semver tag requires channel selection' };
    const tag = refs.tags.filter(item => { const parsed = semver(item.name); return parsed && parsed.numbers[0] === installed.numbers[0] && parsed.channel === installed.channel && versionCompare(item.name,channel.ref)>=0; }).sort((a, b) => versionCompare(b.name, a.name))[0];
    if (!tag) throw new Error('No compatible tag at or above the installed version; downgrade refused');
    return { ...tag, ref: tag.name };
  }
  throw new Error('Unknown installation channel');
}
export function inferChannel(commit, refs) {
  const choices = [
    ...refs.releases.filter(r => r.commit === commit && !r.draft && !r.prerelease).map(r => ({ kind: 'release', ref: r.tag })),
    ...refs.tags.filter(r => r.commit === commit).map(r => ({ kind: 'tag', ref: r.name })),
    ...refs.branches.filter(r => r.commit === commit && r.name === refs.defaultBranch).map(r => ({ kind: 'branch', ref: r.name })),
  ];
  return choices.length === 1 ? { channel: choices[0] } : { choices, confirmationRequired: 'Installation channel is ambiguous or no longer directly referenced' };
}
export function discoverOrigins(skillPath) {
  const text = fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8');
  const candidates = [];
  for (const match of text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/tree\/([^\s/)]+)\/([^\s)"<>]+)/g)) {
    candidates.push({ repo: match[1], subtree: match[3].replace(/\/$/, ''), ref: match[2], evidence: { kind: 'embedded-exact-url', url: match[0] } });
  }
  try {
    const root = command('git', ['rev-parse', '--show-toplevel'], skillPath);
    const url = command('git', ['remote', 'get-url', 'origin'], root);
    const match = /(?:github\.com[:/])([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url);
    if (match) candidates.push({ repo: match[1], subtree: path.relative(root, skillPath) || '.', evidence: { kind: 'git-origin', url } });
  } catch { /* Non-Git downloaded skills can still carry exact source URLs. */ }
  return [...new Map(candidates.map(c => [`${c.repo}/${c.subtree}`, c])).values()];
}
export async function recoverSource(skill, adapter, candidates = discoverOrigins(skill.realPath)) {
  const matches = [];
  const unavailable = [];
  for (const candidate of candidates) {
    if (!candidate.evidence || !['git-origin', 'embedded-exact-url', 'install-record'].includes(candidate.evidence.kind)) continue;
    try {
      const refs = await adapter.refs(candidate.repo);
      for (const commit of await adapter.commits(candidate.repo, candidate.subtree)) {
        const extracted = await adapter.checkout(candidate.repo, commit, candidate.subtree);
        try {
          if (treeHash(extracted.path) === skill.contentHash) matches.push({ ...candidate, ...inferChannel(commit, refs), commit, contentHash: skill.contentHash });
        } finally { extracted.cleanup(); }
      }
    } catch { unavailable.push(candidate.repo); }
  }
  const unique = [...new Map(matches.map(m => [`${m.repo}:${m.subtree}:${m.commit}`, m])).values()];
  const origins = new Set(unique.map(match => `${match.repo}:${match.subtree}`));
  if (origins.size > 1) return { status: 'source-unconfirmed', reason: 'Multiple exact historical origins; confirmation required', candidates: unique, unavailable };
  const resolved = unique.filter(match => match.channel);
  const referenced = unique.filter(match => match.channel || match.choices?.length);
  if (resolved.length > 1 || (!resolved.length && referenced.length > 1) || (!referenced.length && unique.length !== 1)) return { status: unavailable.length ? 'unavailable' : 'source-unconfirmed', reason: unique.length ? 'Multiple exact historical revisions; confirmation required' : 'No exact historical tree with independent origin evidence', candidates: unique, unavailable };
  const source = resolved[0] || referenced[0] || unique[0];
  if (!source) return { status: unavailable.length ? 'unavailable' : 'source-unconfirmed', reason: 'No exact historical tree with independent origin evidence', unavailable };
  if (!source.channel) return { status: 'source-confirmation', source, reason: source.confirmationRequired };
  return { status: 'recovered', source };
}

async function publicReleases(repo) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'codex-skill-updater' };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers });
  if (!response.ok) throw new Error(`GitHub release query unavailable (${response.status})`);
  return response.json();
}

export function createGitHubAdapter({ localRemotes = {}, releases = {}, maxCommits = 200 } = {}) {
  const clones = new Map();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-upstream-'));
  function clone(repo) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid GitHub repository');
    if (!clones.has(repo)) {
      const directory = path.join(temporary, `${clones.size}`);
      command('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--bare', '--filter=blob:none', '--', localRemotes[repo] || `https://github.com/${repo}.git`, directory]);
      clones.set(repo, directory);
    }
    return clones.get(repo);
  }
  function git(repo, args) { return command('git', ['-c', 'core.hooksPath=/dev/null', ...args], clone(repo)); }
  return {
    async refs(repo) {
      const tags = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/tags']).split('\n').filter(Boolean).map(name => ({ name, commit: git(repo, ['rev-parse', `${name}^{commit}`]) }));
      const branches = git(repo, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads']).split('\n').filter(Boolean).map(line => { const [name, commit] = line.split(' '); return { name, commit }; });
      const api = releases[repo] ?? await publicReleases(repo);
      return { tags, branches, defaultBranch: git(repo, ['symbolic-ref', '--short', 'HEAD']), releases: api.map(r => ({ tag: r.tag_name, draft: r.draft, prerelease: r.prerelease, publishedAt: r.published_at || '', commit: tags.find(t => t.name === r.tag_name)?.commit })).filter(r => r.commit) };
    },
    async commits(repo, subtree) {
      const changed = git(repo, ['rev-list', '--all', `--max-count=${maxCommits}`, '--', subtree]).split('\n').filter(Boolean);
      const refs = git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags']).split('\n').filter(Boolean);
      const tips = refs.map(ref => git(repo, ['rev-parse', `${ref}^{commit}`]));
      return [...new Set([...tips, ...changed])];
    },
    async checkout(repo, commit, subtree) {
      if (!/^[a-f0-9]{40,64}$/.test(commit) || path.isAbsolute(subtree) || subtree.split('/').includes('..')) throw new Error('Unsafe remote tree selector');
      const directory = fs.mkdtempSync(path.join(temporary, 'tree-'));
      const entries = git(repo, ['ls-tree', '-r', '-z', commit, '--', subtree]).split('\0').filter(Boolean);
      if (entries.length > 10000) throw new Error('Remote tree exceeds file bound');
      let total = 0;
      for (const entry of entries) {
        const [metadata, filename] = entry.split('\t');
        const [mode, type, object] = metadata.split(' ');
        if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error('Remote links and submodules require manual handling');
        const relative = subtree === '.' ? filename : path.relative(subtree, filename);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Remote path escaped subtree');
        const bytes = spawnSync('git', ['cat-file', 'blob', object], { cwd: clone(repo), timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
        if (bytes.status !== 0 || bytes.error) throw new Error('Remote blob unavailable');
        total += bytes.stdout.length;
        if (total > 64 * 1024 * 1024) throw new Error('Remote tree exceeds byte bound');
        const target = path.join(directory, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes.stdout, { mode: mode === '100755' ? 0o755 : 0o644 });
      }
      if (!fs.existsSync(path.join(directory, 'SKILL.md'))) throw new Error('Remote skill subtree missing');
      return { path: directory, cleanup() { removeTree(directory); } };
    },
    close() { removeTree(temporary); },
  };
}
