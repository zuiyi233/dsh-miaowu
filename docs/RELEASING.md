# Release process

`@dsh-miaowu/dsh` is built as one prebuilt tarball. The GitHub Release carries that
tarball and its checksum; the npm channel is not published yet. A release is created only
from an annotated `miaowu-v` tag whose version matches the package, on a fork `main`
commit.

## Upstream update issues

`.github/workflows/upstream-updates.yml` runs daily and opens one
`upstream-update` issue per new version of a bundled Skill set (latest GitHub
release ahead of the pinned manifest commit) or of DeepSeek Harness (an npm
dist-tag on a version the plugin does not declare). Each issue carries the sync
checklist. Close an issue to decline that version; it will not be reopened.
Run `pnpm upstream:updates` for a local dry run.

## Upstream sync factory (skeleton)

`pnpm sync:upstream` is the one-command sync path that sits between an
`upstream-update` issue and a reviewed release:

- `pnpm sync:upstream --dry-run --json` (the default) reads the four pinned
  manifests, compares them with a `--latest` JSON map or the public GitHub
  release API, and reports `current` / `behind` / `ahead` / `diverged` /
  `unavailable` plus the declared DSH range. It writes nothing; network
  failures become `unavailable` instead of throwing.
- `pnpm sync:upstream --apply --upstream-root <dir>` requires a clean working
  tree and the four upstream checkouts, then runs the existing
  `assets:sync:*` chain and `assets:check`. Add `--verify` to run
  `pnpm verify` and `pnpm test:dsh` afterwards.
- The factory never commits, pushes, tags, publishes or calls the paid
  provider. It writes a JSON report with `baseSha`, per-set status, DSH range
  status, step results and a rollback command. The rollback command restores
  tracked files only; untracked files introduced by a sync must be removed
  manually per the report note.
- `pnpm test:sync-upstream` is part of `pnpm verify`; it exercises the pure
  diff/report logic and the apply gates without network or checkouts.

## Fork status (2026-10-20)

The release pipeline now matches this fork's identity:

- `scripts/release-identity.mjs` derives the repository, package name and tarball prefix
  from `packages/dsh-plugin/package.json`; `scripts/release.mjs` uses that identity for
  every string, install path and User-Agent it emits, and neither script contains an
  upstream `oh-story-dsh` identity.
- Stable tags are parsed as `miaowu-vX.Y.Z`. `.github/workflows/release.yml` triggers on
  `miaowu-v*`, and its guards reject any other tag ref.
- The source preflight rejects a tag or commit that lacks
  `packages/dsh-plugin/src/services/index.ts` and `createDshMiaowuSkillProvider`, or whose
  commit is not on `main` (it must be an ancestor of `main`, or of `origin/main` in a tag
  checkout; the `main` tip is the normal case). Upstream release commits and upstream `v*`
  tags fail before any build starts.
- The upstream-only `recover-v0.1.13.yml` workflow is deleted in this branch. Until that
  deletion is pushed and merged, GitHub still lists it on the default branch; confirm it is
  gone there before assuming the remote has no such workflow.
- npm is unpublished: `@dsh-miaowu/dsh` returns 404 from the registry. Only the GitHub
  Release channel exists, and its only release is `v0.1.16`; versions 0.1.17 and 0.1.18 are
  source-only.

The fork's Release workflow is currently disabled in GitHub Actions: the API reports its
state as `disabled_manually`, so a `miaowu-v*` tag push starts no run until it is enabled.
Enable it from the Actions tab, or list the fork's workflows with `gh workflow list` and
enable the Release entry by its own ID. In this fork that ID is `350173456`, but a workflow
ID can change when a workflow is deleted and re-created, so confirm the current ID from the
Actions UI or `gh api repos/zuiyi233/dsh-miaowu/actions/workflows` before enabling instead
of trusting a saved number.

Enabling the workflow is not sufficient by itself. `scripts/release.mjs ci-proof` requires
the default branch `main` to be protected (`branches/main.protected === true`) and fails
with `publisher requires protected default branch main` otherwise. As of 2026-10-20 the
fork's GitHub API reports `main` as unprotected, so enable branch protection for `main`
(require pull requests and the CI checks) before pushing the first `miaowu-v*` tag.

