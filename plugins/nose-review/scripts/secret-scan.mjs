import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';

export function scanSecrets(directory) {
  const temporary=mkdtempSync(join(tmpdir(),'nose-secrets-'));
  try {
    const config=join(temporary,'defaults.toml'), report=join(temporary,'report.json');
    writeFileSync(config,'[extend]\nuseDefault = true\n',{mode:0o600});
    const env={...process.env};
    for(const name of Object.keys(env)) if(name.startsWith('GITLEAKS_')) delete env[name];
    const result=spawnSync('gitleaks',['dir',directory,'--config',config,'--gitleaks-ignore-path',join(temporary,'no-ignores'),
      '--ignore-gitleaks-allow','--redact=100','--no-banner','--report-format','json','--report-path',report],
    {cwd:temporary,env,encoding:'utf8',timeout:45000,maxBuffer:8*1024*1024});
    if(result.error || ![0,1].includes(result.status)) return {status:'unavailable',findings:[],reason:'Gitleaks unavailable, failed, or exceeded 45 seconds'};
    const raw=JSON.parse(readFileSync(report,'utf8'));
    if(!Array.isArray(raw) || (result.status===1 && raw.length===0)) throw new Error('Invalid result');
    const findings=raw.map(item=>{
      if(typeof item.File!=='string' || typeof item.RuleID!=='string' || !Number.isInteger(item.StartLine) || item.StartLine<1) throw new Error('Invalid finding');
      const file=relative(directory,resolve(directory,item.File));
      if(!file || file==='..' || file.startsWith('..'+sep) || isAbsolute(file)) throw new Error('Outside snapshot');
      return {rule:item.RuleID,file:file.split(sep).join('/'),line:item.StartLine};
    });
    return {status:findings.length?'blocked':'passed',findings};
  } catch {
    return {status:'unavailable',findings:[],reason:'Gitleaks did not produce a valid sanitized report'};
  } finally {
    rmSync(temporary,{recursive:true,force:true});
  }
}
