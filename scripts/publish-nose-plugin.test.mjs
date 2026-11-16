import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'nose-plugin-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  mkdirSync(join(root, 'plugins/nose-review/.codex-plugin'), { recursive: true });
  mkdirSync(join(root, 'plugins/nose-review/scripts'));
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'plugins/nose-review/.codex-plugin/plugin.json'), '{"version":"0.8.1"}\n');
  writeFileSync(join(root, 'plugins/nose-review/scripts/nose-runtime.json'), '{"version":"v0.21.0","repository":"fixture/nose","assets":{}}\n');
  cpSync(new URL('./publish-nose-plugin.mjs', import.meta.url), join(root, 'scripts/publish-nose-plugin.mjs'));
  git('add', '.'); git('commit', '-m', 'ordinary commit, not an automation subject');
  const source = git('rev-parse', 'HEAD');
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const file = path.join(process.env.FIXTURE_ROOT, 'release.json');
const save = value => fs.writeFileSync(file, JSON.stringify(value));
if (args[0] === 'api') {
 const id = args[1].split('/').pop();
 process.stdout.write(fs.readFileSync(path.join(process.env.FIXTURE_ROOT, 'asset-' + id)));
} else if (args[1] === 'create') {
 if (fs.existsSync(file)) process.exit(1);
 save({body:args[args.indexOf('--notes')+1],target_commitish:args[args.indexOf('--target')+1],draft:true,assets:[]});
} else if (args[1] === 'upload') {
 const release=JSON.parse(fs.readFileSync(file));
 for(const input of args.slice(3)) {
  const name=path.basename(input);
  if(release.assets.some(asset=>asset.name===name)) process.exit(1);
  const id=release.assets.length+1;
  fs.copyFileSync(input,path.join(process.env.FIXTURE_ROOT,'asset-'+id));
  release.assets.push({id,name}); save(release);
  const failure=path.join(process.env.FIXTURE_ROOT,'fail-upload');
  if(fs.existsSync(failure)){fs.unlinkSync(failure);process.exit(1);}
 }
} else if (args[1] === 'edit') {
 const release=JSON.parse(fs.readFileSync(file));release.draft=false;save(release);
} else process.exit(1);
`, { mode: 0o755 });
  const server = createServer((request, response) => {
    const file = join(root, 'release.json');
    response.writeHead(existsSync(join(root, 'deny')) ? 403 : existsSync(file) ? 200 : 404, { 'Content-Type': 'application/json' });
    response.end(existsSync(file) ? readFileSync(file) : '{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const run = async command => {
    const child = spawn(process.execPath, ['scripts/publish-nose-plugin.mjs', command], { cwd: root, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, FIXTURE_ROOT: root, GH_REPO: 'fixture/plugins', GH_TOKEN: 'fixture', GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` } });
    let output = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const [status] = await once(child, 'close'); return { status, output };
  };
  return { root, source, git, run, release: () => JSON.parse(readFileSync(join(root, 'release.json'), 'utf8')) };
}

test('finds a missing release after unrelated main commits and skips a complete verified release', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.root, 'unrelated.txt'), 'later commit'); f.git('add', 'unrelated.txt'); f.git('commit', '-m', 'documentation');
  const pending = await f.run('pending'); assert.equal(pending.status, 0, pending.output); assert.match(pending.output, /release=true/);
  const published = await f.run('publish'); assert.equal(published.status, 0, published.output);
  assert.equal(f.release().draft, false); assert.equal(f.release().assets.length, 2);
  writeFileSync(join(f.root, 'unrelated.txt'), 'another commit'); f.git('commit', '-am', 'another documentation change');
  const complete = await f.run('pending'); assert.equal(complete.status, 0, complete.output); assert.match(complete.output, /release=false/);
});

for (const published of [false, true]) {
  test(`repairs interrupted ${published ? 'published' : 'draft'} upload without replacing its existing archive`, async t => {
    const f = await fixture(t);
    writeFileSync(join(f.root, 'fail-upload'), 'interrupt after first asset');
    const interrupted = await f.run('publish'); assert.notEqual(interrupted.status, 0);
    const release = f.release(); assert.equal(release.assets.length, 1);
    if (published) writeFileSync(join(f.root, 'release.json'), JSON.stringify({ ...release, draft: false }));
    const inode = statSync(join(f.root, 'asset-1')).ino;
    writeFileSync(join(f.root, 'unrelated.txt'), 'later commit'); f.git('add', 'unrelated.txt'); f.git('commit', '-m', 'later unrelated change');
    const pending = await f.run('pending'); assert.equal(pending.status, 0, pending.output); assert.match(pending.output, /release=true/);
    const resumed = await f.run('publish'); assert.equal(resumed.status, 0, resumed.output);
    assert.equal(f.release().draft, false); assert.equal(f.release().assets.length, 2);
    assert.equal(f.release().target_commitish, f.source); assert.equal(statSync(join(f.root, 'asset-1')).ino, inode);
  });
}

for (const scenario of ['corrupt archive', 'runtime changed', 'wrong target', 'lookup denied']) {
  test(`refuses publication without replacing assets when ${scenario}`, async t => {
    const f = await fixture(t);
    assert.equal((await f.run('publish')).status, 0);
    switch (scenario) {
      case 'corrupt archive': writeFileSync(join(f.root, 'asset-1'), 'corrupt'); break;
      case 'runtime changed': writeFileSync(join(f.root, 'plugins/nose-review/scripts/nose-runtime.json'), '{"version":"v9.0.0"}'); f.git('commit', '-am', 'changed runtime without version'); break;
      case 'wrong target': writeFileSync(join(f.root, 'release.json'), JSON.stringify({ ...f.release(), target_commitish: 'main' })); break;
      case 'lookup denied': writeFileSync(join(f.root, 'deny'), '403'); break;
      default: throw new Error('Unknown scenario');
    }
    const before = readFileSync(join(f.root, 'release.json'), 'utf8');
    const result = await f.run('publish'); assert.notEqual(result.status, 0, result.output);
    assert.equal(readFileSync(join(f.root, 'release.json'), 'utf8'), before);
  });
}
