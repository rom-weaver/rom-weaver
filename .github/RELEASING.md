# Releases

`release.yml` runs Release Please on every push to `main`. Conventional
`feat`, `fix`, and breaking-change commits update a release pull request and
`CHANGELOG.md`. Merging that pull request creates the `vX.Y.Z` tag and GitHub
Release, then publishes:

- the Cargo workspace to crates.io;
- six npm packages: `@rom-weaver/cli`, its four `@rom-weaver/<platform>`
  binaries, and the unscoped `rom-weaver` alias that depends on the launcher;
- `ghcr.io/<owner>/rom-weaver-cli`;
- `ghcr.io/<owner>/rom-weaver-webapp`.

The npm packages include npm provenance, Cargo authenticates with crates.io's
GitHub OIDC trusted publisher, and both container images include an SBOM plus
signed SLSA build provenance. Publishers check the registry before writing, so
reruns skip versions that already exist instead of failing halfway through a
release.

## One-time repository setup

1. In GitHub Actions settings, allow workflows to read and write the repository
   and to create pull requests.
2. Add a fine-grained `RELEASE_PLEASE_TOKEN` Actions secret with Contents,
   Issues, and Pull requests read/write access to this repository. Release
   Please needs a non-`GITHUB_TOKEN` credential so its release pull requests
   trigger the required CI checks.
3. Sign in to crates.io and create an API token for the first-release bootstrap
   described below.
4. Add `NPM_TOKEN` as an Actions secret - a **granular access token with
   "Bypass 2FA" enabled**, scoped to the six public packages (`@rom-weaver/cli`,
   `rom-weaver`, and the four `@rom-weaver/<platform>` packages). Classic
   automation tokens no longer exist: npm disabled their creation in November
   2025 and permanently revoked every outstanding one on 2025-12-09. Granular
   tokens with write access expire after **90 days at most**, so this secret
   needs rotating on that cadence until the migration in "npm trusted
   publishing" below removes it. GitHub's OIDC token attaches npm provenance
   independently of how the publish authenticates.
5. Require the `Conventional commits` and normal CI checks in the `main` branch
   protection rules. Use squash merges so the validated pull request title is
   the commit subject that lands on `main`.
6. Ensure the existing `v0.5.0` tag is present on GitHub before the first run.

Push the baseline tag and current branch to start Release Please:

```bash
git push origin v0.5.0
git push origin main
```

## First Cargo release

crates.io requires each crate to be published manually once before trusted
publishing can be configured. Wait for Release Please to open its release pull
request and for that pull request to pass CI. From a clean checkout of its final
commit, publish the workspace:

```bash
cargo login
cargo publish --workspace --exclude rom-weaver-typegen --locked
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

Trusted publishing (OIDC) removes `NPM_TOKEN` and its 90-day rotation
entirely. It cannot be configured up front: npm has no way to register a
package that does not exist yet, so the **first** publish of each package must
use the token above. Migrate afterwards.

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
execute under `release.yml`. It does **not** cover dispatching `npm-publish.yml`
directly - npm would see the wrong workflow name and reject the token. See
"Retry a failed publication".

Once every package publishes through OIDC, drop `NPM_TOKEN` from the repository
secrets, from the `secrets:` block in `release.yml`, and from both
`NODE_AUTH_TOKEN` environments in `npm-publish.yml`. Only then set each package
to "Require 2FA and disallow tokens" on npmjs.com: that setting does not affect
trusted publishing, but applying it before the bootstrap completes locks out the
token publish that bootstrap depends on.

Keep the explicit `--provenance` flag. npm documents provenance as automatic
under trusted publishing, but it has been reported not to attach; passing the
flag is harmless when redundant.

## GitHub Pages and the custom domain

`pages.yml` builds the wasm bundle and webapp on every push to `main` and
deploys through `actions/deploy-pages`, so **Settings - Pages - Source** must be
**GitHub Actions**, not a branch. No `CNAME` file is committed; the domain
configured in repository settings is authoritative for Actions-based deploys.

To serve the site from `rom-weaver.com`, point DNS at GitHub Pages - the four
apex `A` records (`185.199.108-111.153`), the matching `AAAA` records
(`2606:50c0:8000-8003::153`), and a `CNAME` on `www` to
`brandonocasey.github.io.` - then set the domain under **Settings - Pages** and
enable **Enforce HTTPS** once the certificate is issued.

The webapp builds with a relative base (`base: "./"` in `vite.config.mjs`), so
it works unchanged at an apex domain, a project subpath, or the existing Forgejo
mirror. One value is **not** relative: the bundle schema's `$id` in
`docs/rom-weaver-bundle.schema.json` is an absolute Forgejo URL. Changing it
changes the schema's identity, so published bundles referencing the old `$id`
keep resolving against the old host - decide deliberately rather than as part of
a domain switch.

## Normal release flow

Commit and push changes using Conventional Commits:

```bash
git commit -m "feat(cli): describe the feature"
git push origin main
```

Use `feat(scope): ...` for a minor release, `fix(scope): ...` for a patch, and
`feat(scope)!: ...` (or a `BREAKING CHANGE:` footer) for a major release. Other
allowed types do not trigger a release by themselves.

Release Please opens or updates a release pull request. Merging it creates the
tag and GitHub Release and runs every publisher. Follow progress under GitHub's
**Actions → Release** page.

## Retry a failed publication

Rerun the failed jobs in the Release workflow. Alternatively, manually run one
of these workflows with the version without a `v` prefix, such as `0.6.0`:

- Publish Cargo crates;
- Publish npm CLI;
- Publish Docker images.

Each workflow checks out the matching release tag. Registry checks make Cargo
and npm retries safe when a previous attempt published only some packages.

Once npm trusted publishing is in place, the manual `Publish npm CLI` dispatch
stops working - npm validates against the calling workflow's filename and would
see `npm-publish.yml` instead of the registered `release.yml`. Re-running the
failed jobs from the original Release run remains the supported npm retry, since
it executes under `release.yml`. Dispatching `release.yml` is not a substitute:
its publish jobs are gated on `release_created`, which is false when no new
release is cut. Cargo and Docker dispatches are unaffected.

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