## One-time npm setup

The npm account used for the first publication must be allowed to publish the
public `@dsh-miaowu/dsh` package. Store a granular publish token as the repository
secret `NPM_TOKEN`; never commit it or put it in an issue, workflow file, or
release note.

This setup is not complete. The first publish must use a granular `NPM_TOKEN` permitted to
create the public package: npm only lets you configure Trusted Publishing on a package that
already exists on the registry, so Trusted Publishing cannot serve a first publish. While no
publish credential exists, the `Publish npm package` job fails, `Verify public channels` is
skipped because it needs that job, and the run is red. The GitHub Release job does not
depend on them.

After the first publication, configure npm Trusted Publishing for:

- repository: `zuiyi233/dsh-miaowu`
- workflow: `release.yml`

The workflow requests an OpenID Connect identity and publishes with provenance.
Once Trusted Publishing is verified, the long-lived `NPM_TOKEN` secret can be
removed.

## Release steps

Before step 1, set the same version in the root and plugin `package.json` and add a dated
`## [<version>] - YYYY-MM-DD` heading to `CHANGELOG.md`; `release.mjs check` rejects a
mismatch or a missing heading.

1. Run `pnpm verify:release` locally. It runs the complete deterministic gate and the
   packaged Chrome smoke on the default DSH `0.2.1-rc.3` line and on the earlier
   `0.2.0-rc.2` line. A host line is not announced from peer metadata or unit tests alone.
2. Build and pack from a clean tree, then write the checksum file:

   ```bash
   pnpm --filter @dsh-miaowu/dsh build
   pnpm --filter @dsh-miaowu/dsh pack --pack-destination release
   cd release && sha256sum dsh-miaowu-dsh-<version>.tgz > SHA256SUMS
   ```

3. On a fork `main` commit, create an annotated `miaowu-v<version>` tag and validate it:

   ```bash
   git tag -a miaowu-v<version> -m "dsh-miaowu <version>"
   node scripts/release.mjs check --tag miaowu-v<version>
   ```

   The check prints the derived version/tag and the source ref, and fails if the tag,
   version, changelog or fork source do not match. Never reuse an upstream `v*` tag name.
4. Publish. Once the Release workflow is enabled (see Fork status), pushing the tag starts
   `.github/workflows/release.yml`, which re-verifies, builds, and uploads the tarball plus
   checksums to the GitHub Release. If you create the Release by hand instead, upload the
   exact local tarball and `SHA256SUMS`, then re-download the asset and compare its SHA-256
   with the local file. Do not create the same release twice: GitHub assets are
   append-only, and a byte-different asset fails the workflow.
5. After the npm setup above, publish and verify `@dsh-miaowu/dsh@<version>`. Until npm is
   live, README installs use a source build or the `v0.1.16` prebuilt asset.

## What the tag workflow does

Once enabled, a `miaowu-v*` tag push makes `.github/workflows/release.yml`:

1. repeats the complete verification suite;
2. builds and inspects a clean installable tarball;
3. checks that the tag and package version match, that the changelog has the dated
   heading, and that the source passed the newest `main` CI attempt;
4. uploads the tarball, the SHA-256 checksum file and the release manifest to a GitHub
   Release;
5. publishes the identical tarball to npm with provenance once a granular `NPM_TOKEN`
   exists; Trusted Publishing can be configured only after the package exists on the
   registry, so it cannot serve a first publish.

The deterministic public manifest records the source commit, tool versions,
tarball size, SHA-256, and npm-compatible SHA-512 integrity. Separate CI and
promotion proofs bind the CI run/attempt and release run/attempt to the exact
manifest and artifact name without making public release bytes change on a
retry. GitHub and npm publishers download the exact artifact ID produced by
that run. The producing job also passes independent SHA-256 values for the
manifest, promotion proof, and CI proof as job outputs; every consumer compares
those values before a write credential is exposed. This prevents a coordinated
replacement of the tarball and all self-contained proof files.

