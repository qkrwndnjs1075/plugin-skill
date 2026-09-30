import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { cacheStateRoot, committedResult, git, scan, scanTimeoutMs } from './review-runtime.mjs';
import { withReviewLock } from './review-policy.mjs';
import {blobDigest, commitTree, fileDigests, verifyArchive} from './commit-inputs.mjs';

const maxArchiveBytes = 2 * 1024 * 1024 * 1024;
const maxTreeEntries = 100_000;

export function archivedScan(root, sha, operation, materializeSymlinks=false, reuse) {
  const started=performance.now();
  const state = cacheStateRoot(root);
  try {
    return withReviewLock(join(state, 'snapshot.lock'), () => scanArchive(root, sha, operation, materializeSymlinks, state, reuse), 'snapshot scan', scanTimeoutMs + 60_000);
  } finally {
    process.stderr.write(`[nose archive] total finished in ${(performance.now()-started).toFixed(3)}ms\n`);
  }
}

export function scanCommit(root, sha) {
  return archivedScan(root,sha,(directory,files,identity,evidence)=>{
    const result=scan(directory,files,root,identity,evidence);
    return {...result,families:relativeFamilies(result.families,directory)};
  },false,(directory,tree)=>tree.reusable?committedResult(directory,root,tree.identity):null);
}

function scanArchive(root, sha, operation, materializeSymlinks, state, reuse) {
  const started=performance.now();
  // Nose keys workspace generations by canonical source root, not cache path.
  const directory = join(state, 'snapshot');
  if (lstatSync(directory,{throwIfNoEntry:false})?.isSymbolicLink()) throw new Error('Snapshot directory must not be a symlink');
  rmSync(directory,{recursive:true,force:true});
  mkdirSync(directory,{mode:0o700});
  let archiveDirectory;
  try {
    const tree=commitTree(root,sha);
    const cached=reuse?.(directory,tree);
    if(cached) return cached;
    archiveDirectory=mkdtempSync(join(tmpdir(),'nose-pre-push-archive-'));
    const archivePath=join(archiveDirectory,'snapshot.tar');
    const archive = spawnSync('git', ['archive', '--format=tar', '--output', archivePath, sha], {cwd:root, timeout:30000});
    if (archive.status !== 0) throw new Error('Commit archive failed');
    if (statSync(archivePath).size > maxArchiveBytes) throw new Error('Commit archive exceeds 2 GiB');
    const extract = spawnSync('tar', ['-xf', archivePath, '-C', directory], {timeout:30000});
    if (extract.status !== 0) throw new Error('Commit archive extraction failed');
    // Archive attributes may omit or substitute files; never scan a silently altered tree.
    const verificationStarted=performance.now();
    process.stderr.write(`[nose archive] extraction finished in ${(verificationStarted-started).toFixed(3)}ms\n`);
    const evidence=verifyArchive(directory,tree,materializeSymlinks);
    process.stderr.write(`[nose archive] source verification finished in ${(performance.now()-verificationStarted).toFixed(3)}ms\n`);
    return operation(directory,tree.files,tree.identity,materializeSymlinks?undefined:evidence);
  } finally {
    const cleanupStarted=performance.now();
    rmSync(directory, {recursive:true, force:true});
    if(archiveDirectory) rmSync(archiveDirectory,{recursive:true,force:true});
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
        const target=relative(root,realpathSync.native(path));
        if(target==='..' || target.startsWith(`..${sep}`) || isAbsolute(target)) return null;
        const normalized=target.split(sep).join('/');
        if(!tracked.has(normalized) && ![...tracked].some(file=>file.startsWith(normalized+'/'))) return null;
      } else if(!stat?.isFile() || fileDigests(path,algorithm,buffer).blob!==object) return null;
    }
    return sha;
  } catch { return null; }
  finally {
    process.stderr.write(`[nose archive] working-tree verification finished in ${(performance.now()-started).toFixed(3)}ms\n`);
  }
}
