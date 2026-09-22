import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './review-runtime.mjs';
import { scanSecrets } from './secret-scan.mjs';

const batchFiles = 256;
const batchBytes = 32 * 1024 * 1024;

function changedBlobs(root, sha) {
  const parents = git(root, ['rev-list', '--parents', '-n', '1', sha]).trim().split(' ').slice(1);
  const args = ['diff-tree', '--root', '--no-commit-id', '--no-renames', '-r', '--raw', '-z', '--no-abbrev'];
  args.push(...(parents.length ? [parents[0], sha] : [sha]));
  const fields = git(root, args).split('\0');
  const blobs = [];
  for (let index = 0; index < fields.length - 1; index += 2) {
    const header = fields[index].split(' ');
    const file = fields[index + 1];
    if (header.length !== 5 || !file) throw new Error('Invalid changed-blob inventory');
    const [, mode, , object, status] = header;
    if (status === 'D') continue;
    if (!['100644', '100755', '120000'].includes(mode) || !/^[a-f0-9]{40,64}$/.test(object))
      throw new Error('Unsupported changed Git entry');
    blobs.push({object, file});
  }
  return blobs;
}

function blobSizes(root, objects) {
  const result = spawnSync('git', ['cat-file', '--batch-check'], {
    cwd: root, input: objects.join('\n') + '\n', encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('Changed blob sizes unavailable');
  const lines = result.stdout.trimEnd().split('\n');
  if (lines.length !== objects.length) throw new Error('Invalid changed-blob sizes');
  return lines.map((line, index) => {
    const [object, type, size] = line.split(' ');
    if (object !== objects[index] || type !== 'blob' || !/^\d+$/.test(size) || !Number.isSafeInteger(Number(size)))
      throw new Error('Invalid changed-blob size');
    return {object, size: Number(size)};
  });
}

function extractBatch(root, batch, temporary, directory) {
  const output = openSync(join(temporary, 'batch'), 'w+', 0o600);
  try {
    const result = spawnSync('git', ['cat-file', '--batch'], {
      cwd: root, input: batch.map(blob => blob.object).join('\n') + '\n',
      stdio: ['pipe', output, 'pipe'], timeout: 30000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error('Changed blobs could not be read');
    let position = 0;
    const buffer = Buffer.alloc(64 * 1024);
    const read = size => {
      const count = readSync(output, buffer, 0, size, position);
      if (!count) throw new Error('Truncated changed-blob batch');
      position += count;
      return count;
    };
    for (const [index, blob] of batch.entries()) {
      let header = '';
      do {
        read(1);
        if (buffer[0] === 10) break;
        header += String.fromCharCode(buffer[0]);
        if (header.length > 128) throw new Error('Invalid changed-blob header');
      } while (true);
      if (header !== `${blob.object} blob ${blob.size}`) throw new Error('Invalid changed-blob framing');
      const name = `${index}.blob`;
      const descriptor = openSync(join(directory, name), 'wx', 0o600);
      try {
        for (let remaining = blob.size; remaining > 0;) {
          const count = read(Math.min(remaining, buffer.length));
          for (let written = 0; written < count;) written += writeSync(descriptor, buffer, written, count - written);
          remaining -= count;
        }
      } finally { closeSync(descriptor); }
      read(1);
      if (buffer[0] !== 10) throw new Error('Invalid changed-blob terminator');
    }
    if (readSync(output, buffer, 0, 1, position)) throw new Error('Unexpected changed-blob data');
  } finally { closeSync(output); }
}

// Deduplicate only within this invocation; every historical occurrence retains its result.
export function scanCommitsSecrets(root, shas) {
  const results = new Map([...new Set(shas)].map(sha => [sha, {status: 'passed', findings: []}]));
  if (!results.size) return results;
  const occurrences = new Map();
  let temporary;
  try {
    for (const sha of results.keys()) {
      for (const {object, file} of changedBlobs(root, sha)) {
        if (!occurrences.has(object)) occurrences.set(object, []);
        occurrences.get(object).push({sha, file});
      }
    }
    temporary = mkdtempSync(join(tmpdir(), 'nose-commit-secrets-'));
    const objects = [...occurrences.keys()];
    const scanBatch = batch => {
      const directory = join(temporary, 'blobs');
      mkdirSync(directory, {mode: 0o700});
      try {
        if (batch.length) extractBatch(root, batch, temporary, directory);
        const result = scanSecrets(directory);
        if (result.status === 'unavailable') throw new Error('Secret detector unavailable');
        const paths = new Map(batch.map((blob, index) => [`${index}.blob`, blob.object]));
        for (const finding of result.findings) {
          const object = paths.get(finding.file);
          if (!object) throw new Error('Secret finding outside changed blobs');
          for (const {sha, file} of occurrences.get(object)) {
            const target = results.get(sha);
            target.status = 'blocked';
            target.findings.push({...finding, file});
          }
        }
      } finally { rmSync(directory, {recursive: true, force: true}); }
    };
    if (!objects.length) scanBatch([]);
    for (let offset = 0; offset < objects.length; offset += batchFiles) {
      let batch = [], bytes = 0;
      for (const blob of blobSizes(root, objects.slice(offset, offset + batchFiles))) {
        if (batch.length && bytes + blob.size > batchBytes) {
          scanBatch(batch); batch = []; bytes = 0;
        }
        batch.push(blob); bytes += blob.size;
      }
      // A blob larger than the byte budget is scanned alone, never truncated or skipped.
      if (batch.length) scanBatch(batch);
    }
    return results;
  } catch {
    return new Map([...results.keys()].map(sha => [sha, {
      status: 'unavailable', findings: [], reason: 'Changed-blob secret scan failed or was unavailable',
    }]));
  } finally {
    if (temporary) rmSync(temporary, {recursive: true, force: true});
  }
}

export function scanCommitSecrets(root, sha) {
  return scanCommitsSecrets(root, [sha]).get(sha);
}
