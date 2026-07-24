# rom-weaver

ROM workflow CLI (native + WASM) with a React webapp. Read
`docs/ARCHITECTURE.md` first - it covers the crate graph, registry traits,
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
npm --prefix packages/rom-weaver-webapp run lint    # oxfmt + oxlint + biome + tsc + browser-compat + knip
npm --prefix packages/rom-weaver-webapp run test:browser:wasm  # wasm-layer browser tests
```

Pre-commit hooks (lefthook) run oxfmt/clippy/typegen/oxlint/biome/tsc scoped to changed
paths; CI runs all of it unconditionally plus the full test suites. `docs/ci.md`
maps every workflow, the shared actions, caching, and the release fan-out.

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
  `docs/ARCHITECTURE.md`.
- **Tracing.** Use `tracing` `trace!`/`debug!` liberally in Rust pipelines -
  trace output is the primary debugging tool for wasm/browser issues.
- **Every `:hover` rule lives inside `@media (hover: hover)`**, paired with an
  `:active` twin that supplies the press feedback touch users lose. Touch
  browsers latch `:hover` onto the last-tapped element, so an ungated rule
  leaves tapped controls stuck in the hover look. Never group `:hover` with
  `:focus-visible`/`:focus-within`/`:active` in one selector list - those halves
  must stay outside the media query. Enforced by `npm run lint:touch-styles`;
  genuine exceptions go in that script's `EXEMPT` map with a reason.
- Relative imports only in TypeScript (no path aliases).

## Releases

Releases are release-please driven; the global `npm version` / `changelog:all`
instructions do **not** apply here.

- **Never hand-edit a version.** `release-please-config.json` owns every bump:
  root + webapp + alias + 4 platform `package.json`s and their locks, the
  `optionalDependencies` pins, `workspace.package.version`, ~43 path-dependency
  pins across `crates/*`, `vendor/*`, and `Cargo.lock`.
- **Flow:** merge conventional commits to `main` → release-please immediately
  opens/updates a `chore(main): release X.Y.Z` PR (on the `push` event, so it
  never trails CI; that path cannot cut a release) → CI goes green and the
  `workflow_run` path refreshes the release screenshots → merging that PR creates a
  **draft** GitHub release and sets `release_created=true`, which unlocks the
  npm/docker/homebrew publish jobs. Each attaches its assets to the draft; the
  final `publish-release` job publishes it, which creates the `vX.Y.Z` tag,
  stamps the release immutable, and triggers `cargo-publish.yml`. Merging the
  release PR is the release decision; nothing publishes before it.
- **Immutable releases are ON.** A published release accepts no new assets and
  permanently reserves its tag name - the version can never be re-cut. That is
  why the fan-out is draft-first: a failed release leaves a deletable draft
  instead of burning the version (v0.6.0 was lost this way). Never publish a
  draft release by hand before the fan-out finishes.
- **Prerelease:** `Release-As: X.Y.Z-alpha.N` commit footer for a one-off, or
  `prerelease`/`prerelease-type` in the config for a sustained track. Routing is
  automatic and keys off a hyphen in the version - no dist-tag step to remember:
  npm gets `beta` instead of `latest`, docker gets `beta` and skips the series
  tags, and the webapp deploys to `beta.rom-weaver.com`. Cargo needs no guard
  (crates.io has no dist-tags).
- `npm version` (→ `scripts/sync-version.mjs`) is the legacy manual path that
  cut v0.2.0-v0.5.0. It overlaps release-please and will fight it. Keep it only
  as a break-glass fallback.
- Pre-1.0 breaking changes bump the minor version because
  `bump-minor-pre-major` is enabled in `release-please-config.json`.

## Layout pointers

- CLI command orchestration: `crates/rom-weaver-cli` (shared library + native + wasm)
- Format handler registries: `crates/rom-weaver-containers`,
  `crates/rom-weaver-patches`
- Browser wasm runtime (OPFS, thread pool, worker client):
  `packages/rom-weaver-webapp/src/wasm`
- Webapp workflows/forms: `packages/rom-weaver-webapp/src`
- Vendored source is all in-tree under `crates/rom-weaver-containers`: the
  libarchive C sources at `libarchive/vendor/libarchive` (refresh with
  `scripts/vendor-libarchive.sh`), the nod and xdvdfs Rust sources under
  `src/nod` and `src/xdvdfs`. There are no git submodules.

## Worktrees

Fresh worktrees need `scripts/setup-worktree.sh` (real `npm ci` installs +
wasm artifact copy - symlink-mirrored node_modules silently stall vitest's
browser mode). Don't share the
main checkout's `target/` for wasm builds - cmake-built C deps (libarchive) break;
use a fresh target dir. Never put `/` or `+` in a worktree name (vitest
browser mode hangs on `+` in test paths).

## Tests

- Rust: `crates/*/tests/unit/`, CLI end-to-end in
  `crates/rom-weaver-cli/tests/cli_smoke/`
- Browser: `packages/rom-weaver-webapp/tests/browser/` (Playwright + vitest)
- Never skip/remove/modify tests to make a change pass.
