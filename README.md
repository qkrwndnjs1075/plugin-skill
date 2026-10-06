# Joowon Plugins

A Codex plugin marketplace containing independently installable packages.

## Packages

- [`nose-review`](plugins/nose-review/README.md): blocking pre-push duplication and secret checks, project on/off/status, and a scoped Nose Fix workflow.
- [`skill-maintenance`](plugins/skill-maintenance/README.md): explicit Skill Eraser and Skill Updater workflows for user-managed Codex skills.
- [Git Workflow](plugins/joowon-plugin/README.md) (`joowon-plugin`): responsibility-scoped Commit and coherent PR workflows.
- [File Checks](plugins/file-checks/README.md) (`file-checks`): staged whitespace, newline, and JSON/YAML/TOML syntax checks before commits.

Register the marketplace, then install the packages you want:

```sh
codex plugin marketplace add qkrwndnjs1075/plugin-skill
codex plugin add nose-review@plugin-skill
codex plugin add skill-maintenance@plugin-skill
codex plugin add joowon-plugin@plugin-skill
codex plugin add file-checks@plugin-skill
```

The packages are isolated under `plugins/`. Registering the marketplace does not install its packages; installing one package does not install or invoke another. Display names do not change installation IDs.

Use `$nose-review on|off|status` and `$file-checks on|off|status` to control each project's automatic gate. File Checks also supports `whitespace on|off` and `syntax on|off`. Settings stay in Git's local configuration, persist across sessions and updates, and are shared by linked worktrees. See each package's README for prerequisites and preserved overrides.

## Validation

```sh
node --test plugins/nose-review/scripts/*.test.mjs
node --test plugins/skill-maintenance/scripts/*.test.mjs
node --test tests/*.test.mjs plugins/file-checks/scripts/*.test.mjs
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/nose-review
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/skill-maintenance
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/joowon-plugin
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/file-checks
```
