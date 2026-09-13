---
name: nose-fix
description: Resolve Nose duplication findings when the user asks to fix or clean up detected duplicates. Refactor appropriate candidates, independently judge intentional duplication, record justified exceptions, and verify behavior and the final scan. Detection-only hook feedback is not a request to run this skill.
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

The helper uses `CODEX_THREAD_ID` to recognize the current hook registration.
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
to make a refactor pass. The skill does not authorize commits or pushes.

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

Run the skill scan again. Check repaired locations against the final families,
including changed family membership; disappearance of an old ID alone is not
proof of removal. Confirm tests pass and no new unreviewed duplication was
introduced by the refactor. Stop when scoped candidates are repaired, intentionally
recorded, or explicitly deferred. Report those outcomes, changed files, test results,
and remaining uncertainty separately. A scan pass is not a behavior-test pass.
