# Nose Review

Code duplication and secret checks at push time, with `$nose-review` project settings and an on-demand `$nose-fix` skill.

## Project settings

```text
$nose-review on
$nose-review off
$nose-review status
```

These commands control this repository's push gate through `hook.nose-review.enabled` in Git's local configuration. OFF preserves reports and review decisions and prevents automatic setup or scans. New sessions and plugin updates leave it OFF. ON uses the existing installer to prepare the gate again. Explicit manual Nose Fix scans remain available while the automatic gate is OFF.

Repository settings are shared by linked worktrees and do not affect other repositories. Existing worktree-specific overrides or an event-wide `hook.pre-push.enabled=false` are preserved; an ON request reports the conflict rather than changing another setting. A valid disabled state is reported as OFF, not as an installation failure.

Status reports ON, OFF, or an error with the project path. It checks registration and tool availability without scanning source, writing review decisions, or installing a hook. ON means the gate is configured and its tools are available, not that the source has passed review. CLI equivalent:

```sh
node scripts/project-settings.mjs /path/to/project status
```

## Automatic installation

Install the plugin, trust its hook, and open a **new Codex session in the Git
project**. The SessionStart hook installs or updates a repository-local
`hook.nose-review` pre-push registration. Its payload lives in the Git common
directory, so existing and future linked worktrees share the same gate even
when `core.hooksPath` is relative. It does not run a Nose scan.

