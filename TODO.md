# TODO

`TODO.md` is the canonical delivery board for `rom-weaver`. Add support rows here before implementation starts, keep exactly one support row `in-progress` after scaffolding, and do not move a row to `done` until fixture tests and CLI smoke coverage are green for that row. Shipped rows are pruned once landed - this board tracks what is left, not a completed-work archive (git history preserves the rest).

## Commands

| ID | Family | Name | Probe | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CMD-009 | command | patch-apply-splitbin-target | n/a | n/a | n/a | in-progress | n/a | context-plumbed | fixture-roundtrip,cli-smoke,json-contract | in-progress | `--select` targeting and ambiguous-candidate failures are implemented for auto-extracted payloads; remaining work is wiring an explicit patch-apply split-bin extraction mode so split-track targeting is first-class. |
| CMD-011 | command | n64-format-converter | n/a | n/a | todo | n/a | n/a | context-plumbed | cli-smoke,fixture-roundtrip,json-contract | todo | Convert between `.z64`, `.n64`, and `.v64` byte orders with auto-detection of the input format. |
| CMD-012 | command | save-file-converter | n/a | n/a | todo | n/a | n/a | context-plumbed | cli-smoke,fixture-roundtrip,json-contract | todo | Convert between save formats (`.sav`, `.srm`, `.eep`, `.fla`, `.sra`), swap endianness, and pad/trim output for flash-cart compatibility. |
| CMD-013 | command | snes-copier-header-tool | n/a | n/a | todo | n/a | n/a | context-plumbed | cli-smoke,fixture-roundtrip,json-contract | todo | Detect, add, and remove 512-byte copier headers. |
| CMD-015 | command | header-fixer-opt-in-flags | n/a | n/a | n/a | todo | n/a | context-plumbed | cli-smoke,json-contract | todo | Expose the retained header repair/validation logic (`repair_checksum_file_in_place`) as opt-in arguments for `checksum` and `patch-apply`, defaulting off unless explicitly requested. The standalone `batch-header-fixer` command was removed; the reusable repair code remains. |

## Threading Groundwork

(all shipped)

## Containers

| ID | Family | Name | Probe | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CTR-027 | container | nsz | todo | todo | n/a | n/a | n/a | block,crypto-aware | fixture-roundtrip,cli-smoke | todo | Add native NSZ container probe/extract support for decompression to NSP semantics, using `nicoboss/nsz` behavior as the parity reference. |
| CTR-028 | container | xcz | todo | todo | n/a | n/a | n/a | block,crypto-aware | fixture-roundtrip,cli-smoke | todo | Add native XCZ container probe/extract support for decompression to XCI semantics, with NSZ-compatible mixed NCZ or NCA entry handling. |
| CTR-029 | container | ncz | n/a | todo | n/a | n/a | n/a | block,crypto-aware | fixture-roundtrip,cli-smoke | todo | Add native NCZ payload decompression support (header plus section or block handling) so NSZ or XCZ extraction can reconstruct original NCA payloads. |

## Patch Formats

| ID | Family | Name | Probe | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PAT-025 | patch | cheat-patch-create | n/a | n/a | n/a | n/a | todo | scan,diff,write flags | fixture-parity,cli-smoke,json-contract | todo | Add cheat patch creation support that emits deterministic cheat-code outputs from original/modified inputs. |
| PAT-027 | patch | DCP (Dreamcast) | done | n/a | n/a | done | todo | streaming write | unit,crate-roundtrip (no cli-smoke yet) | partial | Universal Dreamcast Patcher apply landed (disc input → rebuild GD-ROM data track → reassemble → CHD/GDI), validated byte-correct per file on the real Space Channel 5 disc. NOT a `PatchHandler` (separate disc-rebuild path via `rom-weaver-gdrom` + `rom-weaver-dcp`). Remaining work tracked below. |

### Dreamcast `.dcp` - remaining work

Apply is implemented and engine-tested; these items are not done:

