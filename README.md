# Nose Review

A Codex hook plugin for reviewing newly introduced code duplication with [Nose](https://github.com/corca-ai/nose).

## Automatic use

Start a new Codex session in a Git repository and work normally. The plugin scans
at prompt start and, if code changed, scans again at Stop. It compares duplicate
families by source-span content and requests one **read-only** review of at most
three new or changed families. It does not automatically refactor or accept findings.

Content fingerprints ignore file paths, line offsets, and trailing whitespace.
They preserve internal whitespace and duplicate member count. Existing families
are excluded even when unrelated edits move their line numbers.

## Manual review and intentional duplication

From this plugin's directory, after repository editing has settled:

```sh
node scripts/nose-review.mjs scan /path/to/repository
```

Read `.nose-review/report.json` in that repository, inspect the source, and
record a single intentional family with an explicit reason:

```sh
node scripts/review-policy.mjs accept /path/to/repository FINGERPRINT "Separate ownership requires this copy"
```

Commit `.nose-review/baseline.json` to share decisions. Ignore
`.nose-review/report.json` in the target repository: it is generated review output.
Acceptance checks the current source spans and installed Nose version. A changed
family must be reviewed again. Version/schema mismatches are reported instead of
silently accepting old decisions. There is no blanket acceptance command.

## Concurrent sessions

Overlapping registered sessions in the same worktree are **all** marked
contaminated, including the session that started first. They receive a visible
deferred-review message. A scan also checks code hashes before and after reading
source and discards results if the code changed. Each scan has its own temporary
cache and a 45-second timeout.

These checks do not establish edit ownership or freeze the filesystem.
Editors, older plugin versions, unregistered agents, and edits after a scan are
not fully covered. Use separate worktrees for reliable parallel review. The
follow-up is explicitly read-only to avoid refactoring another worker's code.

An interrupted process can leave an active registration. After confirming that
**all sessions in that worktree have stopped**, clear registrations explicitly:

```sh
node scripts/nose-review.mjs reset-state /path/to/repository --confirm-idle
```

Then run a manual scan or start a new turn. Registrations do not expire silently.

## Requirements and costs

- Nose on PATH (verified with 0.21.0), Git, and Node.js (20 or newer).
- Codex with trusted UserPromptSubmit and Stop plugin hooks.
- Git repositories only; ignored files are excluded from change snapshots.
- Two scans per code-changing turn, one on an unchanged turn. Large repositories
  may hit the timeout; scan failure is reported, never claimed as a pass.
- Source files and registered state are read locally. Generated review output is
  written under the target repository's `.nose-review/` directory.
- This is code review assistance, not a commit/push gate or Markdown duplicate checker.
- Comment changes and removing a member can produce a changed family requiring
  review; language-aware normalization and reduction classification are not implemented.

## Verification

```sh
node --test scripts/*.test.mjs
```

Regression coverage includes real Nose scans, new versus existing duplication,
line shifts, overlapping sessions with the later session finishing first and subsequent recovery,
manual review and acceptance, source/version staleness, and path containment.
The Charness quality design informed content fingerprints and explicit decisions;
this plugin keeps a bounded per-turn review workflow.
