import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

const schema = 1;
const digestPattern = /^[a-f0-9]{64}$/;
const maxEntryBytes = 128 * 1024 * 1024;
const maxTotalBytes = 512 * 1024 * 1024;
const maxEntries = 32;
const digest = value => createHash('sha256').update(value).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function identityDigest(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) || !Object.keys(identity).length) throw new Error('Scan identity is required');
  return digest(JSON.stringify(canonical(identity)));
}

function privateDirectory(path, create) {
  if (create) {
    try { mkdirSync(path, {mode: 0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('Cache directory must be private');
}

function readPrivate(path, limit) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > limit) throw new Error('Unsafe cache file');
    return readFileSync(descriptor);
  } finally { closeSync(descriptor); }
}

function context(directory, create) {
  if (!lstatSync(directory).isDirectory()) throw new Error('Invalid state directory');
  const root = join(directory, 'scan-results');
  privateDirectory(root, create);
  const keyPath = join(root, 'key');
  if (create) {
    try { writeFileSync(keyPath, randomBytes(32), {flag: 'wx', mode: 0o600}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const key = readPrivate(keyPath, 32);
  if (key.length !== 32) throw new Error('Invalid cache key');
  return {root, key};
}

function sourcePath(file) {
  return typeof file === 'string' && file.length > 0 && !file.includes('\0') && !file.includes('\\')
    && !posix.isAbsolute(file) && posix.normalize(file) === file && file !== '..' && !file.startsWith('../');
}

function validResult(result) {
  if (!result || typeof result.noseVersion !== 'string' || !result.noseVersion.trim()
    || !Array.isArray(result.families) || !result.files || typeof result.files !== 'object' || Array.isArray(result.files)
    || result.error !== undefined || result.complete === false) return false;
  if (!Object.entries(result.files).every(([file, hash]) => sourcePath(file) && typeof hash === 'string' && digestPattern.test(hash))) return false;
  return result.families.every(family => family && Array.isArray(family.locations) && family.locations.length > 0
    && Array.isArray(family.memberHashes) && family.memberHashes.length === family.locations.length
    && family.memberHashes.every(hash => typeof hash === 'string' && digestPattern.test(hash))
    && digest(JSON.stringify([...family.memberHashes].sort())) === family.fingerprint
    && family.locations.every(location => location && sourcePath(location.file) && Object.hasOwn(result.files, location.file)
      && Number.isSafeInteger(location.start) && Number.isSafeInteger(location.end) && location.start > 0 && location.end >= location.start));
}

// Only call after scan() has completed source-stability and membership verification.
// Identity must include every scan input and policy/scanner implementation identity.
export function writeScanResult({directory, identity, result}) {
  let temporary;
  try {
    if (!validResult(result)) return false;
    const id = identityDigest(identity);
    const {root, key} = context(directory, true);
    const payload = JSON.stringify({schema, identity: id, result});
    const envelope = JSON.stringify({payload, mac: createHmac('sha256', key).update(payload).digest('hex')});
    if (Buffer.byteLength(envelope) > maxEntryBytes) return false;
    const destination = join(root, `${id}.json`);
    try { readPrivate(destination, maxEntryBytes); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    temporary = join(root, `${id}.${randomBytes(12).toString('hex')}.tmp`);
    writeFileSync(temporary, envelope, {flag: 'wx', mode: 0o600});
    renameSync(temporary, destination);
    prune(root);
    return true;
  } catch { return false; }
  finally { if (temporary) { try { rmSync(temporary, {force: true}); } catch {} } }
}

export function readScanResult({directory, identity}) {
  try {
    const id = identityDigest(identity);
    const {root, key} = context(directory, false);
    const envelope = JSON.parse(readPrivate(join(root, `${id}.json`), maxEntryBytes).toString('utf8'));
    if (typeof envelope.payload !== 'string' || typeof envelope.mac !== 'string' || !digestPattern.test(envelope.mac)) return null;
    const expected = createHmac('sha256', key).update(envelope.payload).digest();
    if (!timingSafeEqual(expected, Buffer.from(envelope.mac, 'hex'))) return null;
    const payload = JSON.parse(envelope.payload);
    if (payload.schema !== schema || payload.identity !== id || !validResult(payload.result)) return null;
    return payload.result;
  } catch { return null; }
}

function prune(root) {
  const entries = readdirSync(root).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
    const path = join(root, name);
    const stat = lstatSync(path);
    return {path, stat};
  }).filter(({stat}) => stat.isFile()).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.path.localeCompare(b.path));
  let bytes = 0;
  for (const [index, {path, stat}] of entries.entries()) {
    bytes += stat.size;
    if (index >= maxEntries || bytes > maxTotalBytes) rmSync(path);
  }
}
