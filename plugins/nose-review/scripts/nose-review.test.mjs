import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildStopOutput,
  selectChangedFamilies,
} from "./nose-review.mjs";

test("selectChangedFamilies keeps changed families and ranks stronger evidence first", () => {
  const families = [
    family("similar-only", "similar", 100, ["src/other.js"]),
    family("near", "similar", 90, ["src/generated.js", "src/base.js"]),
    family("exact", "exact", 20, ["src/generated.js", "src/base.js"]),
    family("copy", "copy-paste", 50, ["src/generated.js", "src/base.js"]),
  ];

  const selected = selectChangedFamilies(families, new Set(["src/generated.js"]), 3);

  assert.deepEqual(
    selected.map((candidate) => candidate.id),
    ["copy", "exact", "near"],
  );
});

test("buildStopOutput requests one review pass only when candidates exist", () => {
  const candidate = family("copy", "copy-paste", 50, ["src/generated.js", "src/base.js"]);

  assert.deepEqual(buildStopOutput([], false, "/repo"), {});
  assert.deepEqual(buildStopOutput([candidate], true, "/repo"), {});
  assert.equal(buildStopOutput([candidate], false, "/repo").decision, "block");
});

test("hook ignores code that was already dirty when the prompt started", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nose-review-baseline-test-"));
  const repoRoot = join(fixtureRoot, "repo");
  const stateRoot = join(fixtureRoot, "state");
  const scriptPath = new URL("./nose-review.mjs", import.meta.url);
  mkdirSync(repoRoot);

  try {
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    writeFileSync(join(repoRoot, "already-dirty.js"), "export const dirty = true;\n");
    const environment = { ...process.env, NOSE_REVIEW_STATE_ROOT: stateRoot };
    runHook(scriptPath, environment, {
      cwd: repoRoot,
      hook_event_name: "UserPromptSubmit",
      session_id: "baseline-test-session",
    });

    const stop = runHook(scriptPath, environment, {
      cwd: repoRoot,
      hook_event_name: "Stop",
      session_id: "baseline-test-session",
      stop_hook_active: false,
    });
    assert.equal(stop.status, 0);
    assert.deepEqual(JSON.parse(stop.stdout), {});
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

for (const managed of [true,false]) test(`hook finds duplication introduced after the prompt baseline (git=${managed})`, () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nose-review-test-"));
  const repoRoot = join(fixtureRoot, "repo");
  const stateRoot = join(fixtureRoot, "state");
  const cacheRoot = join(fixtureRoot, "cache");
  const scriptPath = new URL("./nose-review.mjs", import.meta.url);
  mkdirSync(repoRoot);

  try {
    if (managed) {
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "nose-review@example.invalid"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Nose Review Test"], { cwd: repoRoot });
    writeFileSync(join(repoRoot, "base.js"), duplicatedFunction("summarizeBase"));
    execFileSync("git", ["add", "base.js"], { cwd: repoRoot });
    execFileSync("git", ["commit", "-qm", "seed"], { cwd: repoRoot });
    } else {
      writeFileSync(join(repoRoot, "base.js"), duplicatedFunction("summarizeBase"));
      mkdirSync(join(repoRoot,'node_modules'));
      writeFileSync(join(repoRoot,'node_modules','ignored.js'),duplicatedFunction('ignoredCopy'));
    }
    const hookEnvironment = {
      ...process.env,
      NOSE_REVIEW_CACHE_ROOT: cacheRoot,
      NOSE_REVIEW_STATE_ROOT: stateRoot,
    };
    const prompt = runHook(scriptPath, hookEnvironment, {
      cwd: repoRoot,
      hook_event_name: "UserPromptSubmit",
      session_id: "nose-review-test-session",
    });
    assert.equal(prompt.status, 0);
    assert.equal(prompt.stdout, "");
    assert.equal(
      readdirSync(stateRoot, { recursive: true }).some((entry) => String(entry).endsWith(".json")),
      true,
    );

    writeFileSync(join(repoRoot, "generated.js"), duplicatedFunction("summarizeGenerated"));
    const directReport = JSON.parse(execFileSync("nose", [
      "query", ".", "all", "top=0", "--mode", "syntax,semantic,near",
      "--min-size", "24", "--format", "json",
    ], { cwd: repoRoot, encoding: "utf8" }));
    assert.equal(
      directReport.families.some((candidate) => candidate.locations.some(
        (location) => location.file === "generated.js",
      )),
      true,
      JSON.stringify(directReport.families.map((candidate) => candidate.locations)),
    );

    const stop = runHook(scriptPath, hookEnvironment, {
      cwd: repoRoot,
      hook_event_name: "Stop",
      session_id: "nose-review-test-session",
      stop_hook_active: false,
    });
    assert.equal(stop.status, 0);
    assert.equal(JSON.parse(stop.stdout).decision, "block", `${stop.stdout}${stop.stderr}`);

    // Existing families survive line shifts without another review.
    runHook(scriptPath, hookEnvironment, {cwd:repoRoot,hook_event_name:'UserPromptSubmit',session_id:'shift'});
    writeFileSync(join(repoRoot, 'generated.js'), '\n\n'+duplicatedFunction('summarizeGenerated'));
    const shifted=runHook(scriptPath,hookEnvironment,{cwd:repoRoot,hook_event_name:'Stop',session_id:'shift'});
    assert.deepEqual(JSON.parse(shifted.stdout), {});

    // Both turns become contaminated even if B finishes before A.
    runHook(scriptPath,hookEnvironment,{cwd:repoRoot,hook_event_name:'UserPromptSubmit',session_id:'A'});
    runHook(scriptPath,hookEnvironment,{cwd:repoRoot,hook_event_name:'UserPromptSubmit',session_id:'B'});
    writeFileSync(join(repoRoot,'third.js'),duplicatedFunction('summarizeThird'));
    for (const session_id of ['B','A']) {
      const overlapping=runHook(scriptPath,hookEnvironment,{cwd:repoRoot,hook_event_name:'Stop',session_id});
      const output=JSON.parse(overlapping.stdout);
      assert.match(output.systemMessage,/overlapping/);
      assert.equal(output.decision,undefined);
    }
    // Completed registrations must not poison later, independent work.
    runHook(scriptPath,hookEnvironment,{cwd:repoRoot,hook_event_name:'UserPromptSubmit',session_id:'C'});
    writeFileSync(join(repoRoot,'fourth.js'),duplicatedFunction('summarizeFourth'));
    const independent=runHook(scriptPath,hookEnvironment,{cwd:repoRoot,hook_event_name:'Stop',session_id:'C'});
    assert.equal(JSON.parse(independent.stdout).decision,'block',independent.stdout);
    const manual=spawnSync(process.execPath,[scriptPath.pathname,'scan',repoRoot],{env:hookEnvironment,encoding:'utf8'});
    assert.equal(manual.status,0,manual.stdout);
    assert.equal(JSON.parse(manual.stdout).status,'scanned');
    const report=JSON.parse(readFileSync(join(repoRoot,'.nose-review/report.json'),'utf8'));
    assert.ok(report.candidates.length>0);
    assert.ok(report.candidates.every(family=>family.locations.every(location=>!location.file.includes('node_modules/'))));
    const acceptance=spawnSync(process.execPath,[new URL('./review-policy.mjs',import.meta.url).pathname,'accept',repoRoot,report.candidates[0].fingerprint,'Intentional test fixture'],{encoding:'utf8'});
    assert.equal(acceptance.status,0,acceptance.stderr);
    const policy=JSON.parse(readFileSync(join(repoRoot,'.nose-review/baseline.json'),'utf8'));
    assert.equal(policy.intentional[0].reason,'Intentional test fixture');
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

function family(id, witness, value, files) {
  return {
    id,
    locations: files.map((file, index) => ({ end: index + 10, file, start: index + 1 })),
    removable: value,
    value,
    witness,
  };
}

function duplicatedFunction(name) {
  return `export function ${name}(values) {
  let sum = 0;
  let count = 0;
  let minimum = null;
  let maximum = null;
  for (const value of values) {
    if (value > 0) {
      sum += value;
      count += 1;
      minimum = minimum === null || value < minimum ? value : minimum;
      maximum = maximum === null || value > maximum ? value : maximum;
    }
  }
  const average = count === 0 ? 0 : sum / count;
  return { sum, count, average, minimum, maximum };
}
`;
}

function runHook(scriptPath, environment, input) {
  return spawnSync(process.execPath, [scriptPath.pathname], {
    encoding: "utf8",
    env: environment,
    input: JSON.stringify(input),
  });
}
