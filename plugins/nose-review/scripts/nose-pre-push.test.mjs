import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { install } from './install-pre-push.mjs';
import { gitFixture, pushGit, readReport } from './test-helpers.mjs';

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
  const {root, git} = gitFixture(t, 'nose-push-test-');
  writeFileSync(join(root, 'a.js'), source('alpha'));
  writeFileSync(join(root, 'b.js'), source('beta'));
  git('add', '.'); git('commit', '-qm', 'fixture duplicates');
  const sha = git('rev-parse', 'HEAD');
  const line = (local = sha, remote = zero, ref = 'main') => `refs/heads/${ref} ${local} refs/heads/${ref} ${remote}\n`;
  const run = (input = line(), env = process.env) => spawnSync(process.execPath, [runner, 'origin', 'local-fixture'], {cwd:root, input, env, encoding:'utf8'});
  const report = () => readReport(root);
  const push = () => pushGit(root, 'HEAD:refs/heads/main');
  return {root, git, sha, line, run, report, push};
}

test('a new branch blocks unreviewed duplicates independently of working files', t => {
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
  assert.equal(readFileSync(join(f.root, 'a.js'), 'utf8'), 'export const a = 1;\n');
});
test('tracked ignored source still blocks duplication at push time',t=>{
  const f=fixture(t);
  writeFileSync(join(f.root,'.gitignore'),'b.js\n');
  f.git('add','.gitignore');f.git('commit','-qm','ignore tracked copy');
  const result=f.run(f.line(f.git('rev-parse','HEAD')));
  assert.equal(result.status,1,result.stderr);
  assert.ok(f.report().candidates.length);
});
test('annotated tag messages are scanned and secret values remain redacted',t=>{
  const f=fixture(t),secret='ghp_'+randomBytes(20).toString('hex');
  writeFileSync(join(f.root,'b.js'),'export const b=2;\n');
  f.git('add','b.js');f.git('commit','-qm','clean tree');
  f.git('tag','-a','secret-tag','-m','token='+secret);
  const sha=f.git('rev-parse','secret-tag');
  const result=f.run(`refs/tags/secret-tag ${sha} refs/tags/secret-tag ${zero}\n`);
  assert.equal(result.status,1,result.stderr);
  assert.equal(f.report().refs[0].secrets.status,'blocked');
  assert.equal((result.stderr+JSON.stringify(f.report())).includes(secret),false);
});

test('a new remote branch scans only new commits and compares against its remote boundary', t => {
  const f = fixture(t);
  f.git('remote', 'add', 'origin', '.');
  f.git('update-ref', 'refs/remotes/origin/main', f.sha);
  writeFileSync(join(f.root, 'unique.js'), 'export const unique = 1;\n');
  f.git('add', 'unique.js'); f.git('commit', '-qm', 'feature commit');

  const run = f.run(f.line(f.git('rev-parse', 'HEAD'), zero, 'feature'));

  assert.equal(run.status, 0, run.stderr);
  const report=f.report();
  assert.equal(report.refs[0].secrets.commitsScanned, 1);
  assert.equal(report.refs[0].comparisonBase.sha, f.sha);
  assert.equal(report.candidates.length, 0);
});

test('an existing remote family is a comparison baseline but new growth still blocks', t => {
  const f = fixture(t);
  const unchanged = f.run(f.line(f.sha, f.sha));
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal(f.report().refs[0].comparisonBase.sha, f.sha);
  assert.equal(f.report().candidates.length, 0);

  writeFileSync(join(f.root, 'c.js'), source('gamma'));
  f.git('add', 'c.js'); f.git('commit', '-qm', 'grow duplicate family');
  const grown = f.run(f.line(f.git('rev-parse', 'HEAD'), f.sha));
  assert.equal(grown.status, 1, grown.stderr);
  assert.ok(f.report().candidates.some(family => family.locations.length === 3));
});

