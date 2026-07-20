# rom-weaver

ROM workflow CLI (native + WASM) with a React webapp. Read
`docs/ARCHITECTURE.md` first - it covers the crate graph, registry traits,
threading model, and the Rust⇄TypeScript boundary.

## Commands

```bash
cargo build -p rom-weaver-cli                      # native CLI
cargo test --workspace                             # full Rust suite
mise run typegen                                    # regen TS types (REQUIRED after Rust type/metadata changes)
mise run deny                                      # dep advisories + licenses + sources (deny.toml)
mise run machete                                   # unused Rust dependencies
mise run build-wasm                                # wasm build (needs WASI SDK v33+)
npm --prefix packages/rom-weaver-webapp run dev     # webapp dev server
npm --prefix packages/rom-weaver-webapp run lint    # oxfmt + oxlint + biome + tsc + browser-compat + knip
npm --prefix packages/rom-weaver-webapp run test:browser:wasm  # wasm-layer browser tests
```

Pre-commit hooks (lefthook) run oxfmt/clippy/typegen/oxlint/biome/tsc scoped to changed
paths; CI runs all of it unconditionally plus the full test suites.

## Hard rules

- **Byte-identical parity.** Compression/patch output is validated against
  reference tools (chdman, dolphin-tool). Perf changes must not alter output
  bytes; run the relevant `cli_smoke` tests.
- **Typegen drift fails CI.** Any change to `#[derive(TS)]` types or format
  registry metadata needs `npm run typegen` and the regenerated files
  committed.
- **Dependency policy is `deny.toml`.** New crates must land under an
  already-allowed license, and vulnerabilities fail CI at any depth. Suppress
  an advisory only via an `ignore` entry with a written reason - never by
  loosening `unmaintained`/`yanked`. Unused-dep false positives go in the
  owning crate's `[package.metadata.cargo-machete]`, also with a reason.
- **One error type.** Add variants to `RomWeaverError`
  (`crates/rom-weaver-core/src/error.rs`); never introduce per-crate error
  enums.
- **Browser OPFS code runs in Dedicated Workers only** - no main-thread
  (`window`) usage. All OPFS access goes through the dedicated OPFS proxy
  worker; spawned wasm threads open and read their own OPFS files through it
  (the old read-on-main gates are retired). See "Browser I/O paths" in
  `docs/ARCHITECTURE.md`.
- **Tracing.** Use `tracing` `trace!`/`debug!` liberally in Rust pipelines -
  trace output is the primary debugging tool for wasm/browser issues.
- Relative imports only in TypeScript (no path aliases).

## Releases

Releases are release-please driven; the global `npm version` / `changelog:all`
instructions do **not** apply here.

- **Never hand-edit a version.** `release-please-config.json` owns every bump:
  root + webapp + alias + 4 platform `package.json`s and their locks, the
  `optionalDependencies` pins, `workspace.package.version`, ~43 path-dependency
  pins across `crates/*`, `vendor/*`, and `Cargo.lock`.
- **Flow:** merge conventional commits to `main` → CI goes green → release-please
  opens/updates a `chore(main): release X.Y.Z` PR → merging that PR tags
  `vX.Y.Z` and sets `release_created=true`, which unlocks the cargo/npm/docker
  publish jobs. Merging the release PR is the release decision; nothing
  publishes before it.
- **Prerelease:** `Release-As: X.Y.Z-alpha.N` commit footer for a one-off, or
  `prerelease`/`prerelease-type` in the config for a sustained track. Routing is
  automatic and keys off a hyphen in the version - no dist-tag step to remember:
  npm gets `beta` instead of `latest`, docker gets `beta` and skips the series
  tags, and the webapp deploys to `beta.rom-weaver.com`. Cargo needs no guard
  (crates.io has no dist-tags).
- `npm version` (→ `scripts/sync-version.mjs`) is the legacy manual path that
  cut v0.2.0-v0.5.0. It overlaps release-please and will fight it. Keep it only
  as a break-glass fallback.
- Pre-1.0 bump behavior is **unpinned**: `bump-minor-pre-major` and
  `bump-patch-for-minor-pre-major` are unset, so whether a breaking change
  yields 0.6.0 or 1.0.0 is defaulted, not chosen. Settle this before landing
  anything breaking.

## Layout pointers

- CLI command orchestration: `crates/rom-weaver-app` (shared by native + wasm)
- Format handler registries: `crates/rom-weaver-containers`,
  `crates/rom-weaver-patches`
- Browser wasm runtime (OPFS, thread pool, worker client):
  `packages/rom-weaver-webapp/src/wasm`
- Webapp workflows/forms: `packages/rom-weaver-webapp/src`
- Vendored forks: `vendor/` (`nod` and `libarchive` are submodules; push `nod`
  changes to the fork remote, not upstream). Never run stable `cargo fmt`
  inside `vendor/nod` - its rustfmt config needs nightly (`cargo +nightly fmt`)
  and stable reformats the whole tree into churn.

## Worktrees

Fresh worktrees need `scripts/setup-worktree.sh` (real `npm ci` installs +
wasm artifact copy - symlink-mirrored node_modules silently stall vitest's
browser mode) and `vendor/*` symlinked from the main checkout. Don't share the
main checkout's `target/` for wasm builds - cmake-built C deps (libarchive)
break; use a fresh target dir. Never put `/` or `+` in a worktree name (vitest
browser mode hangs on `+` in test paths).

## Tests

- Rust: `crates/*/tests/unit/`, CLI end-to-end in
  `crates/rom-weaver-cli/tests/cli_smoke/`
- Browser: `packages/rom-weaver-webapp/tests/browser/` (Playwright + vitest)
- Never skip/remove/modify tests to make a change pass.
