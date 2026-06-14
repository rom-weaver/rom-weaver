# rom-weaver

ROM workflow CLI (native + WASM) with a React webapp. Read
`docs/ARCHITECTURE.md` first — it covers the crate graph, registry traits,
threading model, and the Rust⇄TypeScript boundary.

## Commands

```bash
cargo build -p rom-weaver-cli                      # native CLI
cargo test --workspace                             # full Rust suite
cargo run -p rom-weaver-typegen -- --write         # regen TS types (REQUIRED after Rust type/metadata changes)
mise run build-wasm                                # wasm build (needs WASI SDK v33+)
npm --prefix packages/rom-weaver-react run dev     # webapp dev server
npm --prefix packages/rom-weaver-react run lint    # biome + tsc + browser-compat + knip
npm --prefix packages/rom-weaver-react run test:browser:wasm  # wasm-layer browser tests
```

Pre-commit hooks (lefthook) run fmt/clippy/typegen/biome/tsc scoped to changed
paths; CI runs all of it unconditionally plus the full test suites.

## Hard rules

- **Byte-identical parity.** Compression/patch output is validated against
  reference tools (chdman, dolphin-tool). Perf changes must not alter output
  bytes; run the relevant `cli_smoke` tests.
- **Typegen drift fails CI.** Any change to `#[derive(TS)]` types or format
  registry metadata needs `npm run typegen` and the regenerated files
  committed.
- **One error type.** Add variants to `RomWeaverError`
  (`crates/rom-weaver-core/src/error.rs`); never introduce per-crate error
  enums.
- **Browser OPFS code runs in Dedicated Workers only** — no main-thread
  (`window`) usage. Spawned wasm threads cannot open OPFS files; read source
  bytes on the wasm main thread (see "Read-on-main" in `docs/ARCHITECTURE.md`).
- **Tracing.** Use `tracing` `trace!`/`debug!` liberally in Rust pipelines —
  trace output is the primary debugging tool for wasm/browser issues.
- Relative imports only in TypeScript (no path aliases).

## Layout pointers

- CLI command orchestration: `crates/rom-weaver-app` (shared by native + wasm)
- Format handler registries: `crates/rom-weaver-containers`,
  `crates/rom-weaver-patches`
- Browser wasm runtime (OPFS, thread pool, worker client):
  `packages/rom-weaver-react/src/wasm`
- Webapp workflows/forms: `packages/rom-weaver-react/src`
- Vendored forks: `vendor/` (`nod` and `libarchive` are submodules; push `nod`
  changes to the fork remote, not upstream)

## Worktrees

Fresh worktrees need `scripts/setup-worktree.sh` (real `npm ci` installs +
wasm artifact copy — symlink-mirrored node_modules silently stall vitest's
browser mode) and `vendor/*` symlinked from the main checkout. Don't share the
main checkout's `target/` for wasm builds — cmake-built C deps (libarchive)
break; use a fresh target dir. Never put `/` or `+` in a worktree name (vitest
browser mode hangs on `+` in test paths).

## Tests

- Rust: `crates/*/tests/unit/`, CLI end-to-end in
  `crates/rom-weaver-cli/tests/cli_smoke/`
- Browser: `packages/rom-weaver-react/tests/browser/` (Playwright + vitest)
- Never skip/remove/modify tests to make a change pass.
