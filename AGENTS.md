# Agent instructions

## Worktrees

When starting work, always create and use a new linked worktree. Do not make
changes directly in the primary checkout; use `.worktrees/<name>` for the
working tree.

This repository has no Git submodules; every vendored source is committed
in-tree, so a linked worktree contains all source files when it is created.
Install dependencies and copy generated assets with the setup helper below.

Before cleanup, verify the worktree has no real changes, then use the repository
helper:

```bash
node scripts/remove-worktree.mjs .worktrees/<name>
```

The helper refuses to remove a worktree with tracked or untracked changes.

---

## rom-weaver

ROM workflow CLI (native + WASM) with a React webapp. Read
`docs/development/ARCHITECTURE.md` first - it covers the crate graph, registry traits,
threading model, and the Rust⇄TypeScript boundary.

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

Pre-commit hooks (lefthook) select formatting, static analysis, type generation,
dependency-policy, and WASM checks from the changed paths; each selected check
still runs over its full owning workspace. CI adds tests and builds according to
its change classification. `docs/development/ci.md` maps every workflow, the
shared actions, caching, and the release fan-out.

Before pushing webapp or published-doc changes, run a production webapp build
and `check:size`; lint and pre-commit hooks do not cover generated asset sizes.
Use `docs/development/reproduce-ci-locally.md#prevent-repeat-failures` for the
commands and the additional checks for UI changes. Investigate unexpected
growth before proposing a budget increase; never raise a limit just to pass CI.

Codex and Claude use this same pre-push gate (`CLAUDE.md` imports this file).
Select browser test files using the guide's behavior-to-test table; use the full
suite when shared behavior makes the affected files unclear. Run webapp script
tests for build/tooling changes. The CI-script hook checks classifier and runtime
dependency changes; it does not replace browser tests. Build once in production,
check sizes before browser/E2E work, and reuse that current bundle for E2E as
documented. Report which checks passed and any checks that could not run.

## Additional correctness checks

Run `mise run quality-architecture` and `mise run quality-selection` for source, manifest, protocol, worker or test-selection changes. Run `mise run quality-guardrails <base-ref>` before committing; inspect review findings as well as blocking errors. New skips/suppressions need adjacent `quality-reason:` with a concrete reason; never add focused tests. These checks do not replace thread guards or typegen.

For changed core/checksum/patch/container algorithms run the relevant edge/property tests and `mise run quality-mutation diff <base-ref>`. For parser changes run `mise run quality-fuzz smoke`; relevant native extraction changes also run `mise run quality-reference` after building the CLI. Mutation survivors, timeouts and build failures are different findings; none may be relabeled automatically.

For bug fixes, use `quality-regression-proof` where practical and report the exact base/candidate behavioral test evidence. Compile/setup/zero-test failures do not prove a regression caught the bug. For worker lifecycle changes run the seeded lifecycle tests and real OPFS resource assertions, including `browser-runtime-lifecycle.test.mjs` and `browser-opfs-many-entries.test.mjs`. Use `ROM_WEAVER_WASM_EXHAUSTIVE=1` for deeper seeded sequences. See `docs/development/reproduce-ci-locally.md#additional-correctness-checks`.

Exclusion, oracle, budget and verification-script changes require explicit review. Keep generated fuzz corpus growth, solver/build output and crashes out of commits. Deep sanitizer/Miri/Kani lanes have documented limited scopes; never claim they prove whole-workspace correctness or instrument untested/uninstrumented paths.

## Hard rules

- **Byte-identical parity.** Compression/patch output is validated against
  reference tools (chdman, dolphin-tool). Perf changes must not alter output
  bytes; run the relevant `cli_smoke` tests.
- **Typegen drift fails CI.** Any change to `#[derive(TS)]` types or format
  registry metadata needs `npm run typegen` and the regenerated files
  committed.
- **Dependency policy is `.config/deny.toml`.** New crates must land under an
  already-allowed license; disallowed licenses and unknown sources fail CI
  (`mise run deny-policy`). Vulnerabilities do **not** fail CI - advisories run
  in the non-gating `security` job and surface as warnings, so a fresh CVE
  never blocks unrelated work. They are still expected to get fixed; suppress
  one only via an `ignore` entry with a written reason - never by loosening
  `unmaintained`/`yanked`. Unused-dep false positives go in the owning crate's
  `[package.metadata.cargo-machete]`, also with a reason.
- **One error type.** Add variants to `RomWeaverError`
  (`crates/rom-weaver-core/src/error.rs`); never introduce per-crate error
  enums.
- **Browser OPFS code runs in Dedicated Workers only** - no main-thread
  (`window`) usage. All OPFS access goes through the dedicated OPFS proxy
  worker; spawned wasm threads open and read their own OPFS files through it
  (the old read-on-main gates are retired). See "Browser I/O paths" in
  `docs/development/ARCHITECTURE.md`.
