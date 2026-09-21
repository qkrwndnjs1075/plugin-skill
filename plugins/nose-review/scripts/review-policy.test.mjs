import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { filterChangedCandidates, filterRemoteExisting, filterReviewed, fingerprintFamily, hash, memberHashesForFamily, reviewedReductions } from "./review-policy.mjs";
import { scan } from "./review-runtime.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "nose-policy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "repo");
  mkdirSync(root);
  writeFileSync(join(root, "a.js"), "const value = 1;\nreturn value;\n");
  writeFileSync(join(root, "b.js"), "const value = 1;\nreturn value;\n");
  const family = { locations: ["a.js", "b.js"].map((file) => ({ file, start: 1, end: 2 })) };
  return { directory, root, family };
}

test("fingerprint survives file moves, line shifts, member reorder and trailing whitespace", (t) => {
  const { root, family } = fixture(t);
  const expected = fingerprintFamily(family, root);
  writeFileSync(join(root, "moved.js"), "// inserted\nconst value = 1;  \r\nreturn value;\t\r\n");
  const moved = { locations: [family.locations[1], { file: "moved.js", start: 2, end: 3 }] };
  assert.equal(fingerprintFamily(moved, root), expected);
  assert.deepEqual(memberHashesForFamily(moved, root), memberHashesForFamily(family, root));
  assert.equal(hash(JSON.stringify(memberHashesForFamily(moved, root))), expected);
});

test("fingerprint preserves internal whitespace inside strings", (t) => {
  const { root, family } = fixture(t);
  writeFileSync(join(root, "b.js"), "const value = 'a  b';\nreturn value;\n");
  const before = fingerprintFamily(family, root);
  writeFileSync(join(root, "b.js"), "const value = 'a b';\nreturn value;\n");
  assert.notEqual(fingerprintFamily(family, root), before);
});

test("fingerprint changes when source content changes", (t) => {
  const { root, family } = fixture(t);
  const before = fingerprintFamily(family, root);
  writeFileSync(join(root, "b.js"), "const value = 2;\nreturn value;\n");
  assert.notEqual(fingerprintFamily(family, root), before);
});

test("fingerprint preserves the number of identical family members", (t) => {
  const { root, family } = fixture(t);
  assert.notEqual(fingerprintFamily(family, root), fingerprintFamily({ locations: [family.locations[0]] }, root));
});

for (const mode of ["traversal", "absolute", "symlink"]) {
  test(`fingerprint rejects outside-root ${mode}`, (t) => {
    const { directory, root } = fixture(t);
    const outside = join(directory, "private.js");
    writeFileSync(outside, "private\n");
    symlinkSync(outside, join(root, "link.js"));
    const file = { traversal: "../private.js", absolute: outside, symlink: "link.js" }[mode];
    assert.throws(() => fingerprintFamily({ locations: [{ file, start: 1, end: 1 }] }, root), /outside repository/);
  });
}

for (const [start, end] of [[0, 1], [2, 1], [1, 3], [1.5, 2]]) {
  test(`fingerprint rejects invalid span ${start}:${end}`, (t) => {
    const { root } = fixture(t);
    assert.throws(() => fingerprintFamily({ locations: [{ file: "a.js", start, end }] }, root));
  });
}

test("filterReviewed suppresses only recorded content fingerprints", () => {
  const families = ["a", "b", "c"].map((letter) => ({ fingerprint: letter.repeat(64) }));
  const baseline = {
    schemaVersion: 1, noseVersion: "nose 1.0", accepted: [families[0].fingerprint],
    intentional: [{ fingerprint: families[1].fingerprint, reason: "Separate ownership" }],
  };
  assert.deepEqual(filterReviewed(families, baseline, "nose 1.0"), [families[2]]);
  for (const incompatible of [null, { ...baseline, schemaVersion: 2 }, { ...baseline, noseVersion: "nose 2.0" }, { ...baseline, intentional: [{}] }]) {
    assert.deepEqual(filterReviewed(families, incompatible, "nose 1.0"), families);
  }
});

function memberFamily(...members) {
  const memberHashes = members.map(hash).sort();
  return { fingerprint: hash(JSON.stringify(memberHashes)), memberHashes };
}

function memberBaseline(family) {
  return { schemaVersion: 1, noseVersion: "nose fixture", accepted: [],
    intentional: [{ ...family, reason: "Independent ownership" }] };
}

