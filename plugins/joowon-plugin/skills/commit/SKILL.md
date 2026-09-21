---
name: commit
description: Split requested changes into responsibility-scoped local commits and execute them safely. Use when asked to commit work, split pending changes, or repartition unpublished local commits; not for pushing, PR creation, or general history investigation.
---

# Commit

Create a readable implementation history: identify the feature or domain, then separate its entity, contract, validator, service, controller, or equivalent responsibilities. Decide the partition yourself and execute within the requested scope; do not require approval of a routine split plan.

## Establish scope

Read the repository instructions and Git conventions, current branch, staged and unstaged diffs, relevant untracked contents, and recent commit subjects. Use the repository's message language, format, branch rules, and issue policy. Do not impose one project's issue numbering or release workflow elsewhere.

Account for pre-existing edits by purpose. Requested work may have been dirty before the session; unrelated work stays untouched, including its staged state. Loading this skill is not itself an instruction to commit. An explicit commit request authorizes new local commits, not pushing, PR creation, or rewriting existing history. An explicit request to repartition or fix existing commits authorizes rewriting only the identified unpublished local range; never rewrite published history without separate authorization. Honor narrower requests such as a split preview only.

## Choose the boundaries

1. Separate independent features or domains. Do not mix order changes with independent payment changes in one commit. A feature or issue is usually larger than a commit.
2. Within each feature, separate implementation responsibilities. Backend examples include an entity, request contract, validation rule, service behavior, repository adapter, and controller wiring. In other stacks, use equivalent responsibilities already present in that codebase; do not create new architectural layers merely to match the example.
3. Group every file or hunk needed for one responsibility. File count, diff size, and a shared directory are not boundaries. A controller commit can include its route registration; two independent changes in one file can belong to different commits.
4. Keep changes together only when they complete one responsibility or splitting would leave a concrete build or behavioral invariant broken. Keep generated output and necessary direct regressions with their owner. An import dependency usually determines order, not co-location; a shared test fixture does not make all its consumers inseparable. Before merging proposed groups, record the exact dependency or failing invariant and try prerequisite ordering or smaller source/test hunks. If they cannot resolve it, group only the affected changes. Do not claim an import cycle without tracing one, or treat a cycle as proof that the changed hunks cannot be ordered.
5. Order dependencies from foundation to consumer. Inspect imports, contracts, migrations and their consumers rather than mechanically using a fixed entity → validator → service → controller order. An unused foundation may land before its wiring when its own contract and relevant checks hold. Split independent paths inside shared source files, test modules, and fixtures as needed. Separate test-only or documentation responsibilities when appropriate; do not hide unrelated regressions in the last controller commit. Keep mandatory contract or usage documentation with its owner when repository rules require it.

For multi-responsibility changes, audit the partition before the first commit: record each group's concrete responsibility, paths/hunks, prerequisites, subject, and smallest relevant check in an existing task record or concise progress note. Reconsider broad groups such as “contracts,” “storage,” or “integration” when they contain independently reviewable decisions. Storage versus selection policy, a repository hook versus its consuming service, and separate tool operations may warrant separate commits even within one feature. Neither a target commit count nor one commit per file is a substitute for this audit.

Treat that partition as a hypothesis, not proof. For every proposed group, answer these before staging:

- What single behavior or ownership decision does reverting this commit remove?
- Which changed hunks are necessary for that decision, and which merely share a directory, fixture, channel, or delivery scope?
- Does any included test, fixture, import, route, or composition code require a later group?

If the revert answer contains independent clauses such as “and also,” split the group unless one concrete invariant requires them together. Broad labels such as “core,” “integration,” “channels,” “tests,” or “docs” are warning signs: enumerate the decisions hidden by the label and partition them by responsibility. A large orchestration or adapter commit may still be valid, but only when its exact shared invariant is recorded; common ownership by one service or channel is not enough.

For example, an order-creation feature might yield these subjects, adapted to the repository's style:

- `add order entity and persistence mapping`
- `add order creation validator`
- `implement order creation service`
- `expose order creation controller`

