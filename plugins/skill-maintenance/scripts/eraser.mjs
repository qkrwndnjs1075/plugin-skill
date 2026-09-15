import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { inventory, treeHash, within, defaultRoots, defaultStateRoot } from './inventory.mjs';
import { indexLogs, logFiles, summarize } from './log-index.mjs';
import { markdownInline, indentedJson } from './report-format.mjs';

const defaultState = defaultStateRoot('skill-eraser');
function safeDir(dir) {
  const absolute = path.resolve(dir);
  let current = path.parse(absolute).root;
  for (const piece of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current,piece);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink state path: ${current}`);
  }
  fs.mkdirSync(absolute,{recursive:true,mode:0o700});
}
function save(file, value) {
  safeDir(path.dirname(file));
  const temporary = file + '.' + crypto.randomUUID();
  fs.writeFileSync(temporary,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});
  fs.renameSync(temporary,file);
}
function read(file,fallback) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : fallback; }
function lock(stateRoot, fn) {
  safeDir(stateRoot);
  const file = path.join(stateRoot,'operation.lock');
  const fd = fs.openSync(file,'wx',0o600);
  try { return fn(); } finally { fs.closeSync(fd); fs.unlinkSync(file); }
}
export async function analyze({ roots = defaultRoots(), stateRoot = defaultState, logsRoot, logsRoots = logsRoot ? [logsRoot] : [path.join(os.homedir(),'.codex/sessions'), path.join(os.homedir(),'.codex/archived_sessions')], now = new Date(), sources = read(path.join(os.homedir(),'.codex/skill-updater/sources.json'),{}) } = {}) {
  safeDir(stateRoot);
  const lockPath = path.join(stateRoot,'operation.lock'), fd = fs.openSync(lockPath,'wx',0o600);
  try {
    const inv = inventory({roots});
    const index = await indexLogs({files:logFiles(logsRoots),skills:inv.skills,previous:read(path.join(stateRoot,'index.json'),{}),now,sources});
    save(path.join(stateRoot,'index.json'),index);
    const evidence = {...summarize(index,inv.skills), excluded:inv.excluded, inventoryErrors:inv.errors};
    const transactions = path.join(stateRoot,'trash');
    evidence.pendingTransactions = fs.existsSync(transactions) ? fs.readdirSync(transactions).flatMap(id=> { const m=read(path.join(transactions,id,'manifest.json'),null); return m && !['verified','restored'].includes(m.status) ? [{id,status:m.status}] : []; }) : [];
    const report = path.join(stateRoot,'reports',now.toISOString().replace(/[:.]/g,'-')+'.md');
    safeDir(path.dirname(report));
    const rows = evidence.skills.map(s=>`## ${markdownInline(s.name)}\n\nIdentity: ${markdownInline(s.id)}\n\nContent hash: ${markdownInline(s.contentHash)}\n\nObserved facts:\n\n${indentedJson(s.versions)}\n\nJudgment: pending AI assessment. No fixed usage threshold applies.\n\nReason and confidence: pending.\n`);
    fs.writeFileSync(report,`# Skill eraser evidence\n\nPeriod: ${index.coverage.from} to ${index.coverage.to}\n\nLogs: ${index.coverage.scannedLogs}; unparsed records: ${index.coverage.unparsedRecords}; excluded plugin/system entries: ${inv.excluded.length}; inventory errors: ${inv.errors.length}.\n\nNo observed use does not prove non-use. Historical events with unknown version must not be charged to the current version.\n\n${rows.join('\n')}\n`,{mode:0o600,flag:'wx'});
    const evidenceFile = report.replace(/\.md$/, '.evidence.json');
    save(evidenceFile, { schemaVersion: 1, report, coverage: evidence.coverage, unassigned: evidence.unassigned, inventoryErrorCount: inv.errors.length, skills: evidence.skills.map(({ id, name, contentHash, versions, observation }) => ({ id, name, contentHash, versions, observation })) });
    return {...evidence,report,evidenceFile};
  } finally { fs.closeSync(fd); fs.unlinkSync(lockPath); }
}

