# Nose Review

Nose Review snapshots the repository's dirty code files when a prompt starts,
then runs one local `nose query` when the turn stops if code changed. It reports at most three duplicate
families that contain a changed file and requests one review pass. A continued
Stop event is allowed through so the hook cannot loop indefinitely.

The baseline makes the review independent of the edit tool Codex used and
excludes unrelated changes that were already present before the prompt.

The plugin does not edit source files or decide that similar code must be
refactored. Nose analysis caches live outside repositories under
`~/.cache/nose-review/analysis`.

Requirements:

- `nose` on `PATH`
- `git`
- Node.js

Run the tests with:

```sh
node --test scripts/nose-review.test.mjs
```
