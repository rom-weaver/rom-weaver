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
  - [`scripts/ci/classify-changes.sh`](#scriptsciclassify-changessh)
  - [`scripts/ci/resolve-wasm-run.sh`](#scriptsciresolve-wasm-runsh)
  - [`scripts/ci/npm-publish-package.mjs`](#scriptscinpm-publish-packagemjs)
- [Release fan-out](#release-fan-out)
  - [Containers reuse what the fan-out already built](#containers-reuse-what-the-fan-out-already-built)
  - [Draft-first releases](#draft-first-releases)
  - [Package managers publish last](#package-managers-publish-last)
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
| `commitlint.yml` | PR (open/edit/sync) | **Yes** | Conventional-commit pull request title |
| `codeql.yml` | source push to `main`, weekly, manual | No | Static analysis into the Security tab |
| `coverage.yml` | weekly Sunday 06:43 UTC, manual | No | Rust + React coverage reports |
| `parity.yml` | nightly 07:13 UTC, manual | No | Byte parity against live chdman / dolphin-tool, with an exact cached CLI |
| `e2e-nightly.yml` | manual | No | Exhaustive Chromium E2E matrix |
| `cache-cleanup.yml` | every 6 h, manual | No | Reap closed-PR and superseded Actions caches |
| `release.yml` | after a successful `CI` on `main`, manual | n/a | Release Please, then the publish fan-out |
| `cargo-publish.yml` | `v*` tag push, manual | n/a | crates.io publish |
| `npm-publish.yml` | called by `release.yml` | n/a | 9 platform packages, launcher, alias |
| `docker-publish.yml` | called by `release.yml`, manual | n/a | CLI + webapp images to ghcr.io |

Coverage is deliberately sampled weekly rather than repeated after every green
`main` build. It restores the source-exact production WASM cache and builds on
a miss, so the report still covers the current commit; manual runs use the same
path.

`commitlint.yml` lints the **pull request title only**. Merge commits are
disabled and squash merges take `PR_TITLE` as the subject, so the title is the
only text that reaches `main` and the only text Release Please reads. Branch
commits are squashed away, so they are not linted.

Nothing publishes on a push. `release.yml` runs on `workflow_run` gated on a
**successful** CI, and even then only opens a release pull request; merging
that pull request is what sets `release_created` and unlocks the publish jobs.

> **`main` is protected by the active `main protection` ruleset.** Pull requests
> must use squash merge and pass `Rust`, `Conventional commits`, `Build WASM
> module`, `Lint workflows + scripts + Dockerfiles`, `Webapp`, `Docker build
> (CLI)`, and `Docker build (webapp)`.

## `ci.yml` - the required gate

```
changes ── changed paths -> rust / webapp / security

             ┌── rust-host ─────┐
changes ─────┼── rust-macos ────┼── rust (aggregate check name)
             ├── rust-windows ──┤
             └── cli-platforms ─┘ (9 release targets)

         ┌── webapp-static ───┐
         ├── webapp-browser ──┼── webapp (aggregate check name)
         ├── webapp-wasm-e2e ─┤
         ├── webapp-webkit-e2e┘
wasm ────┤
         └── deploy ── Cloudflare Pages, one leg per channel (non-gating)
                 ↑
           deploy-plan ── ref -> channel list

webapp-static ── docker-prebuilt (webapp) - the release COPY path

security ── advisories (warn only, always green)
```

### Jobs

- **`changes`** classifies the pull request or push diff once. Rust and
  vendored C changes select Rust, webapp integration, and the CLI image build;
  webapp-only changes select the webapp while restoring the exact cached WASM
  module; dependency manifests select the advisory scanners. Documentation
  changes select none of those expensive stacks. Manual runs and changes to
  CI, coverage, the toolchain, or the classifier run everything.
- **`repo-lint`** lints the repository's own plumbing: `actionlint` over the
  workflows and composite actions, `shellcheck` over every tracked `.sh`, and
  `hadolint` over the Dockerfiles. It installs no language toolchain and
  compiles nothing, so it reports in well under a minute instead of hiding
  behind a build job. `actionlint` shells out to `shellcheck` for `run:`
  blocks, which is why both are in its `tools:` list.
- **`docker`** builds the CLI and webapp images **from source** without
  pushing, so a broken Dockerfile fails here rather than at the moment it
  blocks a release publish. The CLI leg runs for Cargo workspace sources and
  manifests as well as its image plumbing, so the required check builds the
  image whenever its binary changes. The webapp source leg runs only when its
  image plumbing changes (the Dockerfile, `.dockerignore`,
  `docker-compose.yml`, `sws.toml`, the Docker compression script, `ci.yml`, or
  `docker-publish.yml`); ordinary webapp changes use the release-equivalent
  prebuilt smoke below. On `main`, source builds also refresh their registry
  cache. The CLI leg additionally smokes the `BINARY=prebuilt` release path
  with a stub binary whenever it is selected.

  Handing this job CI's cached wasm to lift the gate does not work. The CLI
  image contains no wasm at all - it is `cargo build --release -p
  rom-weaver-cli`, and CI publishes no Linux release binary to reuse - and for
  the webapp, `DIST=prebuilt` skips the entire builder stage (rustup, the
  pinned WASI SDK and binaryen checksums, `npm ci`, the wasm compile), which is
  exactly the fragile half this job exists to test.
- **`docker-prebuilt`** builds the webapp's `DIST=prebuilt` release path. It
  consumes the real `webapp-dist` artifact `webapp-static` uploads, so
  `compress-static-assets.mjs` runs over the real bundle. The CLI equivalent
  stays in the image-gated `docker` leg instead of starting a separate runner
  after every Rust or webapp change.
- **`wasm`** builds the production WASM module. This is the single most
  expensive step in the pipeline (~6.5 min) and it used to run twice, so it is
  built once here and shared with `webapp` and `deploy` as an artifact, and
  with `release` by artifact download. A webapp-only change
  restores it by its source-exact key; a change outside the webapp/runtime
  stack leaves the required job present but does no artifact work.
- **`rust-host`** is everything needing a host-profile Rust build: fmt, clippy,
  typegen drift, whitespace, thread guards, the Rust test suite, license
  attribution, `cargo deny` licenses/sources, unused dependencies, and a
  `cargo publish --dry-run`.
- **`cli-platforms`** builds and packages every native release target before
  release day: macOS arm64/x86-64; Linux x86-64 GNU plus arm64/i686/x86-64
  musl; and Windows arm64/x86/x86-64 MSVC. Every binary verifies a SHA-256;
  round-trips ZIP, 7z, and Z3DS; extracts fixed CHD, RVZ, TAR, and RAR fixtures;
  and creates/applies fourteen patch formats on its target architecture. Native
  arm64 runners and OS emulation cover the 32-bit x86 targets. The matrix runs
  only when Rust or native-package inputs change.
- There is **no separate `wasm-check` job**. It ran `cargo check -p
  rom-weaver-containers --lib` against `wasm32-wasip1-threads`, which `wasm`
  already compiles as a strict subset (the app build pulls `containers` in with
  default features), and whose cache key covers every input that could break
  it - so a cache hit means nothing checkable changed. The check remains part
  of the broad local `mise run ci` gate.
- **`rust-macos`** runs the Rust test suite on `macos-14` (arm64) - the
  platform the release fan-out ships CLI binaries for, but that nothing
  previously tested. It uses the same mise/setup-build-env path as the Linux
  jobs. fmt, clippy, typegen, and the policy checks are platform-independent
  and already gate in `rust-host`.
- **`rust-windows`** runs the Rust test suite on `windows-2025`. It installs
  the toolchain with `dtolnay/rust-toolchain` (pin read from `.mise.toml`)
  rather than mise, whose `[env]` exec templates assume a POSIX shell; the
  release jobs already prove this route on the same image. Because it bypasses
  mise it re-declares `CARGO_INCREMENTAL=0` itself, and it trims MSVC debug
  info to line tables (`CARGO_PROFILE_DEV_DEBUG=line-tables-only`) - PDB
  generation is the priciest part of a Windows debug build. No wasm leg:
  building the wasm module on Windows is unsupported until the bash compiler
  shims have a native counterpart.

  The test run phase uses cargo-nextest on every platform leg (the mise legs
  through the `test-rust` task, Windows via `taiki-e/install-action` at the
  same pinned version). nextest does not execute doctests, so each leg runs a
  separate `cargo test --doc` pass rather than silently shrinking the suite.
- **`rust`** is an aggregator: it fails unless selected jobs succeeded and
  unselected jobs were intentionally skipped. It also fails if classification
  itself failed.
  Its only purpose is to present one stable check name (`Rust`) while the work
  runs in parallel, so branch protection has a single thing to require.
- **`security`** runs on dependency-manifest changes and executes `cargo deny
  advisories` and `npm audit`. **Deliberately
  non-gating** - an advisory can be published against a transitive dependency
  without any commit of ours, and letting that turn every open pull request red
  blocks unrelated work. Findings surface as warnings via
  `scripts/warn-only.sh`; the job stays green.
- **`webapp-static`**, **`webapp-browser`**, **`webapp-wasm-e2e`**, and
  **`webapp-webkit-e2e`** consume
  the prebuilt module and compile no Rust. The work is split three ways so the
  parallel browser suite - the single longest webapp step - is never
  serialized behind the rest: `webapp-static` is the node-only work (build
  script tests, lint, unit tests, vite build; no Playwright install),
  `webapp-browser` is the parallel browser suite alone and uses Chrome from the
  Ubuntu runner image, while `webapp-wasm-e2e` is the remaining Playwright work
  (icon check, wasm browser suite, webapp E2E); the WebKit leg runs the
  supported Safari-family implementation on macOS.
- **`webapp`** is the aggregator for those four, mirroring `rust`: one stable
  check name (`Webapp`) while the suites run in parallel.
- **`deploy-plan`** turns the ref into the list of channels to publish (below).
  It exists as its own job because a matrix can only be fed by an upstream
  job's output. Documentation-only commits do not deploy; webapp/runtime
  changes, tags, and explicit manual deploys do.
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

| Channel | Cloudflare project | URL | Intended use |
| --- | --- | --- | --- |
| `prod` | `rom-weaver` | [rom-weaver.com](https://rom-weaver.com/) | Stable public webapp |
| `beta` | `rom-weaver-beta` | [beta.rom-weaver.com](https://beta.rom-weaver.com/) | Release candidates and prereleases |
| `nightly` | `rom-weaver-nightly` | [nightly.rom-weaver.com](https://nightly.rom-weaver.com/) | Latest webapp changes from `main` |
| `preview` | `rom-weaver-preview` | `pr-<n>.rom-weaver-preview.pages.dev` | Review an internal pull request |

Only production is intended for search indexing. Beta, nightly, and pull-request
preview builds include `noindex, nofollow` in both the HTML robots metadata and
the Cloudflare `X-Robots-Tag` response header, and their generated `robots.txt`
blocks crawling with `Disallow: /`. Production instead publishes `Allow: /`.
Its sitemap lists the two stable, crawlable workflow pages:
[`/weave`](https://rom-weaver.com/weave) and
[`/create`](https://rom-weaver.com/create). History API navigation keeps those
URLs distinct; the generated HTML gives each its own title, description, and
canonical URL plus Open Graph and Twitter card metadata.

Each build also generates Cloudflare Pages `_headers`. All channels receive the
cross-origin isolation headers required by threaded WASM. Content-hashed
`/assets/*` responses use a one-year immutable browser cache, while
`cache-service-worker.js` uses `no-cache` so a deployment is discovered
promptly. Non-production channels add their `X-Robots-Tag` in the same file.

The channels form a stability ladder - `prod` above `beta` above `nightly` -
and a ref deploys to the channel it enters at **plus every less-stable channel
below it**. Otherwise a quiet stretch on `main` would leave beta and nightly
serving code older than production, which makes them useless for reproducing a
release-day bug.

| Ref | Deploys to |
| --- | --- |
| `vX.Y.Z` tag | `prod`, `beta`, `nightly` |
| `vX.Y.Z-alpha.N` tag | `beta`, `nightly` |
| webapp/runtime push to `main` | `nightly` |
| webapp/runtime pull request | `preview` |

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
as a commit status (`preview/webapp`) and in one marker-backed PR comment.
Repeated deployments update that comment instead of accreting comments.

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
  against are outside the cache, so a hit still runs `install-deps`. The
  parallel browser job skips this cache and uses Chrome already installed on
  the Ubuntu runner image.

### `.github/actions/wasm-cache`

Restores a prebuilt WASM module (`variant: prod` for CI and weekly coverage,
`dev` for the nightly E2E suite, which needs an unoptimized module CI never
builds). The key is a
SHA-256 over `git ls-tree` of every source, dependency, toolchain, and
build-script input - `git ls-tree` rather than `hashFiles` because it resolves
the pull request merge tree, and because the `crates` tree SHA covers the
vendored libarchive sources under it.

Deliberately no `restore-keys`: a partial-prefix hit could serve a module built
from different source. A miss costs one build; a false hit ships stale WASM.
`cache-epoch` invalidates everything by hand.

### `scripts/ci/classify-changes.sh`

Maps changed paths to the Rust, webapp, dependency-scanning, and per-image
Docker stacks.
Rust and vendored C imply webapp integration, while webapp-only
changes do not imply Rust. Changes to CI, coverage, toolchain setup, or the
classifier fail open by selecting every stack.
`scripts/ci/classify-changes.test.mjs` pins these boundaries.

### `scripts/ci/resolve-wasm-run.sh`

Finds the CI run that built `wasm-prod` for a commit, so release packaging ships
the exact module CI tested. It prefers the
triggering run, **verifies that run is actually for this commit** (a
`workflow_run` event can fire for a re-run or lose a race with a newer push),
otherwise searches by commit, and finally confirms the artifact has not
expired. Release falls back to a source build when it is unavailable.

### `scripts/ci/npm-publish-package.mjs`

Publishes one package idempotently. Eleven packages go out per release through
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
| `semver-check` | nothing - gates the publish on no accidental breaking API change |
| `cargo-publish-dry-run` | nothing - gates npm and draft publication on crates.io accepting Cargo metadata |
| `static-webapp` | `rom-weaver-webapp.tar.gz` + checksum on the GitHub release |
| `publish-npm` | 9 platform packages → launcher → unscoped alias, in that order |
| `publish-containers` | `ghcr.io/.../rom-weaver-cli` and `-webapp`, signed provenance |
| `publish-release` | flips the draft release to published, creating the tag |
| `publish-homebrew` | formula commit to `brandonocasey/homebrew-tap` (stable only) |
| `publish-scoop` | manifest commit to `brandonocasey/scoop-bucket` (stable only) |

The table is in dependency order. Everything above `publish-release` attaches an
asset to the draft or gates it; the two package-manager pushes come after it, and
[Package managers publish last](#package-managers-publish-last) explains why.

Ordering inside `publish-npm` is load-bearing: the unscoped `rom-weaver` alias
is a dependency-only pointer at `@rom-weaver/cli`, so publishing it first would
make installs resolve a version that is not on the registry yet.

### Containers reuse what the fan-out already built

`publish-containers` runs after `static-webapp` and `publish-npm` rather than
beside them, because both images are now assembled from artifacts those jobs
produce from the same commit:

| Image | Consumes | Instead of |
| --- | --- | --- |
| `rom-weaver-cli` | `cli-binary-linux-x64-gnu`, the `linux-x64-gnu` binary `publish-npm` builds | a second `cargo build --release` of the workspace |
| `rom-weaver-webapp` | `webapp-dist`, the bundle `static-webapp` packages | rustup + WASI SDK + binaryen + a cold wasm build |

Each Dockerfile keeps both paths and picks with a build arg (`BINARY`, `DIST`)
that defaults to building from source, so `docker build` with no arguments -
what self-hosters and the `docker` job in `ci.yml` run - is unchanged. The
prebuilt half reads a `prebuilt/` directory out of the build context, which only
has to exist for the build that asks for it: BuildKit builds only the stages the
selected one depends on. `docker-publish.yml` downloads the artifact, falls back
to `source` when there is none, and so still works standalone under
`workflow_dispatch`, where there are no sibling jobs.

Two consequences worth knowing:

- The CLI runtime is `gcr.io/distroless/cc-debian13`, and the `debian13`
  (trixie) half of that is load-bearing, not bookworm. The reused binary is
  linked against the glibc of the `ubuntu-24.04` runner `publish-npm` builds on
  (2.39), which bookworm's 2.36 cannot load; trixie ships 2.41 and accepts both
  halves of the switch. `-cc` rather than `-base` supplies the
  libgcc/libstdc++ the vendored C deps expect. There is no shell in the image.
- `static-webapp` packages a raw webapp tarball. The webapp Dockerfile adds the
  `.br` siblings that its static-web-server expects (`compression-static` in
  `sws.toml`) after the shared raw artifact is copied. No `.gz` siblings: sws
  gzips on demand for the rare client without brotli, which keeps ~2.8 MB out
  of the image.
- `static-webapp` also owns the **build channel** for everything that is not a
  Cloudflare deploy. Its bundle becomes both `rom-weaver-webapp.tar.gz` and the
  container image, so it passes `ROM_WEAVER_CHANNEL` explicitly: `beta` for a
  prerelease, `prod` otherwise, on the same hyphen test as the rest of the
  prerelease routing. Without it a prerelease image would claim production
  while the deploy ladder put the same commit on `beta.rom-weaver.com`. The
  `deploy` job passes its own channel per target; an unset channel builds as
  `prod`, which is what a plain `npm run build` by a self-hoster should be.

A prebuilt build deliberately does **not** write the `buildcache` tag: it has
nothing expensive to cache, and exporting its handful of `COPY` layers would
evict the source layer graph that the `docker` job in `ci.yml` restores.

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
The standalone Cargo and Docker dispatches fall back to `v${version}`, which by
then exists.

`cargo-publish.yml` is triggered by the resulting `v*` tag push instead of being
called by `release.yml`. `release.yml` never runs on an event crates.io Trusted
Publishing accepts: ordinary commits reach it through `workflow_run`, which
Trusted Publishing rejects outright, and the runs that actually set
`release_created` arrive through `pull_request` (the release pull request
closing), which it will not accept either. A job inherits its workflow's event,
so OIDC could never authenticate from inside the fan-out. Keying off the tag
also orders it naturally last.

`cargo-semver-checks` runs in `release.yml` as the `semver-check` job, not in
`cargo-publish.yml` where it used to live. By the time the tag exists the
release is published and immutable and the version can never be re-cut, so a
break found there could not be acted on; as a gate on `publish-release` a
failure leaves a deletable draft instead. It publishes nothing, so it needs no
registry credentials and runs alongside the publishing jobs.

It runs per-crate rather than `--workspace` so a crate with no published
baseline (a first release, or a newly added crate) is skipped instead of
failing the whole job.

### Package managers publish last

`publish-homebrew` and `publish-scoop` run **after** `publish-release`, not as
gates on it. Both write a manifest whose download URL is
`releases/download/vX.Y.Z/...`, and a draft release's assets are not publicly
downloadable - pushing them earlier put a live formula in the tap and a live
manifest in the bucket whose URLs 404 until the draft was published.

The ordering costs the property that a tap failure holds the draft, and that is
the better half of the trade. These two are the only publishes in the fan-out
that are trivially retryable: a git push to a repository we own, with no
registry state to reconcile. Rerunning the job fixes it. Everything that *is*
irreversible - npm, the container registry, the release itself - still gates
`publish-release`, and crates.io still runs after the tag for the same reason.

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
that fills. Three mechanisms keep it under the cap; they exist because it was
exceeded (11.46 GB, with 5.1 GB parked in six closed Dependabot pull requests,
evicting the `main` caches every cold run depends on).

1. `save-if: github.ref == 'refs/heads/main'` on the cargo cache, so branch
   runs restore but never write.
2. `cache-cleanup.yml` runs every six hours and deletes two kinds of dead
   weight: caches belonging to closed and merged pull requests, and superseded
   generations - entries whose key family (the key minus its trailing content
   hashes) has a newer save in the same ref scope, which restores prefix-match
   past but that still occupy hundreds of megabytes each. `wasm-prod` is
   exempt from generation pruning: it restores by exact fingerprint key, so an
   older ~4 MB entry is still what a branch based on older `main` asks for.
   The job warns in its summary if usage is still above 9 GiB afterwards.
3. `parity.yml` caches only its release CLI binary, keyed without restore
   prefixes over the Rust/C source and toolchain inputs, and saves only on
   `main`. The nightly check still installs and runs the current external tools.

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
| `HOMEBREW_TAP_TOKEN` | `release.yml` | Pushing to the tap repository |
| `SCOOP_BUCKET_TOKEN` | `release.yml` | Pushing to the Scoop bucket repository |
| `GITHUB_TOKEN` | everywhere | ghcr.io, releases, statuses, cache deletion |

crates.io needs no stored secret - `rust-lang/crates-io-auth-action` mints a
short-lived token from the workflow's OIDC identity.

npm trusted publishing likewise uses the workflow's OIDC identity and needs no
stored npm secret.

Permissions are declared per workflow and widened per job rather than granted
workflow-wide; `cache-cleanup.yml` starts from `permissions: {}` and takes only
`actions: write` and `pull-requests: read`.

## Reproducing CI locally

The pre-commit hooks select lint checks from the staged paths. CI reuses those
tasks over the whole tree, then adds tests, builds, publishability checks, and
the macOS/Windows Rust legs. `mise run ci` is the broad local gate; use the
individual commands below when narrowing a failure or matching a specific job.

```bash
mise run ci                                                  # broad local gate

mise run actionlint ::: shellcheck ::: hadolint                  # repo-lint
node --test scripts/ci/classify-changes.test.mjs                 # change boundaries
mise run fmt ::: clippy ::: typegen-check ::: whitespace ::: thread-guards
mise run test-rust ::: licenses-check ::: deny-policy ::: machete # rust-host
cargo publish --workspace --locked --dry-run --no-verify     # rust-host
mise run wasm-check                                          # local threaded-target check
mise run build-wasm-prod                                     # wasm
npm test                                                     # webapp build-script tests
npm --prefix packages/rom-weaver-webapp run lint             # webapp lint fan-out
npm --prefix packages/rom-weaver-webapp run icons:channels:check
npm --prefix packages/rom-weaver-webapp run test:unit
npm --prefix packages/rom-weaver-webapp run test:browser:wasm
npm --prefix packages/rom-weaver-webapp run test:browser:parallel
npm --prefix packages/rom-weaver-webapp run test:e2e:webapp
npm --prefix packages/rom-weaver-webapp run build
```

`actionlint` is shellcheck-aware and also lints inline workflow `run:` scripts;
the separate `shellcheck` task covers tracked shell files. `docker` is
conditional on image-plumbing changes and is most directly reproduced with the
source-build commands in the [self-hosting guide](self-hosting.md);
`docker-prebuilt` is `docker build --build-arg DIST=prebuilt .` with the bundle
staged under `prebuilt/`; the CLI job uses `BINARY=prebuilt` when its packaging
inputs change.

## Gotchas

- **Never set `RUSTFLAGS` in the wasm build job.** Cargo *replaces* configured
  target flags instead of extending them, silently dropping shared memory, LTO,
  and exports. Overriding it for `wasm-check` is safe because nothing is
  linked.
- **`cargo publish --dry-run` exits 0 when a package sets `publish = false`**,
  so that CI gate becomes a silent no-op rather than an error.
- **The root `package-lock.json` needs generated `@rom-weaver/*` optional
  entries.** The scope is not fully published when Release Please opens a new
  release PR, so `scripts/sync-version.mjs` writes local platform-package lock
  entries without registry `resolved`/`integrity` fields. A lefthook
  `root-lock-sync` hook guards this.
- **`COPY --chmod` silently drops the sticky bit.** It takes the low nine bits
  only, so `--chmod=1777` yields `drwxrwxrwx`, not `drwxrwxrwt`. Naming a
  directory as the COPY *source* does not preserve its mode either - only its
  contents are contributed, and the destination is recreated 0755. The CLI
  image needs a sticky-writable `/work` and has no shell to `mkdir` with, so it
  builds the directory in a throwaway stage and copies the **parent**, which
  does preserve the mode of everything inside. Verify with `ls -ld /work` from
  a shell-bearing stage; `drwxrwxrwt` is the passing result.
