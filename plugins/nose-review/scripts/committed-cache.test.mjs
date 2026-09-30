import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {payloadSources} from './install-pre-push.mjs';
import {archivedScan, scanCommit} from './verified-archive.mjs';
import {commitTree} from './commit-inputs.mjs';
import {cacheStateRoot, scan, shellQuote, snapshot} from './review-runtime.mjs';
import {commitAll, gitFixture, preserveEnvironment} from './test-helpers.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const {root, directory, git} = gitFixture(t, 'nose-committed-cache-', {subdirectory:'repo'});
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const calls = join(directory, 'nose-calls');
  for (const executable of ['git', 'tar']) {
    const actual = execFileSync('which', [executable], {encoding:'utf8'}).trim();
    writeFileSync(join(bin, executable), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(join(directory, executable+'-calls'))}\nexec ${shellQuote(actual)} "$@"\n`, {mode:0o700});
  }
  writeFileSync(join(bin, 'nose'), '#!'+process.execPath+'\n'+`
    const fs = require('node:fs');
    const config = ['nose.toml', '.nose.toml'].find(file => fs.existsSync(file));
    if (process.argv.includes('--version')) console.log('nose committed-cache fixture');
    else if (process.argv.includes('--show-config')) console.log(JSON.stringify({
      schema:'nose.query-config/v1', config_file:config ?? null,
      query:{'ignore-file':null, 'semantic-pack-lock':null, 'semantic-packs':[]}
    }));
    else {
      fs.appendFileSync(${JSON.stringify(calls)}, 'query\\n');
      const suppressed = config && fs.readFileSync(config, 'utf8').includes('min-size = 999');
      console.log(JSON.stringify({families:suppressed ? [] : [{id:'duplicate', score:42,
        locations:['a.js', 'b.js'].map(file => ({file, start:1, end:1}))}]}));
    }
  `, {mode:0o700});
  preserveEnvironment(t,['PATH','NOSE_REVIEW_STATE_ROOT']);
  process.env.PATH = bin+':'+process.env.PATH;
  process.env.NOSE_REVIEW_STATE_ROOT = join(directory, 'state');
  writeFileSync(join(root, 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(root, 'b.js'), 'export const b = 1;\n');
  const sha = commitAll(git);
  const records = name => existsSync(join(directory, name)) ? readFileSync(join(directory, name), 'utf8').trim().split('\n') : [];
  const counts = () => ({
    archive:records('git-calls').filter(call => call.startsWith('archive ')).length,
    tar:records('tar-calls').length,
    query:records('nose-calls').length,
  });
  return {root, git, sha, counts};
}

function capturePhases(t, operation) {
  const output = [];
  const mock = t.mock.method(process.stderr, 'write', chunk => { output.push(String(chunk)); return true; });
  try { return {result:operation(), output:output.join('')}; }
  finally { mock.mock.restore(); }
}

test('warm committed results preserve source-proven families without archive, tar or source snapshot', t => {
  const {root, sha, counts} = fixture(t);
  const first = scanCommit(root, sha);
  assert.equal(first.families.length, 1);
  assert.deepEqual(first.families[0].memberHashes, [digest('export const a = 1;'), digest('export const b = 1;')].sort());
  assert.deepEqual(counts(), {archive:1, tar:1, query:1});

  const warm = capturePhases(t, () => scanCommit(root, sha));

  assert.deepEqual(warm.result, first);
  assert.deepEqual(counts(), {archive:1, tar:1, query:1});
  assert.doesNotMatch(warm.output, /\[nose scan\] source snapshot finished/);
});

test('review and logging edits preserve analysis while source-proof edits invalidate it',t=>{
  const {root,sha,counts}=fixture(t);
  const payload=join(dirname(root),'payload');
  mkdirSync(payload);
  for(const name of payloadSources) copyFileSync(new URL(name,import.meta.url),join(payload,name));
  const run=()=>{
    const script=`const {scanCommit}=await import(${JSON.stringify(join(payload,'verified-archive.mjs'))});const result=scanCommit(${JSON.stringify(root)},${JSON.stringify(sha)});console.log(JSON.stringify(result));`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:root,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    return JSON.parse(result.stdout);
  };
  const first=run();
  for(const name of ['review-policy.mjs','review-runtime.mjs','nose-pre-push.mjs']) {
    const file=join(payload,name);
    writeFileSync(file,readFileSync(file,'utf8')+'\n// review/logging revision\n');
  }
  assert.deepEqual(run(),first);
  assert.deepEqual(counts(),{archive:1,tar:1,query:1});
  const proof=join(payload,'source-evidence.mjs');
  writeFileSync(proof,readFileSync(proof,'utf8')+'\n// source-proof revision\n');
  assert.deepEqual(run(),first);
  assert.deepEqual(counts(),{archive:2,tar:2,query:2});
});

test('native global ignores invalidate reuse even when Git reads a different global config',t=>{
  const {root,sha,counts}=fixture(t);
  const home=join(dirname(root),'home');
  mkdirSync(home);
  const ignore=join(home,'native-ignore');
  const override=join(home,'git-override');
  writeFileSync(join(home,'.gitconfig'),`[core]\nexcludesFile = ${ignore}\n`);
  writeFileSync(override,'');
  writeFileSync(ignore,'generated.js\n');
  preserveEnvironment(t,['HOME','GIT_CONFIG_GLOBAL']);
  Object.assign(process.env,{HOME:home,GIT_CONFIG_GLOBAL:override});
  assert.equal(execFileSync('git',['config','--global','--list'],{cwd:root,encoding:'utf8'}),'');
  const first=scanCommit(root,sha);
  assert.deepEqual(scanCommit(root,sha),first);
  assert.deepEqual(counts(),{archive:1,tar:1,query:1});
  writeFileSync(ignore,'vendor.js\n');
  assert.deepEqual(scanCommit(root,sha),first);
  assert.deepEqual(counts(),{archive:2,tar:2,query:2});
});

test('different commits with the same tree reuse committed results', t => {
  const {root, git, sha, counts} = fixture(t);
  const first = scanCommit(root, sha);
  git('commit', '--allow-empty', '-qm', 'same tree, different commit');
  const other = git('rev-parse', 'HEAD');
  assert.notEqual(other, sha);
  assert.equal(git('rev-parse', other+'^{tree}'), git('rev-parse', sha+'^{tree}'));

  const reused = scanCommit(root, other);

  assert.deepEqual(reused, first);
  assert.deepEqual(counts(), {archive:1, tar:1, query:1});
});

test('committed source edits invalidate families and rerun the verified archive', t => {
  const {root, git, sha, counts} = fixture(t);
  const first = scanCommit(root, sha);
  writeFileSync(join(root, 'a.js'), 'export const a = 2;\n');
  const changed = commitAll(git, 'source edit');

  const result = scanCommit(root, changed);

  assert.equal(result.files['a.js'], digest('export const a = 2;\n'));
  assert.notEqual(result.families[0].fingerprint, first.families[0].fingerprint);
  assert.deepEqual(counts(), {archive:2, tar:2, query:2});
});

for (const name of ['nose.toml', '.nose.toml']) {
  test(`committed ${name} disables reuse despite a conflicting clean working file`, t => {
    const {root, git, sha, counts} = fixture(t);
    assert.equal(scanCommit(root, sha).families.length, 1);
    writeFileSync(join(root, name), '[query]\nmin-size = 999\n');
    const configured = commitAll(git, 'committed query configuration');
    git('update-index', '--assume-unchanged', name);
    writeFileSync(join(root, name), '[query]\nmin-size = 24\n');
    assert.equal(git('status', '--porcelain'), '');

    const first = scanCommit(root, configured);
    const second = scanCommit(root, configured);

    assert.deepEqual(first.families, []);
    assert.deepEqual(second, first);
    assert.deepEqual(counts(), {archive:3, tar:3, query:3});
  });
}

for (const [name, prepare, alias] of [
  ['regular source', root => symlinkSync('a.js', join(root, 'alias.js')), 'alias.js'],
  ['directory prefix', root => {
    mkdirSync(join(root, 'sources'));
    writeFileSync(join(root, 'sources', 'value.js'), 'export const a = 1;\n');
    symlinkSync('sources', join(root, 'prefix'));
    symlinkSync('prefix/value.js', join(root, 'alias.js'));
  }, 'alias.js'],
  ['three parent components', root => {
    mkdirSync(join(root, 'plugins', 'example', 'skills'), {recursive:true});
    symlinkSync('../../../a.js', join(root, 'plugins', 'example', 'skills', 'shared.js'));
  }, 'plugins/example/skills/shared.js'],
]) {
  test(`committed internal ${name} symlinks reuse results without extracting again`, t => {
    const {root, git, counts} = fixture(t);
    prepare(root);
    assert.equal(readFileSync(join(root, alias), 'utf8'), 'export const a = 1;\n');
    const sha = commitAll(git, 'internal source symlink');
    assert.equal(commitTree(root, sha).reusable, true);
    const first = scanCommit(root, sha);

    const second = scanCommit(root, sha);

    assert.deepEqual(second, first);
    assert.equal(first.families.length, 1);
    assert.deepEqual(counts(), {archive:1, tar:1, query:1});
  });
}

for (const [name, prepare] of [
  ['external relative target', root => {
    writeFileSync(join(root, '..', 'outside'), 'EXTERNAL');
    symlinkSync('../outside', join(root, 'alias'));
    assert.equal(readFileSync(join(root, 'alias'), 'utf8'), 'EXTERNAL');
  }],
  ['absolute target', root => symlinkSync(join(root, 'a.js'), join(root, 'alias'))],
  ['dangling target', root => symlinkSync('missing', join(root, 'alias'))],
  ['cycle', root => {
    symlinkSync('other', join(root, 'alias'));
    symlinkSync('alias', join(root, 'other'));
  }],
  ['symlink before parent component escaping the tree', root => {
    writeFileSync(join(root, 'file'), 'TRACKED');
    writeFileSync(join(root, '..', 'file'), 'EXTERNAL');
    symlinkSync('.', join(root, 'a'));
    symlinkSync('a/../file', join(root, 'x'));
    assert.equal(readFileSync(join(root, 'x'), 'utf8'), 'EXTERNAL');
  }],
]) {
  test(`committed symlinks with ${name} retain archive verification on warm scans`, t => {
    const {root, git, counts} = fixture(t);
    prepare(root);
    const sha = commitAll(git, 'unsupported source symlink');
    assert.equal(commitTree(root, sha).reusable, false);
    const first = scanCommit(root, sha);

    const second = scanCommit(root, sha);

    assert.deepEqual(second, first);
    assert.equal(first.families.length, 1);
    assert.equal(counts().archive, 2);
    assert.equal(counts().tar, 2);
  });
}

test('archive source evidence matches raw-byte snapshots across invalid UTF-8 and chunk boundaries', t => {
  const {root, git} = fixture(t);
  const sources = {
    'invalid.js':Buffer.from([0x61, 0xff, 0xfe, 0x0a]),
    'crlf.js':Buffer.from('const value = 1;  \r\nreturn value;\t\r\n'),
    'large.js':Buffer.concat([Buffer.alloc(1024*1024-1, 0x61), Buffer.from('한\r\n'), Buffer.alloc(19, 0x62)]),
  };
  for (const [file, bytes] of Object.entries(sources)) writeFileSync(join(root, file), bytes);
  const sha = commitAll(git, 'raw source bytes');

  archivedScan(root, sha, (directory, files, identity, evidence) => {
    assert.deepEqual(evidence.files, snapshot(directory, files));
    for (const [file, bytes] of Object.entries(sources)) assert.equal(evidence.files[file], digest(bytes), file);
    assert.deepEqual(scan(directory, files, root, identity, evidence).files, evidence.files);
  });
});

test('source mutation between archive verification and scan entry rejects the result', t => {
  const {root, sha} = fixture(t);

  assert.throws(() => archivedScan(root, sha, (directory, files, identity, evidence) => {
    writeFileSync(join(directory, 'a.js'), 'export const a = 9;\n');
    return scan(directory, files, root, identity, evidence);
  }), /Code changed during scan/);
});

for (const mismatch of ['root', 'identity']) {
  test(`archive evidence with a mismatched ${mismatch} is rejected before scanning`, t => {
    const {root, sha, counts} = fixture(t);

    assert.throws(() => archivedScan(root, sha, (directory, files, identity, evidence) => {
      const wrong = mismatch === 'root' ? {...evidence, root} : {...evidence, identity:{...identity, inventory:'other'}};
      return scan(directory, files, root, identity, wrong);
    }), /Archive source evidence does not match scan inputs/);

    assert.equal(counts().query, 0);
  });
}

test('corrupt immutable result falls back to an archive and restores authentic families', t => {
  const {root, sha, counts} = fixture(t);
  const first = scanCommit(root, sha);
  const directory = join(cacheStateRoot(root), 'scan-results');
  const entry = readdirSync(directory).find(name => name.endsWith('.json'));
  assert.ok(entry);
  writeFileSync(join(directory, entry), '{}\n');

  const recovered = scanCommit(root, sha);

  assert.deepEqual(recovered, first);
  assert.deepEqual(counts(), {archive:2, tar:2, query:2});
});
