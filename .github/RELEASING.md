# Releases

This is the release *decision* and its one-time setup. For the pipeline that
executes it - workflows, jobs, caching, and the publish fan-out - see
[`docs/ci.md`](../docs/ci.md).

`release.yml` runs Release Please after CI succeeds on `main`, or when started
manually. Conventional `feat`, `fix`, and breaking-change commits update a
release pull request and `CHANGELOG.md`. Merging that pull request creates the
`vX.Y.Z` tag and GitHub Release, then publishes:

- the Cargo workspace to crates.io;
- six npm packages: `@rom-weaver/cli`, its four `@rom-weaver/<platform>`
  binaries, and the unscoped `rom-weaver` alias that depends on the launcher;
- the `rom-weaver` formula in `brandonocasey/homebrew-tap` for stable releases;
- the `rom-weaver` manifest in `brandonocasey/scoop-bucket` for stable releases;
- `ghcr.io/<owner>/rom-weaver-cli`;
- `ghcr.io/<owner>/rom-weaver-webapp`.

The npm packages include npm provenance, Cargo authenticates with crates.io's
GitHub OIDC trusted publisher, and both container images include an SBOM plus
signed SLSA build provenance. Publishers check the registry before writing, so
reruns skip versions that already exist instead of failing halfway through a
release.

No GitHub Release, registry package, or tap formula has been published yet.
Complete the one-time setup below before treating the public package commands
as available.

<!-- START doctoc -->
## Table of contents

