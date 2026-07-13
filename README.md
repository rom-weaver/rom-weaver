# rom-weaver

`rom-weaver` is a CLI (native and WASM) for ROM workflows:

- probe containers, patches, and known ROM headers
- extract containers (with nested extraction)
- checksum files/ranges and auto-resolved container payloads
- compress into multiple container formats
- trim or revert trim for supported ROM/disc image families
- apply and create many ROM patch formats
- repair ROM headers/checksums on patch apply (`--repair-checksum`)

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the workspace layout,
crate graph, threading model, and the Rust⇄TypeScript boundary.
See [`docs/self-hosting.md`](docs/self-hosting.md) to deploy the webapp on a
subdomain or alongside an existing site.

## Setup

Toolchain versions and build tasks are managed with [mise](https://mise.jdx.dev).
Install it (`brew install mise`, or see the mise docs), then from the repo root:

```bash
mise install        # rust, node, wasm-opt (binaryen), ripgrep - pinned in .mise.toml
mise trust          # trust this repo's mise config (first time only)
```

Two build dependencies are not pinnable through mise and must be installed
separately:

- **WASI SDK** (for the WebAssembly build). Install [wasi-sdk](https://github.com/WebAssembly/wasi-sdk/releases)
  to `/opt/wasi-sdk`, `/opt/homebrew/opt/wasi-sdk`, or `~/.local/toolchains/wasi-sdk-<ver>`
  - or set `WASI_SDK_PATH` to wherever it lives. `mise run build-wasm` finds it
  automatically (see `scripts/wasm/detect-wasi-sdk.sh`).
- **brotli** (compresses the wasm artifact): `brew install brotli` (or your OS
  package manager).

Then install the JS workspaces and git hooks:

```bash
npm ci --prefix packages/rom-weaver-react
npm install         # root: installs lefthook + runs `lefthook install`
```

Run `mise tasks` to list available tasks, or `mise run ci` for the full local
quality gate (matches CI).

## Build And Run

```bash
cargo build -p rom-weaver-cli
cargo run -p rom-weaver-cli -- --help
```

WASM artifacts + JS wrappers (via [mise](https://mise.jdx.dev) tasks):

```bash
mise run build-wasm
```

The WASM artifact keeps the `rom-weaver-app.wasm` package ABI, but the binary is
only a CLI/argv/reporter shim over the shared `rom-weaver-app` command
orchestration crate.

The threaded WASI toolchain wiring (WASI SDK discovery, `CC`/`CFLAGS`, the static
rustflags in `.cargo/config.toml`) is supplied by `mise`'s environment, so ad-hoc
target checks just work under `mise`:

```bash
mise run wasm-check   # cargo check the threaded containers lib
mise exec -- cargo check -p rom-weaver-containers --target wasm32-wasip1
```

By default `build-wasm` writes artifacts to `packages/rom-weaver-react/src/wasm`
(gitignored). Set `ROM_WEAVER_WASM_OUT_DIR` to write elsewhere; when the output
directory differs from the package, the artifacts are synced into
`packages/rom-weaver-react/src/wasm` automatically:

```bash
ROM_WEAVER_WASM_OUT_DIR=/path/to/wasm-artifacts mise run build-wasm
```

See [`packages/rom-weaver-react/src/wasm/README.md`](packages/rom-weaver-react/src/wasm/README.md) for browser OPFS usage.

Browser compatibility checks:

```bash
cd packages/rom-weaver-react
npm run lint:browser-compat
npm run test:browser
npm run test:browser:webkit:smoke
```

Tiered end-to-end checks:

```bash
mise run test-e2e-fast       # warm local/PR-equivalent gate
mise run test-e2e-nightly    # exhaustive valid interactions + WebKit
mise run test-e2e-ios        # generated archive corpus + HTTPS LAN server
```

See [`docs/mobile-safari-verification.md`](docs/mobile-safari-verification.md) for real iOS Safari,
Xcode Simulator Safari, and WebKit verification steps.

## WASM Package Surface

The wasm layer (`packages/rom-weaver-react/src/wasm`) exposes:

- Browser OPFS WASI runner (`run` and `runJson`)
- single `/work` OPFS mount wiring for browser workers
- dedicated browser worker client
- TypeScript declarations

Integration notes:

- Browser OPFS runtime is Dedicated Worker only (not main-thread `window`).

## CLI Commands

- `probe`
- `list`
- `extract`
- `checksum`
- `compress`
- `trim`
- `patch apply`
- `patch create`
- `patch validate`

Global flags:

- `--json`
- `--progress` / `--no-progress`
- `--trace`

Interactive selection fallback is enabled only for non-JSON TTY sessions (stdin and stderr are terminals).

Probe behavior highlights:

- `probe` auto-resolves payloads from archive containers (zip/7z/rar/tar) by default
- `probe` reports disc-image codec containers (CHD, RVZ, Z3DS, CSO, PBP, GCZ, WIA, WBFS, …) directly instead of decompressing them
- `probe --no-extract` probes source bytes directly
- `probe --select` chooses payload(s)
- `probe --no-ignore` disables default ignore filters (`.txt`, `.nfo`, `.sfv`, `.md5`, etc.)

List behavior highlights:

- `list` lists original container entries
- `list --select` chooses a nested container before listing its entries
- `list --no-ignore` disables default ignore filters during nested selection

## Patch Format Support

All listed formats support probe/parse (`probe`) and apply (`patch apply`).

| Format         | Aliases                     | Extensions                     | `patch create` |
| -------------- | --------------------------- | ------------------------------ | -------------- |
| `IPS`          | none                        | `.ips`                         | yes            |
| `IPS32`        | none                        | `.ips32`                       | yes            |
| `SOLID`        | `solidpatch`, `solid-patch` | `.solid`                       | yes            |
| `BPS`          | none                        | `.bps`                         | yes            |
| `UPS`          | none                        | `.ups`                         | yes            |
| `VCDIFF`       | `vcdiff`                    | `.vcdiff`                      | yes            |
| `xdelta`       | `xdelta3`                   | `.xdelta`, `.delta`, `.dat`    | yes            |
| `GDIFF`        | `gdiff`                     | `.gdiff`, `.gdf`               | yes            |
| `APS` (N64)    | none                        | `.aps`                         | yes            |
| `APSGBA`       | `aps-gba`                   | `.apsgba`                      | yes            |
| `RUP`          | none                        | `.rup`                         | yes            |
| `PPF`          | none                        | `.ppf`                         | yes            |
| `PAT`          | `ffp`, `fireflower`         | `.pat`, `.ffp`                 | yes            |
| `EBP`          | none                        | `.ebp`                         | yes            |
| `BDF/BSDIFF40` | `bdf`, `bsdiff`, `bsdiff40` | `.bdf`, `.bsdiff`, `.bsdiff40` | yes            |
| `BSP`          | none                        | `.bsp`                         | no             |
| `MOD`          | `pmsr`                      | `.mod`, `.pmsr`                | yes            |
| `DLDI`         | none                        | `.dldi`                        | yes            |
| `DPS`          | none                        | `.dps`                         | yes            |

Notes:

- `patch apply` accepts repeated `--patch` and applies patches sequentially.
- Patch checksum validation is strict by default for formats that embed checksums; use `--ignore-checksum-validation` to skip it.
- RUP apply honors legacy Ninja2 console normalization for existing patches. RUP create emits generic single-file `rom_type = 0` patches rather than console-normalized RUP variants.

## Container And Compression Format Support

| Format    | Aliases                                  | Extensions                                   | Probe | Extract | Create |
| --------- | ---------------------------------------- | -------------------------------------------- | ------- | ------- | ------ |
| `zip`     | none                                     | `.zip`                                       | yes     | yes     | yes    |
| `zipx`    | none                                     | `.zipx`                                      | yes     | yes     | no     |
| `7z`      | `7zip`                                   | `.7z`                                        | yes     | yes     | yes    |
| `rar`     | none                                     | `.rar`                                       | yes     | yes     | no     |
| `tar`     | none                                     | `.tar`                                       | yes     | yes     | no     |
| `tar.gz`  | `tgz`                                    | `.tar.gz`, `.tgz`                            | yes     | yes     | no     |
| `tar.bz2` | `tbz2`                                   | `.tar.bz2`, `.tbz2`                          | yes     | yes     | no     |
| `tar.xz`  | `txz`                                    | `.tar.xz`, `.txz`                            | yes     | yes     | no     |
| `gz`      | `gzip`                                   | `.gz`                                        | yes     | yes     | no     |
| `bz2`     | `bzip2`                                  | `.bz2`                                       | yes     | yes     | no     |
| `xz`      | `lzma`, `lzma2`                          | `.xz`                                        | yes     | yes     | no     |
| `zst`     | `zstd`, `zstandard`                      | `.zst`                                       | yes     | yes     | no     |
| `cso`     | `ciso`                                   | `.cso`, `.ciso`                              | yes     | yes     | no     |
| `pbp`     | none                                     | `.pbp`                                       | yes     | yes     | no     |
| `chd`     | `chd-cd`, `chd-dvd`, `chd-raw`, `chd-hd` | `.chd`                                       | yes     | yes     | yes    |
| `gcz`     | none                                     | `.gcz`                                       | yes     | yes     | no     |
| `wia`     | none                                     | `.wia`                                       | yes     | yes     | no     |
| `tgc`     | none                                     | `.tgc`                                       | yes     | yes     | no     |
| `nfs`     | none                                     | `.nfs`                                       | yes     | yes     | no     |
| `wbfs`    | none                                     | `.wbfs`                                      | yes     | yes     | no     |
| `rvz`     | none                                     | `.rvz`                                       | yes     | yes     | yes    |
| `z3ds`    | `3ds`                                    | `.z3ds`, `.zcci`, `.zcxi`, `.zcia`, `.z3dsx` | yes     | yes     | yes    |
| `xiso`    | none                                     | `.xiso`, `.xiso.iso`                         | no      | no      | no     |

Notes:

- `xiso` is intentionally trim-only (via `trim`).
- `extract` ignores common sidecar/metadata files by default (`.txt`, `.nfo`, `.sfv`, `.md5`, `__MACOSX`, etc.), supports `--select` (exact/prefix/glob), and recursively extracts nested containers up to depth 8.
- `extract --no-ignore` disables the default common-file filter.
- `extract --split-bin` is CHD-only (ignored for non-CHD input).
- CHD parent/differential workflows are supported when a parent CHD is supplied by the caller.
- CHD create accepts full MAME-style codec lists; Rust-native encoding emits CHD-compatible payloads for `zstd`, `zlib`, `lzma`, `huff`, `flac`, `cdzs`, `cdzl`, `cdlz`, `cdfl`, and `avhuff` (aliases `huffman` and `avhu` are accepted).
- `zipx` and `zst` are probe/extract inputs only. `compress --format zip --codec zstd` writes ZIP-compatible `.zip` output.

## Create-Time Codec Support

| Output format(s) | Supported `--codec` values                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `zip`            | `store`, `deflate`, `zstd`                                                                   |
| `7z`             | `lzma2` only                                                                                 |
| `rvz`            | `zstd` only                                                                                  |
| `z3ds`           | `zstd` only                                                                                  |
| `chd`            | `store`, `zlib`, `zstd`, `lzma`, `huff` (`huffman` alias), `flac`, `cdlz`, `cdzl`, `cdzs`, `cdfl`, `avhuff` (`avhu` alias) |

## Compression Level Profiles

`compress --level` and `patch apply --compress-level` share these named profiles:

- `min`
- `very-low`
- `low`
- `medium`
- `high`
- `very-high`
- `max`

Profile-to-numeric mapping is codec-aware (standard vs zstd), with explicit `codec:level` overrides taking priority.

## Checksum Support

Supported algorithms:

- `crc32`
- `md5`
- `sha1`
- `sha256`
- `blake3`
- `crc32c`
- `crc16`
- `adler32`

Behavior highlights:

- checksums can auto-resolve payloads from containers by default
- `--no-extract` disables auto-extract
- `--select` chooses payload(s)
- `--no-ignore` disables default ignore filters (`.txt`, `.nfo`, `.sfv`, `.md5`, etc.)
- `--no-trim-fix` disables automatic trim-boundary checksum fixes
- header/checksum compatibility transforms surface as `checksum_variants` (raw, remove-header, fix-header, n64 byte order)

## Trim Support

`trim` supports:

- NDS family (`.nds`, `.dsi`, `.srl`)
- GBA (`.gba`)
- 3DS (`.3ds`)
- XISO images (`.xiso`, `.xiso.iso`, and probed `.iso` XDVDFS)
- RVZ-scrub candidates (detected via format recommendation)

Notes:

- `--revert` is supported for NDS/GBA/3DS, but not for XISO or RVZ-scrub paths.
- XISO trim warns that original padding cannot be reconstructed.

## Header Detection And Repair

Known header detection is built into probe/checksum/patch apply flows, including:

- A78
- LNX
- NES / FDS
- SNES copier + SMC variants
- PCE copier
- Game Boy / GBA
- Mega Drive / Genesis
- SMS/GG
- N64 (all byte orders)
- NDS
- Neo Geo Pocket
- MSX

## Patch-Apply Workflow Features

- input and patch paths both support auto-extract payload resolution
- input pre-validation via `--validate-with-checksum ALGO=HEX`
- trusted checksum hints via `--checksum-cache ALGO=HEX`
- header operations: `--strip-header`, `--add-header`
- post-apply repair: `--repair-checksum`
- default-on output compression
  - disable with `--no-compress`
  - override with `--compress-format`, `--compress-codec`, `--compress-level`
  - auto mode prefers outer input container when possible, then falls back through built-in heuristics
  - extension is appended automatically when missing

## JSON Output

With `--json`, operations emit structured progress/status lines and include emitted file metadata where relevant.

## References

See [`REFERENCES.md`](REFERENCES.md) for format specs and reference implementations.
