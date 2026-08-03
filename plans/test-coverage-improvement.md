# Test coverage improvement plan

Audit date: 2026-08-03. Delete this file when all phases are done.

## Where coverage stands

- **Strong:** `rom-weaver-patches` (414 tests, every format has a paired
  `tests/unit/<fmt>.rs`), CLI end-to-end (`cli_smoke`, ~675 tests), the webapp
  apply-workflow state layer, the OPFS proxy protocol, the runner scheduler,
  and the end-to-end wasm stack.
- **Weak:** `rom-weaver-containers` (36.7k src lines vs ~7k test lines; the
  `nod/`, `xdvdfs/`, `libarchive/` subtrees are near-untested), CLI
  orchestration internals (big files with zero unit tests), checksum combine
  math, webapp create/trim controllers, the largest React components, and the
  entire webapp `scripts/` tooling layer (6.2k lines, zero tests).
- **Coverage tooling exists but never gates:** `coverage.yml` (cargo-llvm-cov +
  the three vitest coverage modes) runs weekly-cron only, has no thresholds,
  and the three webapp reports are never merged.

## Phase 1 — Free wins and broken things (do first)

1. **Re-wire the orphaned CLI unit tests.**
   `crates/rom-weaver-cli/tests/unit/cli.rs` (294 lines, 14 tests: progress
   defaults, selection parsing, compression profiles) is referenced nowhere —
   it never compiles. Add a `#[cfg(test)] #[path = "../tests/unit/cli.rs"]`
   include in the owning src module, the same way
   `crates/rom-weaver-cli/src/path_access.rs:188` includes its test file.
   Then fix whatever bit-rot surfaces when the 14 tests compile again.
2. **Cover the three CLI commands with zero end-to-end tests.**
   `cli_smoke` has no hits for `tools`, `plan-extract-batch`, or the
   `bundle ppf-undo` subcommand. Add smoke tests in
   `crates/rom-weaver-cli/tests/cli_smoke/`, reusing the fixture builders in
   `cli_smoke/shared.rs`.

## Phase 2 — Highest silent-wrong-answer risk (Rust)

1. **Codec helper round-trips.**
   `crates/rom-weaver-core/src/codecs/helpers.rs` (137 lines, 11
   encode/decode wrappers) has no tests, yet the workspace `Cargo.toml`
   carries warnings that the `bzip2`/`flate2` backend pins are load-bearing
   and can be silently swapped by feature unification. Add round-trip plus
   known-vector tests per codec so a backend swap fails loudly.
2. **Checksum combine math.**
   `crates/rom-weaver-checksum/src/execution.rs` (727 lines): the
   CRC32/CRC16/Adler32 parallel-combine functions and GF(2) matrix helpers
   have no direct tests. Add property tests comparing each `*_combine`
   against the sequential reference. Also cover
   `crates/rom-weaver-checksum/src/core.rs` (streaming/parallel entry
   points, wasm single-thread fallback).
3. **Operation context defaults.**
   `crates/rom-weaver-core/src/context.rs` (465 lines): `OperationContext`,
   `PatchPolicy`, and the strictness flags every crate reads. A wrong default
   silently disables validation workspace-wide. Cheap accessor/default tests
   in `crates/rom-weaver-core/tests/unit/`.
4. **Header repair (destructive writes).**
   `crates/rom-weaver-cli/src/header_repair_systems.rs` writes checksums
   in-place into the user's ROM for six platforms, with only 3 tests across
   the 1,055-line `header_repair*` family. Add per-platform tests using the
   existing `build_test_gba_rom` / `build_test_nds_rom` /
   Genesis-checksum helpers in `cli_smoke/shared.rs`.

## Phase 3 — Webapp quick wins

1. **`docs-routing.mjs` unit tests.**
   `packages/rom-weaver-webapp/src/webapp/docs-routing.mjs` (202 lines) has
   nine importers spanning runtime routing and the SEO build verifier, yet
   only `SITE_ORIGIN` is touched by any test. Add `tests/unit/` coverage for
   `readDocsSlugFromPathname`, `groupDocRoutes`, `createDocsSeoMetadata`,
   `isLegalDocRoute`, `docGroupTitle`. Pure functions — highest
   value-per-line in the webapp.
2. **Create/trim workflow controllers.**
   `src/lib/workflow/create-workflow-controller.ts` (465),
   `trim-workflow-controller.ts` (336), and `base-workflow-controller.ts`
   (347) have zero unit tests while their apply sibling has ~10 dedicated
   test files. Copy the existing apply-controller test pattern from
   `tests/unit/`.
3. **CI shard splitter.**
   `packages/rom-weaver-webapp/scripts/run-browser-tests.mjs` (276 lines)
   does size-weighted sharding for CI; a bug silently drops test files from
   a shard. It already has a `--list` mode, making it easy to test. Add a
   `node --test` sibling test, extending the root `scripts/*.test.mjs`
   convention into the webapp package.
