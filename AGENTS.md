# Agent instructions

## rom-weaver

ROM workflow CLI (native + WASM) with a React webapp. Read
`docs/development/ARCHITECTURE.md` first - it covers the crate graph, registry traits,
threading model, and the Rust⇄TypeScript boundary.

## Worktrees

There are no Git submodules. Prepare a new worktree with
`node scripts/setup-worktree.mjs` and remove one with
`node scripts/remove-worktree.mjs .worktrees/<name>`, which refuses worktrees
with changes (`docs/development/development.md#linked-worktrees`). Give each
checkout its own `target/`; a shared one can reuse stale staged C sources
(recover with `cargo clean -p rom-weaver-containers`). Never put `/` or `+` in
a worktree name (vitest browser mode hangs on `+` in test paths).

## Commands

```bash
cargo build -p rom-weaver-cli                      # native CLI
cargo test --workspace                             # full Rust suite
mise run typegen                                    # regen TS types (REQUIRED after Rust type/metadata changes)
mise run deny                                      # dep advisories + licenses + sources (.config/deny.toml)
mise run machete                                   # unused Rust dependencies
mise run build-wasm                                # wasm build (needs WASI SDK v33+)
npm --prefix packages/rom-weaver-webapp run dev     # webapp dev server
npm --prefix packages/rom-weaver-webapp run lint    # oxfmt + biome (CSS) + oxlint + tsc + browser-compat + knip
npm --prefix packages/rom-weaver-webapp run test:browser:wasm  # wasm-layer browser tests
```

Before pushing webapp or published-doc changes, follow
`docs/development/reproduce-ci-locally.md#prevent-repeat-failures`: one
production build and `check:size`; for UI changes, also browser tests picked
from its behavior-to-test table (full suite when shared behavior makes the
selection unclear) and E2E reusing that bundle.

## Byte-count limits

Investigate unexpected growth first. Then, with standing consent and without
asking again, automatically raise a byte-count limit that blocks CI, tests, or
size checks when its total increase in the PR, measured against the PR base
including earlier commits, is at most 10,000 bytes. Ask before larger
increases. Keep the checks enabled, record measured sizes and the old and new
limits, and rerun affected checks. Budget changes still need review; other
assertions and thresholds keep their existing rules.

## Additional correctness checks

Commands and details:
`docs/development/reproduce-ci-locally.md#additional-correctness-checks`.

- Before committing: `mise run quality-guardrails <base-ref>`; inspect review
  findings as well as errors. New skips/suppressions need an adjacent
  `quality-reason:` with a concrete reason.
- Core/checksum/patch/container algorithm changes: relevant edge/property tests
  and `mise run quality-mutation diff <base-ref>`. Survivors and timeouts
  are distinct findings; never relabel them automatically. Unviable mutants
  (ones that never compile) are counted, not findings, unless all are unviable.
- Parser changes: `mise run quality-fuzz smoke`; native extraction changes also
  run `mise run quality-reference` after building the CLI.
- Bug fixes: `quality-regression-proof` where practical; report the exact
  base/candidate behavioral evidence. Compile, setup, or zero-test failures
  prove nothing.
- Worker lifecycle changes: `browser-runtime-lifecycle.test.mjs` and
  `browser-opfs-many-entries.test.mjs` (`ROM_WEAVER_WASM_EXHAUSTIVE=1` for
  deeper seeded sequences).

Exclusion, oracle, budget, and verification-script changes need explicit
review. Keep fuzz corpus growth, solver/build output, and crashes out of
commits. Sanitizer/Miri/Kani lanes have limited documented scopes; never claim
they prove whole-workspace correctness.

## Hard rules

- **Byte-identical parity.** Compression/patch output is validated against
  reference tools (chdman, dolphin-tool). Perf changes must not alter output
  bytes; run the relevant `cli_smoke` tests.
- **Typegen drift fails CI.** After changing `#[derive(TS)]` types or format
  registry metadata, run `mise run typegen` and commit the regenerated files.
- **Dependency policy is `.config/deny.toml`.** New crates need an
  already-allowed license. Advisories don't gate CI but still get fixed;
  suppress one only via a reasoned `ignore` entry, never by loosening
  `unmaintained`/`yanked`. Unused-dep false positives go in the crate's
  `[package.metadata.cargo-machete]` with a reason.
- **One error type.** Add variants to `RomWeaverError`
  (`crates/rom-weaver-core/src/error.rs`); never introduce per-crate error
  enums.
- **Browser OPFS code runs in Dedicated Workers only**, never on the main
  thread; all OPFS access goes through the OPFS proxy worker ("Browser I/O
  paths" in `docs/development/ARCHITECTURE.md`).
- **Tracing.** Use `trace!`/`debug!` liberally in Rust pipelines - it is the
  primary debugging tool for wasm/browser issues.
- Before changing CSS, design-system styles, or CSS tooling, read and follow
  [the CSS rules](.agents/references/css.md).
- Relative imports only in TypeScript (no path aliases).

## Documentation

Before changing `docs/` or published doc routing (`DOC_SOURCES`, `llms.txt`,
`_redirects`), read and follow
[the documentation rules](.agents/references/docs.md) (Diátaxis modes,
published slugs).

The pre-commit hook regenerates TOCs only for `docs/` and a fixed file list; in
any other Markdown file with a doctoc block (such as crate READMEs), run
`node scripts/update-markdown-toc.mjs <files>`.

## Releases

Before release work, version changes, release automation, or npm/Docker
publishing, read and follow [the release rules](.agents/references/releases.md).

Pick commit and PR title types with
[the commit guide](docs/development/commits.md#choosing-a-type).

## Layout pointers

- CLI command orchestration: `crates/rom-weaver-cli` (shared library + native + wasm)
- Format handler registries: `crates/rom-weaver-containers`,
  `crates/rom-weaver-patches`
- Browser wasm runtime (OPFS, thread pool, worker client):
  `packages/rom-weaver-webapp/src/wasm`
- Webapp workflows/forms: `packages/rom-weaver-webapp/src`
- Vendored libarchive, LZMA SDK, nod, and xdvdfs sources:
  `crates/rom-weaver-containers` (`docs/development/vendor-code.md`)
- Tests: Rust in `crates/*/tests/unit/`, CLI end-to-end in
  `crates/rom-weaver-cli/tests/cli_smoke/`, browser in
  `packages/rom-weaver-webapp/tests/browser/`
