import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function privateDirectory(path) {
  try { mkdirSync(path,{mode:0o700}); } catch(error) { if(error.code!=='EEXIST') throw error; }
  if(!lstatSync(path).isDirectory()) throw new Error('Failure history directory must not be a symlink or file');
}

// Store locations and diagnostics, never raw scanner output or source excerpts.
export function saveFailure(root, report) {
  if(report.exitCode===0) return null;
  const review=join(root,'.nose-review');
  privateDirectory(review);
  const directory=join(review,'failures');
  privateDirectory(directory);
  const createdAt=new Date().toISOString();
  const path=join(directory,createdAt.replaceAll(':','-')+'-'+randomUUID()+'.json');
  const record={schemaVersion:1,createdAt,gateStatus:report.gateStatus,exitCode:report.exitCode,noseVersion:report.noseVersion,reason:report.reason,
    refs:(report.refs??[]).map(ref=>({localRef:ref.localRef,localSha:ref.localSha,remoteRef:ref.remoteRef,remoteSha:ref.remoteSha,
      status:ref.status,warnings:ref.warnings,secrets:ref.secrets,reductions:ref.reductions,
      candidates:(ref.candidates??[]).map(family=>({fingerprint:family.fingerprint,
        locations:family.locations.map(({file,start,end})=>({file,start,end}))}))}))};
  writeFileSync(path,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
  return path;
}
