import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const defaultRoots = () => [path.join(os.homedir(), '.codex/skills'), path.join(os.homedir(), '.agents/skills')];
export const defaultStateRoot = name => path.join(os.homedir(), `.codex/${name}`);
export const within = (root, target) => target === root || target.startsWith(root + path.sep);

export function treeHash(directory) {
  const hash = crypto.createHash('sha256');
  function visit(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === '.git') continue;
      const file = path.join(dir, name), relative = prefix + name, stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Unsupported internal symlink: ${relative}`);
      if (stat.isDirectory()) { hash.update(`dir:${relative}\0`); visit(file, relative + '/'); }
      else if (stat.isFile()) { hash.update(`file:${relative}:${stat.mode & 0o111}\0`); hash.update(fs.readFileSync(file)); hash.update('\0'); }
      else throw new Error(`Unsupported file type: ${relative}`);
    }
  }
  visit(directory);
  return hash.digest('hex');
}

export function inventory({ roots = defaultRoots(), excludedRoots = [] } = {}) {
  const exclusions = [path.join(os.homedir(), '.codex/plugins'), path.join(os.homedir(), 'plugins'), ...excludedRoots].map(p => path.resolve(p));
  const skills = new Map(), excluded = [], errors = [];
  for (const rootInput of roots) {
    const root = path.resolve(rootInput);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root).sort()) {
      const alias = path.join(root, entry);
      try {
        const realPath = fs.realpathSync(alias);
        let owner = realPath, pluginOwned = false;
        while (owner !== path.dirname(owner)) {
          if (fs.existsSync(path.join(owner, '.codex-plugin/plugin.json'))) { pluginOwned = true; break; }
          owner = path.dirname(owner);
        }
        if (entry.startsWith('.') || entry.startsWith('omo:') || pluginOwned || exclusions.some(p => within(p, realPath))) { excluded.push(alias); continue; }
        const skillFile = path.join(realPath, 'SKILL.md');
        if (!fs.statSync(realPath).isDirectory() || !fs.existsSync(skillFile)) continue;
        const text = fs.readFileSync(skillFile, 'utf8');
        const name = text.match(/^name:\s*["']?([^\r\n"']+)/m)?.[1]?.trim() || entry;
        if (name.startsWith('omo:')) { excluded.push(alias); continue; }
        const existing = skills.get(realPath);
        if (existing) { existing.aliases.push(alias); continue; }
        skills.set(realPath, { id: digest(realPath), name, realPath, aliases: [alias], contentHash: treeHash(realPath), description: text.match(/^description:\s*(.*)$/m)?.[1] || '' });
      } catch (error) { errors.push({ path: alias, reason: error.message }); }
    }
  }
  return { skills: [...skills.values()], excluded, errors, roots: roots.map(p => path.resolve(p)) };
}
