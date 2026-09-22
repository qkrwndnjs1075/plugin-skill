import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { hash as digest } from './review-policy.mjs';

const schema = 2;
const digestPattern = /^[a-f0-9]{64}$/;
const maxEntryBytes = 512 * 1024 * 1024;
const maxTotalBytes = 2 * 1024 * 1024 * 1024;
const maxEntries = 32;
const maxRecordBytes = 16 * 1024 * 1024;

function fail(reason) { throw Object.assign(new Error(reason), {cacheReason: reason}); }
function report(onEvent, operation, outcome, reason) {
  try { onEvent?.({operation, outcome, reason}); } catch {}
}
function reason(error) {
  return error.cacheReason ?? (error.code === 'ENOENT' ? 'not-found' : error.code === 'ELOOP' ? 'unsafe-file' : 'io-error');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function identityDigest(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) || !Object.keys(identity).length) fail('invalid-identity');
  return digest(JSON.stringify(canonical(identity)));
}

function privateDirectory(path, create) {
  if (create) {
    try { mkdirSync(path, {mode: 0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) || stat.uid !== process.getuid()) fail('unsafe-directory');
}

function openPrivate(path, limit) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('unsafe-file');
    if (stat.size > limit) fail('entry-too-large');
    return descriptor;
  } catch (error) { closeSync(descriptor); throw error; }
}

function readPrivate(path, limit) {
  const descriptor = openPrivate(path, limit);
  try {
    return readFileSync(descriptor);
  } finally { closeSync(descriptor); }
}

function context(directory, create) {
  if (!lstatSync(directory).isDirectory()) fail('unsafe-directory');
  const root = join(directory, 'scan-results');
  privateDirectory(root, create);
  const keyPath = join(root, 'key');
  if (create) {
    try { writeFileSync(keyPath, randomBytes(32), {flag: 'wx', mode: 0o600}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const key = readPrivate(keyPath, 32);
  if (key.length !== 32) fail('invalid-key');
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

function validateResult(result) {
  if (result?.files && typeof result.files === 'object' && Array.isArray(result.families)
    && result.families.some(family => Array.isArray(family?.locations)
      && family.locations.some(location => sourcePath(location?.file) && !Object.hasOwn(result.files, location.file)))) fail('missing-source-member');
  if (!validResult(result)) fail('invalid-result');
}

// Only call after scan() has completed source-stability and membership verification.
// Identity must include every scan input and policy/scanner implementation identity.
export function writeScanResult({directory, identity, result, onEvent}) {
  let temporary;
  try {
    validateResult(result);
    const id = identityDigest(identity);
    const {root, key} = context(directory, true);
    const destination = join(root, `${id}.json`);
    try { closeSync(openPrivate(destination, maxEntryBytes)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    temporary = join(root, `${id}.${randomBytes(12).toString('hex')}.tmp`);
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      const mac = createHmac('sha256', key);
      let bytes = 65;
      const record = value => {
        const buffer = Buffer.from(`${JSON.stringify(value)}\n`);
        bytes += buffer.length;
        if (buffer.length > maxRecordBytes) fail('record-too-large');
        if (bytes > maxEntryBytes) fail('entry-too-large');
        mac.update(buffer);
        writeFileSync(descriptor, buffer);
      };
      const {families, files, ...metadata} = result;
      record({schema, identity: id, metadata});
      for (const [file, hash] of Object.entries(files)) record({file, hash});
      for (const family of families) record({family});
      writeFileSync(descriptor, `${mac.digest('hex')}\n`);
    } finally { closeSync(descriptor); }
    renameSync(temporary, destination);
    prune(root);
    report(onEvent, 'write', 'stored', 'verified-result');
    return true;
  } catch (error) { report(onEvent, 'write', 'skipped', reason(error)); return false; }
  finally { if (temporary) { try { rmSync(temporary, {force: true}); } catch {} } }
}

function* records(descriptor) {
  const chunk = Buffer.alloc(64 * 1024);
  let parts = [], length = 0, total = 0;
  for (let count; (count = readSync(descriptor, chunk)) > 0;) {
    total += count;
    if (total > maxEntryBytes) fail('entry-too-large');
    let start = 0;
    for (let index = 0; index < count; index++) {
      if (chunk[index] !== 10) continue;
      const part = chunk.subarray(start, index + 1);
      length += part.length;
      if (length > maxRecordBytes) fail('record-too-large');
      yield Buffer.concat([...parts, part], length);
      parts = []; length = 0; start = index + 1;
    }
    if (start < count) {
      parts.push(Buffer.from(chunk.subarray(start, count)));
      length += count - start;
      if (length > maxRecordBytes) fail('record-too-large');
    }
  }
  if (length) fail('invalid-format');
}

export function readScanResult({directory, identity, onEvent}) {
  let descriptor;
  try {
    const id = identityDigest(identity);
    const {root, key} = context(directory, false);
    descriptor = openPrivate(join(root, `${id}.json`), maxEntryBytes);
    const mac = createHmac('sha256', key);
    let result, authenticated = false, familiesStarted = false;
    for (const line of records(descriptor)) {
      if (authenticated) fail('invalid-format');
      const text = line.toString('utf8').slice(0, -1);
      if (digestPattern.test(text)) {
        if (!timingSafeEqual(mac.digest(), Buffer.from(text, 'hex'))) fail('authentication-failed');
        authenticated = true;
        continue;
      }
      mac.update(line);
      let record;
      try { record = JSON.parse(text); } catch { fail('invalid-format'); }
      if (!result) {
        if (record?.schema !== schema) fail('schema-mismatch');
        if (record.identity !== id) fail('identity-mismatch');
        if (!record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) fail('invalid-format');
        result = {...record.metadata, files: {}, families: []};
      } else if (record && Object.hasOwn(record, 'family')) {
        familiesStarted = true;
        result.families.push(record.family);
      } else {
        if (familiesStarted || !record || !sourcePath(record.file) || Object.hasOwn(result.files, record.file)) fail('invalid-result');
        Object.defineProperty(result.files, record.file, {value: record.hash, enumerable: true, configurable: true, writable: true});
      }
    }
    if (!authenticated) fail('authentication-failed');
    validateResult(result);
    report(onEvent, 'read', 'hit', 'verified-result');
    return result;
  } catch (error) { report(onEvent, 'read', 'miss', reason(error)); return null; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function prune(root) {
  const entries = readdirSync(root).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
    const path = join(root, name);
    const stat = lstatSync(path);
    return {path, stat};
  }).filter(({stat}) => stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o077)).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.path.localeCompare(b.path));
  let bytes = 0;
  for (const [index, {path, stat}] of entries.entries()) {
    bytes += stat.size;
    if (index >= maxEntries || bytes > maxTotalBytes) rmSync(path);
  }
}
