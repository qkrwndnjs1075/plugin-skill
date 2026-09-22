---
name: commit
description: Split requested changes into responsibility-scoped local commits and execute them safely. Use when asked to commit work, split pending changes, or repartition unpublished local commits; not for pushing, PR creation, or general history investigation.
---

# Commit

Create small, complete commits, each expressing one logical change with its direct evidence, then name them. A responsibility is a starting boundary, not proof that its entire implementation belongs in one commit. Atomicity means HEAD plus the commit forms a coherent working step without later repairs; it does not require cherry-picking the commit without its prerequisites. Optimize for understanding and verification, not the largest possible commit count. For changes spanning multiple logical changes, follow the gates below: inventory, reviewed partition, staged-diff reconciliation, commit. Decide routine boundaries without asking the user to approve the split.

Treat committing already-verified changes as packaging work. The default path is diff inspection, one bounded partition review when needed, precise staging, required hooks and commit readback. Do not create validation worktrees, install dependencies, start test runtimes or launch a second product review merely because commits are being split.

## Establish scope

Read the repository instructions and Git conventions, current branch, staged and unstaged diffs, relevant untracked contents, and recent commit subjects. Use the repository's message language, format, branch rules, and issue policy. Do not impose one project's issue numbering or release workflow elsewhere.

Account for pre-existing edits by purpose. Requested work may have been dirty before the session; unrelated work stays untouched, including its staged state. Loading this skill is not itself an instruction to commit. An explicit commit request authorizes new local commits, not pushing, PR creation, or rewriting existing history. An explicit request to repartition or fix existing commits authorizes rewriting only the identified unpublished local range; never rewrite published history without separate authorization. Honor narrower requests such as a split preview only.

## 1. Inventory changes before naming commits

Read the actual diff and relevant callers. List each changed behavior or ownership contract, with the paths and hunks implementing it. Include changes within a single file and supporting contract, persistence, service, and caller responsibilities where they exist. Do not start by assigning broad feature titles to file lists.

For example, one scheduler fix may change retained cleanup state, cleanup execution, displayed scheduler status, and who may disable a job. These are candidate boundaries even when they share a file. Conversely, an API change and the caller adaptation needed to keep that API usable can form one responsibility. Inspect additions/deletions, files touched, and distinct questions a reviewer must answer within each candidate. Size is a signal to look for smaller steps, not a quota or grounds for automatic rejection. Prefer a useful part of a feature over its complete delivery bundle; do not manufacture layers to reach a desired commit count.

A small correction implementing one logical change can proceed directly to staging after a concise boundary check. Use the next two gates when the inventory contains multiple logical changes or uncertain boundaries, including during a requested repartition. Several assertions or review questions can support one contract; they do not automatically imply several commits.

## 2. Record the partition and justify boundaries

Before staging, record the partition in an existing task note or concise progress artifact. Keep this working record out of commits unless requested. Each row must contain:

| Group | Logical change and resulting behavior | Paths/hunks and estimated changed lines | Prerequisites | Smallest relevant check | Boundary rationale |
| --- | --- | --- | --- | --- | --- |

Assign every in-scope inventory item to one group; identify unrelated work separately. A whole-file entry is sufficient only when all its changes have that owner. Keep direct regressions, required generated output, and mandatory usage documentation with their owner. Independent documentation, tool operations, and tests of unrelated behaviors must not become a miscellaneous final commit.

Distinguish direct regression tests from broader coverage even when both concern the same feature. Existing-behavior tests, test refactoring, and substantial integration infrastructure can be useful separate steps; keep each step exercised and passing rather than introducing unused scaffolding or a failing test-only commit. A shared fixture or the phrase "required for regression prevention" does not establish that all test scenarios are inseparable.

For example, correcting a runtime contract across two callers can remain one change with its direct regressions and minimal test configuration. Separately proving recovery of persisted state can be another complete change when it adds useful coverage without completing a missing part of that fix. Different feature names, files, fields, or test cases alone do not establish boundaries. Conversely, a CI policy change may warrant its own commit even if only two lines; line count does not decide either direction.

Separate independently revertible responsibilities by default. Order dependencies from foundation to consumer: an import usually establishes order, not a reason to combine. A tested foundation can land before its caller. Keep behavior-changing activation guards with the caller that makes them usable when landing them earlier would break an existing path.

