# Nose CPU and repeated-scan latency

## Cause and disposition

- **Fixed:** the wrapper inherited Rayon's logical-CPU default. On this 12-CPU host, an existing Nose process had 12 workers plus command threads. The common scan owner now defaults to two workers (one on a single-CPU host), honors an explicit valid `RAYON_NUM_THREADS`, and rejects automatic/unbounded or malformed values. This is a concurrency policy, not a hard OS CPU quota.
- **Fixed:** every invocation previously created and deleted its analysis cache. The project now owns a reusable cache; temporary report files are still deleted. Nose retains responsibility for cache invalidation, checksums and storage management.
- **Fixed:** reusing only the cache directory failed the real relocated-snapshot experiment: 735/735 misses after moving an unchanged checkout. Nose 0.21.0 keys workspace state by canonical source root. Pre-push now uses a stable private snapshot path protected by the existing owner-aware lock implementation. Each extraction starts empty, verifies Git object content, and cleans up afterward. Local and remote copies cannot overwrite one another concurrently. Symlinked snapshot/state paths are rejected before cleanup.
- **Fixed:** source verification reread/split the same file for each candidate member. A scan-scoped reader reuses file lines and span hashes. A 100-family regression drops source reads from 200 to 2; a new scan reads changed content again. Final source-snapshot comparison and independent acceptance validation remain mandatory.
- **Fixed:** logs now distinguish scanner execution, report loading, and source verification. Workers and the actual cache directory are reported.
- **Fixed:** Nose Fix no longer repeats the final whole-project scan after baseline-only decisions. Source changes still require refresh; acceptance and pre-push still revalidate source evidence.
- **Not changed:** detection channels, min-size, candidate scope, secrets scanning, approval policy and the 600-second scanner timeout. No threshold or baseline bypass makes the scan appear faster.
- **Not changed:** cross-project scheduling. Evidence showed one costly scan followed by its comparison scan, not a machine-wide concurrent scan storm. Worker budgets apply per process; the snapshot lock serializes one project's pushed snapshots.
- **Follow-up:** cold large-corpus algorithm cost and full-report memory remain Nose limitations. Reducing workers can increase first-run wall time. Changed-corpus global comparisons can still recompute despite cache reuse; do not promise every edited push is faster.

## Reproducible comparison

Host: Node 24.18.1, installed Nose 0.21.0, 12 logical CPUs. Inputs: pinned Chorus `737e1b7e1e3a4e001795e7f7b3e354ae8e2ad4e7`, `src/auto-reply/reply`, 735 files. The temporary harness extracted with `git archive`, used `/usr/bin/time -lp`, sampled process CPU at 250ms intervals, and compared serialized findings and normalized member fingerprints. The old wrapper was loaded directly from plugin-skill HEAD, not reimplemented. All fixture directories were isolated and removed afterward.

Representative same-root paired run:

| Path | Wall seconds | CPU seconds | Findings |
| --- | ---: | ---: | ---: |
| Original wrapper, cold | 1.56 | 6.15 | 1,338 |
| Updated wrapper, cold | 2.51 | 4.19 | 1,338 |
| Updated wrapper, unchanged repeat | 0.72 | 0.98 | 1,338 |

All three findings digests matched: `db346746193cbbe5480669623a2d87bcc6f414e7c1bc7822b6f84ace0ee16c0b`. Another run was 2.92 / 4.01 / 1.08 seconds respectively; this is a small live sample, not a p95 or general speed guarantee. Direct scanner peak samples in the paired run were 660% without a worker budget and 193% with two workers. Short sampling intervals do not establish a strict peak bound.

Mutation check: add two source files containing a new duplicate family. Warm updated analysis reported 1,339 families, matching a fresh old-wrapper analysis exactly (`9381852b229f4723e1dcc432b8cfc05a4a25caa9e7c22ba92c6c216393f615e3`). This also exposed the tradeoff: changed warm analysis took 4.22 seconds versus 2.01 seconds fresh/unbounded. Do not interpret unchanged-cache acceleration as proof of faster changed-input analysis.

## Verification boundaries

