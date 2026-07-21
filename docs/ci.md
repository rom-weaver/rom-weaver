# Continuous integration

Every workflow in `.github/workflows`, what triggers it, what it gates, and
what it caches. For the release *decision* - versions, tags, trusted
publishing, and retry procedures - see the [release guide](../.github/RELEASING.md).

<!-- START doctoc -->
## Table of contents

- [The workflows at a glance](#the-workflows-at-a-glance)
- [`ci.yml` - the required gate](#ciyml---the-required-gate)
  - [Jobs](#jobs)
  - [Tag runs](#tag-runs)
  - [Deploy channels](#deploy-channels)
- [Shared building blocks](#shared-building-blocks)
  - [`.github/actions/setup-build-env`](#githubactionssetup-build-env)
  - [`.github/actions/wasm-cache`](#githubactionswasm-cache)
  - [`scripts/ci/resolve-wasm-run.sh`](#scriptsciresolve-wasm-runsh)
  - [`scripts/ci/npm-publish-package.mjs`](#scriptscinpm-publish-packagemjs)
- [Release fan-out](#release-fan-out)
  - [Draft-first releases](#draft-first-releases)
  - [Prerelease routing](#prerelease-routing)
- [Actions cache budget](#actions-cache-budget)
  - [Why the Docker build cache is not in this budget](#why-the-docker-build-cache-is-not-in-this-budget)
- [Secrets](#secrets)
- [Reproducing CI locally](#reproducing-ci-locally)
- [Gotchas](#gotchas)

<!-- END doctoc -->

## The workflows at a glance

| Workflow | Trigger | Red build blocks a release? | Purpose |
| --- | --- | --- | --- |
| `ci.yml` | PR, push to `main`, `v*` tags, manual | **Yes** | Build, lint, test, deploy the webapp |
| `commitlint.yml` | PR (open/edit/sync), push to `main` | No | Conventional-commit format |
| `codeql.yml` | push to `main`, weekly, manual | No | Static analysis into the Security tab |
| `coverage.yml` | after a successful `CI` on `main` | No | Rust + React coverage reports |
| `parity.yml` | nightly 07:13 UTC, manual | No | Byte parity against live chdman / dolphin-tool |
| `e2e-nightly.yml` | nightly 07:41 UTC, manual | No | Exhaustive Chromium + WebKit E2E matrix |
| `cache-cleanup.yml` | daily 09:00 UTC, manual | No | Reap closed-PR Actions caches |
| `release.yml` | after a successful `CI` on `main`, manual | n/a | Release Please, then the publish fan-out |
| `cargo-publish.yml` | `v*` tag push, manual | n/a | crates.io publish + semver check |
| `npm-publish.yml` | called by `release.yml`, manual | n/a | 4 platform packages, launcher, alias |
| `docker-publish.yml` | called by `release.yml`, manual | n/a | CLI + webapp images to ghcr.io |

Nothing publishes on a push. `release.yml` runs on `workflow_run` gated on a
**successful** CI, and even then only opens a release pull request; merging
that pull request is what sets `release_created` and unlocks the publish jobs.

> **`main` is not branch-protected.** Nothing is a *required* status check
> today, so "gating" above means "CI must be green before Release Please
> runs", not "GitHub will refuse the merge". If protection is ever enabled,
> the checks to require are `Rust`, `Webapp`, and `Conventional commits` -
> the `rust` job exists to give the first of those a single stable name.

## `ci.yml` - the required gate

```
             ┌── rust-host ──┐
checkout ────┤               ├── rust (aggregate check name)
             └── wasm-check ─┘

         ┌── webapp ── lint, unit, browser, E2E, build
wasm ────┤
         └── deploy ── Cloudflare Pages, one leg per channel (non-gating)
                 ↑
           deploy-plan ── ref -> channel list

security ── advisories (warn only, always green)
```

### Jobs

- **`repo-lint`** lints the repository's own plumbing: `actionlint` over the
  workflows and composite actions, `shellcheck` over every tracked `.sh`, and
  `hadolint` over the Dockerfiles. It installs no language toolchain and
  compiles nothing, so it reports in well under a minute instead of hiding
  behind a build job. `actionlint` shells out to `shellcheck` for `run:`
  blocks, which is why both are in its `tools:` list.
- **`docker`** builds the CLI and webapp images without pushing, so a broken
  Dockerfile fails here rather than at the moment it blocks a release publish.
  It runs only when the files defining the images change (the two Dockerfiles,
  `.dockerignore`, `docker-compose.yml`, `sws.toml`, `ci.yml`,
  `docker-publish.yml`), because such a change leaves the sources alone and the
  registry build cache restores every expensive layer; a source-only pull
  request would invalidate `COPY . .` and pay a cold cargo+wasm compile for no
  signal about the Dockerfile. On `main` it also refreshes that cache.
- **`wasm`** builds the production WASM module. This is the single most
  expensive step in the pipeline (~6.5 min) and it used to run twice, so it is
  built once here and shared with `webapp` and `deploy` as an artifact, and
  with `coverage` and `release` by artifact download.
- **`rust-host`** is everything needing a host-profile Rust build: fmt, clippy,
  typegen drift, whitespace, thread guards, the Rust test suite, license
  attribution, `cargo deny` licenses/sources, unused dependencies, and a
  `cargo publish --dry-run`.
- **`wasm-check`** runs `cargo check` against `wasm32-wasip1-threads`. It has a
  separate Cargo fingerprint from the host checks, so serializing it into
  `rust-host` would only lengthen the required gate.
- **`rust`** is an aggregator: it fails unless both jobs above succeeded. Its
  only purpose is to present one stable check name (`Rust`) while the work
  runs in parallel, so branch protection would have a single thing to require.
- **`security`** runs `cargo deny advisories` and `npm audit`. **Deliberately
  non-gating** - an advisory can be published against a transitive dependency
  without any commit of ours, and letting that turn every open pull request red
  blocks unrelated work. Findings surface as warnings via
  `scripts/warn-only.sh`; the job stays green.
- **`webapp`** consumes the prebuilt module and compiles no Rust: build-script
  tests, lint, unit tests, two browser suites, the webapp E2E, and the vite
  build.
- **`deploy-plan`** turns the ref into the list of channels to publish (below).
  It exists as its own job because a matrix can only be fed by an upstream
  job's output.
- **`deploy`** ships the site, one matrix leg per channel (below). Both jobs
  are `continue-on-error: true`, so a Cloudflare outage cannot turn a green
  `main` red and suppress release automation.

### Tag runs

Release tags (`v*`) trigger this workflow, but every test job carries
`if: github.ref_type != 'tag'`. The commit being tagged already passed the same
gate on `main`; a tag run exists only to build and deploy the webapp to the
channels that tag publishes.

### Deploy channels

`deploy-plan` resolves the channel list from the ref; `deploy` runs one matrix
leg per channel, deploying with Cloudflare Direct Upload and reusing the
CI-tested WASM artifact rather than spending Cloudflare build minutes on a
second toolchain.

| Channel | Cloudflare project | URL |
| --- | --- | --- |
| `prod` | `rom-weaver` | rom-weaver.com |
| `beta` | `rom-weaver-beta` | beta.rom-weaver.com |
| `nightly` | `rom-weaver-nightly` | nightly.rom-weaver.com |
| `preview` | `rom-weaver-preview` | `pr-<n>.rom-weaver-preview.pages.dev` |

The channels form a stability ladder - `prod` above `beta` above `nightly` -
and a ref deploys to the channel it enters at **plus every less-stable channel
below it**. Otherwise a quiet stretch on `main` would leave beta and nightly
serving code older than production, which makes them useless for reproducing a
release-day bug.

| Ref | Deploys to |
| --- | --- |
| `vX.Y.Z` tag | `prod`, `beta`, `nightly` |
| `vX.Y.Z-alpha.N` tag | `beta`, `nightly` |
| push to `main` | `nightly` |
| pull request | `preview` |

Legs are independent Pages projects with no shared state, so they upload in
parallel and a release's three channels land in the time of one. Each leg
builds its own bundle because the channel is baked in at build time
(`ROM_WEAVER_CHANNEL`), so there is no artifact to share between them. Failure
is per-leg (`fail-fast: false`): a beta upload failing still lets prod ship.

A hyphen after the version is what makes a tag a prerelease. The same rule
routes the npm dist-tag and the docker `beta` tag - see
[prerelease routing](#prerelease-routing).

`workflow_dispatch` takes a `deploy_channel` input that deploys exactly the
channel named, with no cascade - it is a break-glass override, not a release.

Preview deployments are skipped for forks and Dependabot, which are not given
the Cloudflare secrets and could only ever fail. The preview URL is published
as a commit status (`preview/webapp`) rather than a comment, so it updates in
place instead of accreting comments.

Projects are created on demand through the Cloudflare REST API rather than
`wrangler pages project create`: wrangler enumerates accounts internally, which
a token scoped to specific account resources cannot do, and reports the failure
as a bare `unknown error [code: 8000000]`.

## Shared building blocks

Duplicated CI logic lives in one place. Changing one of these changes every
consumer, which is the point.

### `.github/actions/setup-build-env`

Every toolchain concern, each opt-in so a job installs only what it runs: apt
packages, mise-pinned tools, Rust components and targets, the cargo cache, the
WASI SDK, webapp `node_modules`, and Playwright browsers.

The `tools:` input is a **positive** list of short tool names
(`tools: node rust ripgrep`). mise offers no allowlist - `MISE_DISABLE_TOOLS`
is the only lever - so `scripts/ci/mise-disable-tools.sh` reads the `[tools]`
table of `.mise.toml` and computes the complement. Two consequences worth
knowing:

- Adding a pin to `.mise.toml` costs nothing until a job opts in. Under the
  old hand-maintained exclusion lists it silently slowed down every job.
- A name that is not pinned fails the job instead of being ignored.

Caching decisions that live here:

- **cargo** (`Swatinem/rust-cache`): restore everywhere, **save only on
  `main`**. A branch run writes ~450 MB into a branch-local scope nothing else
  can read, which is pure ballast against the 10 GiB budget.
- **WASI SDK**: keyed on version *and* checksum, so a version bump misses by
  construction and can never serve a stale SDK.
- **`node_modules`**: the installed tree is cached, not `~/.npm` - a hit skips
  `npm ci` outright instead of merely speeding up its download half.
- **Playwright**: browser binaries only. The apt-level libraries they link
  against are outside the cache, so a hit still runs `install-deps`.

### `.github/actions/wasm-cache`

Restores a prebuilt WASM module (`variant: prod` for CI, `dev` for the nightly
E2E suite, which needs an unoptimized module CI never builds). The key is a
SHA-256 over `git ls-tree` of every source, dependency, toolchain, and
build-script input - `git ls-tree` rather than `hashFiles` because it resolves
the pull request merge tree, and because the `crates` tree SHA covers the
vendored libarchive sources under it.

Deliberately no `restore-keys`: a partial-prefix hit could serve a module built
from different source. A miss costs one build; a false hit ships stale WASM.
`cache-epoch` invalidates everything by hand.

### `scripts/ci/resolve-wasm-run.sh`

Finds the CI run that built `wasm-prod` for a commit, so coverage and release
packaging measure and ship the exact module CI tested. It prefers the
triggering run, **verifies that run is actually for this commit** (a
`workflow_run` event can fire for a re-run or lose a race with a newer push),
otherwise searches by commit, and finally confirms the artifact has not
expired. `REQUIRE_ARTIFACT=1` makes a miss fatal (coverage); without it the
caller falls back to a source build (release).

### `scripts/ci/npm-publish-package.mjs`

Publishes one package idempotently. Six packages go out per release through
three jobs that all need the same three rules: never fail because the version
is already on the registry, route prereleases to the `beta` dist-tag, and treat
"publish failed but the version is now present" as a concurrent run winning the
race rather than an error.

The prerelease test reads the **version**, never the package spec - platform
package names contain hyphens (`@rom-weaver/cli-darwin-arm64`), so matching the
spec would tag every platform package as a prerelease.

## Release fan-out

`release.yml` runs Release Please, then on `release_created`:

| Job | Produces |
| --- | --- |
| `static-webapp` | `rom-weaver-webapp.tar.gz` + checksum on the GitHub release |
| `publish-npm` | 4 platform packages → launcher → unscoped alias, in that order |
| `publish-homebrew` | formula commit to `brandonocasey/homebrew-tap` (stable only) |
| `publish-containers` | `ghcr.io/.../rom-weaver-cli` and `-webapp`, signed provenance |
| `publish-release` | flips the draft release to published, creating the tag |

Ordering inside `publish-npm` is load-bearing: the unscoped `rom-weaver` alias
is a dependency-only pointer at `@rom-weaver/cli`, so publishing it first would
make installs resolve a version that is not on the registry yet.

### Draft-first releases

Release Please creates the GitHub release as a **draft** (`"draft": true` in
`release-please-config.json`), every asset-producing job attaches to that draft,
and `publish-release` publishes it only once they have all succeeded. This is
what makes the repo's **immutable releases** setting workable: immutability is
stamped at publish time, and a published immutable release accepts no further
assets *and permanently reserves its tag name* - v0.6.0 was lost that way. A
failure anywhere in the fan-out now leaves a draft, which can be deleted and
re-cut at the same version.

A draft release has no tag until it is published, so every job builds from
`needs.release.outputs.sha` rather than `v${version}` - the reusable npm and
docker workflows take it as a required `sha` input. That also closes a race
they had before: under `workflow_call` they checked out `github.ref`, which is
`main`, so anything merged between the release pull request landing and the
fan-out finishing would have been built and published as the release.
`workflow_dispatch` still falls back to `v${version}`, which by then exists.

`cargo-publish.yml` is triggered by the resulting `v*` tag push instead of being
called by `release.yml`. crates.io Trusted Publishing rejects the `workflow_run`
event that gates `release.yml`, and a reusable workflow inherits its caller's
event, so OIDC could never authenticate from inside the fan-out. Keying off the
tag also orders it naturally last.

`cargo-semver-checks` runs per-crate rather than `--workspace` so a crate with
no published baseline (a first release, or a newly added crate) is skipped
instead of failing the whole job.

### Prerelease routing

One rule, applied in five places: a hyphen in the version means prerelease.

| Target | Stable | Prerelease |
| --- | --- | --- |
| npm dist-tag | `latest` | `beta` |
| docker tags | `X.Y.Z`, `X.Y`, `X` (≥1.0 only), `latest` | `X.Y.Z`, `beta` |
| web channel | rom-weaver.com | beta.rom-weaver.com |
| GitHub release | normal | marked prerelease |
| Homebrew | formula updated | skipped |

The docker major tag starts at 1.0.0 because `0` would float across 0.5 → 0.6,
which semver treats as breaking.

## Actions cache budget

GitHub gives the repository 10 GiB and evicts least-recently-used entries once
that fills. Two mechanisms keep it under the cap; both exist because it was
exceeded (11.46 GB, with 5.1 GB parked in six closed Dependabot pull requests,
evicting the `main` caches every cold run depends on).

1. `save-if: github.ref == 'refs/heads/main'` on the cargo cache, so branch
   runs restore but never write.
2. `cache-cleanup.yml` deletes caches belonging to closed and merged pull
   requests daily, and warns in the job summary if usage is still above 9 GiB
   afterwards.

The cleanup is **scheduled, not triggered by `pull_request: closed`**:
workflows triggered by Dependabot or a fork get a read-only `GITHUB_TOKEN`, so
a close-triggered job could not delete anything for exactly the traffic that
produces most of the garbage.

### Why the Docker build cache is not in this budget

The image builds cache to `ghcr.io/<owner>/<image>:buildcache`, not `type=gha`.
Publishing runs only when a release pull request merges, and Actions entries are
evicted after seven days without a read, so a gha cache was reliably cold by the
next release while `mode=max` still wrote the whole layer graph - Rust builder
stage included - into the 10 GiB budget above. Those entries were also beyond
the cleanup's reach, which reaps closed-pull-request scopes while these were
written on a tag. A registry cache costs no Actions budget, expires on no timer,
and the `docker` job in `ci.yml` reads the same ref.

Cache **mounts** (`--mount=type=cache`) are a separate mechanism and remain
local-only: BuildKit exports them to neither backend, so CI always pays a cold
compile for the layer that runs the build.

## Secrets

| Secret | Used by | For |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | `ci.yml` deploy | Pages Direct Upload |
| `RELEASE_PLEASE_TOKEN` | `release.yml` | Opening the release pull request |
| `NPM_TOKEN` | `npm-publish.yml` | npm automation token |
| `HOMEBREW_TAP_TOKEN` | `release.yml` | Pushing to the tap repository |
| `GITHUB_TOKEN` | everywhere | ghcr.io, releases, statuses, cache deletion |

crates.io needs no stored secret - `rust-lang/crates-io-auth-action` mints a
short-lived token from the workflow's OIDC identity.

Permissions are declared per workflow and widened per job rather than granted
workflow-wide; `cache-cleanup.yml` starts from `permissions: {}` and takes only
`actions: write` and `pull-requests: read`.

## Reproducing CI locally

CI runs the same `mise` tasks the pre-commit hooks do, just unconditionally and
over the whole tree instead of scoped to changed paths.

```bash
mise run fmt clippy typegen-check thread-guards test-rust   # rust-host
mise run licenses-check deny-policy machete                 # rust-host
mise run wasm-check                                         # wasm-check
mise run build-wasm-prod                                    # wasm
npm --prefix packages/rom-weaver-webapp run lint            # webapp
npm --prefix packages/rom-weaver-webapp run test:unit
npm --prefix packages/rom-weaver-webapp run test:browser:wasm

mise x -- actionlint                                        # lint the workflows themselves
```

The workflow files are covered by `actionlint`, which is shellcheck-aware and
so also lints the inline `run:` scripts.

## Gotchas

- **Never set `RUSTFLAGS` in the wasm build job.** Cargo *replaces* configured
  target flags instead of extending them, silently dropping shared memory, LTO,
  and exports. Overriding it for `wasm-check` is safe because nothing is
  linked.
- **`cargo publish --dry-run` exits 0 when a package sets `publish = false`**,
  so that CI gate becomes a silent no-op rather than an error.
- **The root `package-lock.json` needs hand-preserved `@rom-weaver/*` optional
  entries.** The scope is not fully published, so a plain `npm install` strips
  them and `npm ci` then breaks every job. A lefthook `root-lock-sync` hook
  guards this.
