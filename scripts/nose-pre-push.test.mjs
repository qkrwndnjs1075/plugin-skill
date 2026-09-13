import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install } from './install-pre-push.mjs';

const runner = new URL('./nose-pre-push.mjs', import.meta.url).pathname;
const zero = '0'.repeat(40);
const source = name => `export function ${name}(items) {
  const result = [];
  for (const item of items) {
    if (item.enabled && item.value > 0) {
      const value = item.value * 100;
      result.push({name: item.name.trim(), value, label: String(value)});
    }
  }
  return result.sort((a, b) => a.value - b.value);
}\n`;

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nose-push-test-')));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const git = (...args) => execFileSync('git', args, {cwd:root, encoding:'utf8'}).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(root, 'a.js'), source('alpha'));
  writeFileSync(join(root, 'b.js'), source('beta'));
  git('add', '.'); git('commit', '-qm', 'fixture duplicates');
  const sha = git('rev-parse', 'HEAD');
  const line = (local = sha, remote = zero, ref = 'main') => `refs/heads/${ref} ${local} refs/heads/${ref} ${remote}\n`;
  const run = (input = line(), env = process.env) => spawnSync(process.execPath, [runner, 'origin', 'local-fixture'], {cwd:root, input, env, encoding:'utf8'});
  const report = () => JSON.parse(readFileSync(join(root, '.nose-review/report.json'), 'utf8'));
  return {root, git, sha, line, run, report};
}

test('unreviewed pushed duplicates block even if already on remote or removed from working files', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(f.root, 'b.js'), 'export const b = 2;\n');
  const first = f.run();
  assert.equal(first.status, 1, first.stderr);
  const report = f.report();
  assert.equal(report.projectRoot, f.root);
  assert.deepEqual(report.remote, {name:'origin'});
  assert.ok(report.candidates.length > 0, first.stderr);
  assert.equal(report.refs[0].localSha, f.sha);
  assert.ok(report.candidates.every(family => family.locations.every(location => !location.file.startsWith('/'))));
  const next = f.run(f.line(f.sha, f.sha));
  assert.equal(next.status, 1, next.stderr);
  assert.equal(f.report().refs[0].status, 'blocked');
  assert.ok(f.report().candidates.length > 0);
  assert.equal(readFileSync(join(f.root, 'a.js'), 'utf8'), 'export const a = 1;\n');
});

test('no refs and deleted refs do not scan or create a report', t => {
  const f = fixture(t);
  assert.equal(f.run('').status, 0);
  assert.throws(f.report, /ENOENT/);
  const deletion = f.run(f.line(zero, f.sha));
  assert.equal(deletion.status, 0);
  assert.match(deletion.stderr, /deletion skipped/);
  assert.throws(f.report, /ENOENT/);
});

test('all refs are checked against reviewed baselines without remote-object access', t => {
  const f = fixture(t);
  const run = f.run(f.line() + f.line(f.sha, 'f'.repeat(40), 'other'));
  assert.equal(run.status, 1);
  const report = f.report();
  assert.equal(report.refs.length, 2);
  assert.ok(report.refs.every(ref => ref.candidates.length > 0));
  assert.ok(report.refs.every(ref=>ref.status==='blocked'));
});

test('missing Nose blocks with an error record', t => {
  const f = fixture(t);
  const bin = join(f.root, 'bin'); mkdirSync(bin);
  for (const command of ['git', 'tar']) {
    const path = execFileSync('/bin/sh', ['-c', `command -v ${command}`], {encoding:'utf8'}).trim();
    symlinkSync(path, join(bin, command));
  }
  const run = f.run(f.line(), {...process.env, PATH:bin});
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Nose executable unavailable/);
  assert.equal(f.report().refs[0].status, 'error');
});

