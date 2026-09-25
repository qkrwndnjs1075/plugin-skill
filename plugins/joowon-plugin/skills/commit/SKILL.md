---
name: commit
description: Create small, complete local commits from requested changes. Use when asked to commit work, split pending changes, or repartition unpublished local commits; not for pushing, PR creation, or general history investigation.
---

# Commit

Read the diff, group logical changes, inspect each staged diff, and commit. Keep routine boundary decisions within this flow. This skill does not require a separate reviewer, approval verdicts, re-review, or a per-commit evidence ledger. Follow any additional checks explicitly required by the user or repository.

## Scope and source reads

Inspect repository instructions, branch/upstream, staged and unstaged changes, relevant untracked files, and recent commit subjects. Preserve unrelated edits and their staged state. Loading the skill alone does not authorize Git mutations. Honor preview-only requests.

A commit request authorizes local commits. Repartitioning existing commits requires an explicit request for the identified range; published-history rewriting, pushing, and PR publication require their own authorization. Existing authorization for those actions remains valid.

Read the actual diff and reuse those contents. Read callers or HEAD/index versions only when needed to understand a change or resolve a specific intermediate dependency. Batch independent reads; do not repeatedly dump every file's base and final contents after already understanding the diff. Refresh affected reads when the source changes.

## Choose boundaries

Choose boundaries before subjects or commit counts:

- **Inventory responsibilities first.** When the diff spans multiple behaviors or owners, make a short boundary map before staging: the outcome, its implementation and direct tests/docs, prerequisites, and what reverting that group would remove. Keep it in task notes or progress output; do not create a report just for the map. Account for every changed hunk, not only filenames.
- **Split distinct changes.** Identify a useful result for each group. Different files, fields, tests, or feature names alone do not establish independence; a shared owner or incident alone does not establish cohesion.
- **Keep one contract complete.** Keep its implementation, necessary caller adaptations, direct regression tests, required generated output, and essential usage documentation together. Independent existing-behavior tests, refactoring, or broader recovery coverage may stand alone. Revertability is a clue, not a reason to separate a fix from its test.
- **Order prerequisites first.** An import establishes order, not automatic cohesion. Avoid a snapshot that requires later repairs. If a proposed split loses necessary context or breaks a contract, adjust the boundary or order.
- **Stop at reviewable units.** Before accepting a proposed commit, ask whether a reviewer could accept one of its outcomes and reject another while the accepted outcome still makes sense. If so, split it. A commit message that needs independent storage, UI, runtime, workflow, or deployment clauses is a signal to revisit the boundary. Use size as a signal to examine scope, not a quota. Keep a larger commit only when the apparent parts are one inseparable contract, and name the concrete dependency.

For example, one runtime contract correction across two callers may stay together, while separate persisted-state recovery coverage or a CI execution-policy change may stand alone. Judge the actual hunks rather than copying an example's partition.

Explain a non-obvious boundary briefly in progress output when useful. Do not create an approval checkpoint for routine grouping. If intent or scope is genuinely ambiguous, clarify that specific issue.

## Stage, check, commit

Stage explicit paths or hunks for one logical change, not `git add .` or `git add -A`. Read the complete staged diff, run `git diff --cached --check`, and confirm:

- every hunk belongs to the intended change, with no unrelated or sensitive material;
- necessary imports, fixtures, generated inputs, and callers exist in HEAD plus the index, not only in later working-tree changes;
- the message describes one outcome; if the staged diff reveals another independently useful outcome, unstage and repartition before committing.

Prefer normal path staging or partial staging with `git add -p` / `git apply --cached`. Do not routinely reconstruct every file as per-commit `.txt` and formatted copies. If overlapping edits require an intermediate blob, limit it to the affected path, keep task-owned scratch files out of commits, and remove them after use. Direct index updates are a fallback, not the default for every file. Never clean up another running task's scratch files.

If unrelated staged edits would be included, preserve the user's index and isolate the requested commit, for example with a separate index. Do not reset, clear the index, or stash unrelated work as a shortcut. If the staged contents change after inspection, inspect the affected diff again before committing.

Reuse verification that still covers the same content, dependencies, configuration, and scope. A new commit ID or partition alone does not require another QA cycle. Run repository-required checks and hooks. Never bypass a failed hook or modify unrelated code merely to finish committing.

Check intermediate dependencies from source by default. Run a targeted intermediate check only when explicitly required or when a named uncertainty remains after inspection; use code and dependencies from that snapshot. Do not create validation worktrees, install dependencies, or start test runtimes merely to package verified changes. Test discovery and import-only runs may still be expensive. Report reused final-tree checks separately from any intermediate snapshots actually executed.

Write messages in the repository's language and style. Every commit must have a concrete subject and a non-empty body, including small changes. Start the body with the concrete previous behavior or missing capability and its consequence. Explain the cause, why the chosen change addresses it, and the resulting behavior in connected prose. Name specific mechanisms, APIs or values when they make the reasoning clear. Repeating the subject or listing edited files is not enough; the reader should understand the change without the conversation.

Scale the explanation to the change instead of filling a fixed template. Include relevant tradeoffs and behavior that must remain intact. When reporting verification, explain what the check established and any important limit; a test count alone does not explain the evidence. If an earlier test missed the bug, explain the mismatch between its setup and real behavior. Do not invent causes, alternatives, checks or results, or turn the body into a session transcript.

Commit, then inspect the resulting commit's subject, body, paths and diff summary against the staged change. Inspect unexpected differences before continuing. At the end, report commit hashes and purposes, applicable checks and limits, and remaining work. Continue to a push or PR only when separately authorized.

## When repartitioning existing commits

Preserve a recovery ref and the original final tree for the authorized range. Reconstruct separately without overwriting unrelated work, inspect prerequisite order, and verify exact final-tree equality before moving the original branch. Reassess the whole range; an earlier feature-sized commit is not a boundary to preserve. Do not alter product content or invent scaffolding to make a history-only split easier. Execute intermediate snapshots only under the conditions above.

## Rationale

These are supporting sources, not required reading on every invocation:

- [Moonlight: event-price polling](https://github.com/corca-ai/moonlight/commit/9bb8c9331ed1e3bbe913a02132d356a39603f6f9): explains the redundant work, why existing lifecycle events suffice, and where payment validation remains.
- [Moonlight: public pricing lookup](https://github.com/corca-ai/moonlight/commit/a8d56a2c1212d7cbe2b531911a7b89c6fa984eb8): connects the visible failure to application wiring, the fix, and why the earlier test missed it.
- [GitHub: Write Better Commits, Build Better Projects](https://github.blog/developer-skills/github/write-better-commits-build-better-projects/): small scope and complete commits.
- [Google: Small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html): related tests and understandable review units; CLs are not necessarily individual Git commits.
- [Linux: Separate your changes](https://cdn.kernel.org/doc/html/latest/process/submitting-patches.html#separate-your-changes): distinct logical changes and working intermediate states.
