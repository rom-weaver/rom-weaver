# REFERENCES

This file collects patch/container/compression references used by `rom-weaver`.

It is intentionally a living document. Some patch families do not have stable formal specs; in those cases, canonical behavior is documented through widely used implementations.

<!-- START doctoc -->
## Table of contents

- [Patch Format Specs](#patch-format-specs)
- [Patch Reference Implementations](#patch-reference-implementations)
  - [Upstream / External](#upstream--external)
  - [In-Repo (`rom-weaver`) Implementations](#in-repo-rom-weaver-implementations)
- [Container / Compression Specs](#container--compression-specs)
- [Quick Mapping For `rom-weaver` Patch Families](#quick-mapping-for-rom-weaver-patch-families)
- [BPS Comparison: MultiPatch / Flips](#bps-comparison-multipatch--flips)
- [PPF Comparison: MultiPatch / ApplyPPF](#ppf-comparison-multipatch--applyppf)
- [Notes](#notes)

<!-- END doctoc -->

## Patch Format Specs

- IPS: <https://zerosoft.zophar.net/ips.php>
- BPS (Beat Patching System): <https://floating.muncher.se/byuu/bps/bps_spec.html>
- VCDIFF: RFC 3284 <https://www.rfc-editor.org/rfc/rfc3284.html>
- DLDI (Dynamically Linked Device Interface): <https://www.chishm.com/DLDI/>
- BSDIFF family background paper: <https://www.daemonology.net/papers/bsdiff.pdf>
- DCP (Universal Dreamcast Patcher): no formal spec - a ZIP of per-file
  xdelta3/VCDIFF deltas applied inside a GD-ROM ISO9660 filesystem; convention
  documented from the UDP source (see implementations below).
- ISO9660 / ECMA-119 (volume descriptors, directory records, path tables):
  <https://wiki.osdev.org/ISO_9660>
- CD-ROM sector layout + EDC/ECC (ECMA-130, `MODE1/2352`):
  <https://www.ecma-international.org/wp-content/uploads/ECMA-130_2nd_edition_june_1996.pdf>

## Patch Reference Implementations

### Upstream / External

- RomPatcher.js format modules (many ROM patch families):
  - <https://github.com/marcrobledo/RomPatcher.js/tree/master/rom-patcher-js/modules>
  - BPS: <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.bps.js>
  - IPS/IPS32/EBP: <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.ips.js>
  - UPS: <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.ups.js>
  - VCDIFF/xdelta: <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.vcdiff.js>
  - APS (N64): <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.aps_n64.js>
  - APSGBA: <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.aps_gba.js>
  - RUP: <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.rup.js>
  - PPF: <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.ppf.js>
  - PMSR/MOD: <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.pmsr.js>
  - BDF/BSDIFF40: <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.bdf.js>
- Floating IPS / Flips (IPS/BPS creation quality reference):
  - <https://github.com/Alcaro/Flips>
  - IPS delta creator: <https://github.com/Alcaro/Flips/blob/master/libips.cpp>
  - BPS suffix-array delta creator: <https://github.com/Alcaro/Flips/blob/master/libbps-suf.cpp>
- MultiPatch (macOS reference app; BPS routes through vendored Flips):
  - <https://github.com/Sappharad/MultiPatch>
  - BPS adapter snapshot: <https://github.com/Sappharad/MultiPatch/blob/b047dd325f5d37fd3cc920433080e27af779cf47/adapters/BPSAdapter.mm>
  - PPF adapter: <https://github.com/Sappharad/MultiPatch/blob/master/adapters/PPFAdapter.m>
  - PPF apply implementation: <https://github.com/Sappharad/MultiPatch/blob/master/ppfdev/applyppf3_linux.c>
  - PPF create implementation: <https://github.com/Sappharad/MultiPatch/blob/master/ppfdev/makeppf3_linux.c>
  - Vendored Flips snapshot: <https://github.com/Alcaro/Flips/tree/5a3d2012b8ea53ae777c24b8ac4edb9a6bdb9761>
- xdelta3 (VCDIFF-compatible toolchain): <https://github.com/jmacd/xdelta>
- open-vcdiff (RFC 3284 implementation): <https://github.com/google/open-vcdiff>
- Universal Dreamcast Patcher (the `.dcp` reference; GPL-3.0, study only - do
  not copy): <https://github.com/DerekPascarella/UniversalDreamcastPatcher>
  - GD-ROM ISO9660 build/extract (DiscUtilsGD, MIT) used by it and by
    `buildgdi`: <https://github.com/Sappharad/GDIbuilder>
- CD-ROM EDC/ECC reference (Neill Corlett's ECM algorithm; basis for the
  `mode1` re-encoder): widely mirrored as `ecm.c`/`unecm.c` (ECMA-130 P/Q
  Reed-Solomon product code over GF(2⁸), primitive poly `0x11D`, EDC poly
  `0x8001801B`).

### In-Repo (`rom-weaver`) Implementations

- Patch registry: [`crates/rom-weaver-patches/src/lib.rs`](../crates/rom-weaver-patches/src/lib.rs)
- Handlers directory: [`crates/rom-weaver-patches/src/`](../crates/rom-weaver-patches/src/)
- DCP format core: [`crates/rom-weaver-dcp/src/`](../crates/rom-weaver-dcp/src/) (zip, manifest, apply, rebuild)
- GD-ROM filesystem read/write: [`crates/rom-weaver-gdrom/src/`](../crates/rom-weaver-gdrom/src/) (sector, iso9660, gdrom, iso_writer, mode1)
- DCP CLI path: [`crates/rom-weaver-app/src/patch_apply_dcp.rs`](../crates/rom-weaver-app/src/patch_apply_dcp.rs)

## Container / Compression Specs

- ZIP APPNOTE (PKWARE): <https://support.pkware.com/pkzip/appnote>
- zlib format: RFC 1950 <https://www.rfc-editor.org/rfc/rfc1950>
- DEFLATE format: RFC 1951 <https://www.rfc-editor.org/rfc/rfc1951>
- gzip format: RFC 1952 <https://www.rfc-editor.org/rfc/rfc1952.html>
- XZ format specification: <https://tukaani.org/xz/format.html>
- Zstandard format: RFC 8878 <https://datatracker.ietf.org/doc/html/rfc8878>
- CHD tooling/docs (`chdman`): <https://docs.mamedev.org/tools/chdman.html>

## Quick Mapping For `rom-weaver` Patch Families

| `rom-weaver` format   | Primary reference(s)                                                      |
| --------------------- | ------------------------------------------------------------------------- |
| `IPS`, `IPS32`, `EBP` | IPS spec, Flips IPS delta creator, RomPatcher.js IPS implementation       |
| `BPS`                 | byuu BPS spec, Flips/MultiPatch, RomPatcher.js BPS implementation         |
| `UPS`                 | RomPatcher.js UPS implementation                                          |
| `VCDIFF`, `xdelta`    | RFC 3284, xdelta3, open-vcdiff, RomPatcher.js VCDIFF implementation       |
| `GDIFF`               | `rom-weaver` handler implementation (no single canonical spec linked yet) |
| `APS`, `APSGBA`       | RomPatcher.js APS/APSGBA implementations                                  |
| `RUP`                 | RomPatcher.js RUP implementation                                          |
| `PPF`                 | RomPatcher.js PPF implementation, MultiPatch/ApplyPPF                     |
| `PAT` / `FFP`         | `rom-weaver` handler implementation (public spec is scarce)               |
| `BDF/BSDIFF40`        | BSDIFF paper, RomPatcher.js BDF implementation                            |
| `BSP`                 | `rom-weaver` BSP implementation                                           |
| `MOD` / `PMSR`        | RomPatcher.js PMSR implementation                                         |
| `DLDI`                | Chishm DLDI page, `rom-weaver` DLDI implementation                        |
| `DPS`                 | `rom-weaver` DPS implementation                                           |
| `SOLID`               | `rom-weaver` SOLID implementation                                         |
| `DCP` (Dreamcast)     | UniversalDreamcastPatcher (format oracle), DiscUtilsGD/buildgdi (GD-ROM layout), ECMA-130 (EDC/ECC), RFC 3284 (per-file deltas) |

## BPS Comparison: MultiPatch / Flips

Comparison target: MultiPatch `b047dd325f5d37fd3cc920433080e27af779cf47`, whose `flips`
submodule is `Alcaro/Flips` `5a3d2012b8ea53ae777c24b8ac4edb9a6bdb9761`.
MultiPatch's BPS adapter calls Flips `ApplyPatch`, `CreatePatch(... ty_bps_linear)`,
and `CreatePatch(... ty_bps)`.

| Area | MultiPatch / Flips | `rom-weaver` |
| ---- | ------------------ | ------------ |
| Format grammar | Uses the standard `BPS1` header, source/target sizes, metadata length, four action kinds (`SourceRead`, `TargetRead`, `SourceCopy`, `TargetCopy`), and CRC32 footer. | Parses and writes the same BPS grammar in [`crates/rom-weaver-patches/src/bps.rs`](../crates/rom-weaver-patches/src/bps.rs). |
| Apply execution | Flips reads the input patch and ROM into memory, applies to an output buffer, then MultiPatch writes the result. | Uses an in-memory fast path for small files, a streaming sequential path for large files, and a parallel source/literal write path when a patch has no `TargetCopy`. `TargetCopy` stays sequential because it depends on previously produced output. |
| Checksum policy | Flips validates patch/input/output CRCs, but MultiPatch passes `verifyinput = NO`; a wrong-input BPS can still produce an output with a warning. | Defaults to strict patch, input, and output CRC validation. The shared checksum-validation override can skip CRC checks, but input and output sizes are still enforced. |
| Metadata / manifests | Flips can carry BPS metadata and its app wrapper has manifest plumbing. | Reads and skips metadata during parse/apply, reports sizes/checksums/action count, and currently creates zero-length metadata. |
| Patch creation modes | MultiPatch exposes both Flips linear BPS and delta BPS. Flips delta creation uses suffix sorting over target/source data, target-window growth near the current output offset, and cost thresholds before emitting copy actions. | Exposes one copy-aware BPS create path. It mirrors the Flips target-window growth and copy-cost threshold shapes, emits source reads/copies, target reads/copies, and repeated-byte `TargetCopy`, but does not expose a separate linear mode. |
| Header handling | Flips has legacy SMC/SFC 512-byte header removal unless exact handling is requested. MultiPatch inherits that behavior through Flips. | Treats input and output files as exact byte streams; no implicit SMC/SFC header removal. |
| Limits | Flips is bounded by host `size_t`/`off_t` and allocation success; delta creation can use more memory for reverse indexes in some modes. | BPS create is intentionally in-memory and copy-aware only under the repo memory limits, including the current suffix-index budget and 32-bit suffix-array range. |

Use MultiPatch/Flips as a behavioral oracle for applying BPS patches and for creation
heuristics, not as a byte-for-byte creation oracle. Different valid creators can emit
different action streams for the same source/target pair.

## PPF Comparison: MultiPatch / ApplyPPF

Comparison target: MultiPatch `master`, whose PPF path wraps Icarus/Paradox
`ApplyPPF3.c` and `MakePPF3.c`.

| Area | MultiPatch / ApplyPPF | `rom-weaver` |
| ---- | --------------------- | ------------ |
| Apply mode | GUI apply calls `applyPPF`, which always uses APPLY mode. PPF3 undo data is skipped unless the separate command-line undo mode is used. | Normal apply always writes forward patch bytes. PPF3 undo data is parsed and reported, but not auto-applied. |
| Validation | PPF2 validates original size and the block at `0x9320`; PPF3 validates `0x9320` for BIN and `0x80A0` for GI when blockcheck is enabled. | Uses the same validation offsets under strict checksum validation; the shared ignore mode can skip blockcheck bytes. |
| File IDs | Supports PPF2/PPF3 `file_id.diz` trailers when the footer magic/length marker is present. | Skips PPF2 and PPF3 trailers during file parsing, including the 2-byte PPF3 trailer and padded 4-byte variant. |
| Create | Creates PPF3 with BIN image type, blockcheck enabled by default, no undo by default, and optional CLI switches for undo, validation, image type, description, and file ID. | Creates PPF3 forward patches with BIN-style blockcheck when the source is large enough; no explicit undo/file-id/image-type options yet. |

## Notes

- If you add a new patch format, append at least one spec link (if available) and one implementation link.
- For formats without a reliable formal spec, capture behavior with cross-implementation tests and cite those implementation sources here.
