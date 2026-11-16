# Nose distribution maintenance

`qkrwndnjs1075/nose` is an independent private repository retaining the MIT
licensed upstream source and release artifacts. Plugin users need authenticated
GitHub CLI read access for first installation. Existing validated caches remain
usable without GitHub. A project's `hook.nose-review.enabled=false` setting
remains OFF: session setup skips installation and scans for that project.

The source repository checks for upstream releases and runs its managed build
workflow before publishing. All four native targets must pass workspace tests
and real clean/duplicate CLI checks before a release is published. The first
v0.21.0 distribution preserves upstream binaries
byte for byte with upstream checksums, source archive, and an additional locked
Cargo dependency archive. Subsequent managed releases build from preserved source.
The [source maintenance guide](https://github.com/qkrwndnjs1075/nose/blob/managed/.managed/README.md)
describes the automatic pipeline and the `Managed build` manual recovery path.
Its Actions run stores
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

For scheduled plugin releases, set the `plugin-skill` Actions secret
`NOSE_RELEASE_TOKEN` to a fine-grained token with **Contents: read** permission
on `qkrwndnjs1075/nose` only. Do not commit a token. The workflow uses that token
only to read the release; its own `GITHUB_TOKEN` publishes the verified manifest
commit and plugin release. This repository does not need source workflow-write
permission. The source distribution's separate `NOSE_UPDATE_TOKEN` preserves
original upstream tags, whose history can contain workflow files.
Without the secret, the workflow reports the missing configuration and makes
no update. Manual local updates remain available.

The hourly job verifies every platform archive's checksum, installs and exercises
the pinned Linux runtime with clean/duplicate input, and runs the complete Nose
Review regression suite. Only then does it advance the manifest and plugin patch
version on `main` and publish `nose-review-vVERSION` with a plugin archive and
checksum. It refuses a concurrent non-fast-forward push. Releases are assembled
as drafts and published only after their uploaded bytes match a deterministic
archive of the recorded plugin source commit. A retry finds the same plugin
source even after unrelated main commits and uploads only missing matching
assets; complete releases stay unchanged. Incorrect provenance or modified
existing assets stop publication instead of being overwritten.
The regression job prepares a checksum-verified Gitleaks binary and adds the
already verified managed Nose binary to the runner's PATH before running tests.

Publishing does not update any computer's installed plugin or project gates.
Installation remains manual. For a local marketplace checkout, fetch the new
`main` first, then reinstall `nose-review@plugin-skill` through Codex when ready.

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