test('only pushed baselines apply; malformed baselines warn without hiding findings', t => {
  const f = fixture(t);
  f.run();
  const report = f.report();
  const baseline = {schemaVersion:1, noseVersion:report.noseVersion, accepted:report.candidates.map(family => family.fingerprint), intentional:[]};
  writeFileSync(join(f.root, '.nose-review/baseline.json'), JSON.stringify(baseline));
  f.run();
  assert.ok(f.report().candidates.length > 0);
  f.git('add', '.nose-review/baseline.json'); f.git('commit', '-qm', 'reviewed baseline');
  assert.equal(f.run(f.line(f.git('rev-parse', 'HEAD'))).status,0);
  assert.equal(f.report().candidates.length, 0);
  writeFileSync(join(f.root, '.nose-review/baseline.json'), JSON.stringify({...baseline, schemaVersion:900}));
  f.git('add', '.nose-review/baseline.json'); f.git('commit', '-qm', 'unsupported baseline');
  const run = f.run(f.line(f.git('rev-parse', 'HEAD')));
  assert.equal(run.status,2);
  assert.match(run.stderr, /Unsupported baseline schema/);
  assert.ok(f.report().candidates.length > 0);
});

test('report directory symlink is rejected and export-ignore does not produce false clean', t => {
  const f = fixture(t);
  const external = join(f.root, 'external'); mkdirSync(external);
  symlinkSync(external, join(f.root, '.nose-review'));
  const unsafe = f.run();
  assert.equal(unsafe.status, 2);
  assert.match(unsafe.stderr, /Report directory is unsafe/);
  assert.throws(() => readFileSync(join(external, 'report.json')), /ENOENT/);
  rmSync(join(f.root, '.nose-review'));
  writeFileSync(join(f.root, '.gitattributes'), 'b.js export-ignore\n');
  f.git('add', '.gitattributes'); f.git('commit', '-qm', 'archive attribute');
  const run = f.run(f.line(f.git('rev-parse', 'HEAD')));
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Archive differs from pushed tree/);
  assert.equal(f.report().refs[0].status, 'error');
});

for(const resolution of ['refactor','intentional']) test(`real push is blocked until committed ${resolution} resolves findings`,t=>{
  const f=fixture(t);
  const remote=join(f.root,'remote.git');
  f.git('init','--bare','-q',remote);
  f.git('remote','add','origin',remote);
  install(f.root);
  const push=()=>spawnSync('git',['push','origin','HEAD:refs/heads/main'],{cwd:f.root,encoding:'utf8'});
  const rejected=push();
  assert.notEqual(rejected.status,0);
  assert.equal(f.report().gateStatus,'blocked');
  assert.notEqual(spawnSync('git',['--git-dir',remote,'rev-parse','--verify','refs/heads/main']).status,0);
  if(resolution==='refactor') {
    writeFileSync(join(f.root,'b.js'),'export { alpha as beta } from "./a.js";\n');
    execFileSync(process.execPath,['--input-type=module','-e',"import {beta} from './b.js'; import assert from 'node:assert/strict'; assert.deepEqual(beta([{enabled:true,value:2,name:' x '}]),[{name:'x',value:200,label:'200'}]);"],{cwd:f.root});
    assert.notEqual(push().status,0); // Uncommitted repair cannot unblock a pushed tree.
    f.git('add','b.js');
  } else {
    const fingerprint=f.report().candidates[0].fingerprint;
    execFileSync(process.execPath,[new URL('./review-policy.mjs',import.meta.url).pathname,'accept',f.root,fingerprint,'Independent deployment fixture'],{cwd:f.root});
    assert.notEqual(push().status,0);
    f.git('add','.nose-review/baseline.json');
  }
  f.git('commit','-qm','resolve gate');
  const accepted=push();
  assert.equal(accepted.status,0,accepted.stderr);
  assert.equal(f.report().gateStatus,'passed');
  assert.equal(f.git('--git-dir',remote,'rev-parse','refs/heads/main'),f.git('rev-parse','HEAD'));
});
