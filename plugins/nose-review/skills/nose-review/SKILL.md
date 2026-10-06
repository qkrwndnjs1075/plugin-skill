---
name: nose-review
description: Turn this Git project's Nose Review push gate on or off, or show its status. Use for project settings; use nose-fix to investigate or fix duplication findings.
---

# Nose Review project settings

Run the package command from this skill's location:

```sh
node ../../scripts/project-settings.mjs PROJECT on
node ../../scripts/project-settings.mjs PROJECT off
node ../../scripts/project-settings.mjs PROJECT status
```

Resolve the script relative to this skill directory and replace `PROJECT` with the user's current project path. `$nose-review on`, `$nose-review off`, and `$nose-review status` map to these actions. With no action, show status.

`on` prepares the existing push gate; `off` disables only this gate and leaves its review records intact. Changes are saved in repository-local Git settings and shared by linked worktrees. Report preserved worktree overrides or dependency errors from the command rather than claiming ON.

Report the returned state and project path. Status does not run a duplication or secret scan. Do not disable checks to resolve a blocked push unless the user explicitly requests that change.
