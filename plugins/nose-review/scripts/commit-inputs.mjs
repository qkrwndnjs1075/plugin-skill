import {createHash} from 'node:crypto';
import {closeSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, posix} from 'node:path';
import {git} from './review-runtime.mjs';
import {hash, isSourceFile} from './source-evidence.mjs';

const maxTreeEntries=100_000;

export function commitTree(root,sha) {
  git(root,['cat-file','-e',`${sha}^{commit}`]);
  const raw=git(root,['ls-tree','-rz',sha]).split('\0').filter(Boolean);
  if(raw.length>maxTreeEntries) throw new Error(`Commit exceeds ${maxTreeEntries} tree entries`);
  const objectFormat=git(root,['rev-parse','--show-object-format']).trim();
  if(!['sha1','sha256'].includes(objectFormat)) throw new Error('Unsupported Git object format');
  const entries=raw.map(entry=>{
    const [metadata,file]=entry.split(/\t(.*)/s);
    const [mode,type,object]=metadata.split(' ');
    if(type==='commit') throw new Error('Submodule content cannot be scanned from a commit archive');
    return {file,mode,type,object};
  });
  const identity={kind:'verified-git-tree',objectFormat,inventory:hash(raw.join('\0')),
    preparation:hash([blobDigest,fileDigests,verifyArchive].map(String).join('\n'))};
  // Discovery and link targets are immutable only within this tracked tree.
  // TOML discovery is cwd-only; unmodelled configuration stays on the full path.
  const reusable=entries.every(({file,mode,type})=>type==='blob' && ['100644','100755','120000'].includes(mode)
    && !['nose.toml','.nose.toml'].includes(file) && !file.split('/').includes('.git'))
    && internalLinks(root,entries);
  return {entries,files:entries.map(entry=>entry.file),objectFormat,identity,reusable};
}

function internalLinks(root,entries) {
  const links=new Map(entries.filter(entry=>entry.mode==='120000').map(entry=>
    [entry.file,git(root,['cat-file','blob',entry.object])]));
  if(!links.size) return true;
  const paths=new Set(entries.map(entry=>entry.file));
  const directories=new Set(['.']);
  for(const file of paths) {
    for(let directory=posix.dirname(file);directory!=='.';directory=posix.dirname(directory)) directories.add(directory);
  }
  const resolveLink=file=>{
    const resolved=[],visited=new Set();
    let pending=file.split('/');
    while(pending.length) {
      const part=pending.shift();
      if(!part || part==='.') continue;
      if(part==='..') {
        if(!resolved.length) return false;
        resolved.pop();
        continue;
      }
      resolved.push(part);
      const path=resolved.join('/');
      if(links.has(path)) {
        const target=links.get(path);
        if(!target || posix.isAbsolute(target) || visited.has(path) || visited.size>=64) return false;
        visited.add(path);
        resolved.pop();
        // Resolve a symlink before a following '..', as the filesystem does.
        pending=[...target.split('/'),...pending];
      } else if(pending.length && !directories.has(path)) return false;
    }
    const path=resolved.join('/') || '.';
    return paths.has(path) || directories.has(path);
  };
  return [...links.keys()].every(file=>resolveLink(file));
}

export function blobDigest(content,algorithm) {
  return createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest('hex');
}

export function fileDigests(path,algorithm,buffer,source=false) {
  const size=statSync(path).size;
  const blob=createHash(algorithm).update(`blob ${size}\0`);
  const content=source?createHash('sha256'):null;
  const descriptor=openSync(path,'r');
  let position=0;
  try {
    while(position<size) {
      const count=readSync(descriptor,buffer,0,Math.min(buffer.length,size-position),position);
      if(count===0) throw new Error('Archive file ended before its declared size');
      const chunk=buffer.subarray(0,count);
      blob.update(chunk);
      content?.update(chunk);
      position+=count;
    }
  } finally {closeSync(descriptor);}
  return {blob:blob.digest('hex'),source:content?.digest('hex')};
}

export function verifyArchive(directory,tree,materializeSymlinks) {
  const files={};
  const deadline=Date.now()+120_000;
  const buffer=Buffer.allocUnsafe(1024*1024);
  for(const {file,mode,object} of tree.entries) {
    if(Date.now()>deadline) throw new Error('Commit archive verification exceeded 120 seconds');
    const path=join(directory,file);
    if(mode==='120000') {
      const target=readlinkSync(path,{encoding:'buffer'});
      if(blobDigest(target,tree.objectFormat)!==object) throw new Error(`Archive differs from pushed tree: ${file}`);
      if(materializeSymlinks) {
        rmSync(path);
        writeFileSync(path,target,{flag:'wx',mode:0o600});
      }
      continue;
    }
    if(!lstatSync(path,{throwIfNoEntry:false})?.isFile()) throw new Error(`Archive differs from pushed tree: ${file}`);
    const source=isSourceFile(file);
    const digests=fileDigests(path,tree.objectFormat,buffer,source);
    if(digests.blob!==object) throw new Error(`Archive differs from pushed tree: ${file}`);
    if(source) files[file]=digests.source;
  }
  if(!materializeSymlinks) {
    for(const {file} of tree.entries) {
      if(['.gitignore','.ignore','nose.ignore.json'].includes(file.split('/').at(-1))) rmSync(join(directory,file),{force:true});
    }
  }
  return {root:realpathSync(directory),identity:tree.identity,files};
}