Justify boundaries in both directions. Split when the hunks express distinct, independently useful changes; keep hunks together when they implement and prove one contract, or splitting would leave incomplete behavior or scatter the context needed to understand it. A hypothetical split need not break the build to be a poor boundary. A shared feature, file, fixture, or user symptom alone is insufficient evidence for combining. If dependency breakage is the reason to combine, identify the exact source dependency and first consider prerequisite ordering or smaller hunks. Do not invent scaffolding, new tests, or product changes merely to manufacture additional commits in a history-only repartition. Choose commit subjects after these boundaries hold.

## 3. Review the partition before staging

For a multi-responsibility inventory, use one fresh-context, read-only subagent to review the partition through the available native subagent tool. Provide the user's scope, repository rules, raw diff, relevant caller paths, inventory, proposed groups and dependency evidence. Give access to source; do not provide an expected verdict. The reviewer must not edit, commit, or spawn other reviewers.

Keep this review confined to commit boundaries and specific dependency edges. It must not run tests, install dependencies, create worktrees, perform whole-project QA, or repeat a product/security review. While it runs, prepare messages and selective patches; wait for its verdict before staging. Reuse a partition verdict already covering the same inventory and boundaries.

Ask it to check both directions: identify distinct logical changes hidden in a group, and identify fragments that should be combined into one complete, understandable step. Inspect the largest group, but do not require a split merely because it is largest. Require hunk-level evidence of distinct intent, contract cohesion, or intermediate dependencies; group names, diff size, and "mostly tests" alone do not justify a verdict. Retain a supported boundary when challenged; do not increase the count without new evidence. Once each group is small in scope, complete, and reviewable, stop subdividing.

The result must be `APPROVE`, `REPARTITION`, or `INCONCLUSIVE`, with evidence for the verdict. `APPROVE` names the checked boundaries and dependencies; `REPARTITION` identifies the separable behaviors or broken dependency and proposes a corrected boundary/order. Incorporate corrections and obtain a fresh review of the changed groups before staging; unaffected reviewed groups need not be re-reviewed. An acknowledgment, missing result or unsupported approval is not a pass. Do not commit affected groups while findings remain unresolved.

If the user prohibits subagents or the harness has no delegation tool, perform a separate counterexample pass yourself and label it self-reviewed. This is an explicit fallback, not independent approval; keep the same evidence and stop conditions. Resolve routine findings without another user approval request. A genuine ambiguity in intended behavior or authorization may require clarification.

Retain the reviewed groups and verdict with the partition record. Material changes to behavior, scope, or dependencies invalidate review of the affected groups. Cosmetic message edits do not.

## Write reviewable commit messages

Write for a reviewer who has not read the conversation. Describe only the changes included in this commit. Choose commit boundaries before writing the message; a detailed body does not justify combining independent responsibilities.

- Use a short subject naming the concrete behavior or responsibility.
- For non-trivial changes, explain the problem and resulting behavior in the opening paragraph. Include important rejection conditions, fallback behavior, or invariants when they affect correctness.
- Add concise bullets for implementation locations only when they help the reviewer navigate the change. Explain each location's role; do not repeat a file list already visible in the diff.
- Record relevant verification actually performed. Distinguish tests run on this commit from tests run only on the final combined tree. Never claim later verification for an earlier commit.
- Link related issues and explain their relationship. Avoid shorthand such as "core-only restart" that requires conversation history.
- State intentionally deferred work when its absence could be mistaken for an omission. Do not include an unrelated future-work list.
- Match the repository's message language and conventions, honoring any explicit user preference.
- Scale detail to the change: simple commits may need only a subject. Do not require fixed sections or server/web/docs/test bullets.

For a substantial change, the usual flow is subject, problem and resulting behavior, useful review pointers and verification, then relevant issue context and deferred scope. Omit parts that add no useful information.

## 4. Reconcile the staged diff, then commit

Keep the working partition current as the actual hunks are staged; a sound plan does not certify the resulting commits. Communicate meaningful progress without making routine boundary choices an approval gate. If unrelated staged changes would contaminate a commit, isolate the requested work using a separate index or temporary worktree and preserve the original staging deliberately. Do not clear the user's index, reset, or stash their work as a shortcut.

