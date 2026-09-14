import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inventory, treeHash } from './inventory.mjs';
import { atomicJson, readSources, writeSources } from './update-state.mjs';
import { createGitHubAdapter, recoverSource, selectTarget, discoverOrigins } from './provenance.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const defaultState = () => path.join(os.homedir(), '.codex/skill-updater');
function files(directory, prefix = '', result = {}) {
  for (const name of fs.readdirSync(path.join(directory, prefix)).sort()) {
    if (name === '.git') continue;
    const relative = path.join(prefix, name), absolute = path.join(directory, relative), stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('Internal symlink requires manual handling');
    if (stat.isDirectory()) files(directory, relative, result);
    else if (stat.isFile()) result[relative] = { hash: hash(fs.readFileSync(absolute).toString('base64')), executable: Boolean(stat.mode & 0o111) };
    if (Object.keys(result).length > 10000) throw new Error('Skill file bound exceeded');
  }
  return result;
}
export function validateSkill(directory) {
  const text = fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!frontmatter || !/^name:\s*\S/m.test(frontmatter) || !/^description:\s*\S/m.test(frontmatter)) throw new Error('Invalid skill frontmatter');
  files(directory);
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const ref = match[1].split('#')[0];
    if (!ref || /^[a-z]+:|^\/|\$|[{}<>]/i.test(ref)) continue;
    const resolved = path.resolve(directory, ref);
    if (!resolved.startsWith(`${directory}${path.sep}`) || !fs.existsSync(resolved)) throw new Error('Missing or escaping local skill reference');
  }
  return { structure: 'passed', references: 'passed' };
}
export function inspectImpact(skill, candidate, source, allSkills, configPaths = []) {
  const before = files(skill.realPath), after = files(candidate);
  const changedFiles = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(f => JSON.stringify(before[f]) !== JSON.stringify(after[f]));
  const reasons = [], consumers = [];
  const oldText = fs.readFileSync(path.join(skill.realPath, 'SKILL.md'), 'utf8'), newText = fs.readFileSync(path.join(candidate, 'SKILL.md'), 'utf8');
  const frontmatter = text => text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  const markdownReferences = new Set([...oldText.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/g), ...newText.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/g)].map(match => path.normalize(match[1])));
  const mentionsFile = (text, file) => new RegExp(`(^|[^\\w./-])(?:\\./)?${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\w/-])`, 'm').test(text);
  const safeRootDocument = file => path.dirname(file) === '.' && /^(?:README|CHANGELOG|LICENSE)(?:\.[^.]+)?$/i.test(path.basename(file)) && !markdownReferences.has(path.normalize(file)) && !mentionsFile(oldText, file) && !mentionsFile(newText, file);
  if (frontmatter(oldText) !== frontmatter(newText)) reasons.push('Skill name, description, or activation contract changed');
  if (changedFiles.some(f => f === 'SKILL.md' || (f.endsWith('.md') && !safeRootDocument(f)))) reasons.push('Skill instructions or referenced Markdown changed');
  if (changedFiles.some(f => !f.endsWith('.md') || before[f]?.executable || after[f]?.executable)) reasons.push('Executable, dependency, or public file contract changed');
  if (changedFiles.some(f => !after[f])) reasons.push('Published file removed');
  if (/(?:https?:\/\/|hook|permission|install|npm |pip |brew |curl |\bexec\b)/i.test(newText) && oldText !== newText) reasons.push('Instructions affecting external services, permissions, or execution changed');
  if (oldText !== newText && /```/.test(newText)) reasons.push('Instruction command examples changed; behavior requires review');
  const scanPaths = [...allSkills.filter(s => s.id !== skill.id).flatMap(s => Object.keys(files(s.realPath)).filter(f => /\.(md|json|ya?ml|toml|mjs|js|sh)$/.test(f)).map(f => path.join(s.realPath, f))), ...configPaths];
  if (scanPaths.length > 10000) throw new Error('Reverse dependency scan bound exceeded');
  for (const file of scanPaths) {
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) { reasons.push('Reverse dependency scope could not be fully read'); continue; }
    const text = fs.readFileSync(file, 'utf8');
    if ([skill.realPath, `$${skill.name}`, ...skill.aliases].some(ref => text.includes(ref))) consumers.push(file);
  }
  if (consumers.length && changedFiles.length) reasons.push('Other personal skills or supported configuration reference this skill');
  if (skill.aliases.some(alias => alias !== skill.realPath)) reasons.push('Shared symlink target changes');
  if (source.tests?.length) reasons.push('Recorded upstream tests need a verified isolation adapter; not executed automatically');
  if (changedFiles.some(f => /(?:test|package\.json|pyproject)/i.test(f))) reasons.push('Upstream test or dependency definition changed; candidate commands were not executed');
  return { changedFiles, reasons: [...new Set(reasons)], consumers, scanScope: [...allSkills.map(s => s.realPath), ...configPaths] };
}
function withLock(stateDir, action) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = path.join(stateDir, 'lock');
  try { fs.mkdirSync(lock); } catch {
    let owner; try { owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')); } catch { throw new Error('Updater lock ownership unknown; inspect lock before retry'); }
    try { process.kill(owner.pid, 0); throw new Error('Updater already running'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    fs.rmSync(lock, { recursive: true }); fs.mkdirSync(lock);
  }
  atomicJson(path.join(lock, 'owner.json'), { pid: process.pid });
  return Promise.resolve().then(action).finally(() => fs.rmSync(lock, { recursive: true, force: true }));
}
function transactionFile(stateDir, transaction) { return path.join(stateDir, 'transactions', `${transaction.id}.json`); }
function saveTransaction(stateDir, transaction) { atomicJson(transactionFile(stateDir, transaction), transaction); }
function rollback(stateDir, transaction, fault) {
  try {
    if (fs.existsSync(transaction.backup) && treeHash(transaction.backup) === transaction.beforeHash) {
      if (fs.existsSync(transaction.target)) {
        if (treeHash(transaction.target) !== transaction.afterHash) throw new Error('installed path changed; preserve paths for manual recovery');
        fault?.('rollback-restore', transaction);
        fs.renameSync(transaction.target, transaction.rejected);
      }
      fs.renameSync(transaction.backup, transaction.target);
    }
    if (!fs.existsSync(transaction.target) || treeHash(transaction.target) !== transaction.beforeHash) throw new Error('original tree unavailable');
    if (transaction.priorSource) { const state = readSources(stateDir); state.skills[transaction.skillId] = transaction.priorSource; writeSources(stateDir, state); }
    transaction.status = 'rolled-back'; saveTransaction(stateDir, transaction);
    for (const temporary of [transaction.staged, transaction.rejected]) if (temporary && fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true });
  } catch (error) {
    if (error.message.startsWith('ROLLBACK_FAILED')) throw error;
    throw new Error(`ROLLBACK_FAILED: ${error.message}`);
  }
}
function promotePrevious(stateDir, tx) {
  const previous = path.join(path.dirname(tx.backup), 'previous');
  if (fs.existsSync(tx.backup)) {
    if (fs.existsSync(previous)) fs.rmSync(previous, { recursive: true });
    fs.renameSync(tx.backup, previous);
  }
  return previous;
}
export function pendingTransactions(stateDir) {
  const directory = path.join(stateDir, 'transactions');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(f => f.endsWith('.json')).flatMap(file => {
    const tx = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    return ['verified', 'rolled-back', 'cancelled'].includes(tx.status) ? [] : [{ name: tx.name, status: 'recovery-required', reason: `Pending ${tx.status} transaction; dry-run did not modify it`, transaction: path.join(directory, file) }];
  });
}
export function recoverTransactions(stateDir) {
  const directory = path.join(stateDir, 'transactions');
  if (!fs.existsSync(directory)) return [];
  const recovered = [];
  for (const file of fs.readdirSync(directory).filter(f => f.endsWith('.json'))) {
    const tx = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    if (tx.status === 'verified') { promotePrevious(stateDir, tx); continue; }
    if (['rolled-back', 'cancelled'].includes(tx.status)) continue;
    rollback(stateDir, tx); recovered.push({ name: tx.name, status: 'rolled-back', reason: 'Recovered interrupted transaction' });
  }
  return recovered;
}
export function applyCandidate({ stateDir, state, skill, source, candidate, target, postValidate = validateSkill, fault }) {
  if (treeHash(skill.realPath) !== source.contentHash) return { name: skill.name, status: 'conflict', reason: 'Local content changed before replacement' };
  const id = randomUUID(), base = path.join(stateDir, 'backups', skill.id);
  fs.mkdirSync(base, { recursive: true });
  if (fs.statSync(base).dev !== fs.statSync(skill.realPath).dev) throw new Error('Backup and skill must share a filesystem');
  const tx = { id, name: skill.name, skillId: skill.id, priorSource: source, target: skill.realPath, beforeHash: source.contentHash, afterHash: treeHash(candidate), backup: path.join(base, `${id}.backup`), staged: path.join(path.dirname(skill.realPath), `.skill-update-${id}`), rejected: path.join(base, `${id}.rejected`), status: 'planned' };
  saveTransaction(stateDir, tx);
  fs.cpSync(candidate, tx.staged, { recursive: true, preserveTimestamps: true });
  validateSkill(tx.staged);
  if (treeHash(tx.staged) !== tx.afterHash) throw new Error('Staged content mismatch');
  tx.status = 'staged'; saveTransaction(stateDir, tx);
  fault?.('staged', tx);
  if (treeHash(skill.realPath) !== source.contentHash) {
    tx.status = 'cancelled'; saveTransaction(stateDir, tx); fs.rmSync(tx.staged, { recursive: true });
    return { name: skill.name, status: 'conflict', reason: 'Local content changed immediately before replacement', transaction: transactionFile(stateDir, tx) };
  }
  try {
    fs.renameSync(tx.target, tx.backup); tx.status = 'backed-up'; saveTransaction(stateDir, tx); fault?.('backed-up', tx);
    fs.renameSync(tx.staged, tx.target); tx.status = 'swapped'; saveTransaction(stateDir, tx); fault?.('swapped', tx);
    postValidate(tx.target);
    if (treeHash(tx.target) !== tx.afterHash) throw new Error('Post-update content mismatch');
    const installedAt = new Date().toISOString();
    state.skills[skill.id] = { ...source, id: skill.id, realPath: skill.realPath, contentHash: tx.afterHash, commit: target.commit, channel: { ...source.channel, ref: source.channel.kind === 'branch' ? source.channel.ref : target.ref }, installedAt, history: [...(source.history || []), { contentHash: source.contentHash, commit: source.commit, installedAt: source.installedAt || null, replacedAt: installedAt }] };
    fault?.('persisting', tx);
    writeSources(stateDir, state);
    tx.status = 'verified'; saveTransaction(stateDir, tx);
    const previous = promotePrevious(stateDir, tx);
    return { name: skill.name, status: 'updated', commit: target.commit, previous, transaction: transactionFile(stateDir, tx) };
  } catch (error) { rollback(stateDir, tx, fault); state.skills[skill.id] = source; return { name: skill.name, status: 'rolled-back', reason: error.message, transaction: transactionFile(stateDir, tx) }; }
}
function writeReport(stateDir, rows) {
  const report = path.join(stateDir, 'reports', `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.md`);
  fs.mkdirSync(path.dirname(report), { recursive: true });
  const safe = text => String(text).replace(/[\r\n]+/g, ' ').replace(/([\\`*_{}\[\]()#+.!|<>])/g, '\\$1');
  const json = value => JSON.stringify(value, null, 2).split('\n').map(line => `    ${line}`).join('\n');
  fs.writeFileSync(report, `# Skill updater\n\n${rows.map(row => `## ${safe(row.name)}: ${safe(row.status)}\n\n${safe(row.reason || '')}\n\n${json(row)}`).join('\n\n')}\n`, { mode: 0o600 });
  return { summary: rows.reduce((counts, row) => ({ ...counts, [row.status]: (counts[row.status] || 0) + 1 }), {}), items: rows, report };
}
export async function runUpdater({ roots, excludedRoots, configPaths = [path.join(os.homedir(), '.codex/config.toml'), path.join(os.homedir(), '.codex/AGENTS.md'), path.join(os.homedir(), '.agents/AGENTS.md')], stateDir = defaultState(), adapter, candidates, dryRun = false, token, postValidate, fault } = {}) {
  const remote = adapter || createGitHubAdapter();
  try {
    return await withLock(stateDir, async () => {
      const rows = dryRun ? pendingTransactions(stateDir) : recoverTransactions(stateDir), state = readSources(stateDir), catalog = inventory({ roots, excludedRoots });
      let approvals = [];
      if (token) {
        if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid confirmation token');
        const file = path.join(stateDir, 'confirmations', `${token}.json`);
        approvals = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (hash(approvals) !== token) throw new Error('Confirmation data changed');
      }
      const impacts = [];
      for (const skill of catalog.skills) {
        if (token && !approvals.some(a => a.id === skill.id)) continue;
        let source = state.skills[skill.id], extracted;
        try {
          if (!source) {
            const recovered = await recoverSource(skill, remote, candidates?.[skill.id]);
            if (recovered.status !== 'recovered') { rows.push({ name: skill.name, id: skill.id, contentHash: skill.contentHash, ...recovered }); continue; }
            source = { ...recovered.source, id: skill.id, realPath: skill.realPath, installedAt: new Date().toISOString() };
            state.skills[skill.id] = source; writeSources(stateDir, state);
          }
          if (skill.contentHash !== source.contentHash || source.realPath !== skill.realPath) { rows.push({ name: skill.name, status: 'conflict', reason: 'Local files differ from recorded installation; skipped' }); continue; }
          const refs = await remote.refs(source.repo), target = selectTarget(source, refs);
          if (target.confirmationRequired) {
            rows.push({ name: skill.name, status: 'source-confirmation', reason: target.confirmationRequired, id: skill.id, contentHash: skill.contentHash, repo: source.repo, subtree: source.subtree, commit: source.commit, channel: source.channel, channelChoices: { stableRelease: refs.releases.find(item => !item.draft && !item.prerelease)?.tag || null, tags: refs.tags.map(item => item.name), branches: refs.branches.map(item => item.name) } });
            continue;
          }
          extracted = await remote.checkout(source.repo, target.commit, source.subtree);
          const afterHash = treeHash(extracted.path);
          if (afterHash === source.contentHash) { rows.push({ name: skill.name, status: 'current', commit: target.commit }); continue; }
          const validation = validateSkill(extracted.path), impact = inspectImpact(skill, extracted.path, source, catalog.skills, configPaths);
          const pin = { id: skill.id, commit: target.commit, contentHash: afterHash, beforeHash: source.contentHash, impactHash: hash(impact) };
          if (token && !approvals.some(a => JSON.stringify(a) === JSON.stringify(pin))) { rows.push({ name: skill.name, status: 'confirmation', reason: 'Commit, content, or impact changed since approval' }); continue; }
          if (impact.reasons.length && !token) { impacts.push(pin); rows.push({ name: skill.name, status: 'confirmation', reason: impact.reasons.join('; '), impact, validation, commit: target.commit }); continue; }
          if (dryRun) { rows.push({ name: skill.name, status: 'available', impact, validation, commit: target.commit }); continue; }
          rows.push({ ...applyCandidate({ stateDir, state, skill, source, candidate: extracted.path, target, postValidate, fault }), impact, validation });
        } catch (error) {
          if (error.message.startsWith('ROLLBACK_FAILED')) {
            const directory = path.join(stateDir, 'transactions');
            const transactions = fs.existsSync(directory) ? fs.readdirSync(directory).filter(f => f.endsWith('.json')).map(f => path.join(directory, f)) : [];
            const failure = writeReport(stateDir, [...rows, { name: skill.name, status: 'rollback-failed', reason: error.message, transactions, recovery: 'Stop all updates. Inspect transaction target, backup, and rejected paths. Preserve all copies; restore only the verified beforeHash backup into an empty original path.' }]);
            throw new Error(`${error.message}; report: ${failure.report}`);
          }
          rows.push({ name: skill.name, status: 'unavailable', reason: error.message });
        } finally { extracted?.cleanup(); }
      }
      for (const error of catalog.errors) rows.push({ name: error.path, status: 'unavailable', reason: error.reason });
      const result = writeReport(stateDir, rows);
      if (impacts.length) { result.confirmationToken = hash(impacts); atomicJson(path.join(stateDir, 'confirmations', `${result.confirmationToken}.json`), impacts); }
      return result;
    });
  } finally { if (!adapter) remote.close(); }
}

export async function confirmSource({ roots, excludedRoots, stateDir = defaultState(), adapter, selection }) {
  const remote = adapter || createGitHubAdapter();
  try {
    return await withLock(stateDir, async () => {
      recoverTransactions(stateDir);
      const skill = inventory({ roots, excludedRoots }).skills.find(s => s.id === selection.id);
      if (!skill || skill.contentHash !== selection.contentHash) throw new Error('Selected skill identity or content changed');
      const candidates = discoverOrigins(skill.realPath).filter(c => c.repo === selection.repo && c.subtree === selection.subtree);
      if (!candidates.length) throw new Error('Independent origin evidence missing; name alone cannot bind source');
      const extracted = await remote.checkout(selection.repo, selection.commit, selection.subtree);
      try { if (treeHash(extracted.path) !== skill.contentHash) throw new Error('Historical subtree no longer matches installed content'); } finally { extracted.cleanup(); }
      const refs = await remote.refs(selection.repo);
      const channel = selection.channel;
      const valid = channel.kind === 'branch' ? refs.branches.some(r => r.name === channel.ref) : channel.kind === 'tag' ? refs.tags.some(r => r.name === channel.ref && r.commit === selection.commit) : channel.kind === 'release' && refs.releases.some(r => r.tag === channel.ref && r.commit === selection.commit && !r.draft && !r.prerelease);
      if (!valid) throw new Error('Selected installation channel is not supported by live refs');
      const state = readSources(stateDir);
      state.skills[skill.id] = { id: skill.id, realPath: skill.realPath, contentHash: skill.contentHash, repo: selection.repo, subtree: selection.subtree, commit: selection.commit, channel, evidence: candidates[0].evidence, installedAt: new Date().toISOString() };
      writeSources(stateDir, state);
      return { status: 'source-confirmed', name: skill.name };
    });
  } finally { if (!adapter) remote.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), mode = args.shift() || 'run';
  const value = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
  const stateDir = value('--state-dir') || defaultState();
  try {
    if (!['run', 'apply-impact', 'recover', 'confirm-source'].includes(mode)) throw new Error('Use run, apply-impact --token TOKEN, confirm-source --selection FILE, or recover');
    if (mode === 'apply-impact' && !value('--token')) throw new Error('Explicit impact confirmation token required');
    const result = mode === 'confirm-source' ? await confirmSource({ stateDir, selection: JSON.parse(fs.readFileSync(value('--selection'), 'utf8')) }) : mode === 'recover' ? await withLock(stateDir, () => recoverTransactions(stateDir)) : await runUpdater({ stateDir, dryRun: args.includes('--dry-run'), token: mode === 'apply-impact' ? value('--token') : undefined });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