Use Git 2.54 or newer for both installation and pushes. The installer probes
[configured-hook support](https://git-scm.com/docs/git-hook) and reports setup
unavailable on unsupported Git; an older Git executable can ignore the native
registration. An explicitly disabled or overridden gate is reported, not reset.

Codex has no project-scoped post-install callback: merely downloading this plugin
does not discover and edit all repositories on your computer. Registration occurs
when a project is opened, after hook trust. Reopen the project after updating the
plugin so its Git hook payload gets refreshed.

For the currently open project, registration can also be run explicitly:

```sh
node scripts/install-pre-push.mjs /path/to/project
```

There are **no UserPromptSubmit or Stop scan hooks**. Ordinary prompts do not
trigger Nose. Gitless folders are silently skipped by auto-registration; use the
manual workflow below.

## What happens on push

Before duplicate analysis, the hook compares Git tree identities with the remote
comparison commit. If only regular Markdown files differ, every duplicate-analysis
input is unchanged: the report records `duplication.status: unchanged` without
rerunning Nose. Source files, symlinks, scanner configuration, and review baselines
remain part of this comparison. Secret scanning still runs for outgoing changes.

Verified commit archives pass their file inventory into the shared scan owner;
they do not use ordinary-folder discovery limits. Archive creation writes directly
to disk and verification hashes files in chunks. Archives remain bounded at 2 GiB
and 100,000 entries. Actual Nose analyses use the shared scan budget described
below; exceeding it remains a check failure.

Git runs configured hooks before the hook-directory pre-push. Both receive the
original arguments and complete ref input, and either can reject the push.
Nose inspects each pushed local commit in a temporary snapshot, without checking
out branches or changing the index or working tree.

Snapshots use one private, locked path per project, emptied before each verified
extraction and removed afterward. Keeping the pathname stable lets Nose reuse its
workspace cache between local and remote commits. Concurrent snapshot scans wait
up to 10 seconds and then report unavailable instead of sharing mutable files;
locks from exited processes are recovered.

Reviewed fingerprints and intentional decisions in the local, Git-excluded
`.nose-review/baseline.json` remain the durable source of review decisions for
that checkout. The hook applies them to the verified pushed snapshot, so a stale
decision cannot hide changed source. A pushed baseline from an older setup takes
precedence while it remains tracked. When the pushed ref already exists, the hook
first keeps candidates touching changed files, then analyzes the remote tip as a
comparison base only if candidates remain after applying those decisions:
unchanged families and strict member reductions pass, while new families, growth,
and edited membership block. This comparison does not record or imply review, and
it never writes a baseline. Content fingerprints exclude file paths, line offsets
and trailing whitespace.

When no candidates remain, the remote commit is still checked for availability;
the report records `comparisonBase.analysisSkipped: no-candidates`. Otherwise,
verified commit analyses can reuse a complete result from the private project
cache. An authenticated immutable-tree hit can return before extraction; current
review decisions are reapplied each time. Other paths verify source membership
again. Reuse never records approval.

New intentional decisions include verified per-member hashes. When a reviewed
family disappears and the remaining members are a strict sub-multiset of it,
Nose reports a reduction advisory instead of blocking. New growth or edits beyond
the reviewed membership still require review. The old exact reviewed family stays
accepted until its decision is replaced; reduction does not silently rewrite the
baseline. Legacy decisions without member hashes retain exact-match
behavior; re-record a current reviewed family to enable reduction recognition.

Gitleaks checks the full contents of added or modified files in every outgoing
commit, including symlink target bytes and merge changes against the first parent.
Unchanged inherited files are excluded; a changed file is checked in full, not only
its added lines. Deleting a credential in a later commit does not hide its earlier
occurrence. Root commits check all files. An unavailable
remote commit conservatively scans the reachable local history. This can cost
more on first pushes. For a new branch on a known remote, commits already reachable
from that remote's local tracking refs are excluded; when no tracking refs exist,
the reachable history remains the conservative fallback. Checks use Gitleaks built-in rules, without repository or
environment allowlists or inline suppression. Findings contain only rule, file,
line and commit, never the credential value or source excerpt. This detects known
secret patterns, not every possible secret, and does not inspect nested archives.

Within a push, repeated commit results are reused across refs. Unique changed
blobs are read with Git's batch protocol and checked in groups of at most 256
files or 32 MiB; a larger individual blob is checked alone. Each finding is mapped
back to every original commit and path, including copies later deleted. Secret
scan results are not persisted between pushes.

Verified non-secret findings can be reviewed separately from duplication. The
local, Git-excluded `.nose-review/non-secret-reviews.json` binds each decision to
the Gitleaks version and fixed default-rule contract, original path, SHA-256 of
the complete committed file bytes, rule, and exact line/column span. All changed
blobs are still scanned. A changed file, moved finding, new span, or detector
version gets no benefit from an old decision. Commit/tag metadata cannot be
classified through this file-review route. Invalid or unsafe policies fail closed.

Use `node scripts/review-secrets.mjs record-batch PROJECT DECISIONS.json` only
after verifying the finding is derived public data, a public identifier, a
synthetic fixture without live authority, or a source reference. Each input
decision needs `commit`, `file`, `sourceHash`, `kind`, a concrete `reason`, and
explicit `findings` containing `rule`, `line`, and `span` (`endLine`, `column`,
`endColumn`); the envelope has `schemaVersion: 1` and `detectorIdentity` from the
current secret report. The command rescans the immutable commits without applying
previous decisions and validates the entire batch before saving atomically. There
are no path/rule exclusions or accept-all operation. Never classify an actual
credential as non-secret, include its value in a reason, or reuse a decision for
unreviewed source. Repository/environment allowlists remain disabled.

Outgoing commit metadata and the pushed annotated-tag chain are scanned too;
findings use `git-metadata/<object-id>.commit.txt` or `.tag.txt` locations.
For duplication checks, `.gitignore`, `.ignore`, and `nose.ignore.json` are
removed only from verified temporary commit snapshots, so these files cannot
hide a tracked copy. Working-folder scans retain their normal exclusions.

On a new remote ref with no committed baseline, all unreviewed families in the
pushed snapshot block delivery. On an existing ref, only duplication introduced,
grown, or changed since its remote tip blocks when no baseline exists. To
establish durable reviewed exceptions, use `$nose-fix` and commit its justified
decisions. The supported baseline schema also permits a reviewed `accepted`
fingerprint list; the installer never seeds that list automatically.

Results appear in the push output and `.nose-review/report.json`. The report
includes per-ref commit IDs, the remote comparison SHA when used, findings, and
scan warnings. An unavailable or incompatible remote comparison fails closed.
Exit 1 means unreviewed duplication (`NOSE_DUPLICATION_BLOCKED`); exit 2 means
the check could not complete
(`NOSE_CHECK_UNAVAILABLE`), including invalid baselines or missing tools. Both
reject the push. Ref deletion needs no scan. Submodule/archive limitations also
block as unavailable rather than silently claiming coverage.

`NOSE_SECRETS_BLOCKED` is a separate failure: remove credentials from outgoing
commits and arrange owner rotation for already exposed credentials. A new removal
commit alone cannot clean earlier outgoing commits. History rewriting requires
explicit user approval; the plugin never rewrites history or accepts secrets as
intentional duplication. Gitleaks missing or failing blocks as unavailable.
Verified non-secrets use the separate exact-source review command above; this
does not authorize leaving credentials in outgoing history.

Each failed plugin gate saves a timestamp/UUID-named JSON record under
`.nose-review/failures/` (private directory and files). Later scans can replace
`report.json` but never overwrite these records, even after success. Records
contain commit IDs, findings locations and check errors, not raw scanner logs or
source excerpts. Retention is indefinite until manually removed. The installer
adds report/history paths to Git's local `info/exclude`, preserving existing
entries; baseline decisions remain trackable. If storage is unsafe or unwritable,
the gate still blocks and explicitly reports that history could not be saved.
Failures of a pre-existing hook are still owned and reported by that hook.

For a user-authorized agent push, SessionStart instructs the agent to invoke
`$nose-fix` after a duplication rejection, test, commit scoped fixes or justified
intentional decisions, and retry that push, with at most two fix-and-retry cycles
after the initial rejection.
Unresolved findings remain blocking. Check errors require repair, not acceptance.
Do not bypass hooks or blanket-accept findings. A terminal-only push cannot invoke
an agent: ask Codex to resolve its report and retry. Ordinary prompts do not
authorize automatic edits, commits, or pushes.

This is a pushed-tree review, not an attribution of changes to individual agents.
It does not prevent other sessions from editing source; snapshots keep a push
check independent of those edits. Reports can be replaced by another scan.

## Existing hooks and uninstall

Existing hooks and `core.hooksPath` are untouched. Git continues resolving them
for each worktree, including external hook directories and symlinked hooks.
When upgrading an older Nose installation, owned wrappers in the repository's
existing worktrees are retired and their `pre-push.nose-review-original` backups
are restored. Unmanaged hooks are not replaced.

The dispatcher uses a versioned payload copied under the shared Nose directory's
`.nose-review/` folder. It keeps working outside Codex and when a Codex plugin
cache is replaced. Node.js and Nose must remain available.
An identical payload leaves the hook untouched; changed payloads update it
without changing existing project hooks.
Reinstallation restores a missing executable bit. The shell entrypoint embeds
expected payload hashes and checks them before loading the dispatcher; missing,
empty, or changed payload files block with `NOSE_CHECK_UNAVAILABLE`.

Uninstalling the Codex plugin does not remove repository-local Git registration.
To undo it, run `git config --local --remove-section hook.nose-review` in the
repository. The generated hook and payload directory printed at setup may then
be removed after no registration uses them. Existing project hooks remain active.

## Manual work and fixes

At task completion, or in a folder without Git:

```sh
node scripts/nose-review.mjs scan /path/to/project
```

Or ask: “Use `$nose-fix` to resolve the latest duplication report.”
The skill refreshes evidence, refactors appropriate copies, independently records
concrete reasons for intentional copies, and runs relevant tests and a final scan.
The final scan is required after source edits, not after baseline-only decisions;
acceptance and pre-push still revalidate their source evidence.
Uncertain candidates remain unaccepted. Invoking the skill authorizes these
decisions. Authorized agent-push recovery also invokes this workflow; merely
displaying an unrelated report does not authorize source edits.

To review the whole project instead of the latest report, explicitly request a
full-project scan. A manual scan reads current working files, which may differ
from the commit inspected by pre-push. Treat stored commit findings as candidates
and refresh before editing or accepting them.

When the working tree matches `HEAD`, the Nose Fix helper uses the same verified
commit archive as pre-push, including tracked files hidden by ignore rules. Its
result can be reused by the push without another full analysis. Uncommitted edits
or additional working files use the working-folder scan instead. In authorized
push recovery, finish and verify the source fixes, commit them, then refresh once
and record intentional decisions before retrying the push.

Keep `.nose-review/` in the checkout's Git exclude file. Its baseline records
local source-bound review decisions, while reports and failure history are
generated evidence. Acceptance rejects stale source spans or incompatible Nose versions.
Decisions are serialized and the report and source are revalidated after acquiring
the lock. Locks owned by an exited process are recovered. Legacy ownerless locks
are recovered after 30 seconds; an active or unverifiable owner is never evicted.

## Requirements and limits

- Node.js 20+, Nose and Gitleaks on PATH (tested with Nose 0.21.0 and Gitleaks 8.29.1).
  Gitleaks is a prerequisite, not silently installed by SessionStart.
- Git and tar for pre-push commit snapshots. No Git is required for manual folder scans.
- Shared scans use Nose's native Rayon worker selection. Without
  `RAYON_NUM_THREADS`, Nose selects its default, currently the logical CPU count.
  Explicit Rayon settings are passed unchanged; Nose/Rayon owns interpretation,
  including automatic selection and counts above available parallelism.
- Analysis cache persists under the repository's shared runtime state directory, in
  `analysis-cache`; each scan prints its path. Nose owns content/configuration
  invalidation and its default 5 GiB storage budget. Use `nose cache status` or
  `nose cache clear` with `--dir` pointing to the printed directory when
  inspection or reclamation is needed. Cached analysis never records approval.
  Cold scans can take longer with fewer workers; unchanged reruns benefit most.
  Source paths, lines and span hashes are reused only within a scan, whose final source
  snapshot must still match. Manual acceptance always starts a fresh reader.
- Linked worktrees share the cache through their canonical Git common directory.
  Archive scans share a locked extraction path; editing-session registries remain
  worktree-local. Gitless projects retain their project-local cache owner.
- Complete commit and stable Git working-folder results use a separate `scan-results` cache in that state
  directory, limited to 32 entries and 2 GiB (512 MiB per entry, 16 MiB per record).
  Source and family records are serialized incrementally, avoiding a second
  whole-report JSON string. A private-key MAC authenticates the complete entry
  before a loaded result is returned. Invalid, modified or oversized entries
  fall back to analysis. Older cache formats are misses. Identity includes the actual Git tree
  inventory, scanner executable bytes/version, preparation and source-proof semantics,
  effective settings, global ignore configuration/content and the scanner environment digest. Equivalent trees
  can reuse analysis across commits; each commit's secret checks still run.
  Review-policy or progress-log changes do not discard native analysis. On a
  first committed scan, Git blob verification also computes the initial source
  hashes in the same read; the final independent source check remains mandatory.
  On an immutable-tree hit, authenticated source/member evidence from the fully
  verified tree replaces extraction and repeated source reads. Configuration
  probes and current input identity are still checked before and after loading.
  Root TOML configuration and links outside the tracked tree retain the full
  archive path. Internal links resolve component by component before `..`;
  absolute, dangling and cyclic links also retain full verification.
  The native scanner receives only scanner/Rayon, Git/XDG, locale, loader and OS
  path/home/temp environment inputs. Those inputs are all hashed, including
  `NOSE_*` overrides absent from `--show-config`. Agent-session and unrelated
  shell variables reach neither the scanner nor the cache key. Environment values
  are not written to the cache. Custom scanner wrappers cannot rely on unrelated
  caller variables.
  Wrapper plugin/project/cache-location variables reach neither the scanner nor
  its environment digest; the cache owner and directory remain explicit inputs.
  Repository ownership is resolved before scanner children start. Inherited Git
  repository-location variables are removed from the child environment; the
  selected source directory owns discovery. Git-managed scans resolve Git's child
  search path, while detector and Git configuration inputs remain part of the
  identity. Native hooks and direct recovery therefore share unchanged results,
  including in linked worktrees.
  Working-folder identities include tracked and visible untracked file contents,
  file membership, nested/ancestor ignore controls and Git's local exclude file.
  Mutable source and effective inputs are revalidated before a cached result is returned.
  Working-folder and archived-commit results remain distinct: push scans cover
  tracked ignored files too. The Nose Fix helper selects the archive path when
  working files match `HEAD`, enabling review-to-push reuse without merging these
  different cache identities. Review report/baseline/failure JSON does not invalidate
  working-folder results. Configuration files, external ignores or semantic packs
  disable result reuse. Symlinks include their link text and target contents in the
  identity; cyclic, oversized or unsupported linked inputs bypass reuse, as do
  Gitless working scans. The existing Nose-owned
  analysis cache remains available on these paths. Cold full analyses still incur
  the detector's full cost.
- Nose Fix batches source edits before one refresh. Multiple intentional decisions
  can be recorded with `review-policy.mjs accept-batch <repo> <decisions.json>`,
  where the file is an array of `{fingerprint, reason}` entries. Every reason must
  be source-backed. All entries are validated before one atomic baseline write;
  one invalid entry rejects the entire batch. Recording decisions alone needs no rescan.
- Result-cache decisions are logged on stderr as `[nose result-cache]` with the
  operation, outcome and reason: for example `read miss: not-found`,
  `write skipped: missing-source-member`, `write skipped: entry-too-large`,
  `identity skipped: external-config`, or `read hit: verified-result`.
  A loaded entry passes authentication, version and current-input checks before
  the `verified result cache hit` message confirms reuse. Mutable scans additionally
  repeat source-snapshot and membership checks. CommonJS `.cjs`
  and short HTML `.htm` files are included in source snapshots.
- Gitless/manual snapshot scans skip dependency/build folders and symlinks;
  limits are 20,000 visited entries, depth 64, 10,000 source files,
  5 MiB per source file, and 100 MiB total source.
- Nose has a 600-second limit per scan and writes its JSON to a private temporary
  file instead of buffering the whole report in the hook process. Gitleaks keeps a 45-second
  limit per scan. The dispatcher derives its budget from the same scan limit:
  two scans plus 60 seconds per pushed ref (1,260 seconds), multiplied by the ref count.
  Manual recovery and pushed snapshots use the same budget. Scans report source count,
  worker setting, cache path, scanner completion, source-verification phase and family
  count on stderr. Push diagnostics distinguish the local tree, remote comparison
  tree and membership-comparison duration, and stream through the dispatcher as
  they occur. Membership comparison indexes only hashes present in candidates,
  then checks related families with the same multiplicity-preserving rules.
  A failure/timeout blocks and is reported.
  Millisecond phase durations use a monotonic clock: `[nose archive]` reports
  extraction, Git-source verification, cleanup and total time; `[nose scan]`
  reports source snapshot, cache identity/read, native execution, report/source
  verification, result write and total time. The legacy `scanner finished`
  marker measures native execution only. Scan totals include the initial source
  snapshot and result writes; archive totals also include lock wait and cleanup.
  Immutable hits report `immutable result verification` and omit extraction and
  source-snapshot phases.
- An older open Codex session may still have old prompt hooks. Restart it.
  If a legacy registration remains after all old sessions have stopped, use
  `node scripts/nose-review.mjs reset-state /path/to/project --confirm-idle`.
- No per-prompt refactoring or Markdown duplicate review.

## Validation

```sh
node --test scripts/*.test.mjs
```

Coverage includes pushed-commit scans independent of dirty working files,
remote-tip comparison without a baseline, committed reviewed baselines, missing
tools, Git and plain-folder manual workflows,
original hook argument/stdin/exit preservation, repeat installation and updates,
and real local pushes rejected then accepted after committed fixes or intentional
decisions. Automated tests validate the gate, not model judgment quality.
Additional regressions cover outgoing-history secret detection and redaction,
retained failure records, and reviewed membership reduction versus growth.
