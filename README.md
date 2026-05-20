# rom-weaver

`rom-weaver` is a CLI (native and WASM) for ROM workflows:

- inspect containers, patches, and known ROM headers
- extract containers (with nested extraction)
- checksum files/ranges and auto-resolved container payloads
- compress into multiple container formats
- trim or revert trim for supported ROM/disc image families
- apply and create many ROM patch formats
- batch-fix supported ROM headers/checksums

## Build And Run

```bash
cargo build -p rom-weaver-cli
cargo run -p rom-weaver-cli -- --help
```

WASM artifacts + JS wrappers:

```bash
scripts/build-wasm-cli.sh
```

See [`packages/rom-weaver-wasm/README.md`](packages/rom-weaver-wasm/README.md) for Node/OPFS usage.

## WASM Package Surface

`packages/rom-weaver-wasm` exposes:

- Node WASI runner (`run` and `runJson`)
- NodeFS mount helpers
- ZenFS runners for Node and browser OPFS
- dedicated Node/browser worker clients
- TypeScript declarations

## CLI Commands

- `inspect`
- `extract`
- `checksum`
- `compress`
- `trim`
- `batch-header-fixer`
- `patch-apply`
- `patch-create`

Global flags:

- `--json`
- `--progress` / `--no-progress`
- `--trace`

Interactive selection fallback is enabled only for non-JSON TTY sessions (stdin and stderr are terminals).

## Patch Format Support

All listed formats support inspect/parse (`inspect`) and apply (`patch-apply`).

| Format         | Aliases                     | Extensions                     | `patch-create` |
| -------------- | --------------------------- | ------------------------------ | -------------- |
| `IPS`          | none                        | `.ips`                         | yes            |
| `IPS32`        | none                        | `.ips32`                       | yes            |
| `SOLID`        | `solidpatch`, `solid-patch` | `.solid`                       | yes            |
| `BPS`          | none                        | `.bps`                         | yes            |
| `UPS`          | none                        | `.ups`                         | yes            |
| `VCDIFF`       | `vcdiff`                    | `.vcdiff`                      | yes            |
| `xdelta`       | `xdelta3`                   | `.xdelta`                      | yes            |
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

- `patch-apply` accepts repeated `--patch` and applies patches sequentially.
- Patch checksum validation is strict by default for formats that embed checksums; use `--ignore-checksum-validation` to skip it.

## Container And Compression Format Support

| Format    | Aliases                                  | Extensions                                   | Inspect | Extract | Create |
| --------- | ---------------------------------------- | -------------------------------------------- | ------- | ------- | ------ |
| `zip`     | none                                     | `.zip`                                       | yes     | yes     | yes    |
| `zipx`    | none                                     | `.zipx`                                      | yes     | yes     | yes    |
| `7z`      | `7zip`                                   | `.7z`                                        | yes     | yes     | yes    |
| `rar`     | none                                     | `.rar`                                       | yes     | yes     | no     |
| `tar`     | none                                     | `.tar`                                       | yes     | yes     | yes    |
| `tar.gz`  | `tgz`                                    | `.tar.gz`, `.tgz`                            | yes     | yes     | yes    |
| `tar.bz2` | `tbz2`                                   | `.tar.bz2`, `.tbz2`                          | yes     | yes     | yes    |
| `tar.xz`  | `txz`                                    | `.tar.xz`, `.txz`                            | yes     | yes     | yes    |
| `gz`      | `gzip`                                   | `.gz`                                        | yes     | yes     | yes    |
| `bz2`     | `bzip2`                                  | `.bz2`                                       | yes     | yes     | yes    |
| `xz`      | `lzma`, `lzma2`                          | `.xz`                                        | yes     | yes     | yes    |
| `zst`     | `zstd`, `zstandard`                      | `.zst`                                       | yes     | yes     | yes    |
| `cso`     | `ciso`                                   | `.cso`, `.ciso`                              | yes     | yes     | yes    |
| `pbp`     | none                                     | `.pbp`                                       | yes     | yes     | no     |
| `chd`     | `chd-cd`, `chd-dvd`, `chd-raw`, `chd-hd` | `.chd`                                       | yes     | yes     | yes    |
| `gcz`     | none                                     | `.gcz`                                       | yes     | yes     | no     |
| `wia`     | none                                     | `.wia`                                       | yes     | yes     | yes    |
| `tgc`     | none                                     | `.tgc`                                       | yes     | yes     | yes    |
| `nfs`     | none                                     | `.nfs`                                       | yes     | yes     | no     |
| `wbfs`    | none                                     | `.wbfs`                                      | yes     | yes     | yes    |
| `rvz`     | none                                     | `.rvz`                                       | yes     | yes     | yes    |
| `z3ds`    | `3ds`                                    | `.z3ds`, `.zcci`, `.zcxi`, `.zcia`, `.z3dsx` | yes     | yes     | yes    |
| `xiso`    | none                                     | `.xiso`, `.xiso.iso`                         | no      | no      | no     |

Notes:

- `xiso` is intentionally trim-only (via `trim`).
- `extract` supports `--select` (exact/prefix/glob) and recursively extracts nested containers up to depth 8.
- `extract --split-bin` is CHD-only (ignored for non-CHD input).

## Create-Time Codec Support

| Output format(s)     | Supported `--codec` values                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `zip`, `zipx`        | `store`, `deflate`, `bzip2`, `zstd`                                                          |
| `7z`                 | `lzma2` (default), `lzma`                                                                    |
| `tar`                | `store` (or omit)                                                                            |
| `tar.gz`, `gz`       | `gzip` / `deflate`                                                                           |
| `tar.bz2`, `bz2`     | `bzip2`                                                                                      |
| `tar.xz`, `xz`       | `xz` / `lzma` / `lzma2`                                                                      |
| `zst`                | `zstd`                                                                                       |
| `cso`, `tgc`, `wbfs` | `store` only                                                                                 |
| `wia`                | `store`, `bzip2`, `lzma`, `lzma2`, `zstd`                                                    |
| `rvz`                | `store`, `zstd`, `bzip2`, `lzma`, `lzma2`                                                    |
| `z3ds`               | `zstd` only                                                                                  |
| `chd`                | `store`, `zlib`, `zstd`, `lzma`, `huffman`, `flac`, `cdlz`, `cdzl`, `cdzs`, `cdfl`, `avhuff` |

## Compression Level Profiles

`compress --level` and `patch-apply --compress-level` share these named profiles:

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
- `--strip-header` and `--no-trim-fix` control compatibility transforms

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

Known header detection is built into inspect/checksum/patch-apply flows, including:

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

`batch-header-fixer` supports these profile groups:

- `snes`
- `nes`
- `fds`
- `game-boy`
- `gba`
- `sega-genesis`
- `sms-gg`
- `n64`
- `atari-7800`
- `atari-lynx`
- `pce-tg16`
- `virtual-boy`
- `neo-geo-pocket`
- `msx`
- `nds`
- `atari-jaguar`
- `colecovision`
- `watara-supervision`
- `intellivision`

## Patch-Apply Workflow Features

- input and patch paths both support auto-extract payload resolution
- input pre-validation via `--validate-with-checksum ALGO=HEX`
- cache seeding via `--checksum-cache ALGO=HEX`
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
