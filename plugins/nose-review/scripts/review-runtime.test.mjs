import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { homedir, availableParallelism } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scan, projectRoot, snapshot } from './review-runtime.mjs';
import { countRecordedCalls, preserveEnvironment, testDirectory } from './test-helpers.mjs';

test('plain folders exclude dependencies, build output and symlinks and enforce size limits', t=>{
  const root=testDirectory(t,'nose-plain-');
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
  const fixture=testDirectory(t,'nose-race-');
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

test('scan ignores an ungrounded Nose location whose span exceeds its file', t=>{
  const fixture=testDirectory(t,'nose-invalid-span-');
  const repo=join(fixture,'repo'),bin=join(fixture,'bin');
  mkdirSync(repo);mkdirSync(bin);execFileSync('git',['init','-q'],{cwd:repo});
  writeFileSync(join(repo,'long.py'),Array.from({length:304},(_,i)=>`long_${i}`).join('\n')+'\n');
  writeFileSync(join(repo,'short.py'),Array.from({length:174},(_,i)=>`short_${i}`).join('\n')+'\n');
  execFileSync('git',['add','.'],{cwd:repo});
  const family={id:'invalid-span',locations:[
    {file:'long.py',start:3,end:234,region:{start_byte:14,end_byte:1980}},
    {file:'short.py',start:3,end:234,region:null,region_key:null},
  ]};
  writeFileSync(join(bin,'nose'),'#!'+process.execPath+'\n'+
    `if(process.argv.includes('--version')) console.log('nose fixture'); else console.log(${JSON.stringify(JSON.stringify({families:[family]}))});\n`,{mode:0o700});
  const previous=process.env.PATH;process.env.PATH=bin+':'+previous;
  try { assert.deepEqual(scan(repo).families,[]); }
  finally { process.env.PATH=previous; }
});

test('scan accepts valid Nose JSON larger than the child-process output buffer', t=>{
  const fixture=testDirectory(t,'nose-large-report-');
  const repo=join(fixture,'repo'),bin=join(fixture,'bin');
  mkdirSync(repo);mkdirSync(bin);execFileSync('git',['init','-q'],{cwd:repo});
  writeFileSync(join(repo,'app.js'),'export const answer = 42;\n');
  execFileSync('git',['add','.'],{cwd:repo});
  writeFileSync(join(bin,'nose'),'#!'+process.execPath+'\n'+
    "if(process.argv.includes('--version')) console.log('nose fixture'); else process.stdout.write(JSON.stringify({families:[],padding:'x'.repeat(65*1024*1024)}));\n",{mode:0o700});
  const previous=process.env.PATH;process.env.PATH=bin+':'+previous;
  try { assert.deepEqual(scan(repo).families,[]); }
  finally { process.env.PATH=previous; }
});

test('scans leave worker defaults to Nose, pass overrides unchanged and reuse the project cache', t=>{
  const fixture=testDirectory(t,'nose-resources-');
  const bin=join(fixture,'bin'),owner=join(fixture,'owner');
  mkdirSync(bin);mkdirSync(owner);
  const calls=join(fixture,'calls.jsonl');
  writeFileSync(join(bin,'nose'),'#!'+process.execPath+'\n'+`
    const fs=require('node:fs'),path=require('node:path');
    if(process.argv.includes('--version')) console.log('nose fixture');
    else {
      const args=process.argv.slice(2),cache=args[args.indexOf('--cache-dir')+1];
      fs.mkdirSync(cache,{recursive:true});
      const marker=path.join(cache,'cache-marker');
      fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({threads:process.env.RAYON_NUM_THREADS??null,cache,hit:fs.existsSync(marker),args})+'\\n');
      fs.writeFileSync(marker,'cached analysis');
      console.log(JSON.stringify({families:[]}));
    }
  `,{mode:0o700});
  const previous=preserveEnvironment(t,['PATH','NOSE_REVIEW_STATE_ROOT','RAYON_NUM_THREADS']);
  process.env.PATH=bin+':'+previous.PATH;process.env.NOSE_REVIEW_STATE_ROOT=join(fixture,'state');delete process.env.RAYON_NUM_THREADS;
  for(const name of ['snapshot1','snapshot2']) {
    const root=join(fixture,name);mkdirSync(root);writeFileSync(join(root,'app.js'),'const x=1;\n');
    scan(root,['app.js'],owner);
  }
  const rows=readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].threads,null,'the scanner must receive no wrapper-selected worker count');
  assert.equal(rows[1].threads,null);
  assert.equal(rows[1].cache,rows[0].cache);
  assert.equal(rows[0].hit,false);assert.equal(rows[1].hit,true);
  assert.ok(existsSync(rows[0].cache));
  assert.ok(rows[0].args.includes('syntax,semantic,near'));
  assert.equal(process.env.RAYON_NUM_THREADS,undefined);
  for(const override of ['1','0',String(availableParallelism()+1),'auto','']) {
    process.env.RAYON_NUM_THREADS=override;
    scan(owner);
    const last=JSON.parse(readFileSync(calls,'utf8').trim().split('\n').at(-1));
    assert.equal(last.threads,override,'Rayon owns interpretation, including automatic and oversubscribed settings');
  }
});

