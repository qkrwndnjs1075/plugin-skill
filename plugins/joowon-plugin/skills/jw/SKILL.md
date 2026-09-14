---
name: jw
description: Route an explicitly requested Git delivery task to the Commit or PR workflow. Use only when the user invokes $jw.
---

# Joowon Git Workflow

Choose the workflow from the user's requested outcome.

- For local commit creation, splitting, or repartitioning, read and follow [Commit](../commit/SKILL.md).
- For creating or updating a pull request, read and follow [PR](../pr/SKILL.md). The PR workflow uses Commit when local commits are needed.
- If the user says only “Git 작업” or does not name a delivery outcome, ask one short question: commit only, or PR delivery?

Do not create commits, push branches, create pull requests, merge, or rewrite history unless the user's request authorizes that action.
