# UI evidence for a PR

Read this for UI changes. Show how the real product changed, rather than merely asserting that it looks better.

## Capture comparable states

Identify the screen and interaction affected by the change. Run the base revision and candidate in separate worktrees or otherwise isolated environments so comparison does not disturb the user's current work. Use the same route, viewport, theme, representative data and interaction state where feasible. Note meaningful differences in environment or data.

Exercise the changed path in a real browser or native app and inspect the resulting captures yourself. Capture before and after when the baseline can be run; choose only the states needed to demonstrate the change, including responsive or error states when directly affected. Record the revision and capture conditions with the evidence. Never substitute a generated mockup for a screenshot of observed behavior.

If the before state cannot be reproduced, include the actual after capture and explain why the baseline is unavailable. If the UI cannot be run at all, state that visual verification is unperformed, provide reproducible steps and the blocker, and do not claim the screenshot requirement passed.

## Attach without leaking or polluting the repository

Use non-sensitive representative data and check for account information, tokens, private messages, and unrelated content. Prefer capturing with safe data over altering the evidence. If redaction is necessary, label it and preserve the visible behavior being evaluated.

Use the repository's approved attachment workflow or the Git host's authenticated attachment interface. Do not commit temporary captures just to obtain URLs, or upload private evidence to an arbitrary external image host. If no permitted upload mechanism is available, keep the local files, report the missing attachment capability, and do not present local filesystem paths as working PR image links.

When creating a PR and attachments are blocked, create a Draft with the missing evidence and blocker visible unless the user or repository requires attachments before creation. In that case, stop at the completed local body and captures and report the blocker. For an existing PR, preserve its review state and disclose the limitation.

Inspect the rendered PR to ensure attachments actually display for the intended reviewer. A file on disk, an attempted upload, or an inaccessible URL is not a successfully attached screenshot.

## Present the difference

Use a Before/After table when it remains readable; otherwise use separate labeled images. Add a short caption explaining the behavior or visual change, not just the filename. Match the PR's language.

For example, a validation UI comparison should show the same invalid input before and after, with a caption explaining the new inline error and submit-button behavior. Use a recording only when motion or a multi-step interaction cannot be explained by still screenshots; a recording supplements the explanation.
