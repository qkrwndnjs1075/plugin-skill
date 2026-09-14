import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scan, projectRoot, snapshot } from './review-runtime.mjs';

test('plain folders exclude dependencies, build output and symlinks and enforce size limits', t=>{
  const root=mkdtempSync(join(tmpdir(),'nose-plain-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,'app.js'),'export const a = 1;');
  for(const name of ['node_modules','dist','.venv','.nose-review']) {
    mkdirSync(join(root,name));
    writeFileSync(join(root,name,'ignored.js'),'export const a = 1;');
  }
  symlinkSync(join(root,'app.js'),join(root,'linked.js'));
  assert.equal(projectRoot(root),realpathSync(root));
  const originalPath=process.env.PATH;
  process.env.PATH='';
  try { assert.equal(projectRoot(root),realpathSync(root)); }
  finally { process.env.PATH=originalPath; }
  assert.deepEqual(Object.keys(snapshot(root)),['app.js']);
  writeFileSync(join(root,'large.js'),Buffer.alloc(5*1024*1024+1));
  assert.throws(()=>snapshot(root),/source limits/);
});

test('plain home and filesystem roots are rejected',()=>{
  assert.throws(()=>projectRoot('/'),/project folder/);
  assert.throws(()=>projectRoot(homedir()),/project folder/);
});

test('scan discards a result when source changes during Nose execution', t=>{
  const fixture=mkdtempSync(join(tmpdir(),'nose-race-'));
  t.after(()=>rmSync(fixture,{recursive:true,force:true}));
  const repo=join(fixture,'repo');
  const bin=join(fixture,'bin');
  mkdirSync(repo); mkdirSync(bin);
  execFileSync('git',['init','-q'],{cwd:repo});
  const source=join(repo,'a.js');
  writeFileSync(source,'export const a = 1;\n');
  // A deterministic external scanner mutates the file after the pre-scan snapshot.
  writeFileSync(join(bin,'nose'), '#!'+process.execPath+'\n'+
    "const fs=require('node:fs'); if(process.argv.includes('--version')) console.log('nose fixture'); else {fs.appendFileSync("+
    JSON.stringify(source)+",'// external edit\\n'); console.log(JSON.stringify({families:[]}));}\n",{mode:0o700});
  const previous=process.env.PATH;
  process.env.PATH=bin+':'+previous;
  try { assert.throws(()=>scan(repo),/Code changed during scan/); }
  finally { process.env.PATH=previous; }
});