test("a missing reviewed family permits a strict member reduction and reports its counts", () => {
  const original = memberFamily("a", "a", "b");
  const reduced = memberFamily("a", "b");
  const baseline = memberBaseline(original);
  assert.deepEqual(filterReviewed([reduced], baseline, baseline.noseVersion), []);
  assert.deepEqual(reviewedReductions([reduced], baseline, baseline.noseVersion), [{
    fingerprint: reduced.fingerprint, reviewedFingerprint: original.fingerprint,
    previousMembers: 3, currentMembers: 2, removedMembers: 1,
  }]);
});

test("identical members retain multiplicity instead of using set membership", () => {
  const baseline = memberBaseline(memberFamily("a", "a", "a", "b"));
  const reduced = memberFamily("a", "a", "a");
  const extraCopy = memberFamily("a", "b", "b");
  assert.deepEqual(filterReviewed([reduced, extraCopy], baseline, baseline.noseVersion), [extraCopy]);
});

test("a still-present original family cannot exempt an unrelated smaller family", () => {
  const original = memberFamily("a", "a", "b");
  const reduced = memberFamily("a", "b");
  const baseline = memberBaseline(original);
  assert.deepEqual(filterReviewed([original, reduced], baseline, baseline.noseVersion), [reduced]);
  assert.deepEqual(filterReviewed([reduced], baseline, baseline.noseVersion, [original, reduced]), [reduced]);
  assert.deepEqual(reviewedReductions([reduced], baseline, baseline.noseVersion, [original, reduced]), []);
});

test("growth, replacement, and content edits remain findings", () => {
  const baseline = memberBaseline(memberFamily("a", "a", "b"));
  const findings = [memberFamily("a", "a", "a", "b"), memberFamily("a", "b", "b"), memberFamily("a", "changed")];
  assert.deepEqual(filterReviewed(findings, baseline, baseline.noseVersion), findings);
  assert.deepEqual(reviewedReductions(findings, baseline, baseline.noseVersion), []);
});

test("remote comparison permits existing families and reductions but blocks growth and edits", () => {
  const existing = memberFamily("a", "a", "b");
  const reduced = memberFamily("a", "b");
  const grown = memberFamily("a", "a", "a", "b");
  const edited = memberFamily("a", "changed");
  assert.deepEqual(filterRemoteExisting([existing, reduced, grown, edited], [existing]), [grown, edited]);
});

test("push comparison keeps only families that touch a changed path", () => {
  const changed = { locations: [{ file: "src/changed.ts" }, { file: "src/base.ts" }] };
  const unchanged = { locations: [{ file: "src/other.ts" }, { file: "src/base.ts" }] };
  assert.deepEqual(filterChangedCandidates([changed, unchanged], ["src/changed.ts"]), [changed]);
});

test("remote comparison fails closed on unverifiable membership", () => {
  const existing = memberFamily("a", "b");
  assert.deepEqual(filterRemoteExisting([{ ...existing, memberHashes: undefined }], [existing]), [{ ...existing, memberHashes: undefined }]);
  assert.deepEqual(filterRemoteExisting([existing], [{ ...existing, memberHashes: [hash("forged")] }]), [existing]);
});

test("legacy reviews, incompatible versions, and missing policy remain exact-only or unreviewed", () => {
  const original = memberFamily("a", "a", "b");
  const reduced = memberFamily("a", "b");
  const baseline = memberBaseline(original);
  delete baseline.intentional[0].memberHashes;
  assert.deepEqual(filterReviewed([original, reduced], baseline, baseline.noseVersion), [reduced]);
  assert.deepEqual(reviewedReductions([reduced], baseline, baseline.noseVersion), []);
  const accepted = { ...baseline, accepted: [original.fingerprint], intentional: [] };
  assert.deepEqual(filterReviewed([reduced], accepted, accepted.noseVersion), [reduced]);
  for (const policy of [null, { ...memberBaseline(original), schemaVersion: 2 }, { ...memberBaseline(original), noseVersion: "obsolete" }]) {
    assert.deepEqual(filterReviewed([reduced], policy, "nose fixture"), [reduced]);
    assert.deepEqual(reviewedReductions([reduced], policy, "nose fixture"), []);
  }
});

test("invalid reviewed membership fails closed including exact matches", () => {
  const original = memberFamily("a", "a", "b");
  const reduced = memberFamily("a", "b");
  for (const memberHashes of [null, [], ["invalid"], [hash("a"), hash("b")], "invalid"]) {
    const baseline = memberBaseline({ ...original, memberHashes });
    assert.deepEqual(filterReviewed([original, reduced], baseline, baseline.noseVersion), [original, reduced]);
    assert.deepEqual(reviewedReductions([reduced], baseline, baseline.noseVersion), []);
  }
});

