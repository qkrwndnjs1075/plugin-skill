#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanCommitsSecrets } from './commit-secrets.mjs';
import { projectRoot } from './review-runtime.mjs';
import { withReviewLock } from './review-policy.mjs';
import { findingKey, readSecretReviews, secretReviewFilename, validSecretReviews } from './secret-review.mjs';

export function recordNonSecretBatch(cwd, inputPath) {
  const root = projectRoot(cwd);
  const stat = lstatSync(inputPath);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('Decisions must be a bounded regular file');
  const input = JSON.parse(readFileSync(inputPath, 'utf8'));
  if (!validSecretReviews(input) || !input.decisions.length
    || input.decisions.some(entry => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.commit ?? '')))
    throw new Error('Each non-secret decision needs exact source, finding spans, a commit SHA, a kind, and a concrete reason');

  // Never let a prior decision influence the evidence used to record a new one.
  const fresh = scanCommitsSecrets(root, input.decisions.map(entry => entry.commit), {applyReviews: false});
  const candidates = new Map();
  for (const [commit, result] of fresh) {
    if (result.status === 'unavailable' || result.detectorIdentity !== input.detectorIdentity)
      throw new Error('Non-secret evidence unavailable or detector identity changed');
    for (const finding of result.findings) {
      const key = JSON.stringify([commit, finding.file, finding.sourceHash]);
      if (!candidates.has(key)) candidates.set(key, new Set());
      candidates.get(key).add(findingKey(finding));
    }
  }
  for (const entry of input.decisions) {
    const current = candidates.get(JSON.stringify([entry.commit, entry.file, entry.sourceHash]));
    if (!current || entry.findings.some(finding => !current.has(findingKey(finding))))
      throw new Error('Non-secret decision does not match freshly scanned committed source');
  }

  const review = join(root, '.nose-review');
  const directoryStat = lstatSync(review, {throwIfNoEntry: false});
  if (directoryStat && !directoryStat.isDirectory()) throw new Error('Non-secret review directory must be a real directory');
  if (!directoryStat) mkdirSync(review, {mode: 0o700});
  return withReviewLock(join(review, '.non-secret-reviews.lock'), () => {
    const previous = readSecretReviews(root);
    if (previous && previous.detectorIdentity !== input.detectorIdentity)
      throw new Error('Existing non-secret reviews use a different detector; review them before replacing the policy');
    const merged = new Map((previous?.decisions ?? []).map(entry => [JSON.stringify([entry.file, entry.sourceHash]), entry]));
    for (const {commit, ...entry} of input.decisions) merged.set(JSON.stringify([entry.file, entry.sourceHash]), entry);
    const baseline = {schemaVersion: 1, detectorIdentity: input.detectorIdentity, decisions: [...merged.values()]};
    const temporary = join(review, `.non-secret-reviews-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(baseline) + '\n', {flag: 'wx', mode: 0o600});
      renameSync(temporary, join(review, secretReviewFilename));
    } finally { rmSync(temporary, {force: true}); }
    return {status: 'recorded', files: input.decisions.length,
      findings: input.decisions.reduce((total, entry) => total + entry.findings.length, 0)};
  }, 'non-secret review');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5 || process.argv[2] !== 'record-batch')
      throw new Error('Usage: review-secrets.mjs record-batch PROJECT DECISIONS.json');
    process.stdout.write(JSON.stringify(recordNonSecretBatch(process.argv[3], resolve(process.argv[4]))) + '\n');
  } catch {
    process.stderr.write('Non-secret review rejected: invalid, stale, unsafe, or unavailable evidence; no decisions saved.\n');
    process.exitCode = 1;
  }
}
