import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, parse, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createMemberHasher, hash, isSourceFile, verifiedFamilies } from './source-evidence.mjs';
import { readScanResult, writeScanResult } from './scan-result-cache.mjs';
import { scannerInputs } from './scanner-inputs.mjs';
export { hash } from './source-evidence.mjs';
export { shellQuote } from './scanner-inputs.mjs';

export const scanTimeoutMs = 600_000;
export const refTimeoutMs = 2 * scanTimeoutMs + 60_000;

const excluded = new Set(['.git','.nose-review','node_modules','.venv','venv','__pycache__','dist','build','target','vendor','.next','.nuxt','coverage','.cache']);
export function projectRoot(cwd) {
  if (typeof cwd !== 'string' || !cwd) throw new Error('Project directory is required');
  const root=realpathSync(cwd);
  if (!lstatSync(root).isDirectory()) throw new Error('Project path must be a directory');
  try { return realpathSync(git(root,['rev-parse','--show-toplevel']).trim()); }
  catch {
    for(let parent=root;;parent=dirname(parent)) {
      if(existsSync(join(parent,'.git'))) throw new Error('Git project detected but Git state is unavailable');
      if(dirname(parent)===parent) break;
    }
    if(root===parse(root).root || root===realpathSync(homedir())) throw new Error('Choose a project folder, not the home or filesystem root');
    return root;
  }
}
function isGit(root) {
  return existsSync(join(root,'.git'));
}
function plainFiles(root) {
  const files=[];
  let visited=0;
  function walk(directory,depth) {
    if(depth>64) throw new Error('Project directory depth exceeds 64');
    for(const entry of readdirSync(join(root,directory),{withFileTypes:true})) {
      if(++visited>20000) throw new Error('Project exceeds 20000 directory entries');
      if(excluded.has(entry.name) || entry.isSymbolicLink()) continue;
      const path=directory?directory+'/'+entry.name:entry.name;
      if(entry.isDirectory()) walk(path,depth+1);
      else if(entry.isFile() && isSourceFile(path)) files.push(path);
    }
  }
  walk('',0);
  return files.sort();
}
export function git(root, args) {
  const result = spawnSync('git', args, {cwd:root,encoding:'utf8',timeout:10000,maxBuffer:32*1024*1024});
  if (result.status !== 0) throw new Error('Git state could not be read');
  return result.stdout;
}
export function sameDuplicateInputs(root, commits) {
  const inventories = commits.map(commit => git(root, ['ls-tree', '-rz', commit])
    .split('\0').filter(Boolean).filter(entry => {
      const [metadata, file] = entry.split(/\t(.*)/s);
      // Markdown is not a Nose source format. Keep symlinks and every other
      // entry, including scanner configuration and review baselines, in identity.
      return !/^(100644|100755) blob /.test(metadata) || !file.endsWith('.md');
    }).join('\0'));
  return inventories.length === 2 && inventories[0] === inventories[1];
}
export function snapshot(root, verifiedFiles) {
  const managed=verifiedFiles !== undefined || isGit(root);
  const files = verifiedFiles ?? (managed ? [...new Set(git(root,['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean))].sort() : plainFiles(root));
  const entries = [];
  let bytes=0;
  for (const file of files) {
    if (!isSourceFile(file)) continue;
    try {
      const stat=lstatSync(join(root,file));
      if (!stat.isFile()) continue;
      bytes+=stat.size;
      if(!managed && (entries.length>=10000 || stat.size>5*1024*1024 || bytes>100*1024*1024)) throw new Error('Project exceeds source limits: 10000 files, 5 MiB per file, 100 MiB total');
      entries.push([file,hash(readFileSync(join(root,file)))]);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return Object.fromEntries(entries);
}
export function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value,null,2)+'\n', {mode:0o600});
  renameSync(temporary,path);
}
export function stateRoot(root) {
  const directory = join(process.env.NOSE_REVIEW_STATE_ROOT ?? join(tmpdir(),'nose-review-v2'),hash(root));
  mkdirSync(directory,{recursive:true,mode:0o700});
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Review state directory must not be a symlink');
  return directory;
}
export function cacheStateRoot(root) {
  const owner = isGit(root)
    ? realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim())
    : realpathSync(root);
  return stateRoot(owner);
}

function workingIdentity(root) {
  if (!isGit(root)) return null;
  const files = [...new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort();
  const inputs = [];
  const controls = new Set();
  for (const file of files) {
    if (/^\.nose-review\/(?:report\.json|baseline\.json|failures\/.*\.json)$/.test(file)) continue;
    const path = join(root, file);
    const stat = lstatSync(path, {throwIfNoEntry:false});
    if (stat?.isSymbolicLink()) {
      try { inputs.push([file, linkedInput(path)]); }
      catch { return null; }
    } else {
      if (stat && !stat.isFile()) return null;
      inputs.push([file, stat ? hash(readFileSync(path)) : null]);
    }
    for (let directory=dirname(path);;directory=dirname(directory)) {
      for (const name of ['.gitignore', '.ignore', '.rgignore', 'nose.ignore.json']) controls.add(join(directory,name));
      if (directory===root) break;
    }
  }
  for (let directory=root;;directory=dirname(directory)) {
    for (const name of ['.gitignore', '.ignore', '.rgignore', 'nose.ignore.json']) controls.add(join(directory,name));
    if (dirname(directory)===directory) break;
  }
  const localExclude=git(root,['rev-parse','--path-format=absolute','--git-path','info/exclude']).trim();
  const controlHashes=[...controls].sort().flatMap(path=>{
    const stat=lstatSync(path,{throwIfNoEntry:false});
    if (stat && !stat.isFile()) throw new Error('Ignore controls must be regular files');
    if (!stat && !path.startsWith(root+'/')) return [];
    return [[path.startsWith(root+'/') ? path.slice(root.length+1) : path,stat ? hash(readFileSync(path)) : null]];
  });
  const excludeStat=lstatSync(localExclude,{throwIfNoEntry:false});
  if (excludeStat && !excludeStat.isFile()) throw new Error('Ignore controls must be regular files');
  controlHashes.push(['git:info/exclude',excludeStat ? hash(readFileSync(localExclude)) : null]);
  return hash(JSON.stringify({kind:'working-folder',inputs,controls:controlHashes}));
}

function linkedInput(path, ancestors = new Set(), budget = {remaining:20000}) {
  if (--budget.remaining < 0 || ancestors.size > 64) throw new Error('Linked input exceeds identity limits');
  const stat=lstatSync(path,{throwIfNoEntry:false});
  if (!stat) return null;
  if (ancestors.has(path)) throw new Error('Cyclic linked input');
  const next=new Set([...ancestors,path]);
  if (stat.isSymbolicLink()) {
    const target=readlinkSync(path);
    return {link:target,target:linkedInput(resolve(dirname(path),target),next,budget)};
  }
  if (stat.isFile()) return hash(readFileSync(path));
  if (stat.isDirectory()) return readdirSync(path).sort().map(name=>[name,linkedInput(join(path,name),next,budget)]);
  throw new Error('Unsupported linked input');
}
export function withRegistry(root, operation) {
  const directory = stateRoot(root);
  const lock = join(directory,'lock');
  try { mkdirSync(lock); } catch (error) {
    if (error.code === 'EEXIST') {
      writeFileSync(join(directory,'collision'), 'Registry contention');
      throw new Error('Concurrent session registry update; review deferred');
    }
    throw error;
  }
  try { return operation(directory); } finally { rmSync(lock,{recursive:true}); }
}
export function register(root, session) {
  return withRegistry(root, directory => {
    const name = `${hash(session)}.json`;
    const others = readdirSync(directory).filter(file=>file.endsWith('.json') && file!==name);
    for (const file of others) {
      const previous = JSON.parse(readFileSync(join(directory,file),'utf8'));
      atomicJson(join(directory,file),{...previous,overlap:true});
    }
    const record = {overlap:others.length>0,ready:false};
    atomicJson(join(directory,name),record);
    return record;
  });
}
const cacheEvent=({operation,outcome,reason})=>process.stderr.write(`[nose result-cache] ${operation} ${outcome}: ${reason}\n`);
const identitySkipped=reason=>cacheEvent({operation:'identity',outcome:'skipped',reason});

// Call only for a locked, immutable tree prepared under the identity's proof
// contract. Mutable folders always use scan() and independent source reads.
export function committedResult(root, cacheOwner, inputIdentity) {
  const started=performance.now();
  const directory=cacheStateRoot(cacheOwner);
  const inputs=scannerInputs(root,{cacheDirectory:directory,cacheOwner,managed:true});
  const identity=inputs.identity(inputIdentity,identitySkipped);
  const cached=identity ? readScanResult({directory,identity,onEvent:cacheEvent}) : null;
  if (!cached || cached.noseVersion!==inputs.noseVersion
    || JSON.stringify(identity)!==JSON.stringify(inputs.identity(inputIdentity,identitySkipped))) return null;
  process.stderr.write(`[nose scan] verified result cache hit for ${inputIdentity.inventory}; ${cached.families.length} families\n`);
  process.stderr.write(`[nose scan] immutable result verification finished in ${(performance.now()-started).toFixed(3)}ms\n`);
  return cached;
}

export function scan(root, verifiedFiles, cacheOwner = root, inputIdentity, evidence) {
  const started = performance.now();
  const phaseFinished=(phase,start)=>process.stderr.write(`[nose scan] ${phase} finished in ${(performance.now()-start).toFixed(3)}ms\n`);
  const snapshotStarted=performance.now();
  if(evidence && (evidence.root!==realpathSync(root) || JSON.stringify(evidence.identity)!==JSON.stringify(inputIdentity)))
    throw new Error('Archive source evidence does not match scan inputs');
  const before = evidence?.files ?? snapshot(root, verifiedFiles);
  phaseFinished('source snapshot',snapshotStarted);
  const cacheReadStarted=performance.now();
  const cacheDirectory = cacheStateRoot(cacheOwner);
  const inputs=scannerInputs(root,{cacheDirectory,cacheOwner,managed:verifiedFiles!==undefined || isGit(root),exclusions:[...excluded]});
  const {env,args,cache,threads,noseVersion}=inputs;
  const temporary = mkdtempSync(join(tmpdir(),'nose-review-scan-'));
  try {
    const contentIdentity=()=>verifiedFiles === undefined ? workingIdentity(root) : inputIdentity;
    const initialIdentity=contentIdentity();
    const identity=inputs.identity(initialIdentity,identitySkipped);
    const resultCache={directory:cacheDirectory,identity,onEvent:cacheEvent};
    const cached=identity ? readScanResult(resultCache) : null;
    phaseFinished('cache identity/read',cacheReadStarted);
    const cachedVerificationStarted=performance.now();
    if (cached && cached.noseVersion===noseVersion && JSON.stringify(cached.files)===JSON.stringify(before)) {
      const memberHashesForFamily=createMemberHasher(root);
      const verified=cached.families.every(family=>hash(JSON.stringify(memberHashesForFamily(family)))===family.fingerprint);
      if (verified && JSON.stringify(before)===JSON.stringify(snapshot(root,verifiedFiles))
        && JSON.stringify(identity)===JSON.stringify(inputs.identity(contentIdentity(),identitySkipped))) {
        phaseFinished('report/source verification',cachedVerificationStarted);
        process.stderr.write(`[nose scan] verified result cache hit for ${initialIdentity}; ${cached.families.length} families\n`);
        return cached;
      }
      cacheEvent({operation:'verify',outcome:'miss',reason:verified?'source-changed-during-read':'membership-mismatch'});
    } else if (cached) {
      cacheEvent({operation:'verify',outcome:'miss',reason:cached.noseVersion===noseVersion?'source-snapshot-mismatch':'version-mismatch'});
    }
    if (cached) phaseFinished('report/source verification',cachedVerificationStarted);
    const reportPath=join(temporary,'report.json');
    const reportDescriptor=openSync(reportPath,'wx',0o600);
    let result;
    let scannerStarted;
    try {
      process.stderr.write(`[nose scan] ${Object.keys(before).length} source files; worker setting ${threads}; reusable cache ${cache}; budget ${scanTimeoutMs / 1000}s\n`);
      scannerStarted=performance.now();
      result = spawnSync('nose',args,{
        cwd:root,
        env,
        encoding:'utf8',
        timeout:scanTimeoutMs,
        maxBuffer:8*1024*1024,
        stdio:['ignore',reportDescriptor,'pipe'],
      });
    } finally {
      if (scannerStarted!==undefined) phaseFinished('native execution',scannerStarted);
      closeSync(reportDescriptor);
    }
    if (result.error?.code==='ETIMEDOUT') throw new Error(`Nose scan exceeded ${scanTimeoutMs / 1000} seconds`);
    if (result.signal) throw new Error(`Nose scan terminated by ${result.signal}`);
    if (result.status!==0) throw new Error('Nose scan failed');
    process.stderr.write(`[nose scan] scanner finished in ${Math.ceil((performance.now() - scannerStarted) / 1000)}s; loading report\n`);
    const verificationStarted=performance.now();
    const report = JSON.parse(readFileSync(reportPath,'utf8'));
    if (!Array.isArray(report.families)) throw new Error('Unsupported Nose report');
    process.stderr.write(`[nose scan] verifying ${report.families.length} families against source\n`);
    const families = verifiedFamilies(report,root);
    if (JSON.stringify(before)!==JSON.stringify(snapshot(root, verifiedFiles))) throw new Error('Code changed during scan; review deferred');
    const verifiedResult={noseVersion,families,files:before};
    if (identity) {
      const afterIdentity=inputs.identity(contentIdentity(),identitySkipped);
      if (JSON.stringify(identity)!==JSON.stringify(afterIdentity)) throw new Error('Scan inputs changed during scan; review deferred');
    }
    phaseFinished('report/source verification',verificationStarted);
    if (identity) {
      const writeStarted=performance.now();
      writeScanResult({...resultCache,result:verifiedResult});
      phaseFinished('result write',writeStarted);
    }
    process.stderr.write(`[nose scan] completed in ${Math.ceil((performance.now() - started) / 1000)}s; ${families.length} families\n`);
    return verifiedResult;
  } finally {
    rmSync(temporary,{recursive:true,force:true});
    phaseFinished('total',started);
  }
}
