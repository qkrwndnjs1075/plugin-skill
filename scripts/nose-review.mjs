#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

const CODE_EXTENSIONS = new Set([
  ".c", ".css", ".cts", ".go", ".h", ".html", ".java", ".js",
  ".jsx", ".mjs", ".mts", ".py", ".pyi", ".rb", ".rs", ".svelte",
  ".swift", ".ts", ".tsx", ".vue",
]);

export function selectChangedFamilies(families, changedPaths, limit = 3) {
  return families
    .filter((family) => family.locations.some((location) => changedPaths.has(normalize(location.file))))
    .sort((left, right) => {
      const evidenceOrder = priority(left.witness) - priority(right.witness);
      return evidenceOrder || numberField(right, "value") - numberField(left, "value");
    })
    .slice(0, limit);
}

export function buildStopOutput(candidates, stopHookActive, repoRoot) {
  if (stopHookActive || candidates.length === 0) return {};
  const lines = candidates.map((candidate) => {
    const locations = candidate.locations
      .slice(0, 4)
      .map((location) => `${location.file}:${location.start}`)
      .join(", ");
    return `- ${candidate.witness} id=${candidate.id}, ~${candidate.removable} removable lines: ${locations}`;
  });
  return {
    decision: "block",
    reason: [
      "Nose found duplication candidates involving files changed in this turn.",
      "Inspect the source and ownership before finishing; similarity alone is not a refactoring decision.",
      ...lines,
      `Open a family with: nose query ${shellQuote(repoRoot)} id=<id> full`,
    ].join("\n"),
  };
}

function main() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (input.hook_event_name === "UserPromptSubmit") {
    captureBaseline(input);
    return;
  }
  if (input.hook_event_name !== "Stop") return;
  if (input.stop_hook_active === true) {
    process.stdout.write("{}\n");
    return;
  }

  const repoRoot = findRepoRoot(input.cwd);
  if (!repoRoot) {
    process.stdout.write("{}\n");
    return;
  }
  const changedPaths = loadChangedPaths(input.session_id, repoRoot);
  if (changedPaths.size === 0) {
    clearBaseline(input.session_id, repoRoot);
    process.stdout.write("{}\n");
    return;
  }

  const result = runNose(repoRoot);
  clearBaseline(input.session_id, repoRoot);
  if (result.error) {
    process.stdout.write(`${JSON.stringify({ systemMessage: result.error })}\n`);
    return;
  }
  const candidates = selectChangedFamilies(result.families, changedPaths);
  process.stdout.write(`${JSON.stringify(buildStopOutput(candidates, false, repoRoot))}\n`);
}

function captureBaseline(input) {
  const repoRoot = findRepoRoot(input.cwd);
  if (!repoRoot) return;
  const sessionDirectory = stateDirectory(input.session_id);
  mkdirSync(sessionDirectory, { recursive: true });
  const baseline = { dirty: dirtyCodeHashes(repoRoot), head: currentHead(repoRoot), repoRoot };
  writeFileSync(baselinePath(input.session_id, repoRoot), JSON.stringify(baseline));
}

function findRepoRoot(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function loadChangedPaths(sessionId, repoRoot) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath(sessionId, repoRoot), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
  if (baseline.repoRoot !== repoRoot) return new Set();

  const currentDirty = dirtyCodeHashes(repoRoot);
  const changed = new Set();
  for (const [path, hash] of Object.entries(currentDirty)) {
    if (baseline.dirty[path] !== hash) changed.add(path);
  }
  const head = currentHead(repoRoot);
  if (baseline.head && head && baseline.head !== head) {
    for (const path of gitPaths(repoRoot, ["diff", "--name-only", "-z", baseline.head, head])) {
      if (isCodePath(path)) changed.add(normalize(path));
    }
  }
  return changed;
}

function dirtyCodeHashes(repoRoot) {
  const paths = new Set([
    ...gitPaths(repoRoot, ["diff", "--name-only", "-z"]),
    ...gitPaths(repoRoot, ["diff", "--cached", "--name-only", "-z"]),
    ...gitPaths(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return Object.fromEntries([...paths]
    .map(normalize)
    .filter(isCodePath)
    .map((path) => [path, fileDigest(join(repoRoot, path))]));
}

function gitPaths(repoRoot, args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.split("\0").filter(Boolean) : [];
}

function currentHead(repoRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function fileDigest(filePath) {
  if (!existsSync(filePath)) return null;
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function clearBaseline(sessionId, repoRoot) {
  rmSync(baselinePath(sessionId, repoRoot), { force: true });
}

function runNose(repoRoot) {
  const cacheRoot = process.env.NOSE_REVIEW_CACHE_ROOT
    ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "nose-review", "analysis");
  const cacheDirectory = join(cacheRoot, digest(repoRoot));
  const result = spawnSync("nose", [
    "query", ".", "all", "top=0", "sort=extractability",
    "--mode", "syntax,semantic,near", "--min-size", "24",
    "--cache-dir", cacheDirectory, "--format", "json",
  ], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error?.code === "ENOENT") {
    return { error: "Nose Review skipped: the nose executable is not available.", families: [] };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim().split("\n").at(-1) || `exit ${result.status}`;
    return { error: `Nose Review could not complete: ${detail}`, families: [] };
  }
  const report = JSON.parse(result.stdout);
  if (!Array.isArray(report.families)) {
    return { error: "Nose Review received an unsupported report format.", families: [] };
  }
  return { error: null, families: report.families };
}

function stateDirectory(sessionId) {
  const stateRoot = process.env.NOSE_REVIEW_STATE_ROOT ?? join(tmpdir(), "nose-review-state");
  return join(stateRoot, digest(typeof sessionId === "string" ? sessionId : "unknown-session"));
}

function baselinePath(sessionId, repoRoot) {
  return join(stateDirectory(sessionId), `${digest(repoRoot)}.json`);
}

function isCodePath(filePath) {
  return CODE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function normalize(filePath) {
  return filePath.split(sep).join("/");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function priority(witness) {
  return witness === "exact" || witness === "copy-paste" ? 0 : 1;
}

function numberField(value, key) {
  return typeof value[key] === "number" ? value[key] : 0;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
