#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, hash, projectRoot, scan, sameDuplicateInputs, stateRoot } from './review-runtime.mjs';
import { filterChangedCandidates, filterRemoteExisting, filterReviewed, reviewedReductions, validBaseline, withReviewLock } from './review-policy.mjs';
import { scanSecrets } from './secret-scan.mjs';
import { scanCommitsSecrets } from './commit-secrets.mjs';
import { saveFailure } from './failure-history.mjs';

const zero = /^0+$/;
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const maxArchiveBytes = 2 * 1024 * 1024 * 1024;
const maxTreeEntries = 100_000;
const advise = message => process.stderr.write(`[nose pre-push] ${message}\n`);

function remoteTrackingCommits(root, remoteName) {
  const remotes=git(root,['remote']).trim().split('\n').filter(Boolean);
  if(!remotes.includes(remoteName)) return [];
  const commits=git(root,['for-each-ref','--format=%(objectname)',`refs/remotes/${remoteName}/`]).trim().split('\n').filter(Boolean);
  if(commits.some(commit=>!shaPattern.test(commit))) throw new Error('Invalid remote-tracking commit');
  return [...new Set(commits)];
}

function blobDigest(content, algorithm) {
  return createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest('hex');
}

function fileDigest(path, algorithm) {
  const size = statSync(path).size;
  const digest = createHash(algorithm).update(`blob ${size}\0`);
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  try {
    while (position < size) {
      const bytesRead = readSync(descriptor, buffer, 0, Math.min(buffer.length, size - position), position);
      if (bytesRead === 0) throw new Error('Archive file ended before its declared size');
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest('hex');
}

function archivedScan(root, sha, operation, materializeSymlinks=false) {
  const state = stateRoot(root);
  return withReviewLock(join(state, 'snapshot.lock'), () => scanArchive(root, sha, operation, materializeSymlinks, state), 'snapshot scan');
}

function scanArchive(root, sha, operation, materializeSymlinks, state) {
  git(root, ['cat-file', '-e', `${sha}^{commit}`]);
  // Nose keys workspace generations by canonical source root, not cache path.
  const directory = join(state, 'snapshot');
  if (lstatSync(directory,{throwIfNoEntry:false})?.isSymbolicLink()) throw new Error('Snapshot directory must not be a symlink');
  rmSync(directory,{recursive:true,force:true});
  mkdirSync(directory,{mode:0o700});
  const archiveDirectory = mkdtempSync(join(tmpdir(), 'nose-pre-push-archive-'));
  const archivePath = join(archiveDirectory, 'snapshot.tar');
  try {
    const archive = spawnSync('git', ['archive', '--format=tar', '--output', archivePath, sha], {cwd:root, timeout:30000});
    if (archive.status !== 0) throw new Error('Commit archive failed');
    if (statSync(archivePath).size > maxArchiveBytes) throw new Error('Commit archive exceeds 2 GiB');
    const extract = spawnSync('tar', ['-xf', archivePath, '-C', directory], {timeout:30000});
    if (extract.status !== 0) throw new Error('Commit archive extraction failed');
    // Archive attributes may omit or substitute files; never scan a silently altered tree.
    const entries = git(root, ['ls-tree', '-rz', sha]).split('\0').filter(Boolean);
    if (entries.length > maxTreeEntries) throw new Error(`Commit exceeds ${maxTreeEntries} tree entries`);
    const objectFormat = git(root, ['rev-parse', '--show-object-format']).trim();
    if (!['sha1', 'sha256'].includes(objectFormat)) throw new Error('Unsupported Git object format');
    const verificationDeadline = Date.now() + 120000;
    for (const entry of entries) {
      if (Date.now() > verificationDeadline) throw new Error('Commit archive verification exceeded 120 seconds');
      const [metadata, file] = entry.split(/\t(.*)/s);
      const [mode, type, object] = metadata.split(' ');
      if (type === 'commit') throw new Error('Submodule content cannot be scanned from a commit archive');
      const path = join(directory, file);
      if (mode === '120000') {
        const target = readlinkSync(path, {encoding:'buffer'});
        if (blobDigest(target, objectFormat) !== object) {
          throw new Error(`Archive differs from pushed tree: ${file}`);
        }
        if(materializeSymlinks) {
          rmSync(path);
          writeFileSync(path,target,{flag:'wx',mode:0o600});
        }
        continue;
      }
      if (!lstatSync(path, {throwIfNoEntry:false})?.isFile()
        || fileDigest(path, objectFormat) !== object) {
        throw new Error(`Archive differs from pushed tree: ${file}`);
      }
    }
    if(!materializeSymlinks) {
      // Git ignore files govern untracked discovery, not coverage of the pushed tree.
      for(const entry of entries) {
        const file=entry.split(/\t(.*)/s)[1];
        if(['.gitignore','.ignore','nose.ignore.json'].includes(file.split('/').at(-1))) rmSync(join(directory,file),{force:true});
      }
    }
    return operation(directory, entries.map(entry => entry.split(/\t(.*)/s)[1]), hash(entries.join('\0')));
  } finally {
    rmSync(directory, {recursive:true, force:true});
    rmSync(archiveDirectory, {recursive:true, force:true});
  }
}

function baselineAt(directory, source, result, warnings, reductions) {
  const review = lstatSync(join(directory, '.nose-review'), {throwIfNoEntry:false});
  if (!review) return null;
  if (!review.isDirectory()) {
    warnings.push(`${source} baseline directory is unsafe; baseline ignored`);
    return {candidates:result.families, hasBaseline:true, baselineSource:source.toLowerCase()};
  }
  const path = join(directory, '.nose-review', 'baseline.json');
  const stat = lstatSync(path, {throwIfNoEntry:false});
  if (!stat) return null;
  try {
    if (!stat.isFile()) throw new Error('Baseline must be a regular file');
    const baseline = JSON.parse(readFileSync(path, 'utf8'));
    if (!validBaseline(baseline) || baseline.noseVersion !== result.noseVersion) {
      throw new Error('Unsupported baseline schema or Nose version');
    }
    reductions.push(...reviewedReductions(result.families,baseline,result.noseVersion));
    return {candidates:filterReviewed(result.families, baseline, result.noseVersion), hasBaseline:true,
      baselineSource:source.toLowerCase()};
  } catch (error) {
    warnings.push(`${error instanceof SyntaxError?'Invalid baseline JSON':error.message}; ${source.toLowerCase()} baseline ignored`);
    return {candidates:result.families, hasBaseline:true, baselineSource:source.toLowerCase()};
  }
}

function baselineCandidates(snapshotDirectory, root, result, warnings, reductions) {
  return baselineAt(snapshotDirectory, 'Pushed', result, warnings, reductions)
    ?? baselineAt(root, 'Local', result, warnings, reductions)
    ?? {candidates:result.families, hasBaseline:false};
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
  const secretResults = new Map();
  let noseVersion;
  for (const line of updates) {
    const [localRef, localSha, remoteRef, remoteSha, extra] = line.trim().split(/\s+/);
    const record = {localRef, localSha, remoteRef, remoteSha, candidates:[], warnings:[], reductions:[]};
    refs.push(record);
    try {
      if (extra || !shaPattern.test(localSha ?? '') || !shaPattern.test(remoteSha ?? '')) throw new Error('Invalid Git pre-push ref update');
      if (zero.test(localSha)) { record.status = 'deleted'; advise(`${remoteRef}: deletion skipped`); continue; }
      // A removed credential can still leak through an earlier outgoing commit.
      const range=[localSha];
      let outgoing, comparisonSha=zero.test(remoteSha)?null:remoteSha;
      if(!zero.test(remoteSha)) {
        const known=spawnSync('git',['cat-file','-e',`${remoteSha}^{commit}`],{cwd:root,timeout:10000});
        if(known.status===0) range.push('^'+remoteSha);
      } else {
        const knownRemoteCommits=remoteTrackingCommits(root,args[0]);
        if(knownRemoteCommits.length) {
          const history=git(root,['rev-list','--boundary',localSha,'--not',...knownRemoteCommits]).trim().split('\n').filter(Boolean);
          if(history.some(commit=>!shaPattern.test(commit.startsWith('-')?commit.slice(1):commit))) throw new Error('Invalid remote history');
          outgoing=history.filter(commit=>!commit.startsWith('-'));
          comparisonSha=history.find(commit=>commit.startsWith('-'))?.slice(1) ?? (outgoing.length===0?localSha:null);
        }
      }
      outgoing ??= git(root,['rev-list',...range]).trim().split('\n').filter(Boolean);
      record.secrets={status:'passed',findings:[],commitsScanned:0};
      const metadata=mkdtempSync(join(tmpdir(),'nose-git-metadata-'));
      try {
        for(const commit of new Set(outgoing)) {
          const peeled=git(root,['rev-parse',`${commit}^{commit}`]).trim();
          writeFileSync(join(metadata,peeled+'.commit.txt'),git(root,['cat-file','commit',peeled]),{mode:0o600});
        }
        let object=localSha;
        const seen=new Set();
        while(git(root,['cat-file','-t',object]).trim()==='tag') {
          if(seen.has(object)||seen.size>=64) throw new Error('Tag chain exceeds metadata limits');
          seen.add(object);
          const content=git(root,['cat-file','tag',object]);
          writeFileSync(join(metadata,object+'.tag.txt'),content,{mode:0o600});
          const target=/^object ([a-f0-9]{40}|[a-f0-9]{64})\n/.exec(content)?.[1];
          if(!target) throw new Error('Invalid tag object');
          object=target;
        }
        const result=scanSecrets(metadata);
        record.secrets.status=result.status;
        if(result.reason) record.secrets.reason=result.reason;
        for (const finding of result.findings) record.secrets.findings.push({...finding,file:'git-metadata/'+finding.file,commit:finding.file.split('.')[0]});
      } finally { rmSync(metadata,{recursive:true,force:true}); }
      if (record.secrets.status !== 'unavailable') {
        const pending=[...new Set(outgoing)].filter(sha=>!secretResults.has(sha));
        for (const [sha,result] of scanCommitsSecrets(root,pending)) secretResults.set(sha,result);
      }
      for(const sha of new Set(outgoing)) {
        if(record.secrets.status==='unavailable') break;
        const result=secretResults.get(sha);
        record.secrets.commitsScanned++;
        for (const finding of result.findings) record.secrets.findings.push({...finding,commit:sha});
        if(result.status==='unavailable') { record.secrets.status='unavailable'; record.secrets.reason=result.reason; break; }
        if(result.status==='blocked') record.secrets.status='blocked';
      }
      if (comparisonSha && sameDuplicateInputs(root, [comparisonSha, localSha])) {
        record.duplication = {status:'unchanged', comparisonSha};
        record.comparisonBase = {sha:comparisonSha, identicalInputs:true};
        record.status = record.secrets.status === 'unavailable' ? 'error'
          : record.secrets.status === 'blocked' ? 'blocked' : 'scanned';
        if (record.secrets.reason) record.warnings.push(record.secrets.reason);
        advise(`${localRef}: duplicate-analysis inputs unchanged from ${comparisonSha}; secrets ${record.secrets.status}`);
        continue;
      }
      advise(`local ${localSha}: preparing and scanning verified tree`);
      const local = archivedScan(root, localSha, (directory, files, identity) => {
        const result=scan(directory, files, root, identity);
        const policy=baselineCandidates(directory, root, result, record.warnings, record.reductions);
        return {noseVersion:result.noseVersion, families:result.families,
          candidates:policy.candidates, hasBaseline:policy.hasBaseline,
          baselineSource:policy.baselineSource, directory};
      });
      if(local.baselineSource) record.baselineSource=local.baselineSource;
      if (comparisonSha) {
        git(root, ['cat-file', '-e', `${comparisonSha}^{commit}`]);
        const changedFiles=git(root,['diff','--name-only','-z',comparisonSha,localSha,'--']).split('\0').filter(Boolean);
        local.candidates=filterChangedCandidates(local.candidates,changedFiles);
        if (local.candidates.length) {
          advise(`remote ${comparisonSha}: preparing comparison scan for ${local.candidates.length} local candidate(s)`);
          const remote=archivedScan(root, comparisonSha, (directory, files, identity) => scan(directory, files, root, identity));
          if (remote.noseVersion !== local.noseVersion) throw new Error('Remote comparison uses a different Nose version');
          const comparisonStarted=performance.now();
          advise(`comparing ${local.candidates.length} local candidate(s) with ${remote.families.length} remote families`);
          local.candidates=filterRemoteExisting(local.candidates,remote.families);
          advise(`comparison completed in ${Math.round(performance.now()-comparisonStarted)}ms; ${local.candidates.length} unreviewed candidate(s)`);
          record.comparisonBase={sha:comparisonSha, familyCount:remote.families.length};
        } else {
          record.comparisonBase={sha:comparisonSha, analysisSkipped:'no-candidates'};
        }
      }
      noseVersion = local.noseVersion;
      record.candidates = relativeFamilies(local.candidates, local.directory);
      record.status = record.warnings.length || record.secrets.status==='unavailable' ? 'error' : record.candidates.length || record.secrets.status==='blocked' ? 'blocked' : 'scanned';
      if(record.secrets.status==='unavailable') record.warnings.push(record.secrets.reason);
      for(const reduction of record.reductions) advise(`ADVISORY reduction: ${reduction.reviewedFingerprint} -> ${reduction.fingerprint}`);
      for(const finding of record.secrets.findings) advise(`Secret candidate: ${finding.rule} at ${finding.file}:${finding.line} (value redacted)`);
      advise(`${localRef} ${localSha} -> ${remoteRef} ${remoteSha}: ${record.candidates.length} unreviewed candidate(s)`);
    } catch (error) { record.status = 'error'; record.warnings.push(`Scan unavailable: ${error instanceof SyntaxError?'Invalid scanner JSON':error.message}`); }
    for (const warning of record.warnings) advise(`${localRef}: ${warning}`);
  }
  if (refs.every(ref => ref.status === 'deleted')) return 0;
  const review = join(root, '.nose-review');
  const stat = lstatSync(review, {throwIfNoEntry:false});
  if (stat && !stat.isDirectory()) throw new Error('Report directory is unsafe; report was not written');
  if (!stat) mkdirSync(review, {mode:0o700});
  const exitCode=refs.some(ref=>ref.status==='error')?2:refs.some(ref=>ref.status==='blocked')?1:0;
  const report = {schemaVersion:1, noseVersion, gateStatus:exitCode===2?'unavailable':exitCode===1?'blocked':'passed', exitCode, projectRoot:root, remote:{name:args[0]}, refs, candidates:refs.flatMap(ref => ref.candidates)};
  const historyPath=saveFailure(root,report);
  if(historyPath) { report.failureHistory=historyPath; advise(`Failure record: ${historyPath}`); }
  const temporary = join(review, `.report-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', {flag:'wx', mode:0o600});
    renameSync(temporary, join(review, 'report.json'));
  } finally { rmSync(temporary, {force:true}); }
  if(refs.some(ref=>ref.secrets?.status==='blocked')) advise('NOSE_SECRETS_BLOCKED: remove credentials from outgoing commits; never print secret values or accept them as duplication. Already exposed credentials require owner rotation. Do not bypass the hook.');
  if(refs.some(ref=>ref.candidates.length)) advise('NOSE_DUPLICATION_BLOCKED: run $nose-fix, verify behavior, commit source fixes or record source-bound intentional decisions locally, then retry the authorized push. Do not bypass the hook.');
  if(exitCode===2) advise('NOSE_CHECK_UNAVAILABLE: restore valid scan inputs/tools before retrying. This is not a clean scan.');
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode=runPrePush(readFileSync(0, 'utf8'), process.argv.slice(2)); }
  catch (error) {
    advise(`NOSE_CHECK_UNAVAILABLE: Review unavailable: ${error.message}`);
    try { advise('Failure record: '+saveFailure(projectRoot(process.cwd()),{exitCode:2,gateStatus:'unavailable',refs:[],reason:'Gate could not finish or write its report'})); }
    catch { advise('Failure history could not be saved; check report directory permissions and symlinks'); }
    process.exitCode=2;
  }
}
