#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, projectRoot, scan } from './review-runtime.mjs';
import { filterReviewed } from './review-policy.mjs';

const zero = /^0+$/;
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const advise = message => process.stderr.write(`[nose pre-push] ${message}\n`);

function archivedScan(root, sha, operation) {
  git(root, ['cat-file', '-e', `${sha}^{commit}`]);
  const directory = mkdtempSync(join(tmpdir(), 'nose-pre-push-'));
  try {
    const archive = spawnSync('git', ['archive', '--format=tar', sha], {cwd:root, timeout:30000, maxBuffer:128*1024*1024});
    if (archive.status !== 0) throw new Error('Commit archive failed');
    const extract = spawnSync('tar', ['-xf', '-', '-C', directory], {input:archive.stdout, timeout:30000});
    if (extract.status !== 0) throw new Error('Commit archive extraction failed');
    // Archive attributes may omit or substitute files; never scan a silently altered tree.
    const entries = git(root, ['ls-tree', '-rz', sha]).split('\0').filter(Boolean);
    if (entries.length > 20000) throw new Error('Commit exceeds 20000 tree entries');
    const verificationDeadline = Date.now() + 15000;
    for (const entry of entries) {
      if (Date.now() > verificationDeadline) throw new Error('Commit archive verification exceeded 15 seconds');
      const [metadata, file] = entry.split(/\t(.*)/s);
      const [mode, type, object] = metadata.split(' ');
      if (type === 'commit') throw new Error('Submodule content cannot be scanned from a commit archive');
      if (mode === '120000') continue;
      const path = join(directory, file);
      if (!lstatSync(path, {throwIfNoEntry:false})?.isFile()
        || git(root, ['hash-object', '--no-filters', path]).trim() !== object) {
        throw new Error(`Archive differs from pushed tree: ${file}`);
      }
    }
    return operation(directory, scan(directory));
  } finally {
    rmSync(directory, {recursive:true, force:true});
  }
}

function baselineCandidates(directory, result, warnings) {
  const review = lstatSync(join(directory, '.nose-review'), {throwIfNoEntry:false});
  if (!review) return result.families;
  if (!review.isDirectory()) { warnings.push('Pushed baseline directory is unsafe; baseline ignored'); return result.families; }
  const path = join(directory, '.nose-review', 'baseline.json');
  const stat = lstatSync(path, {throwIfNoEntry:false});
  if (!stat) return result.families;
  try {
    if (!stat.isFile()) throw new Error('Baseline must be a regular file');
    const baseline = JSON.parse(readFileSync(path, 'utf8'));
    const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    if (baseline?.schemaVersion !== 1 || baseline.noseVersion !== result.noseVersion
      || !Array.isArray(baseline.accepted) || !baseline.accepted.every(fingerprint)
      || !Array.isArray(baseline.intentional) || !baseline.intentional.every(entry => entry && fingerprint(entry.fingerprint) && typeof entry.reason === 'string' && entry.reason.trim())) {
      throw new Error('Unsupported baseline schema or Nose version');
    }
    return filterReviewed(result.families, baseline, result.noseVersion);
  } catch (error) {
    warnings.push(`${error.message}; pushed baseline ignored`);
    return result.families;
  }
}

function relativeFamilies(families, directory) {
  return families.map(family => ({...family, locations:family.locations.map(location => {
    const file = relative(directory, resolve(directory, location.file));
    if (file === '..' || file.startsWith(`..${sep}`) || isAbsolute(file)) throw new Error('Source outside snapshot');
    return {...location, file:file.split(sep).join('/')};
  })}));
}

export function runPrePush(input, args, cwd = process.cwd()) {
  const updates = input.trim().split('\n').filter(line => line.trim());
  if (!updates.length) return 0;
  const root = projectRoot(cwd);
  const refs = [];
  let noseVersion;
  for (const line of updates) {
    const [localRef, localSha, remoteRef, remoteSha, extra] = line.trim().split(/\s+/);
    const record = {localRef, localSha, remoteRef, remoteSha, candidates:[], warnings:[]};
    refs.push(record);
    try {
      if (extra || !shaPattern.test(localSha ?? '') || !shaPattern.test(remoteSha ?? '')) throw new Error('Invalid Git pre-push ref update');
      if (zero.test(localSha)) { record.status = 'deleted'; advise(`${remoteRef}: deletion skipped`); continue; }
      const local = archivedScan(root, localSha, (directory, result) => ({
        noseVersion:result.noseVersion,
        candidates:relativeFamilies(baselineCandidates(directory, result, record.warnings), directory),
      }));
      noseVersion = local.noseVersion;
      record.candidates = local.candidates;
      // Remote presence is not a reviewed acceptance decision.
      record.status = record.warnings.length ? 'error' : record.candidates.length ? 'blocked' : 'scanned';
      advise(`${localRef} ${localSha} -> ${remoteRef} ${remoteSha}: ${record.candidates.length} unreviewed candidate(s)`);
    } catch (error) { record.status = 'error'; record.warnings.push(`Scan unavailable: ${error.message}`); }
    for (const warning of record.warnings) advise(`${localRef}: ${warning}`);
  }
  if (refs.every(ref => ref.status === 'deleted')) return 0;
  const review = join(root, '.nose-review');
  const stat = lstatSync(review, {throwIfNoEntry:false});
  if (stat && !stat.isDirectory()) throw new Error('Report directory is unsafe; report was not written');
  if (!stat) mkdirSync(review, {mode:0o700});
  const exitCode=refs.some(ref=>ref.status==='error')?2:refs.some(ref=>ref.status==='blocked')?1:0;
  const report = {schemaVersion:1, noseVersion, gateStatus:exitCode===2?'unavailable':exitCode===1?'blocked':'passed', exitCode, projectRoot:root, remote:{name:args[0]}, refs, candidates:refs.flatMap(ref => ref.candidates)};
  const temporary = join(review, `.report-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', {flag:'wx', mode:0o600});
    renameSync(temporary, join(review, 'report.json'));
  } finally { rmSync(temporary, {force:true}); }
  if(exitCode===1) advise('NOSE_DUPLICATION_BLOCKED: run $nose-fix, verify behavior, commit fixes or justified intentional decisions, then retry the authorized push. Do not bypass the hook.');
  if(exitCode===2) advise('NOSE_CHECK_UNAVAILABLE: restore valid scan inputs/tools before retrying. This is not a clean scan.');
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode=runPrePush(readFileSync(0, 'utf8'), process.argv.slice(2)); }
  catch (error) { advise(`NOSE_CHECK_UNAVAILABLE: Review unavailable: ${error.message}`); process.exitCode=2; }
}
