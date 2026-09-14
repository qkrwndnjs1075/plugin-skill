import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=realpathSync(join(dirname(fileURLToPath(import.meta.url)),'..'));
const readJson=path=>JSON.parse(readFileSync(path,'utf8'));

test('repository marketplace exposes two isolated plugin packages',()=>{
  const marketplace=readJson(join(root,'.agents/plugins/marketplace.json'));
  assert.equal(marketplace.name,'plugin-skill');
  assert.deepEqual(marketplace.plugins.map(plugin=>plugin.name),['nose-review','skill-maintenance']);
  for(const plugin of marketplace.plugins) {
    const directory=resolve(root,plugin.source.path);
    assert.ok(directory.startsWith(join(root,'plugins')+'/'));
    const manifest=readJson(join(directory,'.codex-plugin/plugin.json'));
    assert.equal(manifest.name,plugin.name);
    assert.equal(plugin.source.source,'local');
  }
});

test('Nose owns its hook while skill maintenance stays explicit-only',()=>{
  assert.ok(existsSync(join(root,'plugins/nose-review/hooks/hooks.json')));
  assert.equal(existsSync(join(root,'plugins/skill-maintenance/hooks/hooks.json')),false);
  for(const skill of ['skill-eraser','skill-updater']) {
    const directory=join(root,'plugins/skill-maintenance/skills',skill);
    assert.ok(existsSync(join(directory,'SKILL.md')));
    const openai=readFileSync(join(directory,'agents/openai.yaml'),'utf8');
    assert.match(openai,/allow_implicit_invocation: false/);
    assert.match(openai,new RegExp('\\$'+skill));
  }
});