The integration suite covers real local pushes, unchanged-input skips, secrets, stale sources, baseline acceptance, large archives, lock recovery and snapshot cleanup. New regressions cover worker environment, cache ownership, stable local/remote paths, no leftover files between commits, rejected symlinks and one-read-per-file verification.

The full user-case QA used an isolated local shared clone and invoked the pre-push entrypoint directly for `88b4ca276b3e40aa121f80d797915f4d03f40c5d` against `3e990cca408e69fad9b7a3b1a8dc8f64b3f2d4c8` (the two requested commits). It did not push, create a PR, or alter the user's working files.

- 35,336 source files; local and remote each produced 49,689 families.
- Local scanner 172s, full scan including verification 183s. Remote scanner 167s, full scan 183s.
- Full gate: **424.59s wall**, 610.52s user CPU + 77.86s system CPU. Process samples during analysis stayed around 180–200% CPU. This is not a universal CPU ceiling.
- Exit **1**, `NOSE_DUPLICATION_BLOCKED`, one unreviewed candidate, no scan warnings. The gate still blocks rather than substituting a performance success for a review decision.
- `/usr/bin/time -l`: maximum resident set size 5,738,741,760 bytes, peak memory footprint 2,317,510,184 bytes, zero swaps. These are different OS metrics, not interchangeable memory claims. Large-report memory remains a follow-up.
- The user's earlier log showed more than 11 minutes elapsed. The 7m05s isolated result is a direct measured duration, not a controlled same-host-state percentage speedup. Remote comparison remained expensive even with shared cache; the changed-corpus cost is not solved by caching alone.

Final regressions: **91/91 passed**, `node --test --test-concurrency=1 --test-reporter=tap plugins/nose-review/scripts/*.test.mjs`; syntax, whitespace and skill validation passed. No independent reviewer was run. The small-corpus original comparator was plugin-skill HEAD `a4d54219fd0384b63015dc6c89f4de83a40c3106`.

Local rollout: updated the five inspected source-identical files in installed Nose Review 0.6.1 (three runtime scripts, README and Nose Fix skill), retaining recoverable local backups. Updated the named Chorus worktree hook via the existing installer; payload `c69ad7f476c49972d074` matches source, reinstall returns `current`, and a no-ref entrypoint smoke check exits 0 without a push. Other already-installed project hook copies update when their installer runs. At verification time the source changes were not yet committed/pushed. Skill Maintenance dirty work was preserved byte-for-byte.

