# Skill Maintenance

Two explicit-only Codex skills for user-managed skills under `~/.codex/skills` and `~/.agents/skills`.

## Skill Eraser

`$skill-eraser` incrementally indexes the last 90 days of local Codex sessions. It counts explicit use and evidenced automatic use, separates version identities, and records clear errors/interruption plus attributable rework/rollback without a model. A separate ephemeral `gpt-5.6-luna` process with `high` reasoning receives a strictly reconstructed compact prompt and makes the recommendations. The child runs read-only from an empty directory and is instructed not to use tools; this is not an operating-system tool-free isolation boundary. Analysis never moves a skill. After explicit approval, selected skills move to recoverable local trash with a transaction manifest.

## Skill Updater

`$skill-updater` checks all user-managed skills only when invoked. It follows recorded GitHub release, tag, or branch provenance, protects local modifications, stages and validates candidates, applies safe updates automatically, and batches impact-bearing updates for one confirmation. Every verified swap keeps only the immediately previous version and rolls back after failed verification.

Plugin-provided skills, including LazyCodex `omo:*` skills, are excluded from both workflows.

The updater needs Node.js 20 or newer, Git, and network access to GitHub. Public release metadata is read through the GitHub API; `GH_TOKEN` or `GITHUB_TOKEN` is optional and used only when already present.

If origin or channel evidence is ambiguous, the updater reports `source-unconfirmed` or `source-confirmation` instead of guessing. A confirmed selection is rechecked against the installed content and live Git refs before it is saved.

## Local state

Runtime state stays outside skill directories:

- `~/.codex/skill-eraser/`: usage index, reports, recoverable trash
- `~/.codex/skill-updater/`: provenance, reports, transactions, one-version backups

Raw prompts, responses, tool outputs, and source excerpts are not copied into the usage index or reports.
