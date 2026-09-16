import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inventory, treeHash } from './inventory.mjs';
import { createGitHubAdapter, recoverSource, selectTarget, parseGitHubCodeSearch, publicReleases } from './provenance.mjs';
import { runUpdater, recoverTransactions, confirmSource, validateSkill, inspectImpact } from './updater.mjs';
import { writeSources, readSources, atomicJson } from './update-state.mjs';

function git(cwd, ...args) { const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); }
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'updater-test-'))), remote = path.join(root, 'remote'), skills = path.join(root, 'skills'), stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(remote, 'demo'), { recursive: true }); fs.mkdirSync(skills);
  const text = '---\nname: demo\ndescription: Useful personal guidance\n---\n\nOriginal guidance.\n\n[Guide](guide.md)\n[Operational README](references/README.md)\n';
  fs.writeFileSync(path.join(remote, 'demo/SKILL.md'), text);
  fs.writeFileSync(path.join(remote, 'demo/guide.md'), 'Stable instructions.\n');
  fs.mkdirSync(path.join(remote, 'demo/references'));fs.writeFileSync(path.join(remote, 'demo/references/README.md'),'Operational instructions.\n');
  fs.writeFileSync(path.join(remote, 'demo/README.md'), 'Original notes.\n');
  git(remote, 'init', '-b', 'main'); git(remote, 'config', 'user.email', 'test@example.invalid'); git(remote, 'config', 'user.name', 'Test'); git(remote, 'add', '.'); git(remote, 'commit', '-m', 'initial');
  const first = git(remote, 'rev-parse', 'HEAD'); fs.cpSync(path.join(remote, 'demo'), path.join(skills, 'demo'), { recursive: true });
  fs.appendFileSync(path.join(remote, 'demo/README.md'), '\nA clearer explanation.\n'); git(remote, 'add', '.'); git(remote, 'commit', '-m', 'clarify');
  const second = git(remote, 'rev-parse', 'HEAD'), skill = inventory({ roots: [skills] }).skills[0];
  const source = { id: skill.id, realPath: skill.realPath, repo: 'example/demo', subtree: 'demo', contentHash: skill.contentHash, commit: first, channel: { kind: 'branch', ref: 'main' }, evidence: { kind: 'install-record' } };
  writeSources(stateDir, { schemaVersion: 1, skills: { [skill.id]: source } });
  const adapter = createGitHubAdapter({ localRemotes: { 'example/demo': remote }, releases: { 'example/demo': [] }, search: async () => [] });
  t.after(() => { adapter.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, remote, roots: [skills], stateDir, adapter, skill, source, first, second, configPaths: [] };
}
test('branch update replaces installed bytes and preserves exactly previous; repeat current', async t => {
  const f = fixture(t), result = await runUpdater(f);
  assert.equal(result.summary.updated, 1);
  assert.equal(treeHash(f.skill.realPath), treeHash(path.join(f.remote, 'demo')));
  assert.equal(treeHash(result.items[0].previous), f.source.contentHash);
  assert.equal(readSources(f.stateDir).skills[f.skill.id].commit, f.second);
  assert.equal((await runUpdater(f)).summary.current, 1);
  assert.match(fs.readFileSync(result.report, 'utf8'), /updated/);assert.ok(!fs.readFileSync(result.report,'utf8').includes('```'));
});
test('local changes produce visible conflict and preserve local bytes', async t => {
  const f = fixture(t); fs.appendFileSync(path.join(f.skill.realPath, 'SKILL.md'), 'Local edits');
  const before = treeHash(f.skill.realPath), result = await runUpdater(f);
  assert.equal(result.summary.conflict, 1); assert.equal(treeHash(f.skill.realPath), before);
});
test('skill and referenced Markdown changes require impact confirmation',async t=>{
  for(const file of ['SKILL.md','guide.md','references/README.md']){
    const f=fixture(t);fs.appendFileSync(path.join(f.remote,'demo',file),'\nBehavior change.\n');git(f.remote,'add','.');git(f.remote,'commit','-m',`change ${file}`);
    const remote=createGitHubAdapter({localRemotes:{'example/demo':f.remote},releases:{'example/demo':[]}});t.after(()=>remote.close());
    const result=await runUpdater({...f,adapter:remote});assert.equal(result.summary.confirmation,1);assert.match(result.items[0].reason,/instructions|Markdown/);
  }
});
test('plain-text reference to a root README makes its changes impact-bearing',t=>{
  for(const reference of ['Read README.md.','Read `./README.md` before use.']){
    const f=fixture(t);fs.appendFileSync(path.join(f.skill.realPath,'SKILL.md'),`\n${reference}\n`);
    const candidate=path.join(f.root,'candidate');fs.cpSync(f.skill.realPath,candidate,{recursive:true});fs.appendFileSync(path.join(candidate,'README.md'),'changed behavior\n');
    const skill=inventory({roots:f.roots}).skills[0],impact=inspectImpact(skill,candidate,{},[skill],[]);
    assert.match(impact.reasons.join(';'),/instructions|Markdown/);
  }
});
test('indirect instruction links require confirmation for root README changes',async t=>{
  const f=fixture(t);
  for(const directory of [f.skill.realPath,path.join(f.remote,'demo')]) fs.appendFileSync(path.join(directory,'guide.md'),'\nRead [steps](README.md).\n');
  f.source.contentHash=treeHash(f.skill.realPath);writeSources(f.stateDir,{schemaVersion:1,skills:{[f.skill.id]:f.source}});
  git(f.remote,'add','.');git(f.remote,'commit','-m','link operational steps');
  const result=await runUpdater(f);
  assert.equal(result.summary.confirmation,1);
  assert.equal(treeHash(f.skill.realPath),f.source.contentHash);
});
test('tag update never silently downgrades an installed version',async t=>{
  const f=fixture(t);git(f.remote,'tag','v1.8.0');
  f.source.channel={kind:'tag',ref:'v1.9.0'};writeSources(f.stateDir,{schemaVersion:1,skills:{[f.skill.id]:f.source}});
  const result=await runUpdater(f);
  assert.equal(result.summary.updated,undefined);
  assert.equal(treeHash(f.skill.realPath),f.source.contentHash);
});
test('instruction traversal normalizes nested paths and terminates on cycles',t=>{
  const f=fixture(t),candidate=path.join(f.root,'candidate');
  fs.writeFileSync(path.join(f.skill.realPath,'guide.md'),'[Back](SKILL.md)\n[Steps](./references/../README.md)\n');
  fs.cpSync(f.skill.realPath,candidate,{recursive:true});fs.appendFileSync(path.join(candidate,'README.md'),'\nChanged instructions\n');
  const impact=inspectImpact(f.skill,candidate,{},[f.skill],[]);
  assert.match(impact.reasons.join(';'),/instructions|Markdown/);
});
test('concurrent local change after staging is rehashed and never replaced',async t=>{
  const f=fixture(t),result=await runUpdater({...f,fault(phase){if(phase==='staged')fs.appendFileSync(path.join(f.skill.realPath,'SKILL.md'),'concurrent local edit');}});
  assert.equal(result.summary.conflict,1);assert.match(fs.readFileSync(path.join(f.skill.realPath,'SKILL.md'),'utf8'),/concurrent local edit/);
  assert.deepEqual(recoverTransactions(f.stateDir),[]);
});
test('validation requires name and description inside frontmatter',t=>{
  const directory=path.join(fixture(t).root,'invalid');fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'SKILL.md'),'---\nname: demo\n---\n\ndescription: only in body\n');
  assert.throws(()=>validateSkill(directory),/frontmatter/);
});
test('two successful updates retain only immediately previous; failed third preserves it', async t => {
  const f = fixture(t); await runUpdater(f);
  const secondHash = treeHash(f.skill.realPath);
  fs.appendFileSync(path.join(f.remote, 'demo/README.md'), '\nThird explanation.\n'); git(f.remote, 'add', '.'); git(f.remote, 'commit', '-m', 'third');
  const fresh = createGitHubAdapter({ localRemotes: { 'example/demo': f.remote }, releases: { 'example/demo': [] } }); t.after(() => fresh.close());
  const result = await runUpdater({ ...f, adapter: fresh }); assert.equal(result.summary.updated, 1);
  const base = path.join(f.stateDir, 'backups', f.skill.id);
  assert.deepEqual(fs.readdirSync(base), ['previous']); assert.equal(treeHash(path.join(base, 'previous')), secondHash);
  fs.appendFileSync(path.join(f.remote, 'demo/README.md'), '\nFourth explanation.\n'); git(f.remote, 'add', '.'); git(f.remote, 'commit', '-m', 'fourth');
  const fourth = createGitHubAdapter({ localRemotes: { 'example/demo': f.remote }, releases: { 'example/demo': [] } }); t.after(() => fourth.close());
  const current = treeHash(f.skill.realPath);
  assert.equal((await runUpdater({ ...f, adapter: fourth, postValidate() { throw new Error('reject'); } })).summary['rolled-back'], 1);
  assert.equal(treeHash(f.skill.realPath), current); assert.equal(treeHash(path.join(base, 'previous')), secondHash); assert.deepEqual(fs.readdirSync(base), ['previous']);
});
test('rollback failure stops remaining updates and preserves original backup', async t => {
  const f = fixture(t);
  await assert.rejects(runUpdater({ ...f, fault(phase, tx) { if (phase === 'swapped') { fs.appendFileSync(path.join(tx.target, 'SKILL.md'), 'concurrent mutation'); throw new Error('unexpected'); } } }), /ROLLBACK_FAILED/);
  const txFile = fs.readdirSync(path.join(f.stateDir, 'transactions'))[0], tx = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'transactions', txFile)));
  assert.equal(treeHash(tx.backup), f.source.contentHash); assert.equal(tx.status, 'swapped');
});
test('impact requires pinned confirmation and succeeds only unchanged', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.remote, 'demo/tool.mjs'), 'throw new Error("candidate must never execute");'); git(f.remote, 'add', '.'); git(f.remote, 'commit', '-m', 'new command');
  const result = await runUpdater(f); assert.equal(result.summary.confirmation, 1); assert.ok(result.confirmationToken);
  assert.equal(treeHash(f.skill.realPath), f.source.contentHash);
  const applied = await runUpdater({ ...f, token: result.confirmationToken }); assert.equal(applied.summary.updated, 1);
});
test('changed impact pin cannot apply', async t => {
  const f = fixture(t); const consumer = path.join(f.roots[0], 'consumer'); fs.mkdirSync(consumer); fs.writeFileSync(path.join(consumer, 'SKILL.md'), '---\nname: consumer\ndescription: Consumer\n---\n$demo');
  const result = await runUpdater(f); assert.ok(result.confirmationToken);
  fs.appendFileSync(path.join(consumer, 'SKILL.md'), '\nextra');
  // Changing the consumer content alone does not change the reference contract; add a second consumer.
  fs.writeFileSync(path.join(consumer, 'extra.md'), '$demo');
  const applied = await runUpdater({ ...f, token: result.confirmationToken }); assert.equal(applied.summary.confirmation, 1); assert.equal(treeHash(f.skill.realPath), f.source.contentHash);
});
test('post-swap failure rolls back and leaves source revision unchanged', async t => {
  const f = fixture(t), result = await runUpdater({ ...f, postValidate() { throw new Error('post validation rejected'); } });
  assert.equal(result.summary['rolled-back'], 1); assert.equal(treeHash(f.skill.realPath), f.source.contentHash); assert.equal(readSources(f.stateDir).skills[f.skill.id].commit, f.first);
});
test('persistence finalization failure rolls back installed content and in-memory provenance',async t=>{
  const f=fixture(t),result=await runUpdater({...f,fault(phase){if(phase==='persisting')throw new Error('state write failed');}});
  assert.equal(result.summary['rolled-back'],1);assert.equal(treeHash(f.skill.realPath),f.source.contentHash);assert.equal(readSources(f.stateDir).skills[f.skill.id].commit,f.first);
});
test('rollback filesystem failure is fatal and preserves both copies',async t=>{
  const f=fixture(t);
  await assert.rejects(runUpdater({...f,postValidate(){throw new Error('reject');},fault(phase){if(phase==='rollback-restore')throw new Error('EACCES');}}),/ROLLBACK_FAILED/);
  const tx=JSON.parse(fs.readFileSync(path.join(f.stateDir,'transactions',fs.readdirSync(path.join(f.stateDir,'transactions'))[0]),'utf8'));
  assert.equal(treeHash(tx.backup),f.source.contentHash);assert.equal(treeHash(tx.target),tx.afterHash);
});
test('interrupted backed-up transaction recovers before next run', t => {
  const f = fixture(t), backup = path.join(f.root, 'backup'); fs.renameSync(f.skill.realPath, backup);
  atomicJson(path.join(f.stateDir, 'transactions/interrupted.json'), { id: 'interrupted', name: 'demo', target: f.skill.realPath, backup, rejected: path.join(f.root, 'rejected'), beforeHash: f.source.contentHash, afterHash: 'candidate', status: 'backed-up' });
  assert.equal(recoverTransactions(f.stateDir)[0].status, 'rolled-back'); assert.equal(treeHash(f.skill.realPath), f.source.contentHash);
});
test('dry-run reports an interrupted transaction without restoring files',async t=>{
  const f=fixture(t),backup=path.join(f.root,'backup');fs.renameSync(f.skill.realPath,backup);
  atomicJson(path.join(f.stateDir,'transactions/interrupted.json'),{id:'interrupted',name:'demo',target:f.skill.realPath,backup,rejected:path.join(f.root,'rejected'),beforeHash:f.source.contentHash,afterHash:'candidate',status:'backed-up'});
  const result=await runUpdater({...f,dryRun:true});assert.equal(result.summary['recovery-required'],1);assert.ok(!fs.existsSync(f.skill.realPath));assert.equal(treeHash(backup),f.source.contentHash);
});
test('origin requires independent evidence and exact historical whole subtree', async t => {
  const f = fixture(t);
  assert.equal((await recoverSource(f.skill, f.adapter, [{ repo: 'example/demo', subtree: 'demo' }])).status, 'source-unconfirmed');
  const recovered = await recoverSource(f.skill, f.adapter, [{ repo: 'example/demo', subtree: 'demo', evidence: { kind: 'install-record' } }]);
  assert.equal(recovered.source.commit, f.first); assert.equal(recovered.status, 'source-confirmation');
  fs.writeFileSync(path.join(f.skill.realPath, 'extra'), 'local');
  assert.equal((await recoverSource({ ...f.skill, contentHash: treeHash(f.skill.realPath) }, f.adapter, [{ repo: 'example/demo', subtree: 'demo', evidence: { kind: 'install-record' } }])).status, 'source-unconfirmed');
});
test('GitHub code search only seeds candidates; an exact whole subtree still proves origin', async t => {
  const f = fixture(t);
  const rows = [{ repository: { nameWithOwner: 'example/demo' }, path: 'demo/SKILL.md', url: `https://github.com/example/demo/blob/${f.first}/demo/SKILL.md` }];
  const candidates = parseGitHubCodeSearch(f.skill, JSON.stringify(rows));
  assert.equal(candidates.length, 1);
  const recovered = await recoverSource(f.skill, f.adapter, candidates);
  assert.equal(recovered.status, 'source-confirmation');
  assert.equal(recovered.source.commit, f.first);
  fs.appendFileSync(path.join(f.skill.realPath, 'SKILL.md'), 'Local change');
  const changed = inventory({ roots: f.roots }).skills[0];
  assert.equal((await recoverSource(changed, f.adapter, candidates)).status, 'source-unconfirmed');
});
test('GitHub code search rejects malformed, mismatched, and escaping candidates', () => {
  const skill = { name: 'demo' };
  const rows = [
    { repository: { nameWithOwner: 'example/demo' }, path: '../demo/SKILL.md', url: 'https://github.com/example/demo/blob/0123456789012345678901234567890123456789/../demo/SKILL.md' },
    { repository: { nameWithOwner: 'example/other' }, path: 'demo/SKILL.md', url: 'https://github.com/example/demo/blob/0123456789012345678901234567890123456789/demo/SKILL.md' },
    { repository: { nameWithOwner: 'example/demo' }, path: 'other/SKILL.md', url: 'https://github.com/example/demo/blob/0123456789012345678901234567890123456789/other/SKILL.md' },
  ];
  assert.deepEqual(parseGitHubCodeSearch(skill, JSON.stringify(rows)), []);
});
test('release lookup prefers authenticated GitHub CLI and bounds HTTP fallback', async () => {
  let requested = false;
  const cli = await publicReleases('example/demo', { runner: () => ({ status: 0, stdout: '[]' }), request: async () => { requested = true; } });
  assert.deepEqual(cli, []); assert.equal(requested, false);
  let signal;
  const fallback = await publicReleases('example/demo', { runner: () => ({ status: 1, stdout: '' }), request: async (url, options) => { signal = options.signal; return { ok: true, json: async () => [] }; } });
  assert.deepEqual(fallback, []); assert.ok(signal instanceof AbortSignal);
});
test('origin recovery considers unchanged subtree at a tagged branch tip and reports channel ambiguity', async t => {
  const f = fixture(t);
  git(f.remote, 'checkout', '-b', 'release-base', f.first);
  fs.writeFileSync(path.join(f.remote, 'README.md'), 'unrelated release note'); git(f.remote, 'add', '.'); git(f.remote, 'commit', '-m', 'unrelated');
  const tagged = git(f.remote, 'rev-parse', 'HEAD'); git(f.remote, 'tag', 'v1.0.0', tagged);
  const remote = createGitHubAdapter({ localRemotes: { 'example/demo': f.remote }, releases: { 'example/demo': [] } }); t.after(() => remote.close());
  const recovered = await recoverSource(f.skill, remote, [{ repo: 'example/demo', subtree: 'demo', evidence: { kind: 'install-record' } }]);
  assert.equal(recovered.status, 'source-confirmation'); assert.equal(recovered.source.commit, tagged);
  assert.deepEqual(recovered.source.choices, [{ kind: 'tag', ref: 'v1.0.0' }, { kind: 'branch', ref: 'release-base' }]);
});
test('source confirmation rechecks embedded origin, exact tree, and live channel', async t => {
  const f=fixture(t);git(f.remote,'checkout','-b','provenance',f.first);
  const evidence='\nSource: https://github.com/example/demo/tree/provenance/demo\n';
  fs.appendFileSync(path.join(f.remote,'demo/SKILL.md'),evidence);git(f.remote,'add','.');git(f.remote,'commit','-m','record source');
  fs.appendFileSync(path.join(f.skill.realPath,'SKILL.md'),evidence);
  const skill=inventory({roots:f.roots}).skills[0],commit=git(f.remote,'rev-parse','HEAD');
  const remote=createGitHubAdapter({localRemotes:{'example/demo':f.remote},releases:{'example/demo':[]}});t.after(()=>remote.close());
  const result=await confirmSource({roots:f.roots,stateDir:f.stateDir,adapter:remote,selection:{id:skill.id,contentHash:skill.contentHash,repo:'example/demo',subtree:'demo',commit,channel:{kind:'branch',ref:'provenance'}}});
  assert.equal(result.status,'source-confirmed');assert.equal(readSources(f.stateDir).skills[skill.id].commit,commit);
});
test('release and compatible semver tag selection do not follow default branch', () => {
  const refs = { releases: [{ tag: 'v1.1.0', commit: 'stable', publishedAt: '2026-01-01', draft: false, prerelease: false }, { tag: 'v2.0.0-rc.1', commit: 'rc', publishedAt: '2026-02-01', prerelease: true }], tags: ['v1.0.0', 'v1.2.0', 'v2.0.0', 'v1.3.0-beta.2', 'v1.3.0-beta.10'].map(name => ({ name, commit: name })), branches: [] };
  assert.equal(selectTarget({ channel: { kind: 'release' } }, refs).commit, 'stable');
  assert.equal(selectTarget({ channel: { kind: 'tag', ref: 'v1.0.0' } }, refs).ref, 'v1.2.0');
  assert.equal(selectTarget({ channel: { kind: 'tag', ref: 'v1.3.0-beta.2' } }, refs).ref, 'v1.3.0-beta.10');
  assert.ok(selectTarget({ channel: { kind: 'tag', ref: 'legacy' } }, refs).confirmationRequired);
});
for (const kind of ['release', 'tag']) test(`${kind} local Git channel updates installed subtree`, async t => {
  const f = fixture(t); git(f.remote, 'tag', 'v1.0.0', f.first); git(f.remote, 'tag', 'v1.1.0', f.second);
  f.source.channel = { kind, ref: 'v1.0.0' }; writeSources(f.stateDir, { schemaVersion: 1, skills: { [f.skill.id]: f.source } });
  const remote = createGitHubAdapter({ localRemotes: { 'example/demo': f.remote }, releases: { 'example/demo': [{ tag_name: 'v1.1.0', draft: false, prerelease: false, published_at: '2026-01-01' }] } }); t.after(() => remote.close());
  const result = await runUpdater({ ...f, adapter: remote }); assert.equal(result.summary.updated, 1); assert.equal(readSources(f.stateDir).skills[f.skill.id].channel.ref, 'v1.1.0'); assert.equal(treeHash(f.skill.realPath), treeHash(path.join(f.remote, 'demo')));
});
