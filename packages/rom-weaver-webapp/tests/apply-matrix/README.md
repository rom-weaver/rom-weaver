# Apply matrix (webapp)

Re-runnable end-to-end matrix for every path that writes bytes through the Apply route (`apply-rom-patches`): patch formats, input containers, output formats/levels, naming, header handling, chains, disc images, cheats, weave/combined-patch export, cancel/retry, large inputs.

It drives the real UI in headless Chromium (Playwright from the webapp package), downloads the result and compares sha256 with an oracle:

1. known target bytes from independent, dependency-free encoders (`../fixtures/apply-matrix/encoders.mjs`),
2. the native CLI (`target/release/rom-weaver`, or `RW_BIN`) as a differential oracle when it is built,
3. invariants (no page error, no hang, no silent success on a corrupt patch).

Missing tools or fixtures turn a case into `skip` with a printed reason; nothing is skipped silently. Disc outputs in a container format that need the native CLI to open them, when none is built, pass with the note `unverified (no native CLI)` in the case detail; raw (`none`) outputs always need an exact byte match.

## Run

```bash
# once: production wasm + bundle (see docs/development/reproduce-ci-locally.md)
mise run build-wasm && npm --prefix packages/rom-weaver-webapp run build

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

Known failures (product behavior, see the report): `rom-in/rom.{gz,xz,bz2,zst,lz4}` and `patch-in/patch.*` use extension-less single-file wrappers, which the app does not recognise; they fail by design of the matrix until the app is fixed.

## Fixtures

`../fixtures/apply-matrix/generate.mjs` (called by the runner, also runnable alone; `--check` verifies hashes) builds everything deterministically. Neither the runner nor a plain run rewrites the tracked `manifest.json`; only `node generate.mjs --update-manifest` does, and it keeps recorded entries instead of replacing them with `unavailable` ones. The manifest records (name, purpose, sha256, how generated):

- `blobs/` - small pure-Node fixtures (patches for 9 formats, hdiffpatch copies), committed; `blobs/borrowed/` holds hand-assembled BSP scripts and DLDI/DS samples copied verbatim from the cli worker.
- `$RW_MATRIX_CACHE` (default `~/.cache/agents/apply-matrix-fixtures/webapp`) - archives built with host `xz`/`bzip2`/`zstd`/`lz4`/`zip` and formats only the native CLI writes (dps, rup, ppf, aps, apsgba, pat, solid, mod, bdf, 7z), plus a 40 MiB PMSR stand-in. Regenerated on demand.
