import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=realpathSync(join(dirname(fileURLToPath(import.meta.url)),'..'));
const readJson=path=>JSON.parse(readFileSync(path,'utf8'));

test('repository marketplace exposes isolated plugin packages',()=>{
  const marketplace=readJson(join(root,'.agents/plugins/marketplace.json'));
  assert.equal(marketplace.name,'plugin-skill');
  assert.deepEqual(marketplace.plugins.map(plugin=>plugin.name),['nose-review','skill-maintenance','joowon-plugin']);
  for(const plugin of marketplace.plugins) {
    const directory=resolve(root,plugin.source.path);
    assert.ok(directory.startsWith(join(root,'plugins')+'/'));
    const manifest=readJson(join(directory,'.codex-plugin/plugin.json'));
    assert.equal(manifest.name,plugin.name);
    assert.equal(plugin.source.source,'local');
  }
});

test('Joowon Plugin preserves the local Commit and PR skill packages and exposes JW',()=>{
  for(const skill of ['commit','pr','jw']) {
    const directory=join(root,'plugins/joowon-plugin/skills',skill);
    assert.ok(existsSync(join(directory,'SKILL.md')));
    assert.ok(existsSync(join(directory,'agents/openai.yaml')));
  }
  assert.ok(existsSync(join(root,'plugins/joowon-plugin/skills/pr/references/visual-evidence.md')));
  const jw=readFileSync(join(root,'plugins/joowon-plugin/skills/jw/agents/openai.yaml'),'utf8');
  assert.match(jw,/allow_implicit_invocation: false/);
  assert.match(jw,/\$jw/);
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
  assert.ok(existsSync(join(root,'plugins/skill-maintenance/scripts/judge.mjs')));
  assert.ok(existsSync(join(root,'plugins/skill-maintenance/scripts/judgment.schema.json')));
});
