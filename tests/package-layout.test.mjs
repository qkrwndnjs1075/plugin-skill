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
  assert.equal(marketplace.interface.displayName,'Joowon Plugins');
  assert.deepEqual(marketplace.plugins.map(plugin=>plugin.name),['nose-review','joowon-plugin','file-checks']);
  for(const plugin of marketplace.plugins) {
    const directory=resolve(root,plugin.source.path);
    assert.ok(directory.startsWith(join(root,'plugins')+'/'));
    const manifest=readJson(join(directory,'.codex-plugin/plugin.json'));
    assert.equal(manifest.name,plugin.name);
    assert.equal(plugin.source.source,'local');
  }
});

test('Git Workflow preserves the local Commit and PR skill packages',()=>{
  for(const skill of ['commit','pr']) {
    const directory=join(root,'plugins/joowon-plugin/skills',skill);
    assert.ok(existsSync(join(directory,'SKILL.md')));
    assert.ok(existsSync(join(directory,'agents/openai.yaml')));
  }
  assert.ok(existsSync(join(root,'plugins/joowon-plugin/skills/pr/references/visual-evidence.md')));
  assert.equal(existsSync(join(root,'plugins/joowon-plugin/skills/jw')),false);
});

test('Nose keeps its hook after Skill Maintenance is retired',()=>{
  assert.ok(existsSync(join(root,'plugins/nose-review/hooks/hooks.json')));
  assert.equal(existsSync(join(root,'plugins/skill-maintenance/.codex-plugin/plugin.json')),false);
  assert.equal(existsSync(join(root,'plugins/skill-maintenance/skills/skill-eraser/SKILL.md')),false);
  assert.equal(existsSync(join(root,'plugins/skill-maintenance/skills/skill-updater/SKILL.md')),false);
});
