import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
export function readSources(stateDir) {
  const file = path.join(stateDir, 'sources.json');
  if (!fs.existsSync(file)) return { schemaVersion: 1, skills: {} };
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.schemaVersion !== 1 || !state.skills) throw new Error('Unsupported sources state');
  return state;
}
export function writeSources(stateDir, state) { atomicJson(path.join(stateDir, 'sources.json'), state); }
