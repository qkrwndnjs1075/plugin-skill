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