GitHub assets are append-only under workflow control: an absent asset is
uploaded, an existing byte-identical asset is accepted, and an existing asset
with different bytes fails the run. The workflow never uses `--clobber` and it
does not delete a partial release. npm follows the same rule: an absent version
is published, the same version and `dist.integrity` is accepted on a retry, and
a different integrity fails. HTTP 401/403/429/5xx and network failures are
errors, not evidence that a release or version is absent.

This is workflow-enforced append-only behavior, not a claim that GitHub makes a
tag or release immutable against repository administrators. Immediately before
either GitHub or npm can mutate public state, the shared source gate re-resolves
the tag, confirms the canonical public repository and protected default `main`,
proves source ancestry, and rechecks the exact CI workflow. It refetches the
selected run after reading its latest-attempt jobs and rejects an attempt,
check-suite, source, status, conclusion, or GitHub Actions application change.

After both publishers finish, the workflow anonymously downloads the GitHub
tarball, waits a bounded time for npm registry propagation, compares
`dist.integrity`, and installs the exact public npm version with lifecycle
scripts disabled. A timeout or channel mismatch leaves the workflow red. Until an npm
credential is configured, the `npm` job fails and `verify-public` is skipped; the GitHub
Release job still publishes.

## Dry-run and failure outcomes

Manual dispatch is accepted only on `main`. It performs the source/CI checks,
the complete deterministic release suite, and package/manifest upload, but the
GitHub and npm publisher jobs do not run. Pull requests never receive release
write or OIDC permissions.

Tag publication requires all of the following before dependency installation
or package construction: a stable `miaowu-vX.Y.Z` tag; matching root and plugin
versions; a dated changelog heading; the tag commit on `main`; and the newest
GitHub Actions `CI` main-push run for that exact SHA, latest attempt, expected
workflow path/application, and all four named jobs successful.

If GitHub succeeds and npm fails (or the reverse), do not overwrite or delete
the successful channel. Fix the credential or transient failure and rerun the
same workflow: the successful channel must verify as byte-identical and skip,
while the incomplete channel resumes. A moved tag, changed asset, changed npm
integrity, missing required CI job, or older successful attempt is a hard
failure and needs investigation rather than a retry that mutates public bytes.

## Verify the public installation

### Historical: upstream 0.1.13 npm recovery

The upstream `oh-story-dsh` 0.1.13 npm recovery fixed a bare relative tarball path
that npm read as a GitHub package shorthand. It was a one-time, upstream-bound
workflow with upstream artifact IDs and commit hashes; this fork does not ship
`recover-v0.1.13.yml`, and none of its IDs or digests apply to `zuiyi233/dsh-miaowu`.
Do not resurrect that workflow here.

### After npm is published

Do not announce an npm release until the registry reports the exact version:

```bash
VERSION=<version>
npm view "@dsh-miaowu/dsh@$VERSION" version dist.integrity
npx -y --package pnpm@11.7.0 --package @deepseek-ai/dsh@0.2.1-rc.3 dsh plugin --profile web add "@dsh-miaowu/dsh@$VERSION"
```

Until publication, `npm view "@dsh-miaowu/dsh" version` returns 404; that is the expected
unpublished state.

The default public smoke pins DSH `0.2.1-rc.3`. After it passes,
repeat the isolated install/start/browser smoke with
`@deepseek-ai/dsh@0.2.0-rc.2`; never mix host versions within one profile or
describe a host line as supported before its Chrome run passes.

The GitHub Release tarball remains a registry-independent installation path. The
last published asset is `v0.1.16`; future releases use the `miaowu-v` tag prefix:

```bash
# existing prebuilt asset
VERSION=0.1.16
npx -y --package pnpm@11.7.0 --package @deepseek-ai/dsh@0.2.1-rc.3 dsh plugin --profile web add "https://github.com/zuiyi233/dsh-miaowu/releases/download/v$VERSION/dsh-miaowu-dsh-$VERSION.tgz"

# a future release, where <version> matches the miaowu-v tag
# https://github.com/zuiyi233/dsh-miaowu/releases/download/miaowu-v<version>/dsh-miaowu-dsh-<version>.tgz
```