test('remote comparison also filters candidates not covered by a committed baseline', t => {
  const f = fixture(t);
  const first = f.run();
  const baseline = {schemaVersion:1, noseVersion:f.report().noseVersion, accepted:[], intentional:[]};
  writeFileSync(join(f.root, '.nose-review/baseline.json'), JSON.stringify(baseline));
  f.git('add', '.nose-review/baseline.json'); f.git('commit', '-qm', 'empty reviewed baseline');

  const compared = f.run(f.line(f.git('rev-parse', 'HEAD'), f.sha));

  assert.equal(first.status, 1, first.stderr);
  assert.equal(compared.status, 0, compared.stderr);
  assert.equal(f.report().refs[0].comparisonBase.sha, f.sha);
  assert.equal(f.report().candidates.length, 0);
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

test('an unavailable remote comparison object fails closed', t => {
  const f = fixture(t);
  const run = f.run(f.line() + f.line(f.sha, 'f'.repeat(40), 'other'));
  assert.equal(run.status, 2);
  const report = f.report();
  assert.equal(report.refs.length, 2);
  assert.equal(report.refs[0].status, 'blocked');
  assert.equal(report.refs[1].status, 'error');
  assert.match(report.refs[1].warnings.join('\n'), /Scan unavailable/);
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
  const push=f.push;
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

test('real push catches secrets in earlier outgoing commits and retains sanitized failure after success',t=>{
  const f=fixture(t), remote=join(f.root,'remote.git');
  f.git('init','--bare','-q',remote);
  f.git('remote','add','origin',remote);
  const token=['gh','p_'].join('')+randomBytes(18).toString('hex');
  writeFileSync(join(f.root,'a.js'),'export const a = 1;');
  writeFileSync(join(f.root,'b.js'),'export const b = 2;');
  writeFileSync(join(f.root,'credentials.txt'),'token='+token);
  f.git('add','a.js','b.js','credentials.txt');f.git('commit','-qm','synthetic secret');
  const exposed=f.git('rev-parse','HEAD');
  f.git('rm','-q','credentials.txt');f.git('commit','-qm','remove from tip');
  install(f.root);
  const push=f.push;
  const blocked=push();
  assert.notEqual(blocked.status,0);
  assert.match(blocked.stderr,/NOSE_SECRETS_BLOCKED/);
  assert.ok(!blocked.stderr.includes(token));
  assert.equal(f.report().candidates.length,0);
  assert.ok(f.report().refs[0].secrets.findings.some(item=>item.commit===exposed));
  const history=f.report().failureHistory;
  const saved=readFileSync(history,'utf8');
  assert.ok(!saved.includes(token));
  assert.notEqual(spawnSync('git',['--git-dir',remote,'rev-parse','--verify','refs/heads/main']).status,0);
  // A separate safe lineage proves the history remains after a later successful push.
  f.git('switch','-qc','safe',f.sha);
  writeFileSync(join(f.root,'a.js'),'export const a = 1;');
  writeFileSync(join(f.root,'b.js'),'export const b = 2;');
  f.git('add','a.js','b.js');f.git('commit','-qm','safe source');
  const passed=push();
  assert.equal(passed.status,0,passed.stderr);
  assert.equal(f.report().gateStatus,'passed');
  assert.equal(readFileSync(history,'utf8'),saved);
});

test('real pushed reviewed family reduction passes while added copies block',t=>{
  const f=fixture(t), remote=join(f.root,'remote.git');
  writeFileSync(join(f.root,'c.js'),source('gamma'));
  f.git('add','c.js');f.git('commit','-qm','three independent fixture copies');
  f.run(f.line(f.git('rev-parse','HEAD')));
  const family=f.report().candidates.find(c=>c.locations.length===3);
  assert.ok(family);
  execFileSync(process.execPath,[new URL('./review-policy.mjs',import.meta.url).pathname,'accept',f.root,family.fingerprint,'Independent deployment fixture contracts'],{cwd:f.root});
  f.git('add','.nose-review/baseline.json');f.git('commit','-qm','review independent contracts');
  f.git('init','--bare','-q',remote);f.git('remote','add','origin',remote);install(f.root);
  const push=f.push;
  assert.equal(push().status,0);
  f.git('rm','-q','c.js');f.git('commit','-qm','remove independent copy');
  const reduced=push();
  assert.equal(reduced.status,0,reduced.stderr);
  assert.equal(f.report().refs[0].reductions.length,1);
  assert.match(reduced.stderr,/ADVISORY reduction/);
  writeFileSync(join(f.root,'c.js'),source('gamma'));
  writeFileSync(join(f.root,'d.js'),source('delta'));
  f.git('add','c.js','d.js');f.git('commit','-qm','grow beyond reviewed copies');
  assert.notEqual(push().status,0);
  assert.equal(f.report().gateStatus,'blocked');
  assert.ok(readdirSync(join(f.root,'.nose-review/failures')).length>0);
});

test('secret scans inspect symlink blob text without following its target',t=>{
  const f=fixture(t);
  const token=['gh','p_'].join('')+randomBytes(18).toString('hex');
  symlinkSync(token,join(f.root,'reference'));
  f.git('add','reference');f.git('commit','-qm','synthetic symlink secret');
  const result=f.run(f.line(f.git('rev-parse','HEAD')));
  assert.equal(result.status,1,result.stderr);
  assert.match(result.stderr,/NOSE_SECRETS_BLOCKED/);
  assert.ok(!result.stderr.includes(token));
  assert.ok(f.report().refs[0].secrets.findings.some(finding=>finding.file==='reference'));
});