Source contracts checked: [Nose thread initialization](https://github.com/corca-ai/nose/blob/v0.21.0/crates/nose-cli/src/main.rs), [Nose cache identity](https://github.com/corca-ai/nose/blob/v0.21.0/crates/nose-cli/src/cache/source.rs), [Rayon worker selection](https://docs.rs/rayon/latest/rayon/struct.ThreadPoolBuilder.html#method.num_threads). Local cache-command flags were checked with `nose cache status --help` and `nose cache clear --help`.

Review method: direct source/runtime inspection, no subagents. The mandela check excludes claims of independent detector accuracy and extrapolation from the small benchmark to the full repository. The consistency audit found all scanner entrypoints converge on `review-runtime.scan`; no second resource-policy owner was introduced.

## Follow-up: verified result reuse and bounded secret batches (2026-09-22)

Code revision: `13688bf33bd0c30eea5b913e18521ce00dba1962`.

- Changed-file filtering now precedes remote-family comparison. An empty candidate
  set skips the remote analysis after remote-object validation; local policy and
  secret checks still run.
- Complete commit results use bounded, authenticated private storage. The cache
  key binds the actual Git tree inventory, executable/version, effective settings,
  global ignores, environment digest and wrapper source. Archive bytes, source
  snapshots and family membership are reverified on a hit. External configuration
  disables result reuse. Bad entries miss; no failed scan is cached.
- Secret checks deduplicate objects only within an invocation and batch Git reads
  and Gitleaks calls at 256 files / 32 MiB, with oversized blobs checked alone.
  Every commit/path occurrence is retained. Per-push commit results can be shared
  across refs. No persistent secret cache was added.

### Observed comparison

The isolated fixture uses the same pinned Chorus 735-file subtree described above,
then adds two duplicate functions in a new commit. Both wrappers compare the same
local/remote commits with real Nose and Gitleaks. The old wrapper is exported from
`c23a59b`. Node 24.18.1 and Nose 0.21.0; two workers on both paths.

| Scenario | Wall seconds | Nose analyses | Result |
| --- | ---: | ---: | --- |
| Old wrapper | 6.917 | 2 | blocked, one candidate |
| Updated, cold | 6.671 | 2 | identical candidate |
| Updated, repeated commit | 1.973 | 0 | identical candidate, two verified result hits |
| Baseline-only decision | 1.318 | 0 | passed; remote analysis unnecessary |
| Tampered cache | 6.379 | 2 | rejected cache, original candidate still blocks |
| Added third copy, old | 6.397 | 2 | blocks grown family |
| Added third copy, updated | 4.010 | 1 | identical grown family, remote result reused |

Original candidate digest: `7c0fd21dad75646408e725f435d431ce09cfe57e266c1cc18876a10936c8c8d4`.
Grown candidate digest: `63e07072effc147995f6d5eea9e8bc57f58aeaa1dae0bffb02325aea96e352f2`.
All rows retained secret checks. These are representative single-run timings,
not a p95, full-repository benchmark or promise of faster cold detection.

### Verification and review

- PASS, manual CLI QA, code SHA above: old/new matching-output comparison,
  repeated results, baseline-only policy refresh, tampered cache, and changed
  source. Artifact: `/private/tmp/nose-optimization-qa-V2hcdt/results.json`, with
  individual sanitized logs in that directory.
- PASS, main-session self-review, code SHA above: traced cache authority and
  invalidation, source race checks, first-parent history and symlink secret
  coverage, installer dependency closure, retained remote-object validation,
  original-hook chaining and unrelated dirty work preservation.
- Full suite passed 114/114; a subsequently added multi-ref regression passed
  1/1. Artifacts: `/tmp/nose-optimization-final-tests.tap` and
  `/tmp/nose-multiref-tests.tap`. Exact staged cache-integration snapshot also
  passed the two directly affected pre-push scenarios.
- The first full run exposed an installer-test payload list missing the new
  module. The fixture was repaired; the final full suite includes all 11 passing
  installer tests. No assertions were removed or weakened.
- Editor LSP could not initialize because this repository has no TypeScript
  installation. Node syntax checks and executable tests provided verification.

Independent workers implemented cache storage and secret batching; the parent
integrated them and performed real CLI QA and self-review. No independent gate
reviewer was used. Upstream Nose discovery and effective-config contracts were
checked at [v0.21.0 discovery](https://github.com/corca-ai/nose/blob/v0.21.0/crates/nose-frontend/src/discover.rs)
and [configuration](https://github.com/corca-ai/nose/blob/v0.21.0/crates/nose-cli/src/config.rs).

Push-gate recovery removed the cache's duplicate production SHA-256 helper in
favor of `review-policy.hash`. Cache tests (18) and real pre-push reuse/config
invalidation scenarios (2) passed again. Refreshed source-bound decisions retain
four test-only families: independent digest oracle, separate failure assertions,
and suite-owned temporary-directory lifecycles. Decisions remain in ignored local
state; unrelated Skill Maintenance findings were outside this recovery scope.

## Large-result cache repair (2026-09-22)

The complete-result cache had two independent blockers in the large Chorus case:

- The wrapper snapshot omitted `.cjs` (and `.htm`), although Nose 0.21.0 supports
  them. The retained report contains 18 locations in a CommonJS fixture file.
  Cache validation rejected the whole result because that source was missing from
  its snapshot. A two-file regression reproduced two scanner calls before the
  fix and one call followed by verified reuse after it.
- The retained 49,716-family report occupies 285.99 MiB as formatted JSON. The
  previous 128 MiB envelope cap was inadequate even after source coverage was
  fixed. Serializing a whole JSON payload inside another JSON string also added
  avoidable memory overhead.

The new authenticated record format writes source entries and families
incrementally. Bounds are 512 MiB per entry, 16 MiB per record, 2 GiB total and
32 entries. Authentication, schema, membership, source containment and privacy
checks remain mandatory. Failed or incompatible entries are misses with explicit
safe reason codes; final source verification still precedes scan-result reuse.

An isolated replay of the retained real report verified all member fingerprints
against 35,365 current source files, reproduced the old storage rejection, then
stored and read all 49,716 families without losing any metadata. Cache size was
204.63 MiB; storage took 1.076s and readback 1.325s. The largest family record was
513,146 bytes. These timings measure storage/readback only, not a whole push gate.
Source checking and comparison brought the full QA script to 20.31s; it did not
launch a new whole-repository Nose scan or seed live cache state from old reports.

The real pre-push regression adds a CommonJS duplicate, compares it with its
remote base, then repeats the check. Both local and remote verified results are
reused (zero Nose analyses) with identical blocked candidates. A new or invalidated
commit still needs its first complete analysis before a result can be reused.

Diagnostics now distinguish identity ineligibility, missing entries, schema or
authentication failures, missing source members, size bounds, I/O failures and
source mismatches. Messages contain reason codes, not source text or environment
values. Upstream engine incremental-admission limits were investigated separately;
this repair changes only the wrapper's complete-result cache.

Final verification: 125/125 Nose wrapper tests passed, including tampering,
missing-source diagnostics, >128 MiB round trip, entry/total retention bounds and
real pre-push local/remote reuse. Installed-source equality holds for all six
changed plugin files; the installed CommonJS pre-push reuse scenario passed.
Existing managed hooks in plugin-skill, Chorus, penote and the metrics-management
worktree passed bootstrap smoke checks. Local installed backup is
`/Users/park/.codex/backups/nose-large-cache-20260922.tbpez4`.

## Equivalent-input reuse and indexed comparisons (2026-09-22)

- Cache identity now binds the verified Git inventory rather than commit metadata.
  The native scanner receives a controlled environment covering detector, Rayon,
  Git/XDG, locale, loader and OS path/home/temp inputs. The exact child environment
  is hashed. Session variables cannot affect either scanner execution or reuse;
  detector overrides absent from `--show-config` remain inputs. Source, executable,
  effective configuration, global-ignore and membership checks remain intact.
- Both intentional reductions and remote comparisons index only hashes present
  in candidates, search the smallest matching list, and retain the original
  multiset check. Growth, changed members and unverifiable evidence remain blocked;
  baseline ordering still selects the same first matching reviewed family.
- The dispatcher previously buffered diagnostics until completion. It now streams
  them with backpressure and retains only bounded status-marker state, including
  split markers. Logs distinguish local analysis, remote analysis and comparison.

The parent ran real Nose/Gitleaks against the pinned 735-file Chorus subtree plus
two duplicate fixture files. Comparator: plugin-skill `758df22`. Artifacts:
`/private/tmp/nose-perf-qa-cVTnbE/results.json` and per-scenario logs.

| Scenario | Previous seconds | Updated seconds | Updated analyses |
| --- | ---: | ---: | ---: |
| Cold local and remote | 9.606 | 8.558 | 2 |
| Equivalent tree, new commit and session | 9.424 | 2.502 | 0 |
| Third copy added | 7.441 | 6.194 | 1 |

All paired candidate digests match; all secret checks pass. The grown family has
a different fingerprint and still blocks. Timings are single observations, not
thresholds or full-Chorus latency claims.

The independent policy measurement used frozen old code and identical inputs at
`/private/tmp/nose-policy-measure-6uhdhm94`. All five output digests match. A synthetic
1,000-candidate / 50,000-family workload fell from 4.785s to 0.174s for remote
comparison and 4.567s to 0.182s for reviewed reductions. Combined-process maximum
RSS was 280.5MB before and 272.8MB after limiting the index to candidate hashes.
The retained real 1,338-family corpus showed no material small-input speedup.
No full-repository Chorus benchmark was run.

Verification: 137/137 tests passed across the entire Nose suite plus package
layout, split into disjoint 72- and 65-test invocations. Logs:
`/tmp/nose-perf-core-tests.tap` and `/tmp/nose-perf-remaining-tests.tap`.
Node syntax and whitespace checks passed. Editor LSP remained unavailable because
the JavaScript workspace has no TypeScript installation. Main-session review
checked source/config identity, index ordering and multiplicity, error/timeout
propagation, installer closure and preservation of unrelated dirty work.
