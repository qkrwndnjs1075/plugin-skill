# Nose Review

Code duplication checks at push time, with an on-demand `$nose-fix` skill.

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

The dispatcher first runs any executable pre-existing pre-push with its original
arguments and standard input. Its nonzero exit still rejects the push. If it
passes, Nose inspects each pushed local commit in a temporary snapshot, without
checking out branches or changing the index or working tree.

Only reviewed fingerprints and intentional decisions in the **pushed**
`.nose-review/baseline.json` exempt findings. Remote presence alone is not review.
Content fingerprints exclude file paths, line offsets and trailing whitespace.
Uncommitted decisions do not affect a push check.

On every push, all unreviewed families in the pushed snapshot block delivery;
nothing is silently accepted as an initial
baseline. To establish reviewed exceptions, use `$nose-fix` and commit its
justified decisions. The supported baseline schema also permits a reviewed
`accepted` fingerprint list; the installer never seeds that list automatically.

Results appear in the push output and `.nose-review/report.json`. The report
includes per-ref commit IDs, findings, and scan warnings. Exit 1 means unreviewed
duplication (`NOSE_DUPLICATION_BLOCKED`); exit 2 means the check could not complete
(`NOSE_CHECK_UNAVAILABLE`), including invalid baselines or missing tools. Both
reject the push. Ref deletion needs no scan. Submodule/archive limitations also
block as unavailable rather than silently claiming coverage.

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

## Requirements and limits

- Node.js 20+, Nose on PATH (tested with 0.21.0).
- Git and tar for pre-push commit snapshots. No Git is required for manual folder scans.
- Gitless/manual snapshot scans skip dependency/build folders and symlinks;
  limits are 20,000 visited entries, depth 64, 10,000 source files,
  5 MiB per source file, and 100 MiB total source.
- Nose has a 45-second limit per scan; the dispatcher bounds the complete Nose
  invocation to 180 seconds. A failure/timeout blocks and is reported.
- An older open Codex session may still have old prompt hooks. Restart it.
  If a legacy registration remains after all old sessions have stopped, use
  `node scripts/nose-review.mjs reset-state /path/to/project --confirm-idle`.
- No per-prompt refactoring or Markdown duplicate review.

## Validation

```sh
node --test scripts/*.test.mjs
```

Coverage includes pushed-commit scans independent of dirty working files,
committed reviewed baselines, missing tools, Git and plain-folder manual workflows,
original hook argument/stdin/exit preservation, repeat installation and updates,
and real local pushes rejected then accepted after committed fixes or intentional
decisions. Automated tests validate the gate, not model judgment quality.
