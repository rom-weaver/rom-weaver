# Contributing to rom-weaver

Bug reports, documentation fixes, and focused code contributions are welcome.
Participation in this project is governed by the
[code of conduct](CODE_OF_CONDUCT.md).

<!-- START doctoc -->
## Table of contents

- [Report a problem](#report-a-problem)
- [Propose a change](#propose-a-change)

<!-- END doctoc -->

## Report a problem

Search the [issue tracker](https://github.com/brandonocasey/rom-weaver/issues)
before opening a report. Use the bug-report form and include the rom-weaver
version, webapp or CLI environment, exact reproduction steps, and relevant
diagnostics.

Do not upload copyrighted ROMs or disc images, firmware, encryption keys, or
personal files. Prefer a small redistributable test file; otherwise provide
file sizes and checksums.

Report suspected vulnerabilities privately as described in
[SECURITY.md](SECURITY.md), not through a public issue.

## Propose a change

For substantial behavior or format changes, open an issue first so the scope
can be agreed before implementation. Keep pull requests focused and update the
relevant documentation when behavior changes.

The [development guide](../docs/development.md) covers cloning and bootstrap,
toolchains, builds, tests, generated files, and linked worktrees.

Pull request titles must use Conventional Commits because the squash-merge title
becomes the commit on `main` and the input to Release Please. Use
`type(scope): summary`, for example `fix(webapp): handle empty patch archives`.
The scope is optional; allowed types are `build`, `chore`, `ci`, `docs`, `dx`,
`feat`, `fix`, `perf`, `refactor`, `revert`, `style`, and `test`. Branch commit
messages are not linted.

Before submitting a pull request, run the smallest relevant checks and, when
possible, the complete local gate:

```bash
mise run ci
```

By contributing, you agree that your contribution is licensed under the
[GNU Affero General Public License](../LICENSE.md), version 3 or later.
