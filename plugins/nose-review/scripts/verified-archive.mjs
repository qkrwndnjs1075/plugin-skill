import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readlinkSync, realpathSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { cacheStateRoot, git, hash, scanTimeoutMs } from './review-runtime.mjs';
import { withReviewLock } from './review-policy.mjs';

const maxArchiveBytes = 2 * 1024 * 1024 * 1024;
const maxTreeEntries = 100_000;

function blobDigest(content, algorithm) {
  return createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest('hex');
}

function fileDigest(path, algorithm, buffer) {
  const size = statSync(path).size;
  const digest = createHash(algorithm).update(`blob ${size}\0`);
  const descriptor = openSync(path, 'r');
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

export function archivedScan(root, sha, operation, materializeSymlinks=false) {
  const started=performance.now();
  const state = cacheStateRoot(root);
  try {
    return withReviewLock(join(state, 'snapshot.lock'), () => scanArchive(root, sha, operation, materializeSymlinks, state), 'snapshot scan', scanTimeoutMs + 60_000);
  } finally {
    process.stderr.write(`[nose archive] total finished in ${(performance.now()-started).toFixed(3)}ms\n`);
  }
}

function scanArchive(root, sha, operation, materializeSymlinks, state) {
  const started=performance.now();
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
    const verificationStarted=performance.now();
    process.stderr.write(`[nose archive] extraction finished in ${(verificationStarted-started).toFixed(3)}ms\n`);
    const verificationDeadline = Date.now() + 120000;
    const buffer=Buffer.allocUnsafe(1024 * 1024);
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
        || fileDigest(path, objectFormat, buffer) !== object) {
        throw new Error(`Archive differs from pushed tree: ${file}`);
      }
    }
    process.stderr.write(`[nose archive] source verification finished in ${(performance.now()-verificationStarted).toFixed(3)}ms\n`);
    if(!materializeSymlinks) {
      // Git ignore files govern untracked discovery, not coverage of the pushed tree.
      for(const entry of entries) {
        const file=entry.split(/\t(.*)/s)[1];
        if(['.gitignore','.ignore','nose.ignore.json'].includes(file.split('/').at(-1))) rmSync(join(directory,file),{force:true});
      }
    }
    return operation(directory, entries.map(entry => entry.split(/\t(.*)/s)[1]), hash(entries.join('\0')));
  } finally {
    const cleanupStarted=performance.now();
    rmSync(directory, {recursive:true, force:true});
    rmSync(archiveDirectory, {recursive:true, force:true});
    process.stderr.write(`[nose archive] cleanup finished in ${(performance.now()-cleanupStarted).toFixed(3)}ms\n`);
  }
}

export function relativeFamilies(families, directory) {
  return families.map(family => ({...family, locations:family.locations.map(location => {
    const file = relative(directory, resolve(directory, location.file));
    if (file === '..' || file.startsWith(`..${sep}`) || isAbsolute(file)) throw new Error('Source outside snapshot');
    return {...location, file:file.split(sep).join('/')};
  })}));
}

// Only raw-byte-equivalent work can use committed discovery. Git's clean
// status alone can hide filters and assume-unchanged files.
export function equivalentHead(root) {
  const started=performance.now();
  try {
    const sha=git(root,['rev-parse','--verify','HEAD^{commit}']).trim();
    if(git(root,['diff','--cached','--name-only',sha,'--']).trim()) return null;
    const others=git(root,['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean);
    if(others.some(file=>!/^\.nose-review\/(?:report\.json|baseline\.json|failures\/.*\.json)$/.test(file))) return null;
    const entries=git(root,['ls-tree','-rz',sha]).split('\0').filter(Boolean);
    if(entries.length>maxTreeEntries) return null;
    const tracked=new Set(entries.map(entry=>entry.split(/\t(.*)/s)[1]));
    const algorithm=git(root,['rev-parse','--show-object-format']).trim();
    if(!['sha1','sha256'].includes(algorithm)) return null;
    const buffer=Buffer.allocUnsafe(1024 * 1024);
    for(const entry of entries) {
      const [metadata,file]=entry.split(/\t(.*)/s);
      const [mode,type,object]=metadata.split(' ');
      if(type!=='blob') return null;
      const path=join(root,file),stat=lstatSync(path,{throwIfNoEntry:false});
      if(mode==='120000') {
        if(!stat?.isSymbolicLink() || blobDigest(readlinkSync(path,{encoding:'buffer'}),algorithm)!==object) return null;
        const target=relative(root,realpathSync(path));
        if(target==='..' || target.startsWith(`..${sep}`) || isAbsolute(target)) return null;
        const normalized=target.split(sep).join('/');
        if(!tracked.has(normalized) && ![...tracked].some(file=>file.startsWith(normalized+'/'))) return null;
      } else if(!stat?.isFile() || fileDigest(path,algorithm,buffer)!==object) return null;
    }
    return sha;
  } catch { return null; }
  finally {
    process.stderr.write(`[nose archive] working-tree verification finished in ${(performance.now()-started).toFixed(3)}ms\n`);
  }
}
