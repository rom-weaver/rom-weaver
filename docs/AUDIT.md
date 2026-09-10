# CLI usability audit

The CLI has the main controls expected from a mature command-line tool, but its command syntax and output formats do not yet have the consistency of established Unix utilities. This audit covers the native CLI, not the webapp or the correctness of every ROM format implementation.

The comparison uses the [GNU command-line interface standards][gnu-cli] and the [GNU exit-status conventions][gnu-exit]. It does not claim compatibility with every historical tool. The audit baseline is commit `3a1cfb92e`.

<!-- START doctoc -->
## Table of contents

- [Existing strengths](#existing-strengths)
- [Confirmed findings and fixes](#confirmed-findings-and-fixes)
- [Remaining usability choices](#remaining-usability-choices)
- [Verification scope](#verification-scope)

<!-- END doctoc -->

## Existing strengths

- Help includes examples, command descriptions, aliases, and grouped options. The CLI supplies version output, shell completions, and generated man pages.
- JSON events provide a scripting interface. Human errors and progress use stderr. Query results remain available under quiet mode.
- Existing output files normally require `--force`. Dry runs describe planned work. Interactive selection requires terminal input and stderr, and is off in JSON mode.
- Probe, checksum, and identify accept stdin through `--input -`. File-backed spooling supports formats that require seeking.

## Confirmed findings and fixes

Seven candidate findings were consolidated into five findings. All five were confirmed, with the native man-page output exception narrowed as described below. All five have fixes in this branch.

| ID | Severity | Finding | Fix location |
| --- | --- | --- | --- |
| CLI-1 | High | The output permission check deleted an existing `.rom-weaver-write-probe` file without `--force`. | `crates/rom-weaver-cli/src/path_access.rs:59`, `check_writable_dir` |
| CLI-2 | High | Bundle archive output bypassed overwrite checks. Invalid archive destinations could fail after the JSON definition was written. Main output checks followed source hashing. | `crates/rom-weaver-cli/src/bundle_create.rs:655`, `preflight_bundle_create_outputs` |
| CLI-3 | Medium | A failed stdin copy left its partial temporary file behind. | `crates/rom-weaver-cli/src/stdin_input.rs:58`, `spool_reader_to_file` |
| CLI-4 | Medium | Closing a stdout pipe caused a Rust panic and exit status 101. | `crates/rom-weaver-cli/src/stdout_output.rs:12` and the native output callers |
| CLI-5 | Medium | Man-page installation accepted `--json` but printed a human status line. | `crates/rom-weaver-cli/src/cli.rs:472`, `run_man_command` |

CLI-1 now creates an exclusive probe with a process ID and counter. It removes only the file created by that check. The previous test expected deletion of an existing file; the new contract requires preservation of that file's bytes.

CLI-2 checks both destinations before hashing and writing. An existing archive requires `--force`, and the definition and archive must name different files. This is preflight validation, not a transaction across both outputs. A later disk failure can still leave an output from an earlier successful write.

CLI-3 retains the reserved file handle and creates the cleanup guard before the copy. The file closes before cleanup on a read or write error.

CLI-4 handles native stdout failures without unwinding file operations. A closed pipe preserves the operation's exit status. Other write failures produce a controlled failure. File operations finish even if a consumer stops reading progress. The browser JSON transport is unchanged.

CLI-5 returns an installation event with the page count and directory. Printing a man page remains an asset-generation command, like completions or the bundle schema. That exception is now explicit in the CLI reference. Quiet-mode help also describes its existing summary suppression.

## Remaining usability choices

These are interface choices, not unresolved defects from the confirmed set.

1. **Consistent file operands.** Most commands require `--input`; save commands use positional files. Optional positional input aliases could reduce typing while preserving existing flags. The parser would need explicit rules for repeated inputs and mixed positional and named arguments.
2. **Simple checksum output.** The current command opens archives by default and reports ROM variants. It is not a replacement for `sha1sum`. A dedicated output mode could print digest/file records, with explicit rules for raw bytes, multiple variants, and unusual filenames. JSON is the current stable scripting interface.
3. **A complete stream contract.** Stdin is available for three query commands, but file-producing workflows use paths. Binary stdout would need rules for multi-file outputs, seek-dependent formats, and separation from JSON events. A stdout value of `-` must not be advertised without those rules.

These choices involve public syntax or semantics. This branch preserves the current input and ROM-processing defaults.

## Verification scope

Validation passed: 3,481 Rust workspace tests and doctests, with two repository-configured ignores; all-target, all-feature Clippy with warnings denied; documentation lint; the threaded WASM application compile check; and the native CLI smoke harness. The patch round trip produced the expected CRC32 `221d2d6c`.

The audit inspected argument parsing, native output, stdin, overwrite checks, bundle creation, and the existing smoke coverage. Regression tests cover preservation of user files, failed stdin cleanup, closed stdout, ordinary stdout failures, bundle destination validation, and JSON man installation.

The independent review found an output-alias case involving nonexistent paths with `..`; that case was included in the bundle fix. A second candidate about probe names without process IDs referred to an intermediate diff; the final names include the process ID.

No unresolved confirmed finding remains. This audit does not establish interactive terminal behavior on every shell, native Windows runtime behavior, or performance parity with other tools.

[gnu-cli]: https://www.gnu.org/prep/standards/html_node/Command_002dLine-Interfaces.html
[gnu-exit]: https://www.gnu.org/software/coreutils/manual/html_node/Exit-status.html
