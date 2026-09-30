import { spawnSync } from 'node:child_process';
import { accessSync, constants, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, extname, dirname, parse, delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir, availableParallelism } from 'node:os';
import { createMemberHasher, hash } from './review-policy.mjs';
import { readScanResult, writeScanResult } from './scan-result-cache.mjs';
export { hash } from './review-policy.mjs';
export const shellQuote = text => "'" + text.replaceAll("'", "'\"'\"'") + "'";

export const scanTimeoutMs = 600_000;
export const refTimeoutMs = 2 * scanTimeoutMs + 60_000;

const extensions = new Set(['.c','.cpp','.cc','.h','.hpp','.css','.cts','.go','.htm','.html','.java','.js','.jsx','.cjs','.mjs','.mts','.py','.pyi','.rb','.rs','.svelte','.swift','.ts','.tsx','.vue']);
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
      else if(entry.isFile() && extensions.has(extname(path).toLowerCase())) files.push(path);
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
    if (!extensions.has(extname(file).toLowerCase())) continue;
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
function resultIdentity(root, args, version, inputIdentity, env, onSkip) {
  const skip=reason=>{onSkip?.(reason);return null;};
  if (!inputIdentity) return skip('no-content-identity');
  try {
    const executable = (env.PATH ?? '').split(delimiter).map(directory=>resolve(root,directory,'nose'))
      .find(path=>{try {accessSync(path,constants.X_OK);return lstatSync(realpathSync(path)).isFile();} catch {return false;}});
    if (!executable) return skip('executable-unresolved');
    const config = spawnSync(executable,[...args,'--show-config'],{cwd:root,env,encoding:'utf8',timeout:5000,maxBuffer:1024*1024});
    if (config.status !== 0) return skip('effective-config-unavailable');
    const settings = JSON.parse(config.stdout);
    // External configuration can refer to mutable files outside the verified tree.
    if (settings.schema !== 'nose.query-config/v1' || !settings.query
      || !Array.isArray(settings.query['semantic-packs'])) return skip('effective-config-unsupported');
    if (settings.config_file !== null) return skip('external-config');
    if (settings.query['ignore-file'] !== null) return skip('external-ignore');
    if (settings.query['semantic-pack-lock'] !== null || settings.query['semantic-packs'].length)
      return skip('external-semantic-pack');
    const scripts=dirname(fileURLToPath(import.meta.url));
    const policy=['review-runtime.mjs','review-policy.mjs','nose-pre-push.mjs','verified-archive.mjs','scan-result-cache.mjs']
      .map(name=>[name,hash(readFileSync(join(scripts,name)))]);
    const ignores=spawnSync('git',['config','--path','--get-all','core.excludesFile'],{cwd:root,env,encoding:'utf8',timeout:5000});
    if (ignores.error || ![0,1].includes(ignores.status)) return skip('global-ignore-config-unavailable');
    const ignorePaths=[join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(),'.config'),'git','ignore'),
      ...ignores.stdout.trim().split('\n').filter(Boolean).map(path=>resolve(root,path))];
    const globalIgnores=[...new Set(ignorePaths)].map(path=>[path,existsSync(path)?hash(readFileSync(path)):null]);
    return {inputIdentity,root:isGit(root)?cacheStateRoot(root):root,version,executable:realpathSync(executable),binary:hash(readFileSync(executable)),
      policy,args,settings,globalIgnores,node:process.version,
      environment:hash(JSON.stringify(Object.entries(env).sort(([a],[b])=>a.localeCompare(b))))};
  } catch { return skip('identity-unavailable'); }
}

function scannerEnvironment(root, env) {
  // The caller has resolved repository ownership. Scanner children read the
  // selected source directory, never an inherited hook's index or object store.
  for (const key of ['NOSE_PLUGIN_ROOT','NOSE_PROJECT_ROOT','NOSE_REVIEW_STATE_ROOT',
    'GIT_DIR','GIT_COMMON_DIR','GIT_WORK_TREE','GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_QUARANTINE_PATH']) delete env[key];
  if (!isGit(root)) return env;
  // Git wrappers and hooks prepend executable paths. Run both entry points
  // with Git's actual child environment, including for effective-config reads.
  const script='console.log(JSON.stringify(Object.fromEntries(["PATH","GIT_EXEC_PATH","GIT_PREFIX"].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]))))';
  const command='!'+shellQuote(process.execPath)+' -e '+shellQuote(script);
  const probe=spawnSync('git',['-c','alias.nose-review-env='+command,'nose-review-env'],{
    cwd:root,env,encoding:'utf8',timeout:5000,maxBuffer:1024*1024,
  });
  if(probe.status!==0) throw new Error('Git scanner environment unavailable');
  const effective=JSON.parse(probe.stdout);
  for(const key of ['PATH','GIT_EXEC_PATH','GIT_PREFIX']) {
    if(effective[key]!==undefined && typeof effective[key]!=='string') throw new Error('Invalid Git scanner environment');
  }
  return {...env,...Object.fromEntries(['PATH','GIT_EXEC_PATH','GIT_PREFIX'].filter(key=>effective[key]!==undefined).map(key=>[key,
    key==='PATH' ? [...new Set(effective[key].split(delimiter))].join(delimiter) : effective[key]]))};
}