test('verified content results reuse across sessions but invalidate tool, environment, config and source changes',t=>{
  const logs=[];
  t.mock.method(process.stderr,'write',chunk=>{logs.push(String(chunk));return true;});
  const fixture=testDirectory(t,'nose-result-reuse-');
  const root=join(fixture,'repo'),bin=join(fixture,'bin'),calls=join(fixture,'calls');
  mkdirSync(root);mkdirSync(bin);
  writeFileSync(join(root,'a.js'),'export const a=1;\n');
  const executable=join(bin,'nose');
  writeFileSync(executable,'#!'+process.execPath+'\n'+`
    const fs=require('node:fs');
    if(process.argv.includes('--version')) console.log('nose fixture');
    else if(process.argv.includes('--show-config')) console.log(JSON.stringify({schema:'nose.query-config/v1',
      config_file:fs.existsSync('nose.toml')?'nose.toml':null,
      query:{'ignore-file':null,'semantic-pack-lock':null,'semantic-packs':[]}}));
    else {
      if(process.env.CODEX_THREAD_ID || process.env.TERM_SESSION_ID) throw new Error('session environment leaked');
      fs.appendFileSync(${JSON.stringify(calls)},'query\\n');console.log(JSON.stringify({families:[]}));
    }
  `,{mode:0o700});
  const previous=preserveEnvironment(t,['PATH','NOSE_REVIEW_STATE_ROOT','NOSE_TEST_CONTEXT','XDG_CONFIG_HOME','CODEX_THREAD_ID','TERM_SESSION_ID','NOSE_ANCHOR_MIN_WEIGHT','LC_ALL']);
  Object.assign(process.env,{PATH:bin+':'+previous.PATH,NOSE_REVIEW_STATE_ROOT:join(fixture,'state'),XDG_CONFIG_HOME:join(fixture,'config')});
  const run=()=>scan(root,['a.js'],root,'a'.repeat(40));
  const count=countRecordedCalls.bind(null,calls);
  const first=run();assert.deepEqual(run(),first);assert.equal(count(),1);
  process.env.CODEX_THREAD_ID='another-thread';process.env.TERM_SESSION_ID='another-terminal';
  assert.deepEqual(run(),first);assert.equal(count(),1);
  process.env.NOSE_TEST_CONTEXT='changed';run();assert.equal(count(),2);
  writeFileSync(executable,readFileSync(executable,'utf8')+'\n// same version, changed executable\n');
  run();assert.equal(count(),3);
  writeFileSync(join(root,'a.js'),'export const a=2;\n');
  run();assert.equal(count(),4);
  writeFileSync(join(root,'nose.toml'),'[query]\n');
  run();run();assert.equal(count(),6);
  rmSync(join(root,'nose.toml'));
  mkdirSync(join(fixture,'config','git'),{recursive:true});
  writeFileSync(join(fixture,'config','git','ignore'),'generated.js\n');
  run();assert.equal(count(),7);
  writeFileSync(join(fixture,'config','git','ignore'),'vendor.js\n');
  run();assert.equal(count(),8);
  process.env.NOSE_ANCHOR_MIN_WEIGHT='19';run();assert.equal(count(),9);
  process.env.LC_ALL=process.env.LC_ALL==='C'?'en_US.UTF-8':'C';run();assert.equal(count(),10);
  scan(root,['a.js'],root,'changed-inventory');assert.equal(count(),11);
  assert.ok(logs.some(line=>line.includes('identity skipped: external-config')));
  assert.ok(logs.some(line=>line.includes('verify miss: source-snapshot-mismatch')));
});

