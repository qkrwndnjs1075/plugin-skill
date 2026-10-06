# File Checks

An independently installed pre-commit plugin for staged file hygiene and configuration syntax. It does not install or invoke Nose Review.

## Project settings

```text
$file-checks on
$file-checks off
$file-checks status
$file-checks whitespace on
$file-checks whitespace off
$file-checks syntax on
$file-checks syntax off
```

Overall on/off uses Git's repository-local `hook.file-checks.enabled` setting. The `file-checks.whitespace` and `file-checks.syntax` boolean settings select the two rule groups; both default to ON. Whitespace covers trailing whitespace, EOF newlines, and mixed line endings. Syntax covers JSON, YAML, and TOML. A project with an existing formatter can use `whitespace off` and keep `syntax on`.

Group settings take effect on the next commit without reinstalling the hook. Turning the gate OFF preserves group choices; changing a group does not turn the gate ON. New sessions and plugin updates preserve OFF without preparing dependencies. If both groups are OFF while the gate is ON, no files are inspected.

Settings are shared by linked worktrees, not other repositories. Explicit worktree overrides and an event-wide `hook.pre-commit.enabled=false` are preserved and reported. Invalid boolean settings are errors, never interpreted as OFF. Status checks the registration and prepared dependencies offline without inspecting staged contents or installing packages.

CLI equivalent, with an absolute project path:

```sh
node scripts/project-settings.mjs /path/to/project whitespace off
node scripts/project-settings.mjs /path/to/project status
```

## Installation

Install Node.js 20+, Git 2.54+ (configured hooks), uv, and Python 3.10+. Then install this package from the marketplace:

```sh
codex plugin add file-checks@plugin-skill
```

Trust its hook and open a new Codex session in a Git project. Unless the gate is OFF, SessionStart copies the checker and its dependency lock into the project's shared Git directory, prepares the pinned pre-commit-hooks environment with uv, and registers `hook.file-checks` for `pre-commit`. The first setup needs access to the Python package registry. Commits run offline; if the environment is missing, reopen the project to prepare it again. Setup reports missing dependencies without registering a new gate.

To register the hook explicitly from this package:

```sh
node scripts/install-pre-commit.mjs /path/to/project
```

Registering the **Joowon Plugins** marketplace alone does not install this package. Existing plugins do not gain File Checks automatically.

## Checks

| Check | Behavior |
| --- | --- |
| Trailing whitespace | Reports trailing spaces and tabs; preserves two-space Markdown line breaks. |
| End-of-file newline | Requires nonempty text to end with one newline; accepts LF or CRLF. |
| Mixed line endings | Rejects mixed LF, CRLF, or CR; does not force one OS's line endings. |
| JSON | Parses `.json` syntax; does not treat JSONC as JSON. |
| YAML | Parses `.yaml` and `.yml` syntax, allowing custom tags and multiple documents. |
| TOML | Parses `.toml` syntax. |

The checker reads added, modified, renamed, and type-changed regular files from the Git index. Partially staged files are checked using their staged bytes. Deleted paths, symlinks, and submodule entries are not inspected. Hygiene checks apply to UTF-8 text without NUL bytes; binary and other encodings are skipped. JSON/YAML/TOML files must contain UTF-8 text, so malformed encodings are reported rather than skipped. No repository configuration or code is executed to check syntax.

Fixers run on disposable copies. **Working files and staged content are never rewritten or restaged.** A failure lists original file paths and rule names without configuration values. Correct the files, stage the intended corrections, and commit again. Formatting tools in a project may cover some of the same whitespace rules.

`FILE_CHECKS_BLOCKED` means findings need correction (exit 1). `FILE_CHECKS_UNAVAILABLE` means Git or a checker could not complete (exit 2). uv launch/environment failures also block the commit and display uv's error. If another process changes the staged entries during inspection, the check refuses the unstable result.

## Existing hooks and removal

Git runs this configured hook alongside existing hooks. Installation preserves `core.hooksPath`, existing hook files, and explicitly disabled hook settings. Linked worktrees share the copied checker and registration. Use a supported Git executable for commits as well as setup; older Git may ignore configured hooks.

The copied hook keeps working if the plugin cache disappears. Disabling or uninstalling the Codex plugin does not remove a Git hook that was already registered. To remove this project's registration:

```sh
git config --local --remove-section hook.file-checks
```

## Development

```sh
uv lock --script scripts/check-staged.py
node --test scripts/file-checks.test.mjs
```

Tests exercise real commits in disposable repositories, including rejected syntax, partial staging, existing hooks, and linked worktrees. They require Git 2.54+, Node.js, uv, and initial package access.
