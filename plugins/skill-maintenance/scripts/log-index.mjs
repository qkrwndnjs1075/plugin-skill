import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { digest } from './inventory.mjs';

export const parserVersion = 4;
export function logFiles(root) {
  if (Array.isArray(root)) return [...new Set(root.flatMap(logFiles))];
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? logFiles(path.join(root, e.name)) : e.isFile() && e.name.endsWith('.jsonl') ? [path.join(root, e.name)] : []);
}
async function prefixFingerprint(file, bytes) {
  const hash = crypto.createHash('sha256');
  const ranges = bytes <= 4096 ? [[0, bytes]] : [[0, 4096], [Math.max(4096, bytes - 65536), bytes]];
  for (const [start, end] of ranges) {
    hash.update(`${start}:${end}\0`);
    if (end > start) for await (const chunk of fs.createReadStream(file, { start, end: end - 1 })) hash.update(chunk);
  }
  return hash.digest('hex');
}
function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('\n');
  if (value && typeof value === 'object') return ['text', 'output', 'content', 'message', 'stderr', 'stdout', 'aggregated_output'].map(key => textOf(value[key])).filter(Boolean).join('\n');
  return '';
}
function failedOutput(payload) {
  if (payload.isError === true) return true;
  let value = payload.output;
  if(typeof value==='string') {
    const header=/^Chunk ID: [^\r\n]+\r?\nWall time: [^\r\n]+\r?\nProcess exited with code (-?\d+)\r?\n(?:Final output|Output):/.exec(value);
    if(header) return Number(header[1])!==0;
  }
  if (typeof value === 'string' && /^[\[{]/.test(value.trim())) {
    try { value = JSON.parse(value); } catch { return false; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return value.isError === true || (Number.isInteger(value.exit_code) && value.exit_code !== 0) || ['failed', 'error'].includes(String(value.status).toLowerCase());
}
function resolvedInputs(payload) {
  let args;
  try { args=typeof payload.arguments==='string'?JSON.parse(payload.arguments):payload.arguments; } catch { return []; }
  const cwd=args?.workdir || args?.cwd;
  if(typeof cwd!=='string'||!path.isAbsolute(cwd)) return [];
  const command=args.cmd || args.command;
  if(typeof command!=='string') return [];
  // Resolve literal path arguments only; shell expansion is not evidence of a read.
  const tokens=command.match(/"[^"\n]*"|'[^'\n]*'|[^\s;&|]+/g)||[];
  if(!/^(?:cat|sed|node|python[\d.]*|bash|sh)$/.test(path.basename(tokens[0]||''))) return [];
  return tokens.slice(1).flatMap(token=>{
    const value=token.replace(/^(["'])(.*)\1$/,'$2');
    if(/[\$`*?<>]/.test(value) || value.startsWith('-')) return [];
    return [path.resolve(cwd,value)];
  });
}
async function* completeLines(file, start, size) {
  if(start>=size)return;
  let pending=Buffer.alloc(0);
  for await(const chunk of fs.createReadStream(file,{start,end:size-1})) {
    pending=Buffer.concat([pending,chunk]);
    let newline;
    while((newline=pending.indexOf(10))!==-1) {
      yield {line:pending.subarray(0,newline).toString('utf8'),length:newline+1};
      pending=pending.subarray(newline+1);
    }
  }
}
function versionAt(skill, timestamp, sources, observed) {
  const source = sources?.skills?.[skill.id];
  const versions = [...(source?.history || []), ...(source?.installedAt ? [source] : []), ...(observed[skill.id] || [])];
  return versions.filter(v => Date.parse(v.installedAt) <= Date.parse(timestamp)).sort((a,b) => Date.parse(b.installedAt)-Date.parse(a.installedAt))[0]?.contentHash || 'unknown';
}

export async function indexLogs({ files, skills, previous = {}, now = new Date(), sources = {} }) {
  const cutoff = now.getTime() - 90 * 86400000;
  const state = previous.parserVersion === parserVersion ? structuredClone(previous) : { parserVersion, cursors: {}, events: [], observed: structuredClone(previous.observed || {}) };
  state.observed ||= {};
  for (const skill of skills) {
    const versions = state.observed[skill.id] ||= [];
    if (versions.at(-1)?.contentHash !== skill.contentHash) versions.push({ contentHash: skill.contentHash, installedAt: now.toISOString() });
  }
  state.events = state.events.filter(e => Date.parse(e.timestamp) >= cutoff);
  const available = new Set(files.map(digest));
  state.events = state.events.filter(e => available.has(e.file));
  const events = new Map(state.events.map(e => [e.key,e]));
  let scanned = 0, unparsed = 0, bytesRead = 0;
  for (const file of files) {
    const id = digest(file), stat = fs.statSync(file), old = state.cursors[id];
    if (stat.mtimeMs < cutoff && !old) continue;
    let cursor = old;
    if (!cursor || cursor.identity !== `${stat.dev}:${stat.ino}` || stat.size < cursor.offset || await prefixFingerprint(file, cursor.offset) !== cursor.prefixHash) {
      for (const [key,event] of events) if (event.file === id) events.delete(key);
      cursor = { offset: 0, task: 0, explicit: [], used: [], calls: {}, identity: `${stat.dev}:${stat.ino}`, unparsed: 0 };
    }
    scanned++;
    const primary = () => cursor.used.length === 1 ? cursor.used[0] : null;
    const add = (kind, timestamp, skillId, evidence, call = '') => {
      if (!Number.isFinite(Date.parse(timestamp)) || Date.parse(timestamp) < cutoff) return;
      const skill = skills.find(s => s.id === skillId);
      const key = digest(`${id}:${cursor.task}:${skillId || 'unassigned'}:${kind}:${call}`);
      events.set(key, { key, file: id, task: cursor.task, timestamp, skillId, version: skill ? versionAt(skill,timestamp,sources,state.observed) : 'unknown', kind, evidence });
    };
    let position = cursor.offset;
    for await (const {line,length} of completeLines(file,cursor.offset,stat.size)) {
      position += length; bytesRead += length;
      let record;
      try { record = JSON.parse(line); } catch { cursor.unparsed++; continue; }
      const p = record.payload || {}, timestamp = record.timestamp;
      if (record.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        const text = textOf(p.content);
        const rollback = /(?:되돌려|원복해|롤백해|\b(?:revert|roll back|undo) (?:it|that|this|the changes)\b)/i.test(text);
        const rework = /(?:다시\s*(?:해줘|작업해|만들어|작성해)|\b(?:redo|do (?:it|that) again)\b)/i.test(text);
        if (rollback || rework) add(rollback ? 'rollback' : 'rework', timestamp, primary(), 'explicit-following-user-request');
        cursor.task++; cursor.used = []; cursor.calls = {};
        cursor.explicit = skills.filter(s => new RegExp('\\$' + s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])').test(text)).map(s=>s.id);
      } else if (record.type === 'response_item' && ['function_call','custom_tool_call'].includes(p.type)) {
        const input = typeof p.arguments === 'string' ? p.arguments : textOf(p.input);
        const tool = p.name || '';
        // Only executed reads or skill-local script commands count, not arbitrary mentions or writes.
        const canRead = /(?:exec|shell|read_file|read_text)/i.test(tool) && /(?:\bcat\s|\bsed\s|\breadFile|read_file|read_text)/.test(tool + ' ' + input);
        const resolved=resolvedInputs(p);
        const matches = skills.filter(s => [s.realPath,...s.aliases].some(base => (canRead && (input.includes(base + '/SKILL.md') || resolved.includes(base+'/SKILL.md'))) || (/(?:exec|shell)/i.test(tool) && /(?:\bnode\s|\bpython\S*\s|\bbash\s|\bsh\s)/.test(input) && (input.includes(base + '/scripts/') || resolved.some(file=>file.startsWith(base+'/scripts/'))))));
        if(matches.length)cursor.calls[p.call_id] = matches.map(s=>s.id);
      } else if (record.type === 'response_item' && ['function_call_output','custom_tool_call_output'].includes(p.type)) {
        const linked = cursor.calls[p.call_id] || [], failed = failedOutput(p);
        if (linked.length && failed) add('error', timestamp, linked.length === 1 ? linked[0] : null, 'tool-error');
        else if (linked.length) for (const skillId of linked) {
          if (!cursor.used.includes(skillId)) cursor.used.push(skillId);
          add('use', timestamp, skillId, cursor.explicit.includes(skillId) ? 'explicit' : 'automatic');
        }
      } else if (record.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'CommandExecution') {
        const command = textOf([p.item.command, p.item.parsed_cmd]);
        const matched = skills.filter(s => [s.realPath, ...s.aliases].some(base => command.includes(base + '/scripts/')));
        const failed = (Number.isInteger(p.item.exit_code) && p.item.exit_code !== 0) || ['failed', 'error'].includes(String(p.item.status).toLowerCase());
        if (failed && matched.length) add('error', timestamp, matched.length === 1 ? matched[0].id : null, 'structured-command-error');
        else if (matched.length) for (const skill of matched) {
          if (!cursor.used.includes(skill.id)) cursor.used.push(skill.id);
          add('use', timestamp, skill.id, cursor.explicit.includes(skill.id) ? 'explicit' : 'automatic');
        }
      } else if (record.type === 'event_msg' && ['turn_aborted','task_aborted','interrupted'].includes(p.type)) add('interrupted', timestamp, primary(), 'explicit-interruption');
      else if (!['session_meta','turn_context','response_item','event_msg'].includes(record.type)) cursor.unparsed++;
    }
    cursor.offset = position; cursor.size = stat.size; cursor.mtimeMs = stat.mtimeMs;
    cursor.prefixHash = await prefixFingerprint(file, position);
    state.cursors[id] = cursor; unparsed += cursor.unparsed;
  }
  state.events = [...events.values()];
  state.coverage = { from: new Date(cutoff).toISOString(), to: now.toISOString(), scannedLogs: scanned, unparsedRecords: unparsed, bytesRead, historicalVersionPolicy: 'unknown-until-observed-or-provenance' };
  return state;
}

export function summarize(index, skills) {
  return { coverage: index.coverage, unassigned: index.events.filter(e=>!e.skillId).length, skills: skills.map(skill => {
    const all = index.events.filter(e=>e.skillId === skill.id);
    const versions = [...new Set([...all.map(e=>e.version),skill.contentHash])].map(version => {
      const events = all.filter(e=>e.version === version);
      return { version, current: version === skill.contentHash, explicit: events.filter(e=>e.kind==='use' && e.evidence==='explicit').length, automatic: events.filter(e=>e.kind==='use' && e.evidence==='automatic').length, lastUsed: events.filter(e=>e.kind==='use').map(e=>e.timestamp).sort().at(-1) || null, quality: Object.fromEntries(['error','interrupted','rework','rollback'].map(k=>[k,events.filter(e=>e.kind===k).length])) };
    });
    return { ...skill, versions, observation: all.length ? 'observed' : 'no-observed-use' };
  }) };
}
