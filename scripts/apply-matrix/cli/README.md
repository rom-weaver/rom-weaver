# Native CLI apply matrix

Black-box matrix for every `rom-weaver patch apply` path (plus the apply-adjacent input/output pipeline: `patch validate`, `weave`/`patch weave`, `tools ppf-undo`, `--code`). Node 20+ only, no network, no npm dependencies. It drives the real binary and compares output bytes with independently computed expectations.

```sh
cargo build -p rom-weaver-cli --release            # once
scripts/apply-matrix/cli/run.sh                    # whole matrix (about 10-15 minutes, mostly fuzz + large ROM)
scripts/apply-matrix/cli/run.sh --list             # list case ids
scripts/apply-matrix/cli/run.sh --filter bps       # regex on "<id> <tags>", comma = OR
scripts/apply-matrix/cli/run.sh --filter 'container\.source,output\.zip' --skip fuzz
scripts/apply-matrix/cli/run.sh --strict           # known-bug (xfail) cases count as failures
scripts/apply-matrix/cli/run.sh --gen-fixtures --update-manifest   # build missing fixtures, rewrite manifest.json (to rebuild cache fixtures after a generator change, delete the cache dir or point APPLY_MATRIX_CACHE at an empty one first)
```

Exit status is non-zero when any case fails (or, with `--strict`, any known bug reproduces). Options: `--bin PATH` (or `RW_BIN`), `--work DIR`, `--keep` (keep per-case dirs of passing cases), `--verbose` (print every invocation), `--fail-fast`, `--json FILE`.

<!-- START doctoc -->
## Table of contents

