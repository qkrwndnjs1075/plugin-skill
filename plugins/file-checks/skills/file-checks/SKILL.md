---
name: file-checks
description: Turn this Git project's File Checks commit gate on or off, show status, or select whitespace and configuration syntax checks. Use for project settings rather than general code review.
---

# File Checks project settings

Run the package command from this skill's location:

```sh
node ../../scripts/project-settings.mjs PROJECT on
node ../../scripts/project-settings.mjs PROJECT off
node ../../scripts/project-settings.mjs PROJECT status
node ../../scripts/project-settings.mjs PROJECT whitespace on
node ../../scripts/project-settings.mjs PROJECT whitespace off
node ../../scripts/project-settings.mjs PROJECT syntax on
node ../../scripts/project-settings.mjs PROJECT syntax off
```

Resolve the script relative to this skill directory and replace `PROJECT` with the user's current project path. `$file-checks` followed by an action maps to these arguments. With no action, show status.

`whitespace` includes trailing whitespace, EOF newlines, and mixed line endings. `syntax` includes JSON, YAML, and TOML. Both default to ON. Group changes preserve the overall gate setting; overall on/off preserves group choices. A project with its own formatter can use `whitespace off` while keeping `syntax on`.

Settings are repository-local and shared by linked worktrees. Report the returned state, project path, group choices, and any preserved worktree override or dependency error. Never enable a disabled gate or change a group unless the user requests it. Status does not inspect staged file contents.
