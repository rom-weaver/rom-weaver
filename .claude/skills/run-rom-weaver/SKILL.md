---
name: run-rom-weaver
description: Build, run, and drive rom-weaver - the native ROM-workflow CLI and the React webapp. Use to launch the CLI, start the webapp dev server, screenshot the webapp, or confirm a change works end-to-end (apply a patch, extract/compress a ROM) in the real app, not just tests.
---

# Run rom-weaver

rom-weaver ships two deployable surfaces from one repo:

- **Native CLI** (`rom-weaver`) - probe / list / checksum / extract / compress / trim / patch. Drive it with `cli-smoke.sh` (this dir).
- **React webapp** - the same engine compiled to wasm, run in-browser with OPFS + SharedArrayBuffer threads. Drive it headless with `webapp-driver.mjs` (this dir) over Playwright.

All paths below are relative to the repo root (the directory containing this `.claude/`). The two committed harnesses are the primary agent path - use them, don't hand-drive.

## Prerequisites

Verified on macOS with these already on PATH: `node` 26, `cargo`/`rustc` 1.95. The webapp package's `node_modules` (incl. **Playwright + its chromium**) and the wasm artifact (`packages/rom-weaver-webapp/src/wasm/rom-weaver-app.wasm`, git-ignored build output) were both already present in the checkout - the harnesses reuse them, no extra install needed.

On a clean clone you would first install JS deps and build the wasm artifact (project's documented commands - not re-run here because both were already built):

```bash
npm --prefix packages/rom-weaver-webapp ci   # JS deps + Playwright browsers
mise run build-wasm                         # wasm artifact (needs WASI SDK v33+)
```

## Build the CLI

```bash
cargo build -p rom-weaver-cli --release     # → target/release/rom-weaver
```

## Run: CLI (agent path)

`cli-smoke.sh` exercises list/checksum/extract/compress and a full xdelta patch round-trip against committed fixtures, asserting the patched output's CRC32 equals the known-good target:

```bash
.claude/skills/run-rom-weaver/cli-smoke.sh
```

Last run ended with `OK: CLI smoke passed (patch round-trip matches target 221d2d6c)`. It auto-picks `target/release/rom-weaver`, falling back to `target/debug`; override with `RW_BIN=/path/to/rom-weaver`.

Ad-hoc invocations (note the per-subcommand arg shapes - they differ):

```bash
target/release/rom-weaver checksum --algo crc32 tests/fixtures/vcdiff/secondary-source.bin
target/release/rom-weaver extract packages/rom-weaver-webapp/tests/fixtures/archives/one-rom.zip --out-dir /tmp/ex --checksum-rom crc32
target/release/rom-weaver patch apply --input tests/fixtures/vcdiff/secondary-source.bin --patch tests/fixtures/vcdiff/secondary-djw.xdelta --output /tmp/patched.bin --no-compress
```

## Run: webapp (agent path)

Start the bundled dev server (sets the COOP/COEP cross-origin-isolation headers the wasm thread pool requires - a plain static server will not), then drive it with the Playwright harness. **Run both from `packages/rom-weaver-webapp`.**

```bash
# 1. dev server - HTTPS, self-signed cert, binds all interfaces (pick a free PORT)
cd packages/rom-weaver-webapp
node scripts/dev-server.mjs dev --port 5191      # → https://localhost:5191/   (leave running)

# 2. drive it (separate shell, still inside packages/rom-weaver-webapp)
node ../../.claude/skills/run-rom-weaver/webapp-driver.mjs load    # boot + screenshot
node ../../.claude/skills/run-rom-weaver/webapp-driver.mjs apply   # upload ROM+patch, Apply, capture download
```

`apply` uploads the `secondary-source.bin` ROM + `secondary-djw.xdelta` patch, clicks **Apply & download**, saves the result, and asserts a non-empty download. Screenshots and the downloaded file land in `RW_OUT` (default `/tmp/rw-driver/`): `load.png`, `apply-staged.png`, `apply-done.png`. Last `apply` run reported `OK: apply produced secondary-source - secondary-djw.chd (4975 bytes)`; the done screenshot shows `Patch validation passed`, output `70000` bytes (same as the CLI round-trip), and `DONE … 10 threads`.

Env knobs: `RW_URL` (default `https://localhost:5191/`), `RW_OUT`, `RW_HEAD=1` for a headed browser.

## Run: webapp (human path)

`npm --prefix packages/rom-weaver-webapp run dev` opens the same server for a real browser. Useless headless - you need the Playwright harness above to interact programmatically. Ctrl-C to stop.

## Gotchas

- **The driver resolves Playwright from `packages/rom-weaver-webapp`, not from its own dir.** A bare `import "playwright"` from `.claude/skills/...` fails `ERR_MODULE_NOT_FOUND` (no `node_modules` ancestor). `webapp-driver.mjs` handles this with `createRequire` anchored at the package; if you write your own, do the same or run from inside the package.
- **Dev server is HTTPS with a self-signed cert.** Playwright needs `ignoreHTTPSErrors: true` (the driver sets it); `curl` needs `-k`.
- **Cross-origin isolation is mandatory.** The wasm engine uses SharedArrayBuffer worker threads, which only work under COOP/COEP. The bundled `dev-server.mjs` sets those headers; a plain `python -m http.server` / `vite preview` without them boots the page but breaks threading. Always serve via `dev-server.mjs`.
- **The wasm artifact is git-ignored.** If `src/wasm/rom-weaver-app.wasm` is missing, the page boots but the runtime can't compile - rebuild with `mise run build-wasm`.
- **Apply output defaults to a compressed `.chd`** in both surfaces. The webapp download is a 4.98 KB CHD even though the patched bytes are 70000; the CLI errors on a raw `.bin` output unless you pass `--no-compress` (or a supported compressed extension).
- **CLI arg shapes vary per subcommand:** `checksum` requires `--algo`; `extract` uses `--out-dir` (not `--output`); `patch apply` uses `--input`/`--patch`/`--output`. Guessing one from another fails.
- **Wait on `#rom-weaver-input-file-unified`, not a tab button.** That hidden unified file input is the stable "app mounted" anchor; `getByRole("button", {name:"Apply"})` was not reliably visible during warmup.

## Troubleshooting

- `Cannot find package 'playwright'` → you ran the driver from the wrong cwd with a hand-rolled import, or the package's `node_modules` is absent. Run `npm --prefix packages/rom-weaver-webapp ci`.
- `locator.waitFor: Timeout … #rom-weaver-input-file-unified` → dev server isn't up or you hit the wrong port. Check `curl -sk https://localhost:5191/ -o /dev/null -w '%{http_code}'` returns `200`.
- CLI `extract`: `unexpected argument '--output'` → use `--out-dir`.
- CLI `patch apply`: `output extension '.bin' is not a supported format` → add `--no-compress` or use a compressed extension.
- `no rom-weaver binary` from `cli-smoke.sh` → run `cargo build -p rom-weaver-cli --release` first.
