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
3. Publish each Cargo crate once with a crates.io token, then configure a
   crates.io trusted publisher for every published crate. Select this repository
   and `.github/workflows/cargo-publish.yml`; the workflow then uses short-lived
   OIDC credentials and needs no stored Cargo token.
4. Add `NPM_TOKEN` as an Actions secret. It must be allowed to publish the five
   npm packages; GitHub's OIDC token is used to attach npm provenance.
5. Require the `Conventional commits` and normal CI checks in the `main` branch
   protection rules. Use squash merges so the validated pull request title is
   the commit subject that lands on `main`.
6. Ensure the existing `v0.5.0` tag is present on GitHub before the first run.

Use `feat(scope): ...` for a minor release, `fix(scope): ...` for a patch, and
`feat(scope)!: ...` (or a `BREAKING CHANGE:` footer) for a major release. Other
allowed types do not trigger a release by themselves.

To retry a partially completed release, rerun its failed jobs. The standalone
publisher workflows also accept a version without the `v` prefix and check out
that release tag before publishing.