**Tests**
- `cli_smoke` end-to-end `.dcp` fixture: synthesize a disc (`.gdi` + a `MODE1/2352` data track authored via `rom-weaver-gdrom` + dummy low-density tracks) plus a synthetic `.dcp` (a real xdelta delta + a verbatim file), run `patch apply`, and assert the rebuilt disc's files. Currently the whole CLI path (`run_dcp_apply`, data-track auto-select, staging, compress) is only validated manually against a local disc.
- Boot-sector *replacement* path in `rebuild_track_to_writer`: a `.dcp` carrying `bootsector/IP.BIN` (32768 bytes) → assert the rebuilt boot area matches and `boot_sector_replaced` is set; plus the wrong-size IP.BIN error path. SC5 has no boot sector, so this branch is untested.
- Direct `rom_weaver_xdelta::vcdiff_output_size` unit test (create a patch, assert reported size == target length); currently only covered indirectly.
- CLI validation-error paths: `.dcp` with a non-disc input, `.dcp` chained with another patch, and `.dcp` combined with `--strip-header`/`--add-header`/`--repair-checksum`/`--n64-byte-order` (all currently rejected in `run_dcp_apply`, untested).
- `mode1` real-track byte-for-byte test is `#[ignore]` (needs a local disc); no committed real-vector fixture.
- Lock the streaming writer against the in-memory builder: assert `write_track` output, when mode1-decoded, equals `build_iso` (a 0-byte-file regression already has a targeted test).

**Webapp / browser (Phase 6)**
- DONE: `.dcp` added to the shared patch-extension list (`PATCH_FILTER_FILE_EXTENSIONS` in `rom-weaver-core/src/common_files.rs`), regenerated into `rom-weaver-format-metadata.ts`; the webapp classifier, file-picker `accept`, and patch-probe tolerance all derive from it, so a dropped `.dcp` routes to the patch bucket automatically (tsc + oxlint + biome clean). No hardcoded patch list or format gate elsewhere.
- TODO (form wiring - the main webapp gap): the only `.dcp` reference in `packages/rom-weaver-react/src` is the generated extension list; there is **no UI that pairs a `.dcp` with its disc source or dispatches the apply**. A `.dcp` is byte-stream→byte-stream-incompatible (it rebuilds a whole disc, not a single ROM), so the standard apply form's patch→ROM pairing does not model it. Needs: recognize a `.dcp` in the patch bucket as a disc-rebuild patch, require/pair a grouped disc ROM (`.gdi`/`.cue` + tracks, the disc-as-single-ROM grouping) as its source, and dispatch `run_dcp_apply` (same wasm CLI entry the native path uses) → CHD/GDI. Until this exists, `.dcp` apply is CLI-only despite the file routing to the right bucket.
- TODO: end-to-end browser validation via the dev server (user-driven, after the form wiring above) - drop a disc (`.gdi` + tracks) + a `.dcp`, confirm it stages to OPFS, runs `run_dcp_apply` in the wasm CLI, and produces a CHD. Measure peak browser memory (the per-file VCDIFF apply is the floor - see Memory/perf). Check mobile Safari.
- TODO: needs a fresh DCP-capable wasm build (`mise run build-wasm`) - the local/built wasm artifact must be rebuilt to include DCP.

**Parity / correctness**
- Byte-identical-to-UDP disc image: current output is *file-level* parity (every rebuilt file byte-correct), not the same `.gdi`/CHD bytes UDP emits. Would require reproducing DiscUtils' ISO9660 layout exactly and a UDP reference output to diff against.
- Playability validation on an emulator / real hardware (path tables are correct-by-construction but unverified).

**Memory / perf**
- Per-file VCDIFF apply is still fully in-memory, so a single large patched file (e.g. SC5's ~174 MB `MAKUMA.AFS`) dominates peak RSS (~1.14 GB). The rebuild itself no longer scales with disc size; streaming the xdelta decode would lower the per-file floor.

**Format coverage**
- DCP *create* (generate a `.dcp` from two discs: diff the file trees, emit per-file xdelta deltas + verbatim files + optional `IP.BIN`, zip) - not implemented.
- ZIP64 `.dcp` archives are rejected (large patches); Joliet/Rock Ridge in the source ISO is ignored (primary-descriptor only); non-45000 start LBAs / CDI layouts unsupported; xdelta-LZMA-secondary deltas are rejected (stock UDP uses `flags=0`, so unaffected).

## Codecs

(all shipped)

## Checksum Algorithms

(all shipped)

## Observability

(all shipped)

## Cross-Cutting Tests

| ID | Family | Name | Probe | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TEST-004 | test | chunked-io-large-file | n/a | todo | todo | todo | todo | chunk-planning | fixture | todo | Add large-file IO fixtures with real path-backed reads in Phase 1. |
| TEST-005 | test | temp-output-cleanup | n/a | todo | todo | todo | todo | temp-path lifecycle | fixture | todo | Add cleanup assertions once commands start materializing temp files. |
| TEST-010 | test | large-input-memory-ceilings | n/a | todo | todo | todo | todo | bounded-buffer guarantees | fixture,benchmark | todo | Add large-input fixtures and memory-ceiling checks for migrated patch handlers to prevent regressions back to full-file buffering. |
