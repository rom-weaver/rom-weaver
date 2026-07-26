# Contributing to rom-weaver

Bug reports, documentation fixes, and focused code contributions are welcome.
Participation in this project is governed by the
[code of conduct](.github/CODE_OF_CONDUCT.md).

<!-- START doctoc -->
## Table of contents

- [Report a problem](#report-a-problem)
- [Propose a change](#propose-a-change)
- [Contributor License Agreement](#contributor-license-agreement)

<!-- END doctoc -->

## Report a problem

Search the [issue tracker](https://github.com/rom-weaver/rom-weaver/issues)
before opening a report. Use the bug-report form and include the rom-weaver
version, webapp or CLI environment, exact reproduction steps, and relevant
diagnostics.

Do not upload copyrighted ROMs or disc images, firmware, encryption keys, or
personal files. Prefer a small redistributable test file; otherwise provide
file sizes and checksums.

Report suspected vulnerabilities privately as described in
[SECURITY.md](.github/SECURITY.md), not through a public issue.

## Propose a change

For substantial behavior or format changes, open an issue first so the scope
can be agreed before implementation. Keep pull requests focused and update the
relevant documentation when behavior changes.

The [development guide](docs/development.md) covers cloning and bootstrap,
toolchains, builds, tests, generated files, and linked worktrees.

Pull request titles must use Conventional Commits because the squash-merge title
becomes the commit on `main` and the input to Release Please. Use
`type(scope): summary`, for example `fix(webapp): handle empty patch archives`.
Branch commit messages are not linted. The `PR Title Lint` check comments with
the exact problem when a title does not parse, and deletes that comment once you
rename the pull request. The [commit conventions](docs/commits.md) guide covers
the allowed types, scopes, breaking changes, and release footers.

Before submitting a pull request, run the smallest relevant checks and, when
possible, the complete local gate:

```bash
mise run ci
```

## Contributor License Agreement

rom-weaver is dual-licensed: everyone receives it under the
[GNU Affero General Public License](LICENSE), version 3 or later, and the
maintainer also offers first-party code under separate commercial license
terms. Keeping that model possible requires a license grant covering every
contribution, so all contributions require agreeing to the
[Individual Contributor License Agreement version 2.0](CLA.md).

On your first pull request the `CLA Signed` check comments with the signing
phrase in a copyable block; reply with that phrase in a new comment to sign. Signing covers all of
your past and future contributions to every repository in the
[`rom-weaver` organization](https://github.com/rom-weaver) that uses this
agreement, under that immutable CLA version, and you
will never be asked again. Edit a comment or post another to retry the check.
You keep the copyright in your work, and it is always also released
under the project's open-source license; see the CLA's open-source assurance
section.

Third-party code you did not write is not covered by the CLA: identify it in
the pull request together with its license and source.

If an employer or another entity owns rights in your contribution, the
maintainer may request separate confirmation or an agreement from that rights
holder before accepting it.