test("invalid or mismatched current membership cannot claim a reduction", () => {
  const baseline = memberBaseline(memberFamily("a", "a", "b"));
  const reduced = memberFamily("a", "b");
  for (const memberHashes of [undefined, null, [], ["invalid"], [hash("a")], "invalid"]) {
    const candidate = { ...reduced, memberHashes };
    assert.deepEqual(filterReviewed([candidate], baseline, baseline.noseVersion), [candidate]);
    assert.deepEqual(reviewedReductions([candidate], baseline, baseline.noseVersion), []);
  }
});

test("invalid current membership cannot claim an exact review either", () => {
  const original = memberFamily("a", "a", "b");
  const baseline = memberBaseline(original);
  const forged = { ...original, memberHashes: [hash("a")] };
  assert.deepEqual(filterReviewed([forged], baseline, baseline.noseVersion), [forged]);
});

test("runtime scan emits verified normalized member hashes", (t) => {
  const { directory, root, family } = fixture(t);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "nose"), `#!${process.execPath}\nconsole.log(process.argv.includes('--version') ? 'nose fixture' : ${JSON.stringify(JSON.stringify({ families: [family] }))});\n`, { mode: 0o700 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    const result = scan(root);
    assert.deepEqual(result.families[0].memberHashes, memberHashesForFamily(family, root));
    assert.equal(result.families[0].fingerprint, fingerprintFamily(family, root));
  } finally { process.env.PATH = previous; }
});

function reviewFixture(t) {
  const setup = fixture(t);
  const fingerprint = fingerprintFamily(setup.family, setup.root);
  const version = spawnSync("nose", ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  const baseline = { schemaVersion: 1, noseVersion: version.stdout.trim(), accepted: [], intentional: [] };
  const report = { schemaVersion: 1, noseVersion: baseline.noseVersion, candidates: [{ ...setup.family, fingerprint }] };
  const review = join(setup.root, ".nose-review");
  mkdirSync(review);
  writeFileSync(join(review, "baseline.json"), JSON.stringify(baseline));
  writeFileSync(join(review, "report.json"), JSON.stringify(report));
  return { ...setup, fingerprint, baseline, report, review };
}

function accept(root, fingerprint, reason = "Separate owners") {
  return spawnSync(process.execPath, [new URL("./review-policy.mjs", import.meta.url).pathname, "accept", root, fingerprint, reason], { encoding: "utf8" });
}

function acceptAsync(root, fingerprint, reason, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [new URL("./review-policy.mjs", import.meta.url).pathname, "accept", root, fingerprint, reason], { env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("accept CLI records one current fingerprint and a reason with atomic replacement", (t) => {
  const { root, fingerprint, review, family } = reviewFixture(t);
  const result = accept(root, fingerprint);
  assert.equal(result.status, 0, result.stderr);
  const baseline = JSON.parse(readFileSync(join(review, "baseline.json"), "utf8"));
  assert.deepEqual(baseline.intentional, [{ fingerprint, reason: "Separate owners", memberHashes: memberHashesForFamily(family, root) }]);
  assert.deepEqual(baseline.accepted, []);
  assert.deepEqual(readdirSync(review).sort(), ["baseline.json", "report.json"]);
});

test("accept CLI initializes an absent baseline from the current report", (t) => {
  const { root, fingerprint, review, report, family } = reviewFixture(t);
  rmSync(join(review, "baseline.json"));
  const result = accept(root, fingerprint);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(review, "baseline.json"), "utf8")), {
    schemaVersion: 1, noseVersion: report.noseVersion, accepted: [],
    intentional: [{ fingerprint, reason: "Separate owners", memberHashes: memberHashesForFamily(family, root) }],
  });
});

