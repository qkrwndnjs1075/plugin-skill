import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, lstatSync, mkdtempSync, renameSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fingerprintFamily } from './review-policy.mjs';

const extensions = new Set(['.c','.cpp','.cc','.h','.hpp','.css','.cts','.go','.html','.java','.js','.jsx','.mjs','.mts','.py','.pyi','.rb','.rs','.svelte','.swift','.ts','.tsx','.vue']);
export const hash = value => createHash('sha256').update(value).digest('hex');
export function git(root, args) {
  const result = spawnSync('git', args, {cwd:root,encoding:'utf8',timeout:10000,maxBuffer:32*1024*1024});
  if (result.status !== 0) throw new Error('Git state could not be read');
  return result.stdout;
}
export function snapshot(root) {
  const files = [...new Set(git(root,['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean))].sort();
  const entries = [];
  for (const file of files) {
    if (!extensions.has(extname(file).toLowerCase())) continue;
    try {
      if (!lstatSync(join(root,file)).isFile()) continue;
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
    const result = spawnSync('nose',['query','.','all','top=0','sort=extractability','--mode','syntax,semantic,near','--min-size','24','--cache-dir',cache,'--format','json'],{cwd:root,encoding:'utf8',timeout:45000,maxBuffer:64*1024*1024});
    if (result.status!==0) throw new Error('Nose scan failed or exceeded 45 seconds');
    const report = JSON.parse(result.stdout);
    if (!Array.isArray(report.families)) throw new Error('Unsupported Nose report');
    const families = report.families.map(family=>({...family,fingerprint:fingerprintFamily(family,root)}));
    if (JSON.stringify(before)!==JSON.stringify(snapshot(root))) throw new Error('Code changed during scan; review deferred');
    return {noseVersion:version.stdout.trim(),families,files:before};
  } finally { rmSync(cache,{recursive:true,force:true}); }
}