export function trash({ roots = defaultRoots(), stateRoot = defaultState, skillId, expectedHash } = {}) {
  if (!skillId || !expectedHash) throw new Error('Exact approved skill ID and expected hash are required');
  return lock(stateRoot,()=> {
    const inv = inventory({roots}), skill = inv.skills.find(s=>s.id===skillId);
    if (!skill || skill.contentHash !== expectedHash) throw new Error('Skill absent, excluded, or changed since approval');
    const canonicalRoots = roots.filter(p=>fs.existsSync(p)).map(p=>fs.realpathSync(p));
    if (!canonicalRoots.some(root=>within(root,skill.realPath))) throw new Error('External skill target requires separate review');
    const id = crypto.randomUUID(), directory=path.join(stateRoot,'trash',id), target=path.join(directory,'skill');
    safeDir(directory);
    if (fs.statSync(skill.realPath).dev !== fs.statSync(directory).dev) throw new Error('Cross-filesystem move refused');
    const aliases = skill.aliases.filter(p=>p!==skill.realPath).map(p=> {
      if (!fs.lstatSync(p).isSymbolicLink() || fs.realpathSync(p)!==skill.realPath) throw new Error('Alias changed');
      return {path:p,target:fs.readlinkSync(p)};
    });
    const manifest={schemaVersion:1,id,status:'planned',skillId,contentHash:expectedHash,original:skill.realPath,target,aliases,roots:inv.roots};
    const file=path.join(directory,'manifest.json'); save(file,manifest);
    if (treeHash(skill.realPath)!==expectedHash) throw new Error('Skill changed before rename');
    fs.renameSync(skill.realPath,target); manifest.status='moved'; save(file,manifest);
    for (const alias of aliases) { if (!fs.lstatSync(alias.path).isSymbolicLink() || fs.readlinkSync(alias.path)!==alias.target) throw new Error('Alias changed after move'); fs.unlinkSync(alias.path); }
    if (treeHash(target)!==expectedHash || inventory({roots}).skills.some(s=>s.id===skillId)) throw new Error('Move verification failed; restore transaction');
    manifest.status='verified'; save(file,manifest);
    const report=path.join(stateRoot,'reports',id+'.md'); safeDir(path.dirname(report));
    fs.writeFileSync(report,`# Approved skill move\n\nSkill: ${markdownInline(skill.name)}\n\nApproved identity: ${markdownInline(skillId)}\n\nOriginal: ${markdownInline(manifest.original)}\n\nRecovery copy: ${markdownInline(target)}\n\nStatus: verified\n\nRestore: node scripts/eraser.mjs restore --transaction ${id}\n`,{mode:0o600});
    return {...manifest,report};
  });
}

export function restore({stateRoot=defaultState,transaction}={}) {
  if (!/^[\w-]+$/.test(transaction || '')) throw new Error('Exact transaction ID required');
  return lock(stateRoot,()=> {
    const file=path.join(stateRoot,'trash',transaction,'manifest.json'), m=read(file,null);
    if (!m || m.id!==transaction || !['planned','moved','verified','restoring'].includes(m.status)) throw new Error('Transaction not restorable');
    const expectedTarget=path.resolve(stateRoot,'trash',transaction,'skill');
    if (m.target!==expectedTarget || !m.roots.some(root=>within(path.resolve(root),m.original)) || path.basename(m.original).startsWith('.')) throw new Error('Invalid manifest paths');
    safeDir(path.dirname(m.original));
    const original=fs.lstatSync(m.original,{throwIfNoEntry:false}), recovery=fs.lstatSync(m.target,{throwIfNoEntry:false});
    const resumed=original?.isDirectory() && !recovery && treeHash(m.original)===m.contentHash;
    if(!resumed && (original || !recovery?.isDirectory() || treeHash(m.target)!==m.contentHash)) throw new Error('Restore collision or changed recovery copy');
    const missingAliases=[];
    for (const alias of m.aliases) {
      if (!m.roots.some(root=>within(path.resolve(root),alias.path))) throw new Error('Invalid alias');
      try { const stat=fs.lstatSync(alias.path); if(!stat.isSymbolicLink() || fs.readlinkSync(alias.path)!==alias.target)throw new Error('Alias collision'); } catch(error) { if(error.code!=='ENOENT') throw error; missingAliases.push(alias); }
    }
    m.status='restoring'; save(file,m);
    if(!resumed) fs.renameSync(m.target,m.original);
    for (const alias of missingAliases) fs.symlinkSync(alias.target,alias.path);
    if(treeHash(m.original)!==m.contentHash) throw new Error('Restore verification failed');
    m.status='restored'; save(file,m); return m;
  });
}

export function listTrash({ stateRoot = defaultState } = {}) {
  const directory = path.join(stateRoot, 'trash');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).sort().flatMap(id => {
    const manifest = read(path.join(directory, id, 'manifest.json'), null);
    return manifest ? [{ id: manifest.id, status: manifest.status, skillId: manifest.skillId, contentHash: manifest.contentHash, original: manifest.original, recovery: manifest.target }] : [];
  });
}

if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command,...args]=process.argv.slice(2), options={};
  for(let i=0;i<args.length;i++) { if(args[i]==='--json')continue; const key={'--roots':'roots','--state-root':'stateRoot','--logs-root':'logsRoots','--skill-id':'skillId','--expected-hash':'expectedHash','--transaction':'transaction'}[args[i]]; if(!key || !args[i+1])throw new Error('Unknown or missing argument'); options[key]=['roots','logsRoots'].includes(key)?args[++i].split(path.delimiter):args[++i]; }
  try { const result=command==='analyze'?await analyze(options):command==='trash'?trash(options):command==='restore'?restore(options):command==='list-trash'?listTrash(options):(()=>{throw new Error('Use analyze, trash, restore, or list-trash');})(); process.stdout.write(JSON.stringify(result,null,2)+'\n'); }
  catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
