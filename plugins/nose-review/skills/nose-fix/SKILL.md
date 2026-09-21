---
name: nose-fix
description: Resolve Nose duplication findings when the user asks to fix duplicates or a user-authorized push fails with NOSE_DUPLICATION_BLOCKED. Refactor appropriate candidates, judge intentional duplication, record justified exceptions, and verify behavior. Unrelated detection-only feedback does not authorize edits.
---

# Nose Fix

Use this workflow when asked to resolve Nose findings. The user delegates both
refactoring and the decision to keep intentional copies. Make those decisions
from source and ownership evidence without asking the user to classify each family.

## Scope and current evidence

Resolve the plugin root from this file: it is two directories above the skill
directory. Set `NOSE_PLUGIN_ROOT` to that absolute path and `NOSE_PROJECT_ROOT`
to the user's project folder. These are task variables, not preconfigured environment
variables. Git is optional. If the session starts at the home directory, use the
project explicitly identified in the conversation; ask for its path only if ambiguous.

Read the project's `.nose-review/report.json` first and retain its candidate
locations/fingerprints as the requested scope. Reports can be stale. Refresh with:

```sh
node "$NOSE_PLUGIN_ROOT/scripts/nose-fix-scan.mjs" "$NOSE_PROJECT_ROOT"
```

For a past failed push, read its timestamped `.nose-review/failures/` record when
the latest report has been replaced, then refresh source evidence as below.
History is evidence of that attempt, not proof that current files still match.
`NOSE_SECRETS_BLOCKED` is not a duplication finding: do not accept it with this
skill or print credential values. Cleaning an earlier outgoing commit requires
explicit history-rewrite approval; already exposed credentials need owner rotation.

Pre-push reports may describe committed snapshots rather than current working
files. Read their per-ref SHAs and warnings; an empty failed report is not proof
of no duplication. A `comparisonBase` means the hook used the existing remote
tip only to remove unchanged families and strict reductions from the candidate
set. It is not a review decision and must not be copied into `baseline.json`.
Refresh before acting. If the user explicitly requests a
full-project cleanup, use the refreshed project-wide candidates even if an older
report exists, processing them in bounded batches.

The helper uses `CODEX_THREAD_ID` to recognize any legacy hook registration.
SessionStart now only installs pre-push; it does not register an editing lock.
The helper's scan stability check does not prove edit ownership. Coordinate
overlapping edits and preserve unrelated work before changing candidate files.
If there is no prior report, select up to three high-value unreviewed families
from the refreshed report. If a report existed, resolve those candidates against
current source; do not expand into unrelated project-wide cleanup. A changed
fingerprint requires reading the source again. Skip families already covered by
valid intentional decisions unless the user asks to reconsider them.

On a concurrent-session or scan error, do not edit or accept findings from stale
evidence. Do not reset session state, override `CODEX_THREAD_ID`, disable hooks,
or create an isolated state directory to evade a refusal.

## Decide and act

Read all candidate members, their callers, relevant tests, and module boundaries.
Similarity alone does not establish shared responsibility.

- **Fix:** the copies implement the same contract and should evolve together.
  Prefer an existing implementation; otherwise extract the smallest useful shared
  implementation. Preserve public APIs, errors, side effects, and dependency direction.
- **Keep intentionally:** separate deployment/package ownership, independently
  evolving domain rules, test fixtures that must stay independent of production,
  generated/vendor sources, or a demonstrated coupling cost outweigh reuse.
  Record a concrete reason naming the relevant boundary or contract. Convenience,
  a failing refactor, or uncertainty alone is not a reason to accept duplication.
- **Defer:** evidence is insufficient or a behavior-preserving change cannot be
  established. Leave the candidate unaccepted and explain the specific missing evidence.

Use focused regression tests where existing coverage does not protect the change.
Run the relevant project checks. Do not alter unrelated dirty work or weaken tests
to make a refactor pass. A standalone skill request does not authorize commits or
pushes; the authorized-push recovery below is the scoped exception.

## Recover an authorized push

When a push the user requested fails with `NOSE_DUPLICATION_BLOCKED`, apply this
workflow to that report without waiting for a separate cleanup request. After
tests and any required final scan, commit only scoped source fixes, preserve unrelated
index and worktree changes, and keep source-bound intentional decisions in the
locally excluded `.nose-review/baseline.json`, then retry the same authorized push.
The gate applies those decisions only when their current family fingerprints and
member hashes match the verified pushed snapshot. Never force-push, bypass hooks,
or blanket-accept to pass the gate.

After the initial rejected push, use at most two fix-and-retry cycles. If evidence
is insufficient, candidate edits overlap another person's uncommitted work,
other pushed refs need separate work, or the gate still rejects, stop and report
the remaining blocker. `NOSE_CHECK_UNAVAILABLE` is a tool/input failure, not a
duplication decision: repair the check or report the blocker without accepting
findings. No new remote, branch, or unrelated commit is authorized by recovery.

## Record intentional decisions and verify

Refresh after edits before recording exceptions, since spans and fingerprints may
have changed. For each confidently intentional current family, execute:

```sh
node "$NOSE_PLUGIN_ROOT/scripts/review-policy.mjs" accept \
  "$NOSE_PROJECT_ROOT" FINGERPRINT "Concrete source-backed reason for retaining these copies"
```

The model chooses and records the reason; no routine confirmation is needed.
Use the validated command, not direct baseline edits or blanket acceptance. If
the command rejects a version/source mismatch, resolve the mismatch first.
The command records member hashes so removing copies alone can be recognized as
a reduction. Old decisions without member hashes still match exactly but cannot
prove reductions; only re-record them after checking their current source.

Run the skill scan again if source changed after the last successful scan.
Recording baseline decisions alone does not require another scan: acceptance
revalidates source and Nose version, and pre-push checks the pushed snapshot.
Check repaired locations against the final families,
including changed family membership; disappearance of an old ID alone is not
proof of removal. Confirm tests pass and no new unreviewed duplication was
introduced by the refactor. Stop when scoped candidates are repaired, intentionally
recorded, or explicitly deferred. Report those outcomes, changed files, test results,
and remaining uncertainty separately. A scan pass is not a behavior-test pass.
