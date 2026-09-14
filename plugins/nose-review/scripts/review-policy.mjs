#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA_VERSION = 1;
const FINGERPRINT = /^[a-f0-9]{64}$/;

export function fingerprintFamily(family, repoRoot) {
  return hash(JSON.stringify(memberHashesForFamily(family, repoRoot)));
}

export function memberHashesForFamily(family, repoRoot) {
  if (!Array.isArray(family?.locations) || family.locations.length === 0) {
    throw new Error("Family must contain source locations.");
  }
  const root = realpathSync(repoRoot);
  const members = family.locations.map(({ file, start, end }) => {
    if (typeof file !== "string" || !Number.isInteger(start)
      || !Number.isInteger(end) || start < 1 || end < start) {
      throw new Error("Invalid source span.");
    }
    const path = containedPath(root, file);
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    if (end > lines.length) throw new Error(`Source span exceeds file: ${file}`);
    const content = lines.slice(start - 1, end)
      .map((line) => line.trimEnd()).join("\n");
    return hash(content);
  });
  return members.sort();
}

export function filterReviewed(families, baseline, version, currentFamilies = families) {
  if (!validBaseline(baseline) || baseline.noseVersion !== version) return families;
  const reviewed = new Set([
    ...baseline.accepted,
    ...baseline.intentional.map((entry) => entry.fingerprint),
  ]);
  for (const reduction of reviewedReductions(families, baseline, version, currentFamilies)) {
    reviewed.add(reduction.fingerprint);
  }
  return families.filter((family) => !reviewed.has(family.fingerprint)
    || (family.memberHashes !== undefined && !validMembership(family)));
}

export function reviewedReductions(families, baseline, version, currentFamilies = families) {
  if (!validBaseline(baseline) || baseline.noseVersion !== version) return [];
  const present = new Set(currentFamilies.map((family) => family.fingerprint));
  const exact = new Set([...baseline.accepted, ...baseline.intentional.map((entry) => entry.fingerprint)]);
  const eligible = baseline.intentional.filter((entry) => entry.memberHashes && !present.has(entry.fingerprint));
  return families.flatMap((family) => {
    if (exact.has(family.fingerprint) || !validMembership(family)) return [];
    const reviewed = eligible.find((entry) => strictSubmultiset(family.memberHashes, entry.memberHashes));
    return reviewed ? [{
      fingerprint: family.fingerprint,
      reviewedFingerprint: reviewed.fingerprint,
      previousMembers: reviewed.memberHashes.length,
      currentMembers: family.memberHashes.length,
      removedMembers: reviewed.memberHashes.length - family.memberHashes.length,
    }] : [];
  });
}

export function filterRemoteExisting(families, remoteFamilies) {
  const verifiableRemote = remoteFamilies.filter(validMembership);
  const exact = new Set(verifiableRemote.map((family) => family.fingerprint));
  return families.filter((family) => !validMembership(family)
    || (!exact.has(family.fingerprint)
      && !verifiableRemote.some((remote) => strictSubmultiset(family.memberHashes, remote.memberHashes))));
}

function strictSubmultiset(current, reviewed) {
  if (current.length >= reviewed.length) return false;
  const remaining = new Map();
  for (const member of reviewed) remaining.set(member, (remaining.get(member) ?? 0) + 1);
  for (const member of current) {
    const count = remaining.get(member) ?? 0;
    if (count === 0) return false;
    remaining.set(member, count - 1);
  }
  return true;
}

function validMembership(entry) {
  return Array.isArray(entry.memberHashes) && entry.memberHashes.length > 0
    && entry.memberHashes.every((member) => typeof member === "string" && FINGERPRINT.test(member))
    && hash(JSON.stringify([...entry.memberHashes].sort())) === entry.fingerprint;
}

function containedPath(root, file) {
  const path = resolve(root, file);
  const local = relative(root, path);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error(`Source path is outside repository: ${file}`);
  }
  const actual = realpathSync(path);
  const actualLocal = relative(root, actual);
  if (actualLocal === ".." || actualLocal.startsWith(`..${sep}`) || isAbsolute(actualLocal)) {
    throw new Error(`Source symlink is outside repository: ${file}`);
  }
  return actual;
}

export function validBaseline(baseline) {
  return baseline?.schemaVersion === SCHEMA_VERSION
    && typeof baseline.noseVersion === "string" && baseline.noseVersion.trim().length > 0
    && Array.isArray(baseline.accepted)
    && baseline.accepted.every((entry) => typeof entry === "string" && FINGERPRINT.test(entry))
    && Array.isArray(baseline.intentional)
    && baseline.intentional.every((entry) => entry && typeof entry.fingerprint === "string" && FINGERPRINT.test(entry.fingerprint)
      && typeof entry.reason === "string" && entry.reason.trim().length > 0
      && (entry.memberHashes === undefined || validMembership(entry)));
}

export function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function main(args) {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write("Usage: review-policy.mjs accept <repo> <fingerprint> <reason>\n");
    return;
  }
  const [command, repoRoot, fingerprint, reason] = args;
  if (args.length !== 4 || command !== "accept" || !FINGERPRINT.test(fingerprint)
    || !reason?.trim()) {
    throw new Error("Usage: review-policy.mjs accept <repo> <fingerprint> <reason>");
  }
  const root = realpathSync(repoRoot);
  const reportPath = containedPath(root, ".nose-review/report.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const reviewDirectory = containedPath(root, ".nose-review");
  const baselineFile = join(reviewDirectory, "baseline.json");
  const baselineExists = lstatSync(baselineFile, { throwIfNoEntry: false });
  const baselinePath = baselineExists ? containedPath(root, baselineFile) : baselineFile;
  const baseline = baselineExists ? JSON.parse(readFileSync(baselinePath, "utf8")) : {
    schemaVersion: SCHEMA_VERSION, noseVersion: report.noseVersion, accepted: [], intentional: [],
  };
  if (!validBaseline(baseline) || report?.schemaVersion !== SCHEMA_VERSION
    || report.noseVersion !== baseline.noseVersion || !Array.isArray(report.candidates)) {
    throw new Error("Review baseline and report must have matching supported schema and Nose versions.");
  }
  const installed = spawnSync("nose", ["--version"], { cwd: root, encoding: "utf8", timeout: 10_000 });
  if (installed.status !== 0 || installed.stdout.trim() !== report.noseVersion) {
    throw new Error("Installed Nose version differs from the report or is unavailable; scan again.");
  }
  const candidate = report.candidates.find((entry) => entry.fingerprint === fingerprint);
  const memberHashes = candidate ? memberHashesForFamily(candidate, root) : [];
  if (!candidate || hash(JSON.stringify(memberHashes)) !== fingerprint
    || (candidate.memberHashes !== undefined && !validMembership(candidate))) {
    throw new Error("Fingerprint is absent from the current report or its source has changed; scan again.");
  }
  const updated = {
    ...baseline,
    intentional: [
      ...baseline.intentional.filter((entry) => entry.fingerprint !== fingerprint),
      { fingerprint, reason: reason.trim(), memberHashes },
    ],
  };
  const temporary = join(dirname(baselinePath), `.baseline-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, baselinePath);
  } finally {
    rmSync(temporary, { force: true });
  }
  process.stdout.write(`${JSON.stringify({ fingerprint, reason: reason.trim() })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
