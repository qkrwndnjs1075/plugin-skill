import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

test("hook finds duplication introduced after the prompt baseline", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nose-review-test-"));
  const repoRoot = join(fixtureRoot, "repo");
  const stateRoot = join(fixtureRoot, "state");
  const cacheRoot = join(fixtureRoot, "cache");
  const scriptPath = new URL("./nose-review.mjs", import.meta.url);
  mkdirSync(repoRoot);

  try {
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "nose-review@example.invalid"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Nose Review Test"], { cwd: repoRoot });
    writeFileSync(join(repoRoot, "base.js"), duplicatedFunction("summarizeBase"));
    execFileSync("git", ["add", "base.js"], { cwd: repoRoot });
    execFileSync("git", ["commit", "-qm", "seed"], { cwd: repoRoot });
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
