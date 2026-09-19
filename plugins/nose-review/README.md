# Nose Review

Code duplication and secret checks at push time, with an on-demand `$nose-fix` skill.

## Automatic installation

Install the plugin, trust its hook, and open a **new Codex session in the Git
project**. The SessionStart hook installs or updates that project's pre-push
dispatcher automatically. It does not run a Nose scan.

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
and 100,000 entries. Actual Nose analyses retain their 45-second limit; this does
not claim that all large source changes can be analyzed within that budget.

The dispatcher first runs any executable pre-existing pre-push with its original
arguments and standard input. Its nonzero exit still rejects the push. If it
passes, Nose inspects each pushed local commit in a temporary snapshot, without
checking out branches or changing the index or working tree.

Reviewed fingerprints and intentional decisions in the **pushed**
`.nose-review/baseline.json` remain the durable source of review decisions. When
the pushed ref already exists, the hook also scans the remote tip as a comparison
base after applying those decisions: unchanged families and strict member
reductions pass, while new families, growth, and edited membership block. This
comparison does not record or imply review, and it never writes a baseline.
Content fingerprints exclude file paths, line offsets and trailing whitespace.
Uncommitted decisions do not affect a push check.

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

Outgoing commit metadata and the pushed annotated-tag chain are scanned too;
findings use `git-metadata/<object-id>.commit.txt` or `.tag.txt` locations.
For duplication checks, `.gitignore`, `.ignore`, and `nose.ignore.json` are
removed only from verified temporary commit snapshots, so these files cannot
hide a tracked copy. Manual working-folder scans retain their normal exclusions.

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

The original hook is retained beside pre-push as `pre-push.nose-review-original`.
Other hooks are untouched. Project-local `core.hooksPath` is honored.
External/shared hook directories and symlinked pre-push files are preserved and
produce a setup notice instead of being overwritten.

The dispatcher uses a versioned payload copied under the hooks directory's
`.nose-review/` folder. It keeps working outside Codex and when a Codex plugin
cache is replaced. Node.js and Nose must remain available.
An identical payload leaves the hook untouched; changed payloads update it
without replacing the saved original hook.
Reinstallation restores a missing executable bit. The shell entrypoint embeds
expected payload hashes and checks them before loading the dispatcher; missing,
empty, or changed payload files block with `NOSE_CHECK_UNAVAILABLE`.

Uninstalling the Codex plugin does not remove repository-local Git hooks.
To undo a registration, first inspect the installed hook path printed at setup.
Restore its sibling `pre-push.nose-review-original` if present; otherwise remove
only the generated pre-push. The payload directory can be retained or removed
after no dispatcher uses it.

## Manual work and fixes

At task completion, or in a folder without Git:

```sh
node scripts/nose-review.mjs scan /path/to/project
```

Or ask: “Use `$nose-fix` to resolve the latest duplication report.”
The skill refreshes evidence, refactors appropriate copies, independently records
concrete reasons for intentional copies, and runs relevant tests and a final scan.
Uncertain candidates remain unaccepted. Invoking the skill authorizes these
decisions. Authorized agent-push recovery also invokes this workflow; merely
displaying an unrelated report does not authorize source edits.

To review the whole project instead of the latest report, explicitly request a
full-project scan. A manual scan reads current working files, which may differ
from the commit inspected by pre-push. Treat stored commit findings as candidates
and refresh before editing or accepting them.

Commit `.nose-review/baseline.json` to share intentional decisions. Add
`.nose-review/report.json` to the target project's ignore file: it is generated
output. Acceptance rejects stale source spans or incompatible Nose versions.
Decisions are serialized and the report and source are revalidated after acquiring
the lock. Locks owned by an exited process are recovered. Legacy ownerless locks
are recovered after 30 seconds; an active or unverifiable owner is never evicted.

## Requirements and limits

- Node.js 20+, Nose and Gitleaks on PATH (tested with Nose 0.21.0 and Gitleaks 8.29.1).
  Gitleaks is a prerequisite, not silently installed by SessionStart.
- Git and tar for pre-push commit snapshots. No Git is required for manual folder scans.
- Gitless/manual snapshot scans skip dependency/build folders and symlinks;
  limits are 20,000 visited entries, depth 64, 10,000 source files,
  5 MiB per source file, and 100 MiB total source.
- Nose and Gitleaks each have a 45-second limit per scan; the dispatcher bounds the complete
  invocation to 240 seconds so an existing-ref push can include both local and remote Nose
  snapshots. A failure/timeout blocks and is reported.
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
