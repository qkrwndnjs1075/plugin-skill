import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const digest = data => createHash('sha256').update(data).digest('hex');
export const runtimeManifest = () => JSON.parse(readFileSync(new URL('./nose-runtime.json', import.meta.url), 'utf8'));
const cacheRoot = env => env.NOSE_REVIEW_RUNTIME_ROOT ?? join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache'), 'nose-review', 'runtime');
const target = () => `${process.platform}-${process.arch}`;
const pin = manifest => ({repository:manifest.repository,version:manifest.version,target:target(),archiveSha256:manifest.assets[target()]?.sha256});
const releasePath = (base, manifest) => join(base, `${manifest.version}-${target()}-${digest(JSON.stringify(pin(manifest))).slice(0,16)}`);
function verified(directory, expected) {
  if (!lstatSync(directory, {throwIfNoEntry:false})) return null;
  const binary = join(directory, 'nose');
  const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
  if (expected && Object.entries(expected).some(([key,value])=>receipt[key]!==value)) throw new Error('Managed Nose receipt does not match its pinned release');
  if (!lstatSync(binary).isFile() || digest(readFileSync(binary)) !== receipt.binarySha256)
    throw new Error('Managed Nose integrity check failed');
  accessSync(binary, constants.X_OK);
  return binary;
}
function previous(base, manifest) {
  if (!lstatSync(base,{throwIfNoEntry:false})) return null;
  for (const name of readdirSync(base).filter(name=>/^v\d+\.\d+\.\d+-/.test(name) && !name.endsWith('.lock')).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}))) {
    const directory=join(base,name);
    const receipt=JSON.parse(readFileSync(join(directory,'receipt.json'),'utf8'));
    if (receipt.repository===manifest.repository && receipt.target===target()
      && (receipt.version!==manifest.version || receipt.archiveSha256===manifest.assets[target()]?.sha256)) return verified(directory);
  }
  return null;
}
function external(env, cwd) {
  return (env.PATH || '').split(delimiter).map(part => resolve(cwd, part, 'nose')).find(path => {
    try { accessSync(path, constants.X_OK); return lstatSync(path).isFile() || lstatSync(path).isSymbolicLink(); }
    catch { return false; }
  });
}
export function resolveNose({env=process.env, cwd=process.cwd(), manifest=runtimeManifest()}={}) {
  return verified(releasePath(cacheRoot(env), manifest),pin(manifest)) || previous(cacheRoot(env),manifest) || external(env, cwd) || (() => { throw new Error('Nose executable unavailable; rerun plugin setup'); })();
}
function download(url, destination) {
  const parsed=new URL(url), [,owner,repo,,,version,asset]=parsed.pathname.split('/');
  const result = spawnSync('gh', ['release', 'download', version, '--repo', `${owner}/${repo}`, '--pattern', asset, '--output', destination], {encoding:'utf8', timeout:125000});
  if (result.error || result.status !== 0) throw new Error('Private Nose release download unavailable; install GitHub CLI and run gh auth login with an account that can read '+owner+'/'+repo+'.');
}
export function ensureNose({env=process.env, cwd=process.cwd(), manifest=runtimeManifest(), fetchArchive=download}={}) {
  if (!/^v\d+\.\d+\.\d+$/.test(manifest.version) || !/^[\w.-]+\/[\w.-]+$/.test(manifest.repository)) throw new Error('Invalid Nose runtime manifest');
  const base=cacheRoot(env), destination=releasePath(base, manifest);
  const present=verified(destination,pin(manifest));
  if (present) return {status:'current', binary:present, version:manifest.version};
  const fallback = reason => {
    const cached=previous(base,manifest), binary=cached || external(env,cwd);
    if (!binary) throw new Error(reason);
    return {status:cached?'offline':'external', binary, reason};
  };
  const asset=manifest.assets[target()];
  if (!asset) return fallback('Managed Nose is unavailable for '+target());
  if (!/^[a-zA-Z0-9._-]+$/.test(asset.name) || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid Nose asset metadata');
  mkdirSync(base,{recursive:true,mode:0o700});
  const lock=destination+'.lock';
  try { mkdirSync(lock); } catch(error) {
    if (error.code !== 'EEXIST') throw error;
    return fallback('Another managed Nose installation is in progress. If no setup process is running, remove '+lock+' and retry setup.');
  }
  const stage=mkdtempSync(join(base,'.install-'));
  try {
    const raced=verified(destination,pin(manifest));
    if (raced) return {status:'current',binary:raced,version:manifest.version};
    const archive=join(stage,'archive.tar.xz');
    try { fetchArchive(`https://github.com/${manifest.repository}/releases/download/${manifest.version}/${asset.name}`,archive); }
    catch(error) { return fallback(error.message); }
    if (digest(readFileSync(archive)) !== asset.sha256) throw new Error('Nose archive checksum mismatch; installation rejected');
    const member=asset.name.replace(/\.tar\.xz$/,'')+'/nose';
    const extracted=spawnSync('tar',['-xOf',archive,member],{timeout:30000,maxBuffer:256*1024*1024});
    if (extracted.error || extracted.status !== 0 || !extracted.stdout?.length) throw new Error('Nose archive does not contain the expected executable');
    const binary=join(stage,'nose');
    writeFileSync(binary,extracted.stdout,{mode:0o755});
    const version=spawnSync(binary,['--version'],{encoding:'utf8',timeout:10000});
    if (version.error || version.status !== 0 || version.stdout.trim() !== `nose ${manifest.version.slice(1)}`) throw new Error('Downloaded Nose version verification failed');
    writeFileSync(join(stage,'receipt.json'),JSON.stringify({...pin(manifest),binarySha256:digest(extracted.stdout)})+'\n',{mode:0o600});
    rmSync(archive);
    renameSync(stage,destination);
    return {status:'installed',binary:join(destination,'nose'),version:manifest.version};
  } finally { rmSync(stage,{recursive:true,force:true}); rmSync(lock,{recursive:true,force:true}); }
}
