import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, lstatSync, mkdtempSync, renameSync, realpathSync, existsSync } from 'node:fs';
import { join, extname, dirname, parse } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { memberHashesForFamily, hash } from './review-policy.mjs';
export { hash } from './review-policy.mjs';

const extensions = new Set(['.c','.cpp','.cc','.h','.hpp','.css','.cts','.go','.html','.java','.js','.jsx','.mjs','.mts','.py','.pyi','.rb','.rs','.svelte','.swift','.ts','.tsx','.vue']);
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
export function snapshot(root) {
  const managed=isGit(root);
  const files = managed ? [...new Set(git(root,['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean))].sort() : plainFiles(root);
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
  return directory;
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
export function scan(root) {
  const before = snapshot(root);
  const version = spawnSync('nose',['--version'],{encoding:'utf8',timeout:5000});
  if (version.status!==0) throw new Error('Nose executable unavailable');
  const cache = mkdtempSync(join(tmpdir(),'nose-review-scan-'));
  try {
    const exclusions=isGit(root)?[]:[...excluded].flatMap(name=>['--exclude',name+'/']);
    const result = spawnSync('nose',['query','.','all','top=0','sort=extractability','--mode','syntax,semantic,near','--min-size','24','--cache-dir',cache,'--format','json',...exclusions],{cwd:root,encoding:'utf8',timeout:45000,maxBuffer:64*1024*1024});
    if (result.status!==0) throw new Error('Nose scan failed or exceeded 45 seconds');
    const report = JSON.parse(result.stdout);
    if (!Array.isArray(report.families)) throw new Error('Unsupported Nose report');
    const families = report.families.flatMap(family=>{
      if (!Array.isArray(family?.locations)) throw new Error('Family must contain source locations.');
      const locations=family.locations.filter(location=>location?.region !== null);
      if (locations.length !== family.locations.length && locations.length < 2) return [];
      const candidate=locations.length === family.locations.length ? family : {...family,locations};
      const memberHashes=memberHashesForFamily(candidate,root);
      return [{...candidate,memberHashes,fingerprint:hash(JSON.stringify(memberHashes))}];
    });
    if (JSON.stringify(before)!==JSON.stringify(snapshot(root))) throw new Error('Code changed during scan; review deferred');
    return {noseVersion:version.stdout.trim(),families,files:before};
  } finally { rmSync(cache,{recursive:true,force:true}); }
}