Each describes what that commit introduces. Avoid a broad subject such as `implement order feature` when separable responsibilities exist. Do not combine equivalent layers across independent domains into one `add entities` commit.

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

## Execute and verify

Keep the working partition current as the actual hunks are staged; a sound plan does not certify the resulting commits. Communicate meaningful progress without making routine boundary choices an approval gate. If unrelated staged changes would contaminate a commit, isolate the requested work using a separate index or temporary worktree and preserve the original staging deliberately. Do not clear the user's index, reset, or stash their work as a shortcut.

Stage explicit paths or hunks for the selected responsibility, never `git add .` or `git add -A`. Before each commit, read the complete `git diff --cached`, run `git diff --cached --check`, and confirm scope and sensitive/generated material. Split again if another independent responsibility remains.

Reconcile the actual staged diff against the partition record before running `git commit`:

- list every staged path and shared-file hunk under the responsibility that owns it;
- reject a group whose subject does not explain all staged behavior;
- check imports and fixture dependencies against `HEAD` plus the staged tree, not the final working tree;
- keep a direct regression with its owner when possible; when a concrete prerequisite forces it later, name that prerequisite and create a narrowly titled test commit rather than hiding unrelated delayed tests in a broad integration commit.

A test added by a commit must at least collect or import from that exact committed snapshot. A source commit that changes imports must have its touched entry points imported from that exact snapshot when a cheap import check exists. If the repository provides no executable structural check, inspect the committed tree's imports, generated inputs and prerequisite files directly and record that limitation. These are structural boundary checks, not authorization for a full suite, installed-product QA, or external calls.

Reuse verification already completed for the unchanged requested content. Ordinary commit splitting does not authorize another broad test run, clean checkout, installed-product QA, or model call. Run required commit hooks and inspect staged diffs; rerun the smallest focused check only for unverified new code, an unresolved failure, a concrete prerequisite defect introduced by the split, or an explicit user request. A possible intermediate failure alone is not a reason to start independent validation.

When exact intermediate-tree verification is explicitly requested or needed to resolve a concrete prerequisite defect:

- Test the exact staged tree or commit in a clean detached checkout or exported snapshot containing no later source or test files. Merely creating a temporary worktree does not isolate checks if later uncommitted changes remain in it.
- For editable or path-based environments, confirm the code under test resolves inside that snapshot. Record its tree/commit identity, command, and observed result before marking it verified. Distinguish syntax/package-import checks from behavior tests; neither a final-tree pass nor a working-tree test proves earlier commits work.
- On failure, identify the missing prerequisite or violated invariant. Reorder the needed source/test hunks before broadening the group. Do not absorb whole services or controllers merely to make a fixture import succeed.

For a multi-commit repartition, the structural checks above are always required for every reconstructed commit. If one fails, stop at that commit and repair the order or hunk boundary before creating later commits. Do not continue and rely on a later commit to make the earlier snapshot valid.

Do not bypass hooks or modify unrelated failing code to finish a commit. Preserve remaining work and report a blocker outside scope. Report reused final-content verification separately from any intermediate commits actually tested; do not claim every commit was independently tested when only the final content was verified. Honor a user's instruction to skip repeat validation without reopening it as an approval question.

For an authorized repartition of existing local commits, retain a recovery ref and record the original final tree. Reconstruct the history separately, then verify the intermediate snapshots and exact final-tree equality before moving the original branch. Do not change the final content merely to make the split easier. If a content fix is authorized and necessary, record it separately and do not describe the result as history-only. Preserve unrelated work and remove only known task-owned scratch resources.

Final-tree equality proves content preservation only. It does not prove that the reconstructed commits have correct responsibilities, valid dependency order, collectable tests, or usable intermediate snapshots. Require both equality and the per-commit boundary evidence before moving the original branch.

After each commit, inspect its actual subject and changed paths, compare them with the recorded group, and run its structural boundary check. If the actual commit is broader than planned, rewrite it immediately while the boundary is local; do not compensate by producing more commits afterward. At the end, reconcile requested changes against the resulting commits and remaining staged, unstaged and untracked work. Report hashes with their responsibilities, checks and limitations, and anything left uncommitted. Stop after local commits unless further actions were requested.
