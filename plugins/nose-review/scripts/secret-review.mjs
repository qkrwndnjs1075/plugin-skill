import { lstatSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { spawnSync } from 'node:child_process';

const kinds = new Set(['derived-public-data', 'public-identifier', 'synthetic-fixture', 'source-reference']);
const digest = /^[a-f0-9]{64}$/;
const identity = /^gitleaks\/v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\/default-rules-v1$/;
export const secretReviewFilename = 'non-secret-reviews.json';

export function secretDetectorIdentity() {
  const result = spawnSync('gitleaks', ['version'], {encoding: 'utf8', timeout: 10_000, maxBuffer: 1024});
  const value = `gitleaks/${result.stdout?.trim()}/default-rules-v1`;
  if (result.error || result.status !== 0 || !identity.test(value)) throw new Error('Secret detector identity unavailable');
  return value;
}

export function validSecretFinding(finding) {
  const span = finding?.span;
  return typeof finding?.rule === 'string' && /^[a-z0-9-]+$/.test(finding.rule)
    && Number.isSafeInteger(finding.line) && finding.line > 0
    && Number.isSafeInteger(span?.endLine) && span.endLine >= finding.line
    && Number.isSafeInteger(span?.column) && span.column >= 0
    && Number.isSafeInteger(span?.endColumn) && span.endColumn >= 0
    && (span.endLine > finding.line || span.endColumn >= span.column);
}

export function findingKey(finding) {
  return JSON.stringify([finding.rule, finding.line, finding.span.endLine, finding.span.column, finding.span.endColumn]);
}

export function validSecretDecision(decision) {
  return typeof decision?.file === 'string' && decision.file.length > 0
    && !decision.file.includes('\0') && !posix.isAbsolute(decision.file)
    && posix.normalize(decision.file) === decision.file && !decision.file.startsWith('../')
    && decision.file !== '..' && digest.test(decision.sourceHash ?? '')
    && kinds.has(decision.kind) && typeof decision.reason === 'string'
    && decision.reason.trim().length >= 20 && decision.reason.length <= 4000
    && Array.isArray(decision.findings) && decision.findings.length > 0
    && decision.findings.every(validSecretFinding)
    && new Set(decision.findings.map(findingKey)).size === decision.findings.length;
}

export function validSecretReviews(value) {
  if (value?.schemaVersion !== 1 || !identity.test(value.detectorIdentity ?? '')
    || !Array.isArray(value.decisions) || !value.decisions.every(validSecretDecision)) return false;
  return new Set(value.decisions.map(entry => JSON.stringify([entry.file, entry.sourceHash]))).size === value.decisions.length;
}

export function readSecretReviews(root) {
  const directory = join(root, '.nose-review');
  const directoryStat = lstatSync(directory, {throwIfNoEntry: false});
  if (!directoryStat) return null;
  if (!directoryStat.isDirectory()) throw new Error('Non-secret review directory must be a real directory');
  const path = join(directory, secretReviewFilename);
  const stat = lstatSync(path, {throwIfNoEntry: false});
  if (!stat) return null;
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('Non-secret reviews must be a bounded regular file');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!validSecretReviews(value)) throw new Error('Invalid source-bound non-secret reviews');
  return value;
}

export function secretReviewMatcher(reviews, detectorIdentity) {
  const index = new Map();
  if (reviews?.detectorIdentity === detectorIdentity) {
    for (const entry of reviews.decisions) index.set(JSON.stringify([entry.file, entry.sourceHash]), new Set(entry.findings.map(findingKey)));
  }
  return finding => index.get(JSON.stringify([finding.file, finding.sourceHash]))?.has(findingKey(finding)) === true;
}
