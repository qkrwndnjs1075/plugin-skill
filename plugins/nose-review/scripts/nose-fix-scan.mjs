#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson, hash, projectRoot, scan, snapshot, withRegistry } from './review-runtime.mjs';

function assertAvailable(directory) {
  if (existsSync(join(directory,'collision'))) throw new Error('Concurrent registry activity; wait for other sessions to finish');
  const own=process.env.CODEX_THREAD_ID ? hash(process.env.CODEX_THREAD_ID)+'.json' : null;
  for (const file of readdirSync(directory).filter(name=>name.endsWith('.json'))) {
    const record=JSON.parse(readFileSync(join(directory,file),'utf8'));
    if(file!==own || record.overlap) throw new Error('Another or overlapping session is active; defer fixes');
  }
}
try {
  if(process.argv.length!==3) throw new Error('Usage: nose-fix-scan.mjs <project>');
  const root=projectRoot(process.argv[2]);
  withRegistry(root,assertAvailable);
  const result=scan(root);
  withRegistry(root,directory=>{
    assertAvailable(directory);
    if(JSON.stringify(result.files)!==JSON.stringify(snapshot(root))) throw new Error('Code changed after scan');
    const review=join(root,'.nose-review');
    mkdirSync(review,{recursive:true});
    if(realpathSync(review)!==join(realpathSync(root),'.nose-review')) throw new Error('Review directory must not redirect outside project');
    atomicJson(join(review,'report.json'),{schemaVersion:1,noseVersion:result.noseVersion,candidates:result.families});
    process.stdout.write(JSON.stringify({status:'scanned',families:result.families.length,report:join(review,'report.json')})+'\n');
  });
} catch(error) {
  process.stderr.write(error.message+'\n');
  process.exitCode=1;
}
