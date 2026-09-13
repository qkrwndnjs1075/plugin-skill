import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { scanSecrets } from './secret-scan.mjs';

test('default secret rules cannot be disabled by repository config, comments or environment',t=>{
  const root=mkdtempSync(join(tmpdir(),'secret-fixture-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const secret=['gh','p_'].join('')+randomBytes(18).toString('hex');
  writeFileSync(join(root,'config.txt'),'token='+secret+' # gitleaks:allow\n');
  writeFileSync(join(root,'.gitleaks.toml'),'[allowlist]\npaths = [".*"]\n');
  const old=process.env.GITLEAKS_CONFIG_TOML;
  process.env.GITLEAKS_CONFIG_TOML='[allowlist]\npaths = [".*"]';
  try {
    const result=scanSecrets(root);
    assert.equal(result.status,'blocked',JSON.stringify(result));
    assert.ok(result.findings.some(f=>f.file==='config.txt' && f.line===1));
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(result.findings.every(f=>Object.keys(f).sort().join(',')==='file,line,rule'));
  } finally { if(old===undefined) delete process.env.GITLEAKS_CONFIG_TOML; else process.env.GITLEAKS_CONFIG_TOML=old; }
});

test('clean directories pass; missing scanner is unavailable, not clean',t=>{
  const root=mkdtempSync(join(tmpdir(),'secret-clean-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,'app.js'),'export const answer = 42;');
  assert.equal(scanSecrets(root).status,'passed');
  const path=process.env.PATH;
  process.env.PATH='';
  try { assert.equal(scanSecrets(root).status,'unavailable'); }
  finally { process.env.PATH=path; }
});

test('malformed, inconsistent, and failed scanner output never becomes clean or exposes raw text',t=>{
  const root=mkdtempSync(join(tmpdir(),'secret-errors-')), bin=join(root,'bin');
  mkdirSync(bin);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const previous=process.env.PATH;
  process.env.PATH=bin;
  try {
    for(const [report,status] of [['RAW_PRIVATE_VALUE',0],['[]',1],['[]',2]]) {
      writeFileSync(join(bin,'gitleaks'),'#!'+process.execPath+'\n'+
        'const fs=require("node:fs");fs.writeFileSync(process.argv[process.argv.indexOf("--report-path")+1],'+JSON.stringify(report)+');console.error("RAW_PRIVATE_VALUE");process.exit('+status+');',{mode:0o700});
      const result=scanSecrets(root);
      assert.equal(result.status,'unavailable');
      assert.ok(!JSON.stringify(result).includes('RAW_PRIVATE_VALUE'));
    }
  } finally { process.env.PATH=previous; }
});