test("concurrent accept commands preserve both decisions", async (t) => {
  const { root, fingerprint, review, report, baseline } = reviewFixture(t);
  writeFileSync(join(root, "c.js"), "const other = 2;\nreturn other * 2;\n");
  writeFileSync(join(root, "d.js"), "const other = 2;\nreturn other * 2;\n");
  const otherFamily = { locations: ["c.js", "d.js"].map((file) => ({ file, start: 1, end: 2 })) };
  const otherFingerprint = fingerprintFamily(otherFamily, root);
  report.candidates.push({ ...otherFamily, fingerprint: otherFingerprint });
  writeFileSync(join(review, "report.json"), JSON.stringify(report));

  const barrier = join(review, "barrier"), bin = join(review, "bin");
  mkdirSync(barrier); mkdirSync(bin);
  writeFileSync(join(bin, "nose"), `#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path'),d=process.env.NOSE_ACCEPT_BARRIER;fs.writeFileSync(p.join(d,process.ppid+'.ready'),'');const end=Date.now()+5000;while(fs.readdirSync(d).length<2&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);console.log(process.env.NOSE_ACCEPT_VERSION);\n`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NOSE_ACCEPT_BARRIER: barrier, NOSE_ACCEPT_VERSION: baseline.noseVersion };
  const results = await Promise.all([
    acceptAsync(root, fingerprint, "First owner", env),
    acceptAsync(root, otherFingerprint, "Second owner", env),
  ]);

  assert.deepEqual(results.map(({ status }) => status), [0, 0], results.map(({ stderr }) => stderr).join("\n"));
  const updated = JSON.parse(readFileSync(join(review, "baseline.json"), "utf8"));
  assert.deepEqual(updated.intentional.map(({ fingerprint: value }) => value).sort(), [fingerprint, otherFingerprint].sort());
});
for(const owner of ['exited','legacy']) test(`accept recovers ${owner} orphan lock`,t=>{
  const f=reviewFixture(t),lock=join(f.review,'.baseline.lock');mkdirSync(lock);
  if(owner==='exited'){
    const dead=spawnSync(process.execPath,['-e','']);
    writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:dead.pid}));
  }
  utimesSync(lock,new Date(0),new Date(0));
  const run=accept(f.root,f.fingerprint);
  assert.equal(run.status,0,run.stderr);
});
for(const change of ['source','report']) test(`accept revalidates ${change} after lock acquisition`,t=>{
  const f=reviewFixture(t),probe=join(f.directory,'probe.mjs');
  const mutation=change==='source'
    ? `fs.writeFileSync(${JSON.stringify(join(f.root,'b.js'))},'changed();\\n');`
    : `fs.writeFileSync(${JSON.stringify(join(f.review,'report.json'))},${JSON.stringify(JSON.stringify({...f.report,candidates:[]}))});`;
  writeFileSync(probe,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const mkdir=fs.mkdirSync;fs.mkdirSync=function(path,...args){if(String(path).endsWith('/.baseline.lock')){${mutation}}return mkdir(path,...args);};syncBuiltinESMExports();`);
  const before=readFileSync(join(f.review,'baseline.json'),'utf8');
  const run=spawnSync(process.execPath,['--import',probe,new URL('./review-policy.mjs',import.meta.url).pathname,'accept',f.root,f.fingerprint,'Separate owners'],{encoding:'utf8'});
  assert.equal(run.status,1,run.stderr);
  assert.equal(readFileSync(join(f.review,'baseline.json'),'utf8'),before);
});

test("accept CLI rejects matching files with a stale installed Nose version", (t) => {
  const { root, fingerprint, review, baseline, report } = reviewFixture(t);
  baseline.noseVersion = "nose obsolete";
  report.noseVersion = baseline.noseVersion;
  writeFileSync(join(review, "baseline.json"), JSON.stringify(baseline));
  writeFileSync(join(review, "report.json"), JSON.stringify(report));
  const before = readFileSync(join(review, "baseline.json"), "utf8");
  const result = accept(root, fingerprint);
  assert.equal(result.status, 1);
  assert.equal(readFileSync(join(review, "baseline.json"), "utf8"), before);
});

for (const mode of ["absent", "blank-reason", "version", "schema", "changed-source", "blanket", "invalid-membership"]) {
  test(`accept CLI rejects ${mode} without modifying baseline`, (t) => {
    const { root, fingerprint, review, report } = reviewFixture(t);
    if (mode === "version") report.noseVersion = "nose 2.0";
    if (mode === "schema") report.schemaVersion = 2;
    if (mode === "changed-source") writeFileSync(join(root, "b.js"), "changed();\nreturn value;\n");
    if (mode === "invalid-membership") report.candidates[0].memberHashes = [hash("forged")];
    writeFileSync(join(review, "report.json"), JSON.stringify(report));
    const before = readFileSync(join(review, "baseline.json"), "utf8");
    const selected = mode === "absent" ? "f".repeat(64) : mode === "blanket" ? "all" : fingerprint;
    const result = accept(root, selected, mode === "blank-reason" ? " " : "Separate owners");
    assert.equal(result.status, 1);
    assert.equal(readFileSync(join(review, "baseline.json"), "utf8"), before);
  });
}