- **Tracing.** Use `tracing` `trace!`/`debug!` liberally in Rust pipelines -
  trace output is the primary debugging tool for wasm/browser issues.
- **Formatting ownership.** CSS uses Biome; everything else uses oxfmt.
- Before changing CSS, design-system styles, or CSS tooling, read and follow
  [the CSS rules](.agents/references/css.md), including hover/active pairing,
  cascade layers, formatting ownership, and exception requirements.
- Relative imports only in TypeScript (no path aliases).

## Documentation

`docs/` follows [Diátaxis](https://diataxis.fr/): every page serves exactly one
mode, and the folder names the mode.

- **`tutorials/`** - learning. Guided practice runs against supplied sample
  files, numbered start to finish, ending in verification. Background prose
  belongs in explanation, linked.
- **`how-to/`** - tasks. Start at the task; each recipe uses only the flags
  that task needs. No practice-run openers (link the tutorial in one line), no
  flag-by-flag catalogs (link the reference), no "why" essays (link the
  explanation).
- **`reference/`** - facts. No advice, no steps, no advocacy. Flag catalogs,
  tables, exit codes, formats. A troubleshooting or install procedure found
  here moves to a how-to.
- **`explanation/`** - understanding. No procedures and no UI instructions;
  pages should be able to say "nothing here is a procedure" truthfully.
- When a section drifts into another mode, move it to the owning page and
  leave a one-line link both ways - do not duplicate content across pages. The
  FAQ is a router: answers live on owning pages, the FAQ only links.
- `hosting/` and `development/` are audience folders, with the same
  mode-per-page discipline applied loosely: a subject-organized page
  (`vendor-code.md`, `performance.md`) stays whole when splitting by mode
  would scatter one subject's story.
- Browser guides never contain terminal commands and CLI guides never describe
  cards or drag handles (`explanation/browser-and-cli.md` promises this).
- **Published slugs never break.** Slugs live in `DOC_SOURCES`
  (`packages/rom-weaver-webapp/src/webapp/docs-routing.mjs`); a new page is
  added there (its folder decides its nav shelf), to the `docs/README.md` map,
  and to `llms.txt` when reader-relevant. Moving a page keeps its slug;
  retiring a GitHub-served path needs a stub (see `docs/hosting/cli.md`) or a
  `_redirects` rule.
- Regenerate TOCs with `node scripts/update-markdown-toc.mjs <files>`.

## Releases

Before release work, version changes, release automation, or npm/Docker
publishing, read and follow [the release rules](.agents/references/releases.md).
Release Please owns version bumps; never hand-edit versions or publish a draft
release before its fan-out finishes.

Pick commit and PR title types with
[the commit guide](docs/development/commits.md#choosing-a-type).


## Layout pointers

- CLI command orchestration: `crates/rom-weaver-cli` (shared library + native + wasm)
- Format handler registries: `crates/rom-weaver-containers`,
  `crates/rom-weaver-patches`
- Browser wasm runtime (OPFS, thread pool, worker client):
  `packages/rom-weaver-webapp/src/wasm`
- Webapp workflows/forms: `packages/rom-weaver-webapp/src`
- Vendored source is all in-tree under `crates/rom-weaver-containers`: the
  libarchive C sources at `libarchive/vendor/libarchive` (refresh with
  `scripts/vendor-libarchive.mjs`), the 7-Zip LZMA SDK C sources at
  `lzma-sdk/vendor/C` (refresh with `scripts/vendor-lzma-sdk.mjs`; verbatim, no
  local patches), the nod and xdvdfs Rust sources under
  `src/nod` and `src/xdvdfs`. There are no git submodules.

## Worktree setup

Fresh worktrees need `scripts/setup-worktree.mjs` (real `npm ci` installs +
wasm artifact copy - symlink-mirrored node_modules silently stall vitest's
browser mode). One checkout can share a `target/` between native and wasm
builds: cargo keys every build script's OUT_DIR by target triple and profile,
so the cmake builds never collide (the old libarchive submodule-era breakage
is gone). Sharing one target dir between _checkouts_ is not safe: same crate,
same triple, same profile means the same OUT_DIR and the same compiled build
script, and cargo's mtime-based freshness can silently reuse the other
checkout's staged libarchive tree; `cargo clean -p rom-weaver-containers`
is the recovery. A fresh target dir per worktree is cheap when ccache is
installed - it replays the C compiles across target dirs and worktrees under
the main checkout. Never put `/` or `+` in a worktree name (vitest browser
mode hangs on `+` in test paths).

## Tests

- Rust: `crates/*/tests/unit/`, CLI end-to-end in
  `crates/rom-weaver-cli/tests/cli_smoke/`
- Browser: `packages/rom-weaver-webapp/tests/browser/` (Playwright + vitest)
- Never skip/remove/modify tests to make a change pass.