export function scan(root, verifiedFiles, cacheOwner = root, inputIdentity) {
  const started = performance.now();
  const phaseFinished=(phase,start)=>process.stderr.write(`[nose scan] ${phase} finished in ${(performance.now()-start).toFixed(3)}ms\n`);
  const parallelism = availableParallelism();
  const threads = process.env.RAYON_NUM_THREADS ?? String(Math.min(2, parallelism));
  if (!/^[1-9]\d*$/.test(threads) || !Number.isSafeInteger(Number(threads)) || Number(threads) > parallelism)
    throw new Error(`RAYON_NUM_THREADS must be an integer from 1 to ${parallelism}`);
  const snapshotStarted=performance.now();
  const before = snapshot(root, verifiedFiles);
  phaseFinished('source snapshot',snapshotStarted);
  const cacheReadStarted=performance.now();
  const cacheDirectory = cacheStateRoot(cacheOwner);
  // Nose's detector overrides are not all exposed by --show-config. Preserve
  // scanner, Git/config, locale and OS runtime inputs in both child and cache key.
  const runtimeVariables=new Set(['PATH','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','LANG','LANGUAGE',
    'TMPDIR','TMP','TEMP','SystemRoot','SYSTEMROOT','WINDIR','PATHEXT']);
  const env=scannerEnvironment(cacheOwner,Object.fromEntries(Object.entries(process.env).filter(([key])=>
    runtimeVariables.has(key) || /^(NOSE_|RAYON_|GIT_|XDG_|LC_|DYLD_|LD_)/.test(key))));
  env.RAYON_NUM_THREADS=threads;
  const version = spawnSync('nose',['--version'],{cwd:root,env,encoding:'utf8',timeout:5000});
  if (version.status!==0) throw new Error('Nose executable unavailable');
  const cache = join(cacheDirectory, 'analysis-cache');
  mkdirSync(cache,{recursive:true,mode:0o700});
  if (lstatSync(cache).isSymbolicLink()) throw new Error('Analysis cache must not be a symlink');
  const temporary = mkdtempSync(join(tmpdir(),'nose-review-scan-'));
  try {
    const exclusions=verifiedFiles !== undefined || isGit(root)?[]:[...excluded].flatMap(name=>['--exclude',name+'/']);
    const args=['query','.','all','top=0','sort=extractability','--mode','syntax,semantic,near','--min-size','24','--cache-dir',cache,'--format','json',...exclusions];
    const cacheEvent=({operation,outcome,reason})=>process.stderr.write(`[nose result-cache] ${operation} ${outcome}: ${reason}\n`);
    const identitySkipped=reason=>cacheEvent({operation:'identity',outcome:'skipped',reason});
    const contentIdentity=()=>verifiedFiles === undefined ? workingIdentity(root) : inputIdentity;
    const initialIdentity=contentIdentity();
    const identity=resultIdentity(root,args,version.stdout.trim(),initialIdentity,env,identitySkipped);
    const resultCache={directory:cacheDirectory,identity,onEvent:cacheEvent};
    const cached=identity ? readScanResult(resultCache) : null;
    phaseFinished('cache identity/read',cacheReadStarted);
    const cachedVerificationStarted=performance.now();
    if (cached && cached.noseVersion===version.stdout.trim() && JSON.stringify(cached.files)===JSON.stringify(before)) {
      const memberHashesForFamily=createMemberHasher(root);
      const verified=cached.families.every(family=>hash(JSON.stringify(memberHashesForFamily(family)))===family.fingerprint);
      if (verified && JSON.stringify(before)===JSON.stringify(snapshot(root,verifiedFiles))
        && JSON.stringify(identity)===JSON.stringify(resultIdentity(root,args,version.stdout.trim(),contentIdentity(),env,identitySkipped))) {
        phaseFinished('report/source verification',cachedVerificationStarted);
        process.stderr.write(`[nose scan] verified result cache hit for ${initialIdentity}; ${cached.families.length} families\n`);
        return cached;
      }
      cacheEvent({operation:'verify',outcome:'miss',reason:verified?'source-changed-during-read':'membership-mismatch'});
    } else if (cached) {
      cacheEvent({operation:'verify',outcome:'miss',reason:cached.noseVersion===version.stdout.trim()?'source-snapshot-mismatch':'version-mismatch'});
    }
    if (cached) phaseFinished('report/source verification',cachedVerificationStarted);
    const reportPath=join(temporary,'report.json');
    const reportDescriptor=openSync(reportPath,'wx',0o600);
    let result;
    let scannerStarted;
    try {
      process.stderr.write(`[nose scan] ${Object.keys(before).length} source files; workers ${threads}; reusable cache ${cache}; budget ${scanTimeoutMs / 1000}s\n`);
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
    const memberHashesForFamily = createMemberHasher(root);
    const families = report.families.flatMap(family=>{
      if (!Array.isArray(family?.locations)) throw new Error('Family must contain source locations.');
      const locations=family.locations.filter(location=>location?.region !== null);
      if (locations.length !== family.locations.length && locations.length < 2) return [];
      const candidate=locations.length === family.locations.length ? family : {...family,locations};
      const memberHashes=memberHashesForFamily(candidate);
      return [{...candidate,memberHashes,fingerprint:hash(JSON.stringify(memberHashes))}];
    });
    if (JSON.stringify(before)!==JSON.stringify(snapshot(root, verifiedFiles))) throw new Error('Code changed during scan; review deferred');
    const verifiedResult={noseVersion:version.stdout.trim(),families,files:before};
    if (identity) {
      const afterIdentity=resultIdentity(root,args,version.stdout.trim(),contentIdentity(),env,identitySkipped);
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
