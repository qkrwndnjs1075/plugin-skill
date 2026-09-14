import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { register, stateRoot, hash } from './review-runtime.mjs';

test('skill scan permits its own session and preserves registration, but refuses another session', t=>{
  const fixture=mkdtempSync(join(tmpdir(),'nose-skill-scan-'));
  t.after(()=>rmSync(fixture,{recursive:true,force:true}));
  const previous=process.env.NOSE_REVIEW_STATE_ROOT;
  process.env.NOSE_REVIEW_STATE_ROOT=join(fixture,'state');
  try {
    // Canonical root is important on macOS /tmp aliases.
    const root=realpathSync(fixture);
    register(root,'owner');
    const file=join(stateRoot(root),hash('owner')+'.json');
    const before=readFileSync(file,'utf8');
    const run=id=>spawnSync(process.execPath,[new URL('./nose-fix-scan.mjs',import.meta.url).pathname,root],{encoding:'utf8',env:{...process.env,CODEX_THREAD_ID:id}});
    const own=run('owner');
    assert.equal(own.status,0,own.stderr);
    assert.equal(JSON.parse(own.stdout).status,'scanned');
    assert.equal(readFileSync(file,'utf8'),before);
    assert.equal(run('stranger').status,1);
    register(root,'second');
    assert.equal(run('owner').status,1);
  } finally {
    if(previous===undefined) delete process.env.NOSE_REVIEW_STATE_ROOT;
    else process.env.NOSE_REVIEW_STATE_ROOT=previous;
  }
});
