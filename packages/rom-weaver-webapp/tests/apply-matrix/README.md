# Apply matrix (webapp)

Re-runnable end-to-end matrix for every path that writes bytes through the Apply route (`apply-rom-patches`): patch formats, input containers, output formats/levels, naming, header handling, chains, disc images, cheats, weave/combined-patch export, cancel/retry, large inputs.

It drives the real UI in headless Chromium (Playwright from the webapp package), downloads the result and compares sha256 with an oracle:

1. known target bytes from independent, dependency-free encoders (`../fixtures/apply-matrix/encoders.mjs`),
2. the native CLI (`target/release/rom-weaver`, or `RW_BIN`) as a differential oracle when it is built,
3. invariants (no page error, no hang, no silent success on a corrupt patch).

Missing tools or fixtures turn a case into `skip` with a printed reason; nothing is skipped silently. Disc outputs in a container format that need the native CLI to open them, when none is built, pass with the note `unverified (no native CLI)` in the case detail; single-file raw (`none`) outputs always need an exact byte match.

## Run

```bash
# once: wasm + bundle (see docs/development/reproduce-ci-locally.md)
mise run build-wasm-fast && npm --prefix packages/rom-weaver-webapp run build

# from the repository root
node packages/rom-weaver-webapp/tests/apply-matrix/run.mjs                 # everything
node packages/rom-weaver-webapp/tests/apply-matrix/run.mjs --filter bps    # id/group/tag substring (comma = any)
node packages/rom-weaver-webapp/tests/apply-matrix/run.mjs --group output-format,naming
node packages/rom-weaver-webapp/tests/apply-matrix/run.mjs --list          # print the case catalogue
```

Options: `--workers N` (default 2 parallel browser contexts), `--port 5191`, `--base-url URL`, `--out DIR` (screenshots, downloads; default `$TMPDIR/rw-apply-matrix`), `--json FILE`.

The runner reuses a preview server already listening on the base URL; otherwise it starts `node scripts/dev-server.mjs preview --port <port>` (needs `dist/`) and stops it afterwards. Exit code is non-zero when any case fails. No network is used.

## Groups

`patch-format`, `patch-wrongsource`, `patch-corrupt`, `chain`, `container-input`, `container-select`, `output-format`, `naming`, `reapply`, `header`, `options`, `disc-input`, `cheats`, `weave`, `combined-patch`, `ppf-undo`, `patch-unsupported` (BSP, DLDI and NINJA1 live in `cases-misc.mjs`).

Exhaustive groups (Create, Trim, Compress, Extract, edge cases; ~470 cases):

- `create` - every format the Create UI offers x input pair, containers/codecs/levels, input shapes, size buckets, mobile, repeat. Judged by flips/xdelta3, the native CLI and a webapp Apply round trip.
- `trim` - every trim-capable fixture (NDS/DSi/SRL, GBA, 3DS, XISO) x offered output, GameCube/Wii discs refused at staging, codec x level, native revert round trips.
- `compress` - zip/7z codec x level, RVZ/CHD/Z3DS outputs, duplicate names, 0/1-byte, mobile.
- `extract` - every archive/stream/disc input type vs host tools (7z, bsdtar, chdman, dolphin-tool), negatives, multipart.
- `drop` / `edge` / `console` / `apply-out` - real CDP drag-and-drop (`lib/drag.mjs`), cancel and recover, progress, large (400 MiB) inputs, OPFS cleanup, console cleanliness, per-level Apply output sweeps.

Extra generated fixtures live in `~/.cache/agents/apply-matrix-fixtures/exh-web` and are never committed. Host tools used when present: `7z`, `bsdtar`, `chdman`, `dolphin-tool`, `xdelta3`, `flips`, `target/release/rom-weaver`; a missing tool turns the dependent assertion into a skip. The `create`, `trim`, `compress`, `extract` and `apply-out` groups read fixtures that the CLI harness builds (`scripts/apply-matrix/cli/run.sh --gen-fixtures`); without them those cases skip with `fixture missing`.

Extension-less single-file wrappers: `rom-in/rom.{gz,xz,bz2,zst,lz4}` and `patch-in/patch.{gz,xz,bz2,zst,lz4}` are extracted and applied (Rust ingest accepts an extension-less payload and classifies it by patch signature). When a drop has several ROM candidates, the app asks Rust ingest about each extension-less one before routing it: `rom-in/bare-no-extension-{gz,xz,bz2,zst,lz4}` (sole extension-less compressed ROM named `rom`) are staged and applied, `patch-in/bare-no-extension` (bare extension-less BPS) is applied with no picker, and `rom-in/rom.gz+base.bin-picker` still opens the ROM picker with no error and no patch card. `unsupported/ninja1` (unknown `.rnp` extension) and the split-WBFS `disc/wbfs-split-*` cases assert a visible "not a recognised ROM or patch format" or "split WBFS" message at staging, with no second-ROM picker and no download.

## Fixtures

`../fixtures/apply-matrix/generate.mjs` (called by the runner, also runnable alone; `--check` verifies hashes) builds everything deterministically. Neither the runner nor a plain run rewrites the tracked `manifest.json`; only `node generate.mjs --update-manifest` does, and it keeps recorded entries instead of replacing them with `unavailable` ones. The manifest records (name, purpose, sha256, how generated):

- `blobs/` - small pure-Node fixtures (patches for 9 formats, hdiffpatch copies), committed; `blobs/borrowed/` holds hand-assembled BSP scripts and DLDI/DS samples copied verbatim from the cli worker.
- `$RW_MATRIX_CACHE` (default `~/.cache/agents/apply-matrix-fixtures/webapp`) - archives built with host `xz`/`bzip2`/`zstd`/`lz4`/`zip` and formats only the native CLI writes (dps, rup, ppf, aps, apsgba, pat, solid, mod, bdf, 7z), plus a 40 MiB PMSR stand-in. Regenerated on demand.
