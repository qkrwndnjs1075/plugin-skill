---
name: pr
description: Create or update pull requests around coherent delivery outcomes, preserving responsibility-level commits and adding structured explanations, verification results, and screenshots for UI changes. Use for PR preparation or creation; not for merging, release management, or ongoing review-response work.
---

# PR

Deliver one PR for one coherent requested outcome, with a description and evidence that let a first-time reviewer understand and assess it. Split only when there are distinct delivery outcomes. Determine routine grouping autonomously while honoring the user's requested scope.

## Scope and repository context

Read the repository instructions, Git conventions and PR template. Inspect the current branch, dirty and staged changes, intended remote and base, existing PRs, and the complete branch diff against its base. Identify the actual requested delivery scope; do not sweep in unrelated local work or invent an issue number.

Follow the repository's language, branch naming, issue and Draft policies. Prefer a Draft PR if no policy or user preference specifies otherwise. Loading this skill does not authorize external mutations. A request to create PRs normally includes the necessary local preparation and pushing their feature branches, unless the user or applicable rules reserve those actions separately. Reuse authorization already given; do not repeatedly ask for the same action. A description-only request remains local/read-only as requested.

Finish at PR creation or the requested description update with verification and explanation in place. Merging, releasing, closing issues, changing existing review readiness, or an ongoing review-response loop requires explicit authorization, which may already be present in the same request or earlier instructions. Carry that authorization into the appropriate repository workflow without asking again.

## Choose the PR boundary before creating branches

Start with one PR when the changes serve one coherent user request. Before proposing another PR, name the separate problem it solves and why someone would reasonably accept, defer, or ship it independently. Its diff and verification must also stand on their own. Being technically separable or independently revertible is not sufficient.

Do not derive PR count from file count, directories, document categories, issue numbers, or the number of commits. A single delivery can span several domains and contain many responsibility-level commits. Splitting those commits does not require splitting the PR; keeping one PR does not imply squashing them.

Examples:

- One documentation cleanup covering conventions, architecture, installation guidance, stale path references and supporting work records stays in one PR when all serve the same cleanup outcome. An incidental broken token import can stay with the documentation that identifies its canonical source.
- An API feature's types, validation, service, route, tests and usage documentation belong in one feature PR, with separate responsibility commits as appropriate.
- A checkout bug fix and an unrelated reporting feature warrant separate PRs if either can be delivered without the other. Merely calling both "maintenance" does not make them one outcome.

Decide this grouping from the actual diff before creating worktrees, cherry-picking commits, or publishing branches. If the user specifies one coherent PR or corrects an excessive split, consolidate that delivery and preserve its commit history; do not continue a file-area split.

Within each PR, use [the commit skill](../commit/SKILL.md) for responsibility-level commits when local commits are needed. It owns commit partitioning and execution; this skill owns delivery grouping and PR publication. A PR request's commit authorization is determined by the scope rules above, not by a second approval question.

If work is already committed or mixed in a dirty tree, inspect the hunks and dependencies before constructing the feature branches. Prefer isolated worktrees or new branches from the intended base to preserve the user's work and existing history. Do not rebase, reset, force-push, or replace a published branch merely to get a cleaner partition without authorization for that operation.

Put genuinely reusable prerequisites in a focused foundation PR when independently meaningful. Use dependent/stacked PRs when features need that prerequisite, and document their bases and landing order. Do not duplicate shared changes across sibling PR diffs or arbitrarily separate an inseparable behavior. Check each PR's actual base-to-head diff for unrelated changes and accidental inherited commits. If a dependency cannot be separated safely, explain the concrete constraint instead of manufacturing independent PRs.

## Verify the delivered scope

For each PR, run the repository-required focused checks and exercise the affected user surface when available. Existing evidence is reusable only when its source revision and tested scope cover this PR's final changes. A check of the combined branch does not automatically validate every split branch.

Record commands or interaction steps, observed outcomes, source revision, and limits. Keep local checks, installed-product checks, actual provider calls, CI, and deployed behavior distinct. Do not claim passing CI from local results, or a successful deployment from creating a PR. Inspect available CI status without implying completion while it is pending.

For visual changes, read [visual evidence](references/visual-evidence.md) and capture the actual UI. For complex multi-component behavior, include and render-check a focused diagram of the implemented flow. Do not invent screenshots or diagram validation.

If verification fails, fix task-owned defects when authorized and recheck the affected boundary. Do not bypass required checks, silently bundle unrelated repairs, or claim readiness. If a required check is blocked by missing environment/access, keep the result and limitation visible and follow the repository's rules on whether a Draft may still be created.

## Write for a first-time reviewer

Use the repository's template. Without one, use this structure, scaled to the change:

- **Problem and outcome:** what triggered the work, previous behavior, and what the user can now do. Include a concrete before/after example.
- **Changes and structure:** important responsibilities, contracts and state boundaries; explain unfamiliar terms at first use. For multi-area changes, give an ordered review guide with code links following the user/data flow. Add a diagram when it materially clarifies the flow.
- **Verification:** exact checks or interactions, observed results, and visible failed, pending or unverified items. Put long commands/logs in collapsible details, not essential results or blockers.
- **Impact and limits:** relevant compatibility, authorization, migration, configuration and rollback considerations. Omit irrelevant boilerplate.
- **UI comparison, when applicable:** before/after screenshots with labels, comparable capture conditions and a short explanation of the change.

Link owning issues when present and list dependent PRs when needed. Use a behavior-focused title. Explain the final delivered change, not the conversation, abandoned drafts, or a commit-by-commit diary. Update the title and body when scope changes.

## Publish and confirm

Complete the diff review, description and available evidence before submitting the PR. Use an authenticated connector or repository-supported Git host CLI. For multiline CLI bodies, write the exact Markdown to a temporary file and pass it using the CLI's body-file option, such as `gh pr create --body-file <file>`. Do not inline shell-sensitive text.

Confirm the destination, base and head before pushing or creating. Reuse an existing matching PR instead of making a duplicate; do not overwrite unrelated description content. After a timed-out or ambiguous remote mutation, inspect the remote branch or PR state before retrying. If the result remains unknown, stop that mutation and report uncertainty rather than repeat blindly.

Read back each created/updated PR. Confirm its URL, title, base/head, actual diff, description and attachments are present and usable by the intended reviewer. Report PR links with their feature scopes, verification results and visible limitations. If publishing is blocked, provide the completed local description and exact blocker, explicitly stating that a PR was not created.
