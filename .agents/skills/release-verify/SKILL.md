---
name: release-verify
description: "Explicit-only: verify published ROM Weaver packages, installation, bundled data, and CLI workflows."
disable-model-invocation: true
---

Scope: Verify published ROM Weaver packages, install methods, bundled data, and CLI workflows. Use only when the user invokes release-verify.


# Verify a ROM Weaver release

Start only on the user's explicit invocation. A reference from another skill does not start this workflow. This skill tests published packages; publishing belongs to the `release` skill and needs its own authorization.

Run from the ROM Weaver checkout. Resolve repository paths below against `git rev-parse --show-toplevel`.

## Pin the release and install methods

Use the requested version. If the user requests the latest release, resolve it once and record its tag before downloading. Read `docs/how-to/install-cli.md`, `docs/how-to/verify-downloads.md`, and the publishing workflows for that version. Use `gh release view <TAG>` to inventory the published release and assets.

Build the test matrix from those sources: installation method, OS/architecture, package or asset version, expected bundled data, and available test host. Include both npm entry packages and the documented binary-only methods when present. Separate a source build from a published package installation.

Use temporary install prefixes or disposable containers. Inspect an installer's destination controls before running it: changing the binary directory may still write manpages or completions into the user's home. Use an isolated environment for those installers. Keep system installations and the user's database intact.

## Verify each installed package

Check the executable's resolved path and reported version. Record its package or asset source and checksum. Follow the documented checksum and provenance checks. Missing verification or an unavailable package is a separate result.

Check the packaged database before running setup; setup can hide a packaging defect by downloading missing data. For a method that promises bundled data, verify that it is usable without downloading a replacement. For a binary-only method, check the documented missing-data behavior, then run setup in an isolated data directory and check identification again.

Reuse the `run-rom-weaver` skill and its CLI smoke harness with `RW_BIN` set to the installed executable's absolute path. First make sure that path is executable; the harness can otherwise fall back to a development binary. Check that the harness reports the requested executable. Do not rebuild from the checkout and count that result as a released-package test.

Exercise checksum, extraction, compression, and patch application using the committed fixtures and known expected outputs. Add setup and identify checks: the basic CLI smoke harness does not cover them. Use the release's help output for flags and check the output bytes or checksum, not just its exit status. Check the published webapp in a browser only when its behavior is also in scope.

## Report coverage

Report one result per version, install method, and platform: executed and passed, executed and failed, inspected only, or not tested with the cause. Inspecting an archive does not prove that its executable runs on another OS. Include reproduction commands and package/run URLs for failures.

Make authorized fixes on a new linked worktree branch under the repository's commit and review rules. Push or open a pull request only when asked. Remove temporary installs and containers after recording the results; preserve user input files.
