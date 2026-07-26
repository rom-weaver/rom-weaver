# Commit and pull request title conventions

rom-weaver uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
Pull requests are squash-merged, so the **pull request title** becomes the commit
on `main` and is the input Release Please reads to decide the next version and
write the changelog entry. Branch commit messages are not linted; the title is
the one that has to parse.

<!-- START doctoc -->
## Table of contents

- [Format](#format)
- [Types](#types)
- [Scopes](#scopes)
- [Breaking changes](#breaking-changes)
- [Footers](#footers)
- [Checking a title before you push](#checking-a-title-before-you-push)

<!-- END doctoc -->

## Format

```
type(scope): description
```

- `type` is required and must come from the list below.
- `scope` is optional in Conventional Commits but **required by this project's
  commitlint config**, so include one.
- `description` is lower case, imperative, and no trailing full stop.
- The whole header is capped at 150 characters - raised from the usual 100 so
  grouped Dependabot titles fit.

```
fix(webapp): handle empty patch archives
perf(ci): build multi-arch images on native runners instead of QEMU
```

## Types

Allowed types come from `.config/commitlint.config.mjs`, which is the single
source of truth - the `PR Title Lint` check reads that same file, so this
list cannot drift into being enforced.

| Type | Use it for | Release effect |
| --- | --- | --- |
| `feat` | A new capability | Minor bump |
| `fix` | A bug fix | Patch bump |
| `perf` | A change that is faster without changing output | Patch bump |
| `revert` | Undoing an earlier change | Patch bump |
| `build` | Build system, packaging, vendored sources | Changelog only |
| `chore` | Maintenance with no user-visible effect | Changelog only |
| `ci` | Workflows, actions, release plumbing | Changelog only |
| `docs` | Documentation only | Changelog only |
| `dx` | Developer experience: hooks, scripts, local tooling | Changelog only |
| `refactor` | Restructuring with identical behavior | Changelog only |
| `style` | Formatting only | Changelog only |
| `test` | Tests only | Changelog only |

`perf` changes must not alter output bytes - compression and patch output is
validated against reference tools, so run the relevant `cli_smoke` tests.

## Scopes

Scopes are not enumerated in config, so use the shortest name that says where
the change lands: the crate (`core`, `containers`, `patches`, `cli`), the
surface (`webapp`, `wasm`, `docker`, `ci`, `dx`), or the format (`chd`, `iso`,
`bps`). Match what recent history uses for the same area rather than inventing a
synonym.

## Breaking changes

Append `!` after the type and scope, and explain the break in the body:

```
feat(cli)!: rename --output to --out
```

Before 1.0 a breaking change bumps the **minor** version, because
`bump-minor-pre-major` is enabled in `release-please-config.json`.

## Footers

- `Release-As: X.Y.Z` forces a specific version, including a prerelease such as
  `Release-As: 0.7.0-alpha.1`. Routing keys off the hyphen automatically - npm
  gets the `beta` dist-tag, Docker skips `latest`, and the webapp deploys to
  `beta.rom-weaver.com`.
- `Fixes #123` closes the issue when the pull request merges.

The [release guide](../.github/RELEASING.md) covers the rest of the release
flow, which is manually dispatched rather than triggered by merging.

## Checking a title before you push

`PR Title Lint` comments on the pull request with the exact rule that
failed and the list of valid types, and deletes that comment once you rename the
pull request. To check a message locally:

```bash
echo "fix(webapp): handle empty patch archives" | npx commitlint --config .config/commitlint.config.mjs
```