test('CommonJS and short HTML sources stay in verified snapshots and reused results',t=>{
  const logs=[];
  t.mock.method(process.stderr,'write',chunk=>{logs.push(String(chunk));return true;});
  const fixture=testDirectory(t,'nose-cjs-cache-');
  const bin=join(fixture,'bin'),root=join(fixture,'repo');
  mkdirSync(bin);mkdirSync(root);
  writeFileSync(join(root,'a.cjs'),'module.exports = 1;\n');
  writeFileSync(join(root,'b.htm'),'<script>const value=1;</script>\n');
  const calls=join(fixture,'queries');
  writeFileSync(join(bin,'nose'),'#!'+process.execPath+'\n'+`
    const fs=require('node:fs');
    if(process.argv.includes('--version')) console.log('nose fixture');
    else if(process.argv.includes('--show-config')) console.log(JSON.stringify({schema:'nose.query-config/v1',
      config_file:null,query:{'ignore-file':null,'semantic-pack-lock':null,'semantic-packs':[]}}));
    else {
      fs.appendFileSync(${JSON.stringify(calls)},'query\\n');
      console.log(JSON.stringify({families:[{locations:['a.cjs','b.htm'].map(file=>({file,start:1,end:1,region:{}}))}]}));
    }
  `,{mode:0o700});
  const previous=preserveEnvironment(t,['PATH','NOSE_REVIEW_STATE_ROOT']);
  Object.assign(process.env,{PATH:bin+':'+previous.PATH,NOSE_REVIEW_STATE_ROOT:join(fixture,'state')});
  const files=['a.cjs','b.htm'];
  const first=scan(root,files,root,'b'.repeat(40));
  assert.deepEqual(scan(root,files,root,'b'.repeat(40)),first);
  assert.equal(readFileSync(calls,'utf8'),'query\n','a complete result must be reused');
  assert.deepEqual(Object.keys(first.files),files);
  assert.ok(logs.some(line=>line.includes('[nose result-cache] write stored:')));
  assert.ok(logs.some(line=>line.includes('[nose result-cache] read hit:')));
});