4. **Lint-rule enforcers.**
    `scripts/check-css-layers.mjs` (253) and `check-touch-styles.mjs` (142)
    enforce two AGENTS.md hard rules but have no exports and no tests.
    Refactor each to export a `check(source)`-style function, keep the CLI
    entry, and add `node --test` cases for pass/fail fixtures.

## Phase 4 — Webapp component and hook coverage

 1. **`apply-patch-form.tsx` component contract.**
    1,555 lines, only covered incidentally by full-flow browser tests. Add a
    vitest-browser component-contract test mirroring the existing
    `apply-workflow-view-contract.test.tsx` pattern.
 2. **`use-input-staging.ts` (732 lines).**
    The staging hook behind every workflow form. Unit-test the pure reducer
    pieces; browser-test partial-stage, race, and dispose-ordering failure
    modes.
 3. **`use-list-reorder.ts` (447 lines).**
    Keyboard + pointer patch reordering with no test at all. Add a vitest
    browser test covering pointer reorder, keyboard reorder, and a11y
    announcements.
 4. **Input/output services.**
    `src/lib/output/output-build-service.ts` (608),
    `src/lib/input/input-preparation-service.ts` (607) — unit tests with
    faked runtime adapters.

## Phase 5 — Containers crate breadth (Rust, larger effort)

 1. **`nod/` subtree (~11k lines, 3 files with tests).**
    Priorities: `crates/rom-weaver-containers/src/nod/io/wia.rs` (2,089 —
    malformed-header/truncated-group error paths, fixtures via
    `write_wia_fixture_from_iso`), `disc/preloader.rs` (682, threading),
    `disc/wii.rs` (585, partition decryption), `io/wbfs.rs`, `io/gcz.rs`,
    `io/ciso.rs` (fixture builders already exist in `cli_smoke/shared.rs`).
 2. **`chd/disc_extract.rs` (1,673 lines).**
    Track-layout math and sector-mode dispatch — unit tests alongside the
    existing `tests/unit/chd.rs`.
 3. **`libarchive/` FFI boundary (1,719 lines, 1 tested file).**
    `write.rs`, `entries.rs`, `read.rs` — error-code translation tests.
 4. **`xdvdfs/` (~2.3k lines, 2 tested files).**
    `layout.rs`, `write/dirtab.rs`, `read.rs` round-trips via the existing
    `write_xiso_fixture_from_directory` helper.
 5. **CLI orchestration internals** (as touched, not as a sweep):
    when modifying `patch_apply.rs` (3,024), `command_args.rs` (2,481 — add
    a wasm/native arg-surface parity assertion), `ingest_command.rs` (1,243
    — classifier unit tests), `bundle_apply.rs` (precedence rules from its
    doc comment), extract the decision helpers into testable functions and
    pin them.

## Phase 6 — Cross-boundary contracts and CI gating

 1. **Typegen snapshot.**
    `crates/rom-weaver-cli/src/typegen_main.rs` (672 lines) generates the TS
    types the webapp consumes; snapshot-test its output against
    `docs/rom-weaver-bundle-v1.schema.json` / the committed generated files
    so a silent regression fails a test instead of CI drift detection alone.
 2. **Wasm panic-marker contract.**
    `crates/rom-weaver-cli/src/wasm_main.rs`: unit-test
    `read_wasm_run_request` error strings, and add a webapp-side assertion
    on the `[rom-weaver-panic]` stderr marker the JS host greps for.
 3. **Make coverage visible on PRs.**
    Today `.github/workflows/coverage.yml` is weekly-cron only, non-gating,
    no thresholds, and the three vitest reports are never merged. Steps:
    run `scripts/coverage-summary.mjs` output as a PR comment or artifact
    first (visibility, not gating); once numbers stabilize, add a ratchet
    floor (fail only if coverage drops from the base branch) rather than an
    absolute threshold. Decide gating scope with maintainer sign-off.
 4. **Webkit browser suite in CI.**
    The 67-file `tests/browser/` suite runs chromium-only in CI even though
    the config supports webkit. Add a (possibly nightly) webkit run of
    `test:browser` so webkit-only regressions aren't caught solely by the
    e2e script.
 5. **E2E driver self-tests.**
    `packages/rom-weaver-webapp/scripts/run-webapp-e2e.mjs` (880 lines) is a
    hand-rolled Playwright driver containing its own assertion logic; if it
    is wrong, CI passes while testing nothing. Extract its route-enumeration
    and assertion helpers into importable functions and cover with
    `node --test`.

## Ordering rationale

Phases 1–3 are small, independent, and each guards a real defect class
(dead tests, untested destructive writes, silent checksum corruption,
silently-passing CI). Phases 4–5 are steady-state work best done
incrementally or when touching the files. Phase 6 items 22–23 change CI
behavior and should get maintainer sign-off before landing.
