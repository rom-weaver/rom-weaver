# Agent instructions

## Worktrees

When starting work, always create and use a new linked worktree. Do not make
changes directly in the primary checkout; use `.worktrees/<name>` for the
working tree.

This repository has no Git submodules; every vendored source is committed
in-tree, so a linked worktree is complete as soon as it is created.

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
npm --prefix packages/rom-weaver-webapp run lint    # oxfmt + oxlint + biome + tsc + browser-compat + knip
npm --prefix packages/rom-weaver-webapp run test:browser:wasm  # wasm-layer browser tests
```

Pre-commit hooks (lefthook) select formatting, static analysis, type generation,
dependency-policy, and WASM checks from the changed paths; each selected check
still runs over its full owning workspace. CI adds tests and builds according to
its change classification. `docs/development/ci.md` maps every workflow, the
shared actions, caching, and the release fan-out.

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
- **Every `:hover` rule lives inside `@media (hover: hover)`**, paired with an
  `:active` twin that supplies the press feedback touch users lose. Touch
  browsers latch `:hover` onto the last-tapped element, so an ungated rule
  leaves tapped controls stuck in the hover look. Never group `:hover` with
  `:focus-visible`/`:focus-within`/`:active` in one selector list - those halves
  must stay outside the media query. Enforced by `npm run lint:touch-styles`;
  genuine exceptions go in that script's `EXEMPT` map with a reason.
- **A cascade layer boundary costs more than it looks.** `design-system/index.css`
  declares the layer order; across a boundary that order decides outright and
  specificity stops counting, so a bare `.card` in a later layer beats a
  `.card.is-disabled .rb` in an earlier one. Layers therefore exist only where a
  stylesheet arrives at a different time (`deferred.css`, `docs-route.css`) - a new
  file joins the layer its neighbours are in, never one of its own. An override
  belongs in the file that owns the component it modifies; reaching across a
  boundary cannot be fixed by adding specificity. Enforced by
  `npm run lint:css-layers`, with exceptions in that script's `EXEMPT` map.
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

Releases are release-please driven; the global `npm version` / `changelog:all`
instructions do **not** apply here.

- **Never hand-edit a version.** `release-please-config.json` owns every bump:
  the root/webapp package files and locks, the alias and all 9 platform
  `package.json`s, the `optionalDependencies` pins,
  `workspace.package.version`, and the path-dependency pins across `crates/*`,
  `vendor/*`, and `Cargo.lock`.
- **Flow:** merge conventional commits to `main` (nothing happens - there is no
  `push` trigger) → when you want a release, **run the `Release` workflow
  manually** from the Actions tab, which opens/refreshes the
  `chore(main): release X.Y.Z` PR and captures its screenshots → merging that PR
  creates a **draft** GitHub release and sets `release_created=true`, which
  unlocks the npm/docker/homebrew publish jobs. Each attaches its assets to the
  draft; the final `publish-release` job publishes it, which creates the
  `vX.Y.Z` tag, stamps the release immutable, and triggers `cargo-publish.yml`.
  Merging the release PR is the release decision; nothing publishes before it.
- **Dispatch after main's CI is green.** The screenshots reuse the `wasm-prod`
  artifact from that commit's CI run; without it the job rebuilds WASM from
  source (~6.5 min). Re-dispatch any time to refresh an open release PR.
- The dispatch takes an optional `release_as` input (wired to the action's
  `release-as`) to force a version without a `Release-As:` commit footer.
- **Immutable releases are ON.** A published release accepts no new assets and
  permanently reserves its tag name - the version can never be re-cut. That is
  why the fan-out is draft-first: a failed release leaves a deletable draft
  instead of burning the version (v0.6.0 was lost this way). Never publish a
  draft release by hand before the fan-out finishes.
- **Prerelease:** `Release-As: X.Y.Z-alpha.N` commit footer for a one-off, or
  `prerelease`/`prerelease-type` in the config for a sustained track. Routing is
  automatic and keys off a hyphen in the version - no dist-tag step to remember:
  npm gets `beta` instead of `latest`, docker skips `latest` and the series
  tags, and the webapp deploys to `beta.rom-weaver.com`. Cargo needs no guard
  (crates.io has no dist-tags).
- **Docker channels mirror the webapp's.** `latest`/`beta`/`nightly` are the
  image-side names for prod/beta/nightly and cascade the same way a deploy
  does - a stable release moves all three, a prerelease moves `beta` and
  `nightly`, and a push to `main` moves only `nightly`. The `nightly` images
  are pushed from `ci.yml` (CLI from the `docker` job, webapp from
  `docker-prebuilt`), not from `docker-publish.yml`.
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
  `scripts/vendor-libarchive.mjs`), the 7-Zip LZMA SDK C sources at
  `lzma-sdk/vendor/C` (refresh with `scripts/vendor-lzma-sdk.mjs`; verbatim, no
  local patches), the nod and xdvdfs Rust sources under
  `src/nod` and `src/xdvdfs`. There are no git submodules.

## Worktree setup

Fresh worktrees need `scripts/setup-worktree.mjs` (real `npm ci` installs +
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