test('wrapper and hook location variables reuse direct scan results without leaking into the scanner',t=>{
  const logs=[];
  t.mock.method(process.stderr,'write',chunk=>{logs.push(String(chunk));return true;});
  const fixture=testDirectory(t,'nose-hook-context-');
  const owner=join(fixture,'repo'),root=join(fixture,'snapshot'),bin=join(fixture,'bin'),calls=join(fixture,'queries');
  for(const directory of [owner,root,bin]) mkdirSync(directory);
  execFileSync('git',['init','-q'],{cwd:owner});
  writeFileSync(join(root,'a.js'),'export const a=1;\n');
  const locations={NOSE_PLUGIN_ROOT:bin,NOSE_PROJECT_ROOT:owner,
    GIT_DIR:join(owner,'.git'),GIT_COMMON_DIR:join(owner,'.git'),GIT_WORK_TREE:owner,
    GIT_INDEX_FILE:join(owner,'.git','index'),GIT_OBJECT_DIRECTORY:join(owner,'.git','objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES:join(owner,'.git','objects'),GIT_QUARANTINE_PATH:join(owner,'.git','objects')};
  writeFileSync(join(bin,'nose'),'#!'+process.execPath+'\n'+`
    const fs=require('node:fs');
    if(process.argv.includes('--version')) console.log('nose fixture');
    else if(process.argv.includes('--show-config')) console.log(JSON.stringify({schema:'nose.query-config/v1',
      config_file:null,query:{'ignore-file':null,'semantic-pack-lock':null,'semantic-packs':[]}}));
    else {
      fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(Object.fromEntries(
        ${JSON.stringify([...Object.keys(locations),'NOSE_REVIEW_STATE_ROOT'])}.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]])))+'\\n');
      console.log(JSON.stringify({families:[]}));
    }
  `,{mode:0o700});
  const previous=preserveEnvironment(t,['PATH','NOSE_REVIEW_STATE_ROOT','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0',...Object.keys(locations)]);
  for(const key of Object.keys(previous)) if(key!=='PATH') delete process.env[key];
  Object.assign(process.env,{PATH:bin+':'+previous.PATH,NOSE_REVIEW_STATE_ROOT:join(fixture,'state')});
  const run=()=>scan(root,['a.js'],owner,'hook-context-content');
  const first=run();
  for(const [key,value] of Object.entries(locations)) {
    process.env[key]=value;
    assert.deepEqual(run(),first);
    assert.equal(countRecordedCalls(calls),1,`${key} must not rerun an unchanged scanner`);
    delete process.env[key];
  }
  Object.assign(process.env,locations);
  writeFileSync(join(root,'a.js'),'export const a=2;\n');
  run();
  assert.deepEqual(readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse),[{},{}],
    'a cache miss must also remove inherited repository locations from the scanner');
  Object.assign(process.env,{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.ignorecase',GIT_CONFIG_VALUE_0:'true'});
  run();assert.equal(countRecordedCalls(calls),3,'Git configuration must remain part of cache identity');
  assert.ok(logs.some(line=>line.includes('verified result cache hit')));
});

test('scan phase timings include source snapshot, cache write and total duration',t=>{
  const logs=[];
  t.mock.method(process.stderr,'write',chunk=>{logs.push(String(chunk));return true;});
  const fixture=testDirectory(t,'nose-scan-timing-');
  const root=join(fixture,'repo'),bin=join(fixture,'bin');
  mkdirSync(root);mkdirSync(bin);writeFileSync(join(root,'a.js'),'export const a=1;\n');
  writeFileSync(join(bin,'nose'),'#!'+process.execPath+'\n'+`
    if(process.argv.includes('--version')) console.log('nose fixture');
    else if(process.argv.includes('--show-config')) console.log(JSON.stringify({schema:'nose.query-config/v1',
      config_file:null,query:{'ignore-file':null,'semantic-pack-lock':null,'semantic-packs':[]}}));
    else console.log(JSON.stringify({families:[]}));
  `,{mode:0o700});
  const previous=preserveEnvironment(t,['PATH','NOSE_REVIEW_STATE_ROOT']);
  Object.assign(process.env,{PATH:bin+':'+previous.PATH,NOSE_REVIEW_STATE_ROOT:join(fixture,'state')});
  const run=()=>scan(root,['a.js'],root,'timing-content');
  run();
  const phases=['source snapshot','cache identity/read','native execution','report/source verification','result write','total'];
  const durations=phases.map(phase=>{
    const line=logs.find(line=>line.startsWith(`[nose scan] ${phase} finished in `));
    assert.ok(line,`missing ${phase} timing`);
    return Number(line.match(/finished in ([\d.]+)ms/)[1]);
  });
  assert.ok(durations.at(-1)>=durations.slice(0,-1).reduce((sum,value)=>sum+value,0)-1,
    'total must cover every phase including initial snapshot and cache write');
  assert.equal((logs.join('').match(/scanner finished/g)??[]).length,1,
    'detailed phase timings must preserve the existing scanner invocation marker');
  logs.length=0;run();
  assert.ok(logs.some(line=>line.includes('total finished in ')),'cache hits must report total time');
  assert.ok(!logs.some(line=>line.includes('native execution finished in ')),'cache hits must not claim native execution');
});