- [Case groups (`<group>.<feature>.<name>`)](#case-groups-groupfeaturename)
- [Fixtures](#fixtures)
- [Not covered here](#not-covered-here)

<!-- END doctoc -->

## Case groups (`<group>.<feature>.<name>`)

| group | covers |
| --- | --- |
| `patch.<format>.*` | per patch format: apply variants, validate, dry-run, `--json`/`--jsonl`, wrong source / size, `--expect-in/out`, empty / garbage / truncated / corrupt patch, extension sniffing, streaming-vs-in-memory and `-j` parity, overwrite policy |
| `chain.*` `validate.*` `checksum-flags.*` `header.*` `n64.*` `repair-checksum.*` `ppf-undo.*` `weave.*` `cheats.*` | multi-patch chains and basis rules, `patch validate` modes, checksum flags, SNES/NES copier headers, N64 byte order, header repair, weave round trips, `--code` baking |
| `create.*` | `patch create` for every creatable patch format: round trips over 17 ROM pairs (empty, 1 byte, header-sized, insert/delete, 3 MiB scattered, IPS EOF offset 0x454F46, long runs), `-j` determinism, `--json`/`--jsonl`, overwrite policy, `--plan`/`--dry-run`, `-f`/alias/neutral extension, stdout, unicode names, xdelta secondary, PPF undo, SOLID metadata, `--checksum-name`, `--assume-in`, cross-checks with flips and xdelta3 |
| `compress.*` | `compress` for zip / 7z / chd / rvz / z3ds: every codec x level, `codec:level`, invalid codecs / levels / `--rvz-block-size`, `-j`, JSON, stdin / stdout, multiple inputs, directory input, overwrite, tiny / empty / incompressible inputs, a 4.4 GiB sparse input, verification with `unzip`/`7z`/`chdman`/`dolphin-tool`/`zstd`, chdman byte parity (recorded as observations) |
| `trim.*` | `trim` for NDS (DS, DSi, Download Play certificate), GBA, 3DS (NCSD) with 0xFF and 0x00 padding, GameCube ISO to RVZ and XISO: output naming, `--in-place`, `--dry-run`, `--revert-marker` / `--revert` exact round trips, power-of-two revert, folders, zip / 7z repack, untrimmable and corrupt inputs, `-j`, stdout, JSON |
| `extract.*` | `extract` for ~60 archive variants (zip methods, 7z methods and filters, rar5, tar flavours, single-stream gz / bz2 / xz / zst / lz4), disc containers, chdman- and dolphin-tool-written CHD / RVZ, plus nested, encrypted, truncated, bit-flipped, hostile (zip slip, symlinks, bomb) inputs and the `--select` / `--filter` / `--checksum` / `--probe` / `--force` / stdin / stdout options |
| `apply-matrix.*` | every creatable patch format x {patch in each archive type, ROM in each archive type, single compressed patch, zip / 7z outputs with each codec and level} |
| `registry.*` | cases generated from `rom-weaver formats --json`: every patch extension and alias, writable container aliases, non-writable formats rejected, codec level bounds (min / max valid, one beyond rejected) |
| `container.*` | source ROM and patch inside zip/7z/tar.*/gz/bz2/xz/zst/rar/lz4/zipx, nested archives, `--select`/`--patch-select`/`--filter`/`--no-extract`, broken/encrypted archives, CSO/CISO/WBFS (split)/TGC/PBP/XISO/NFS/WIA/RVZ/CHD/Z3DS inputs |
| `output.*` `output-path.*` | raw vs zip/7z/chd/rvz/z3ds results, every codec x level, `-j` determinism, disc outputs, cue/gdi targets, existing files, unicode, permissions, stdout, symlinks |
| `large.*` | 34 MiB ROM across the in-memory / streaming / sparse tiers |
| `fuzz.*` | every-Nth-byte truncation and bit-flip of a small patch per format (robustness contract: no panic, hang or leftover output) |
| `diagnostics.*` `cancel.*` | verbosity flags, JSON failure documents, usage errors, SIGINT cleanup |
| `reference.*` | parity with the real reference tools, skipped with a reason when a tool is absent: `reference.wia.*` / `reference.gcz.*` (dolphin-tool-written WIA/GCZ over compression, level, block-size and scrub options: extract == original ISO == `dolphin-tool convert -f iso`, patch apply via the container == raw ISO, truncated/bit-flipped/garbage containers), `reference.xdelta3.*` (xdelta3 -e variants applied by rom-weaver; rom-weaver xdelta/vcdiff decoded by `xdelta3 -d`), `reference.flips.*` (flips IPS/BPS styles, --exact, EOF-address, RLE, truncate and metadata quirks, both directions), `reference.7z.*` / `reference.zip.*` / `reference.rar.*` (archives made by `7z a` / `rar a` read by rom-weaver; rom-weaver zip/7z results read by `7z t`/`7z x`) |

Cases may call `skip(reason)`; skips are printed with their reason, never silent. A case with `knownBug: "BUG-..."` is an expected failure (`XFAIL`); if it starts passing the run fails so the marker is removed. Observations that are not failures are printed under `OBSERVATIONS`.

## Fixtures

Registered in `lib/fixture-defs.mjs`; generated lazily and verified against `manifest.json`.

| location | content | policy |
| --- | --- | --- |
| `tests/fixtures/apply-matrix/` (repo) | 40 KiB pseudo-random ROM family, patches from the independent encoders in `lib/encoders.mjs`, header/N64/GB/DLDI/BSP fixtures | byte-deterministic; regenerated when stale; sha256 enforced by the manifest |
| `~/.cache/agents/apply-matrix-fixtures/` (override `APPLY_MATRIX_CACHE`) | `exh/` generators for the create / compress / trim / extract groups (CD cue+bin, DVD iso, NDS, GBA, 3DS, archives from system tools, chdman / dolphin-tool containers; built only when missing), patches authored by `rom-weaver patch create`, archives built by system `zip`/`tar`/`bsdtar`/`xz`/..., disc containers, the 34 MiB ROM | built only when missing, never rebuilt over an existing file; sha256 is enforced for entries marked deterministic (e.g. `cheats/snes4m.sfc`) and informational for tool/product-built ones |
| existing repo fixtures (`ext:` paths) | `tests/fixtures/{vcdiff,rar,extract-only}`, `crates/rom-weaver-patches/tests/fixtures/hdiffpatch`, webapp `archives/` and `browser-generated/` | used in place, never copied |

Oracles: independent Node encoders for IPS, IPS32, BPS, UPS, PPF1-3, APS (N64), GDIFF, VCDIFF; the vendored upstream `bsppatch.js` runtime for BSP; `unzip`/`bsdtar` for zip/7z outputs; system `zip`/`tar`/... for inputs; `node:crypto` for checksums. `chdman`, `dolphin-tool`, `xdelta3`, `flips`, `7z`, `rar`, `unrar` are used when present (cases skip with a reason otherwise); the `reference.*` fixtures (a GameCube-like ISO, WIA/GCZ containers from `dolphin-tool convert`, a 3 MiB block-shuffled pair) live in the cache directory - `mise run quality-reference` and the Rust `cli_smoke` suite assert parity against them where installed.

`container.disc.wia-bitflip.*` and `container.disc.rvz-bitflip.*` each check 40 positions for `none` and 13 for `lzma2` in each of three regions: hashed headers, unchecked raw payloads, and raw payloads covered by an optional NKit SHA-1. Header mismatches must fail cleanly without output. NKit-protected payload flips must extract with exit 0 and a checksum warning.

Unchecked payload changes are reported as `documented-limit`, as described in [WIA and RVZ payload integrity](../../../docs/reference/formats.md#wia-and-rvz-payload-integrity). Valid controls must extract byte for byte.

## Not covered here

- DCP positive rebuild (needs a GD-ROM track; see `patch_apply_dcp_*` in `patch_disc.rs`), `--tui` (needs a terminal), `--cheat` database flow (needs the offline database).
- Browser paths (see the webapp matrix).
