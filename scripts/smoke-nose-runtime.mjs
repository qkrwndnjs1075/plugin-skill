import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { ensureNose } from '../plugins/nose-review/scripts/nose-runtime.mjs';
import { duplicateSource } from '../plugins/nose-review/scripts/test-helpers.mjs';

const runtime=ensureNose();
assert.ok(['installed','current'].includes(runtime.status),'Smoke test requires the pinned managed runtime, not fallback');
const root=mkdtempSync(join(tmpdir(),'nose-runtime-smoke-'));
try {
  for (const name of ['clean','duplicate']) mkdirSync(join(root,name));
  writeFileSync(join(root,'clean','one.js'),'export const square = value => value * value;\n');
  for (const name of ['one','two']) writeFileSync(join(root,'duplicate',name+'.js'),duplicateSource(name));
  const scan=name=>JSON.parse(execFileSync(runtime.binary,['query',join(root,name),'all','top=0','--mode','syntax','--format','json'],{encoding:'utf8',timeout:60000}));
  assert.equal(scan('clean').families.length,0);
  const duplicates=scan('duplicate').families.length;
  assert.ok(duplicates>0);
  console.log(JSON.stringify({runtime:runtime.status,version:runtime.version,cleanFamilies:0,duplicateFamilies:duplicates}));
} finally {
  rmSync(root,{recursive:true,force:true});
}
