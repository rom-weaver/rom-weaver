# Releases

`release.yml` runs Release Please on every push to `main`. Conventional
`feat`, `fix`, and breaking-change commits update a release pull request and
`CHANGELOG.md`. Merging that pull request creates the `vX.Y.Z` tag and GitHub
Release, then publishes:

- the Cargo workspace to crates.io;
- the native launcher and platform packages to npm;
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
4. Add `NPM_TOKEN` as an Actions secret. It must be allowed to publish the five
   npm packages; GitHub's OIDC token is used to attach npm provenance.
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
