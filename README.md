# Joowon-plugin

A Codex plugin marketplace containing independently installable packages.

## Packages

- [`nose-review`](plugins/nose-review/README.md): blocking pre-push duplication and secret checks with a scoped Nose Fix workflow.
- [`skill-maintenance`](plugins/skill-maintenance/README.md): explicit Skill Eraser and Skill Updater workflows for user-managed Codex skills.
- [`joowon-plugin`](plugins/joowon-plugin/README.md): responsibility-scoped Commit and coherent PR workflows.

Install the marketplace and either package:

```sh
codex plugin marketplace add qkrwndnjs1075/plugin-skill
codex plugin add nose-review@plugin-skill
codex plugin add skill-maintenance@plugin-skill
codex plugin add joowon-plugin@plugin-skill
```

The packages are isolated under `plugins/`; installing one does not install or invoke the other.

## Validation

```sh
node --test plugins/nose-review/scripts/*.test.mjs
node --test plugins/skill-maintenance/scripts/*.test.mjs
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/nose-review
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/skill-maintenance
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/joowon-plugin
```