Stage explicit paths or hunks for one reviewed group or the single-responsibility correction, never `git add .` or `git add -A`. Before each commit, read the complete `git diff --cached`, run `git diff --cached --check`, and check sensitive/generated material. Record the group or simple correction, current HEAD, staged tree from `git write-tree`, and the reconciliation result. A short inline record suffices for a simple correction; no partition table or subagent is needed.

- every staged hunk belongs to this group; no neighboring responsibility was pulled in by staging a whole file;
- all changes necessary for this group's contract are present, and its prerequisites are already in HEAD;
- imports, fixtures and checks refer to HEAD plus this staged tree, not later working-tree changes;
- the subject describes the actual staged behavior without hiding another independently revertible decision;
- the actual changed-line count, touched files, and review questions still match the partition; unexpectedly broad test or setup hunks trigger another boundary check.

A tree hash identifies the reviewed snapshot; it does not prove semantic cohesion. An unmapped hunk, missing prerequisite, or newly discovered responsibility stops this commit. Correct the staging, or return affected groups to partition review if their boundaries changed. Any index change after reconciliation requires reconciliation again. Only commit the reconciled tree, then compare the actual commit's parent and tree with that record; a mismatch stops later commits until resolved within the authorized scope.

Check intermediate dependencies statically by default: inspect the relevant HEAD/index versions, imports, exported symbols, fixtures and generated inputs. A test added in one group must not depend on a symbol introduced only in a later group. Record source-inspected dependencies as such; do not claim executed tests or independently buildable commits from that inspection.

Reuse existing verification when the tested files, relevant dependencies, configuration and test scope still cover the delivered content. New commit IDs or different grouping alone do not invalidate that evidence. An unresolved failure or actual source/configuration change needs its affected check; repository-required hooks remain mandatory.

Execute an intermediate snapshot only when the user or repository explicitly requires it, or a named dependency risk cannot be resolved by source inspection. State the exact uncertainty and smallest check first. Prefer an already-available targeted check or small export over another full checkout and dependency installation. Test discovery, import-only runs and filters matching no cases can still initialize a large runtime; they are not automatically cheap or required.

If an isolated execution is necessary, ensure code and dependencies resolve to that snapshot and record its identity, command, result and limits. On failure, repair the prerequisite order or hunks before broadening a group. Do not proceed past a known broken intermediate contract or rely on a later commit to repair it. Apply the same conditional execution rule to repartitioned history; there is no per-commit execution loop by default.

Do not bypass hooks or modify unrelated failing code to finish a commit. Preserve remaining work and report a blocker outside scope. Report reused final-content verification separately from any intermediate commits actually tested; do not claim every commit was independently tested when only the final content was verified. Honor a user's instruction to skip repeat validation without reopening it as an approval question.

For an authorized repartition of existing local commits, retain a recovery ref and record the original final tree. Reconstruct the history separately, then verify the intermediate snapshots and exact final-tree equality before moving the original branch. Do not change the final content merely to make the split easier. If a content fix is authorized and necessary, record it separately and do not describe the result as history-only. Preserve unrelated work and remove only known task-owned scratch resources.

Final-tree equality proves content preservation only. Require it together with reviewed boundaries and source-inspected dependency order before moving the original branch. Execute intermediate snapshots only under the conditions above, and distinguish those executed checks from static inspection in the report.

At the end, reconcile inventory items against actual commits and remaining staged, unstaged and untracked work. Extra later commits do not repair an earlier mixed boundary. Report hashes with their responsibilities, review method, checks and limitations, and anything left uncommitted. Stop after the authorized local commits; pushing, PR publication and published-history rewriting need their own authorization.

## Boundary references

- [GitHub: Write Better Commits, Build Better Projects](https://github.blog/developer-skills/github/write-better-commits-build-better-projects/): split distinct changes even when short; combine incomplete fragments into stable, atomic commits.
- [Google: Small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html): small self-contained review units with related tests; avoid splitting so finely that implications become difficult to understand. CLs are review units, not necessarily individual Git commits; line-count examples are guidance, not limits.
- [Git: SubmittingPatches](https://git-scm.com/docs/SubmittingPatches): logically separate commits; a long explanation can signal a missing boundary.
- [Linux: Separate your changes](https://cdn.kernel.org/doc/html/latest/process/submitting-patches.html#separate-your-changes): understandable, verifiable patches may depend on earlier patches while preserving working intermediate states.