- [One-time repository setup](#one-time-repository-setup)
- [First Cargo release](#first-cargo-release)
- [npm trusted publishing](#npm-trusted-publishing)
- [Webapp hosting and the channel domains](#webapp-hosting-and-the-channel-domains)
- [Normal release flow](#normal-release-flow)
  - [How a prerelease differs](#how-a-prerelease-differs)
- [Retry a failed publication](#retry-a-failed-publication)
- [Run the containers locally](#run-the-containers-locally)

<!-- END doctoc -->

## One-time repository setup

1. In GitHub Actions settings, allow workflows to read and write the repository
   and to create pull requests.
2. Add a fine-grained `RELEASE_PLEASE_TOKEN` Actions secret with Contents,
   Issues, and Pull requests read/write access to this repository. Release
   Please needs a non-`GITHUB_TOKEN` credential so its release pull requests
   trigger the required CI checks.
3. Sign in to crates.io and create an API token for the first-release bootstrap
   described below.
4. Require the `Conventional commits` and normal CI checks in the `main` branch
   protection rules. Use squash merges so the validated pull request title is
   the commit subject that lands on `main`.
5. Ensure the existing `v0.5.0` tag is present on GitHub before the first run.
6. Enable **Immutable releases** in Settings → General. The fan-out is built
   for it: releases are created as drafts and published only after every asset
   is attached. Read the warning under [normal release flow](#normal-release-flow)
   before touching a draft by hand.
7. Create the public `brandonocasey/homebrew-tap` repository with a README,
   then add a fine-grained `HOMEBREW_TAP_TOKEN` Actions secret with Contents
   read/write access to that repository. Stable releases update
   `Formula/rom-weaver.rb`; prereleases leave the tap unchanged.
8. Create the public `brandonocasey/scoop-bucket` repository with a README and
   an empty `bucket/` directory, then add a fine-grained `SCOOP_BUCKET_TOKEN`
   Actions secret with Contents read/write access to it. Stable releases update
   `bucket/rom-weaver.json`; prereleases leave the bucket unchanged.

Push the baseline tag and current branch to start Release Please:

```bash
git push origin v0.5.0
git push origin main
```

## First Cargo release

crates.io requires each crate to be published manually once before trusted
publishing can be configured. Wait for Release Please to open its release pull
request and for that pull request to pass CI. The workspace publishes five
packages: `rom-weaver-core`, `rom-weaver-checksum`, `rom-weaver-containers`,
`rom-weaver-patches`, and `rom-weaver-cli`. From a clean checkout of the release
pull request's final commit, publish them together:

```bash
cargo login
cargo publish --workspace --locked
```

Do not change the release pull request after this publish. Configure a trusted
publisher for every new crate on crates.io using:

- repository: `brandonocasey/rom-weaver`;
- workflow: `cargo-publish.yml`;
- environment: empty.

Merge the release pull request. The automated Cargo job will see that the
bootstrap versions already exist and skip them. Later releases use short-lived
OIDC credentials and do not need a stored Cargo token.

## npm trusted publishing

Trusted publishing (OIDC) is enabled for all six npm packages, so publishing
uses short-lived GitHub Actions credentials and no stored npm token.

The publish jobs already meet the mechanical requirements - `id-token: write`
is set, and the Node 24 toolchain ships npm 11.16.0, above the 11.5.1 minimum.

One caveat decides the configuration. npm validates the OIDC claim against the
**calling** workflow's filename, and `release.yml` reaches the publisher through
`workflow_call`, so npm sees `release.yml` rather than `npm-publish.yml`. Only
one trusted publisher may be configured per package, so register:

- repository: `brandonocasey/rom-weaver`;
- workflow: `release.yml` (filename only, no path);
- environment: empty.

That covers the release path and the "re-run failed jobs" retry, both of which
execute under `release.yml`. Direct dispatch of `npm-publish.yml` is not
available because npm would see the wrong workflow name. See "Retry a failed
publication".

The publish helper keeps its explicit `--provenance` flag; npm also generates
provenance automatically for trusted publishing.

## Webapp hosting and the channel domains

The deploy job in `ci.yml` publishes the tested webapp to **Cloudflare Pages**
with `wrangler pages deploy` (Direct Upload). Cloudflare does not build the
project, so it needs no WASI SDK and consumes no Cloudflare build minutes.

Three permanent channels and one pull-request preview project use separate
Cloudflare Pages origins. They are not subpaths of one site because OPFS,
service-worker scope, and Cache Storage are all per-origin; a shared origin
would let a nightly build read and corrupt production's OPFS state.

| Channel | Domain | Publishes on | Pages project |
| --- | --- | --- | --- |
| Production | `rom-weaver.com` | stable tag `vX.Y.Z` | `rom-weaver` |
| Beta | `beta.rom-weaver.com` | any release tag, stable or prerelease | `rom-weaver-beta` |
| Nightly | `nightly.rom-weaver.com` | every push to `main`, and any release tag | `rom-weaver-nightly` |
| Preview | generated `pages.dev` alias | internal pull request | `rom-weaver-preview` |

The three permanent channels are a stability ladder, and a deploy refreshes its
own channel **plus every less-stable one below it**. A stable release therefore
publishes to production, beta *and* nightly; a prerelease publishes to beta and
nightly. Without that cascade a quiet stretch on `main` would leave beta and
nightly serving code older than production - the opposite of what their names
promise, and useless for reproducing a release-day bug.

Production is CI-gated by construction: Release Please only tags after the
release PR's required checks are green, so an unreviewed push can never reach
`rom-weaver.com`. After that PR merges, the release workflow starts from the
merged PR event rather than waiting for a duplicate full CI run on the merge
commit. `workflow_dispatch` accepts a `deploy_channel` input to force one
channel manually; that override deploys only the channel named and does not
cascade.

Required repository secrets: `CLOUDFLARE_API_TOKEN` (needs **Account -
Cloudflare Pages - Edit**, plus **Zone - DNS - Edit** to attach custom domains)
and `CLOUDFLARE_ACCOUNT_ID`.

The workflow creates its own Pages project on first run for a channel, so there
is no manual bootstrap and no local `wrangler login` - which matters because
`wrangler login` needs a localhost OAuth callback and cannot complete on a
headless machine. An API token is the only credential this setup requires.

DNS lives in the same Cloudflare account, so adding a custom domain to a Pages
project creates the record automatically. Unlike the previous GitHub Pages
setup, records should stay **proxied** (orange) - Pages is Cloudflare-native, so
there is no origin-certificate chicken-and-egg and TLS is issued automatically.

The webapp builds with a relative base (`base: "./"` in `vite.config.mjs`), so
it works unchanged at an apex domain, a project subpath, or the Forgejo mirror.

One value is **not** relative: the bundle schema's `$id` in
`docs/rom-weaver-bundle-v1.schema.json`, mirrored by `BUNDLE_JSON_SCHEMA_URL` in
`crates/rom-weaver-cli/src/bundle_schema.rs` (a unit test asserts they match).
It points at the public GitHub raw-content URL. The published schema revision and
bundle version are both v1; other bundle versions are rejected. Treat any future
edit as a change of the schema's identity rather than a URL update: `$schema`
values are carried through bundles verbatim and never matched against this
constant.

The service worker in
`packages/rom-weaver-webapp/src/webapp/cache-service-worker.ts` injects the
COOP/COEP headers needed for cross-origin isolation and chooses the compatible
COEP mode at runtime. Do not replace this with a static `_headers` file without
testing Safari and iOS.

## Normal release flow

Commit and push changes using Conventional Commits:

```bash
git commit -m "feat(cli): describe the feature"
git push origin main
```

Use `feat(scope): ...` for a minor release, `fix(scope): ...` for a patch, and
`feat(scope)!: ...` (or a `BREAKING CHANGE:` footer) for a major release. Other
allowed types do not trigger a release by themselves.

Release Please opens or updates a release pull request. Merging it creates a
**draft** GitHub Release and runs every asset-producing publisher against that
draft. The `publish-release` job publishes it, which is what creates the
`vX.Y.Z` tag and in turn triggers the crates.io publish. The Homebrew and Scoop
pushes run after that, because the manifests they write point at release
download URLs that do not resolve while the release is a draft. Follow progress
under GitHub's **Actions → Release** page.

> **Never publish a draft release by hand, and never re-cut a version whose
> release was published.** Immutable releases are enabled, so publishing is a
> one-way door: the release accepts no further assets *and permanently reserves
> its tag name*, even if the release is later deleted. v0.6.0 was lost exactly
> that way - it published before its assets were uploaded, every upload came
> back `HTTP 422`, and the version could never be re-cut. A failed fan-out
> leaves a draft, which is safe: delete the draft and merge the release pull
> request again to retry the same version.

### How a prerelease differs

Every publisher keys off one thing: whether the version contains a hyphen
(`0.6.0-alpha.1` is a prerelease, `0.6.0` is not). Nothing else needs setting -
a `Release-As: X.Y.Z-alpha.N` footer is enough to route the whole pipeline.

| Target | Release `0.6.0` | Prerelease `0.6.0-alpha.1` |
| --- | --- | --- |
| Webapp | `rom-weaver.com` | `beta.rom-weaver.com` |
| npm dist-tag | `latest` | `beta` |
| Docker tags | `0.6.0`, `0.6`, `latest` | `0.6.0-alpha.1`, `beta` |
| crates.io | published | published |

Docker also publishes a major series tag (`1`, `2`, ...), but **only from
`1.0.0` on**. Pre-1.0 it is suppressed: a `0` tag would float across `0.5` ->
`0.6`, and semver treats a pre-1.0 minor bump as breaking, so the tag would
promise compatibility it cannot keep. It starts publishing itself once the
first `1.0.0` ships. Before v1.0, Release Please treats breaking changes as
minor bumps because `bump-minor-pre-major` is enabled.

When a stable release follows one or more prereleases, the release workflow
folds all same-version prerelease entries into the stable `CHANGELOG.md`
section and into the GitHub Release notes. The prerelease sections are removed
from the canonical changelog to avoid listing the same changes twice; the
individual prerelease GitHub Releases retain their own notes.

The rule exists because a prerelease that takes `latest` is effectively a
shipped regression: `npm i @rom-weaver/cli` and
`docker pull ghcr.io/<owner>/rom-weaver-cli` both resolve `latest` by default.
Cargo needs no equivalent guard - crates.io has no
dist-tags and Cargo will not resolve a prerelease unless a version request
explicitly asks for one.

Note the npm dist-tag is derived from the **version field**, never from the
`name@version` spec: several package names contain hyphens (`darwin-arm64`,
`linux-x64-gnu`), and matching the spec would tag every platform package as a
prerelease.

## Retry a failed publication

Run **Actions → Retry release**, enter the numeric run ID from the failed
**Release** workflow URL, and start it. This reruns the failed jobs and their
dependents while preserving successful jobs and the artifacts they produced.
Do not choose **Re-run all jobs**: that needlessly repeats the native builds.

Because the release is still a draft, `publish-release` will not have run, so
nothing is stamped immutable and the retry can still attach assets. A
`publish-homebrew` or `publish-scoop` failure is the exception: those run after
the release is published, so the release itself is fine and rerunning the one
job is the whole fix. From the CLI, the same recovery is:

```bash
gh workflow run release-retry.yml -f run_id=29885072562
```

Manual `workflow_dispatch` remains available for Cargo and Docker, taking the
version without a `v` prefix, such as `0.6.1`:

- Publish Cargo crates;
- Publish Docker images.

These dispatches check out `v<version>`, so they only work **after** the release
has been published and the tag exists. While the release is still a draft, rerun
the jobs from the original Release run instead. Registry checks make Cargo
retries safe when a previous attempt published only some packages.

If the fan-out cannot be salvaged, delete the draft release and re-merge the
release pull request: an unpublished draft holds no reservation on its tag name.

Re-run failed npm jobs from the original Release run. npm validates the calling
workflow's filename, so the reusable publisher must run under the registered
`release.yml` trusted publisher rather than through a direct dispatch.

## Run the containers locally

Build and run the CLI image:

```bash
docker build -t rom-weaver-cli .
docker run --rm rom-weaver-cli --help
```

Build and serve the webapp:

```bash
docker compose up --build
```

Open `http://localhost:8080`.
