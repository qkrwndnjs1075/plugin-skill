import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, relative, sep } from "node:path";

const extensions = new Set(['.c','.cpp','.cc','.h','.hpp','.css','.cts','.go','.htm','.html','.java','.js','.jsx','.cjs','.mjs','.mts','.py','.pyi','.rb','.rs','.svelte','.swift','.ts','.tsx','.vue']);

export function isSourceFile(file) {
  return extensions.has(extname(file).toLowerCase());
}

export function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function containedPath(root, file) {
  const path = isAbsolute(file) ? file : `${root}${sep}${file}`;
  const local = relative(root, path);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error(`Source path is outside repository: ${file}`);
  }
  const actual = realpathSync.native(path);
  const actualLocal = relative(root, actual);
  if (actualLocal === ".." || actualLocal.startsWith(`..${sep}`) || isAbsolute(actualLocal)) {
    throw new Error(`Source symlink is outside repository: ${file}`);
  }
  return actual;
}

// Scope reuse to one scan; callers must verify source stability before using it.
export function createMemberHasher(repoRoot) {
  const root = realpathSync.native(repoRoot);
  const files = new Map();
  return family => {
    if (!Array.isArray(family?.locations) || family.locations.length === 0) {
      throw new Error("Family must contain source locations.");
    }
    return family.locations.map(({ file, start, end }) => {
      if (typeof file !== "string" || !Number.isInteger(start)
        || !Number.isInteger(end) || start < 1 || end < start) {
        throw new Error("Invalid source span.");
      }
      let source = files.get(file);
      if (!source) {
        const path = containedPath(root, file);
        const lines = readFileSync(path, "utf8").split(/\r?\n/);
        if (lines.at(-1) === "") lines.pop();
        source = {lines:lines.map(line=>line.trimEnd()),spans:new Map()};
        files.set(file,source);
      }
      if (end > source.lines.length) throw new Error(`Source span exceeds file: ${file}`);
      const key = `${start}:${end}`;
      if (!source.spans.has(key)) source.spans.set(key,hash(source.lines.slice(start - 1,end).join("\n")));
      return source.spans.get(key);
    }).sort();
  };
}

export function verifiedFamilies(report, root) {
  if (!Array.isArray(report.families)) throw new Error('Unsupported Nose report');
  const memberHashesForFamily = createMemberHasher(root);
  return report.families.flatMap(family=>{
    if (!Array.isArray(family?.locations)) throw new Error('Family must contain source locations.');
    const locations=family.locations.filter(location=>location?.region !== null);
    if (locations.length !== family.locations.length && locations.length < 2) return [];
    const candidate=locations.length === family.locations.length ? family : {...family,locations};
    const memberHashes=memberHashesForFamily(candidate);
    return [{...candidate,memberHashes,fingerprint:hash(JSON.stringify(memberHashes))}];
  });
}
