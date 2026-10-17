# Nose distribution maintenance

`qkrwndnjs1075/nose` is an independent private repository retaining the MIT
licensed upstream source and release artifacts. Plugin users need authenticated
GitHub CLI read access for first installation. Existing validated caches remain
usable without GitHub. A project's `hook.nose-review.enabled=false` setting
remains OFF: session setup skips installation and scans for that project.

The source repository proposes upstream release updates in pull requests. Its
managed build workflow tests and packages the accepted source; publishing a new
release is explicit. The first v0.21.0 distribution preserves upstream binaries
byte for byte with upstream checksums, source archive, and an additional locked
Cargo dependency archive. Subsequent managed releases build from preserved source.
The [source maintenance guide](https://github.com/qkrwndnjs1075/nose/blob/managed/.managed/README.md)
describes the `Managed build` workflow: dispatch it on `managed` with the
accepted upstream tag in `release_tag` to test and publish. Its Actions run stores
per-platform smoke results and build logs; release notes identify the build commit.

The plugin consumes only the release pinned in
`plugins/nose-review/scripts/nose-runtime.json`, not an arbitrary upstream HEAD.
The updater downloads all four independent distribution archives and verifies
their individual `.sha256` assets before changing the pin. Targets are macOS
ARM64/x86_64 and Linux ARM64/x86_64. Checksums verify release-file consistency;
the reviewed source and successful build run establish provenance separately.

From the `plugin-skill` repository root, run with a GitHub CLI account that can
read the private repository. The updater changes the manifest and bumps the plugin
patch version in the working tree; it does not commit, push, or create a PR:

```sh
node scripts/update-nose-runtime.mjs
node --test scripts/update-nose-runtime.test.mjs
node scripts/smoke-nose-runtime.mjs
node --test plugins/nose-review/scripts/*.test.mjs
```

For scheduled update PRs, set the `plugin-skill` Actions secret
`NOSE_RELEASE_TOKEN` to a fine-grained token with **Contents: read** permission
on `qkrwndnjs1075/nose` only. Do not commit a token. The workflow uses that token
only to read the release; its own `GITHUB_TOKEN` writes the update branch and PR.
Enable Actions' permission to create pull requests in repository settings.
Without the secret, the workflow reports the missing configuration and makes
no update. Manual local updates remain available.

The scheduled job creates a reviewable PR and never merges it. Review source
repository build evidence and run the full plugin regression suite before
merging. Check out the PR's exact head (`gh pr checkout NUMBER`), then run the
commands above except the updater, which would select a potentially newer release.
GitHub does not trigger ordinary workflows for PR events created using
`GITHUB_TOKEN`; run required validation manually when necessary.

The private source distribution stores no plugin-user credentials. If upstream
becomes unavailable, use the last verified release and its preserved source,
lockfile, toolchain pin and dependency archive. A compatible compiler and system
build tools are still needed to rebuild; the archive is not a complete OS image.
Download the desired release using `gh release download vVERSION --repo
qkrwndnjs1075/nose`. For initial v0.21.0 recovery, follow the release's
`PRESERVATION.md`: extract `source.tar.gz`, extract `nose-dependencies.tar.xz`
at the source root, and copy `dependencies.cargo-config.toml` to
`.cargo/config.toml`. Future dependency archives include `.cargo/config.toml`
directly. Then run `cargo build --release --locked --offline -p nose-cli`.
