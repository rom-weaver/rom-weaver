# Commit and pull request title conventions

rom-weaver uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). Pull requests are squash-merged, so the **pull request title** becomes the commit on `main` and is the input Release Please reads to decide the next version and write the changelog entry. Branch commit messages are not linted; the title is the one that has to parse.

<!-- START doctoc -->
## Table of contents

- [Format](#format)
- [Types](#types)
  - [Choosing a type](#choosing-a-type)
- [Scopes](#scopes)
- [Breaking changes](#breaking-changes)
- [Footers](#footers)
- [Checking a title before you push](#checking-a-title-before-you-push)

<!-- END doctoc -->

## Format

```text
type(scope): description
type: description
```

- `type` is required and must come from the list below.
- `scope` is optional. Include the shortest useful scope when the affected area is clear; an unscoped title is also valid.
- `description` is lower case, imperative, and no trailing full stop.
- The complete header has a 150-character limit to allow grouped Dependabot titles.

```text
fix(webapp): handle empty patch archives
ci: build multi-arch images on native runners instead of QEMU
```

## Types

`.config/commitlint.config.mjs` defines the allowed types. The `PR Title Lint` check reads that file. `release-please-config.json` defines the changelog sections and release settings, and the in-app changelog (`changelog-source.tsx`) mirrors those sections.

| Type | Use it for | Changelog section | Release effect |
| --- | --- | --- | --- |
| `feat` | A capability users did not have: a new command, flag, format, page, tool, setting, or endpoint | Features | Minor bump |
| `ux` | An existing capability that looks, reads, or behaves differently on purpose: layout, flow, visuals, copy, defaults, messages | User Experience | Patch bump |
| `fix` | Behavior that did not work as intended, now repaired | Bug Fixes | Patch bump |
| `security` | A closed vulnerability: injection, XSS, path traversal, unbounded allocation from untrusted input | Security | Patch bump |
| `a11y` | Access for people with disabilities: screen readers, keyboard use, focus, contrast, reduced motion | Accessibility | Patch bump |
| `i18n` | Translations, locale files, locale-aware formatting, or a new language | Localization | Patch bump |
| `perf` | Faster or smaller product with byte-identical output | Performance Improvements | Patch bump |
| `revert` | Undoing an earlier commit | Reverts | Patch bump |
| `docs` | Docs pages, README, code comments, and the docs nav, sitemap, and `llms.txt` entries | Documentation | Patch bump |
| `dx` | Lint and formatter config, hooks, agent instructions, local scripts, `.gitignore` | Developer Experience | Patch bump |
| `deps` | Dependency version bumps (Dependabot uses this type) | Dependencies | Patch bump |
| `refactor` | Restructuring or formatting with identical behavior | Internal | Patch bump |
| `test` | Tests only | Internal | Patch bump |
| `build` | Build scripts, packaging, Dockerfiles, vendored sources | Internal | Patch bump |
| `ci` | Workflows, actions, CI budgets, release plumbing | Internal | Patch bump |
| `chore` | Automation only: release-please release PRs and the release and CLA bots | Internal | Patch bump |

Release Please bumps the minor version for `feat` and the patch version for every other type, also before 1.0. A breaking change bumps the minor version before 1.0. Every type has a visible changelog section, so a release that holds only `docs` or `ci` commits is still a patch release. `style` is retired: formatting is `refactor`, and an intended visual change is `ux`.

`perf` changes must not alter output bytes - compression and patch output is validated against reference tools, so run the relevant `cli_smoke` tests.

### Choosing a type

Choose by what the diff does for a user, not by how important it is or by its scope.

- **Only docs, tests, CI, build, deps, or tooling files changed:** use that area's type, even for a fix. A docs typo fix is `docs`; a broken workflow fix is `ci`; a faster CI job is `ci`, not `perf`.
- **Mixed diffs:** the type of the main purpose wins. A docs page plus the 2-line route entry it needs is `docs`. A new tool with its docs page is `feat`.
- **Product changes:** take the first match in this order: `revert`, `security`, `a11y`, `i18n`, `fix`, `perf`, `feat`, `ux`, `refactor`.
- **`feat` or `ux`:** name what users can do now that they could not do before. If you can, it is `feat`; if the same things got easier or nicer, it is `ux`. Redesigns, merged panels, moved controls, shorter labels, and clearer messages are `ux`.
- **`fix` or `ux`:** a `fix` repairs something that did not work as intended. Restoring a layout that a recent change broke is `fix`.
- **Beta:** a change behind the beta flag is typed as if the flag were on. Releasing a beta feature to everyone is `feat`.
- **Scope:** the scope only names where the change lands. `feat(docs)` is correct for a new docs-viewer capability and wrong for new docs pages.

| Past title | Better title |
| --- | --- |
| `feat(docs): add ROM compression guides` | `docs: add ROM compression guides` |
| `feat(webapp): centralize brand mark assets` | `refactor(webapp): centralize brand mark assets` |
| `feat(webapp): merge card drawers into the card` | `ux(webapp): merge card drawers into the card` |
| `fix(webapp): shorten sample download label` | `ux(webapp): shorten sample download label` |
| `fix(webapp): localize settings labels` | `i18n(webapp): localize settings labels` |
| `fix: protect ROM inputs and bound allocations` | `security: protect ROM inputs and bound allocations` |
| `style(webapp): restore desktop loom layout` | `fix(webapp): restore desktop loom layout` |
| `perf(ci): restore cached identify packs before Lighthouse` | `ci: restore cached identify packs before Lighthouse` |

## Scopes

Scopes are not enumerated in config, so use the shortest name that says where the change lands: the crate (`core`, `containers`, `patches`, `cli`), the surface (`webapp`, `wasm`, `docker`, `ci`, `dx`), or the format (`chd`, `iso`, `bps`). Match what recent history uses for the same area rather than inventing a synonym.

## Breaking changes

Append `!` after the type and scope, and explain the break in the body:

```text
ux(cli)!: rename --output to --out
```

Before 1.0 a breaking change bumps the **minor** version, because `bump-minor-pre-major` is enabled in `release-please-config.json`.

## Footers

- `Release-As: X.Y.Z` forces a specific version, including a prerelease such as `Release-As: 0.7.0-alpha.1`. A hyphen in the version routes every publish to the prerelease channels automatically; see [prerelease routing](ci.md#prerelease-routing).
- `Fixes #123` closes the issue when the pull request merges.

The [release guide](../../.github/RELEASING.md) covers the rest of the release flow. Opening or refreshing the release pull request is manually dispatched; merging that pull request starts the publish fan-out.

## Checking a title before you push

`PR Title Lint` reports the failing commitlint rule in the Title Check log. To check a message locally:

```bash
echo "fix(webapp): handle empty patch archives" | npx commitlint --config .config/commitlint.config.mjs
```
