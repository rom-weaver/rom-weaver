# TODO

`TODO.md` is the canonical delivery board for `rom-weaver`. Add support rows here before implementation starts, keep exactly one support row `in-progress` after scaffolding, and do not move a row to `done` until fixture tests and CLI smoke coverage are green for that row.

## Recent Updates (2026-05-16)

- Dreamcast `.dcp` (Universal Dreamcast Patcher) apply landed. New crates `rom-weaver-gdrom` (GD-ROM ISO9660 read/write + `MODE1/2352` EDC/ECC) and `rom-weaver-dcp` (ZIP/manifest/apply/rebuild); `rom-weaver-xdelta` gained `apply_patch_bytes`. CLI `patch apply` routes `.dcp` to a disc rebuild (input .cue/.gdi → patched data track → reassembled disc → CHD/GDI), validated byte-correct per file on real data. The rebuild streams the raw `MODE1/2352` track to a writer (`rebuild_track_to_writer`): the layout is planned from file sizes and each file's bytes are produced on demand, so peak memory scales with the largest single patched file's apply working set, not the disc. Remaining work (tests, webapp wiring, parity, create, format coverage) is tracked under "Dreamcast `.dcp` — remaining work" in the Patch Formats section.
- `2026-05-17 audit`: Added backlog rows for current threading/streaming gaps (RVZ/Z3DS capability parity, qbsdiff threading, patch streaming migrations off full-buffer reads, and real codec backend implementation).
- Added thread capability/runtime validation groundwork (`ThreadCapability::supports_execution`) and parity assertions for IPS/VCDIFF apply execution paths.
- Native SOLID v4 patch support landed (`.solid`, parse/apply/create, MD5 validation, primitive stream handling, and CLI smoke coverage).
- `b9b66a5`: MOD/PMSR parse/apply/create support landed (`.mod`/`.pmsr`, `pmsr` alias) with module + CLI smoke coverage.
- `6e2e7d1`: Standalone stream container support landed for `gz`, `bz2`, `xz`, and `zst` (`probe`/`extract`/`create`).
- `edf17b0`: RUP parse/apply/create support landed with MD5-matched forward/undo apply validation.
- `70a1850`: Checksum command engine landed with mmap-backed hashing, parallel crc32 fanout, and CLI smoke coverage for baseline algorithms.
- `69bdce6`: APS parse/apply/create support landed (`.aps` via APSGBA-compatible handler).
- `0a0cf64`: APSGBA parse/apply/create support landed (`.apsgba`).
- `fc6829e`: PPF parse/apply/create support landed.
- `1526166`: RAR probe/extract support landed.
- `8141281`: extract command now supports recursive nested archive extraction.
- `43ba2f3`: zip, zipx, 7z, and tar-family probe/extract/create handlers landed.
- `78ae8b9`: z3ds probe/extract/create landed (parallel extract path for large files).
- `67ef8fb`: rvz probe/extract/create landed.
- The command surface now uses `probe`, archive entry output moved to standalone `list`, patch-apply gained `--strip-header`/`--add-header`/`--repair-checksum`, and checksum surfaces header/repair/byte-order compatibility via `checksum_variants` (no `--strip-header` flag).
- Added backlog rows for NSZ-family decompression support (`.nsz`, `.xcz`, `.ncz`) aligned to the `nicoboss/nsz` reference format behavior.

## Commands

| ID | Family | Name | Probe | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CMD-001 | command | probe | done | n/a | n/a | n/a | n/a | n/a | cli-smoke,json-contract | done | Routes probe through container and patch registries with text/JSON reporting; unmatched files now report detected Igir-style ROM headers when present. |
| CMD-002 | command | extract | n/a | done | n/a | n/a | n/a | context-plumbed | cli-smoke,json-contract | done | Container extraction landed, including recursive nested archive extraction. |
| CMD-003 | command | checksum | n/a | n/a | n/a | n/a | n/a | context-plumbed | cli-smoke,json-contract,thread-model | done | Native engine now covers `crc32`, `md5`, `sha1`, `sha256`, `blake3`, `crc32c`, `crc16`, and `adler32` with mmap + threaded fanout; emits `checksum_variants` (raw, remove-header, fix-header, n64 byte order) covering Igir-style ROM header profiles (`.a78`, `.lnx`, `.nes`, `.fds`, `.smc`) with 512-byte fallback compatibility. |
| CMD-004 | command | compress | n/a | n/a | done | n/a | n/a | context-plumbed | cli-smoke,json-contract | done | Container create/compress routing is wired through registered handlers (`--format`, optional `--codec`/`--level`). |
| CMD-005 | command | patch-apply | n/a | n/a | n/a | done | n/a | context-plumbed | cli-smoke,json-contract | done | Patch apply routes through handler probing, emits thread-aware reports, supports compatibility flags `--strip-header`, `--add-header`, and `--repair-checksum`, auto-resolves container payload inputs by default with `--no-extract`/`--select`/`--no-ignore`, and now compresses output by default (with `--no-compress`, `--compress-format`, and `--compress-codec` controls); `--strip-header` is Igir-style profile-aware for `.a78/.lnx/.nes/.fds/.smc`, while checksum repair remains auto-detected for Sega Genesis/Game Boy targets. |
| CMD-006 | command | patch-create | n/a | n/a | n/a | n/a | done | context-plumbed | cli-smoke,json-contract | done | Patch create routes by format name through registered handlers. |
| CMD-007 | command | trim | n/a | n/a | done | n/a | n/a | context-plumbed | cli-smoke,json-contract,thread-model | done | Dedicated image/file trimming workflow landed with NDSTokyoTrim-compatible NDS/DSi boundaries plus GBA, 3DS, XISO, and NOD-disc RVZ-scrub trim handling (XISO and RVZ-scrub revert intentionally unsupported). |
| CMD-008 | command | extract-chd-splitbin | n/a | done | n/a | n/a | n/a | context-plumbed | fixture-roundtrip,cli-smoke,json-contract | done | CHD extract now supports `--split-bin` parity for `chdman extractcd -ob` style output, including deterministic per-track BIN naming, CUE metadata rewriting, and JSON labels that report emitted files. |
| CMD-009 | command | patch-apply-splitbin-target | n/a | n/a | n/a | in-progress | n/a | context-plumbed | fixture-roundtrip,cli-smoke,json-contract | in-progress | `--select` targeting and ambiguous-candidate failures are implemented for auto-extracted payloads; remaining work is wiring an explicit patch-apply split-bin extraction mode so split-track targeting is first-class. |
| CMD-010 | command | patch-apply-compress-level-controls | n/a | n/a | n/a | done | n/a | context-plumbed | cli-smoke,json-contract | done | Patch-apply output compression level controls are implemented via `--compress-level` named profiles, integrated with `--compress-format`/`--compress-codec`, and covered in CLI smoke tests. |
| CMD-011 | command | n64-format-converter | n/a | n/a | todo | n/a | n/a | context-plumbed | cli-smoke,fixture-roundtrip,json-contract | todo | Convert between `.z64`, `.n64`, and `.v64` byte orders with auto-detection of the input format. |
| CMD-012 | command | save-file-converter | n/a | n/a | todo | n/a | n/a | context-plumbed | cli-smoke,fixture-roundtrip,json-contract | todo | Convert between save formats (`.sav`, `.srm`, `.eep`, `.fla`, `.sra`), swap endianness, and pad/trim output for flash-cart compatibility. |
| CMD-013 | command | snes-copier-header-tool | n/a | n/a | todo | n/a | n/a | context-plumbed | cli-smoke,fixture-roundtrip,json-contract | todo | Detect, add, and remove 512-byte copier headers. |
| CMD-015 | command | header-fixer-opt-in-flags | n/a | n/a | n/a | todo | n/a | context-plumbed | cli-smoke,json-contract | todo | Expose the retained header repair/validation logic (`repair_checksum_file_in_place`) as opt-in arguments for `checksum` and `patch-apply`, defaulting off unless explicitly requested. The standalone `batch-header-fixer` command was removed; the reusable repair code remains. |
| CMD-016 | command | list | done | n/a | n/a | n/a | n/a | n/a | cli-smoke,json-contract | done | Lists selectable container entries as its own command, including one-step nested container listing via `--select`; patch inputs are intentionally rejected. |

## Threading Groundwork

| ID | Family | Name | Probe | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TG-001 | threading | shared-thread-pool | n/a | n/a | n/a | n/a | n/a | rayon-backed pool wrapper | unit | done | Implemented in `rom-weaver-core` for command-wide reuse. |
| TG-002 | threading | chunk-scheduler | n/a | n/a | n/a | n/a | n/a | chunk-plan contract | unit | done | Path-backed chunk planning lives in `rom-weaver-core`. |
| TG-003 | threading | thread-capability-reporting | n/a | n/a | n/a | n/a | n/a | requested vs effective threads | unit,json-contract | done | Reports fallback vs actual parallelism consistently. |
| TG-004 | threading | json-reporting | n/a | n/a | n/a | n/a | n/a | stable event schema | cli-smoke,json-contract | done | All commands can emit progress-compatible JSON records. |
| TG-005 | threading | temp-file-concurrency-safety | n/a | n/a | n/a | n/a | n/a | unique temp paths | unit | done | Temp path allocator namespaces per operation context. |
| TG-006 | threading | capability-runtime-parity | n/a | n/a | n/a | n/a | n/a | capability assertions vs real execution paths | unit,json-contract | done | Added `ThreadCapability::supports_execution` validation and parity assertions, including RVZ/Z3DS create-path runtime capability checks. |

## Containers

| ID | Family | Name | Probe | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CTR-001 | container | zip | done | done | done | n/a | n/a | per-entry | fixture-roundtrip,cli-smoke | done | Native zip probe/extract/create landed. |
| CTR-002 | container | zipx | done | done | done | n/a | n/a | per-entry,codec-mapped | fixture-roundtrip,cli-smoke | done | Native zipx probe/extract/create landed with zstd-backed path support. |
| CTR-003 | container | 7z | done | done | done | n/a | n/a | per-entry,codec-mapped | fixture-roundtrip,cli-smoke | done | Native 7z probe/extract/create landed. |
| CTR-004 | container | tar | done | done | done | n/a | n/a | per-entry | fixture-roundtrip,cli-smoke | done | Native tar probe/extract/create landed. |
| CTR-005 | container | tar.gz | done | done | done | n/a | n/a | per-entry,codec-mapped | fixture-roundtrip,cli-smoke | done | Native tar.gz probe/extract/create landed. |
| CTR-006 | container | tar.bz2 | done | done | done | n/a | n/a | per-entry,codec-mapped | fixture-roundtrip,cli-smoke | done | Native tar.bz2 probe/extract/create landed. |
| CTR-007 | container | tar.xz | done | done | done | n/a | n/a | per-entry,codec-mapped | fixture-roundtrip,cli-smoke | done | Native tar.xz probe/extract/create landed. |
| CTR-008 | container | chd | done | done | done | n/a | n/a | per-block | fixture-roundtrip,cli-smoke | done | Native chd probe/extract/create landed. |
| CTR-009 | container | rvz | done | done | done | n/a | n/a | per-block,codec-mapped | fixture-roundtrip,cli-smoke | done | Native rvz probe/extract/create landed. |
| CTR-010 | container | z3ds | done | done | done | n/a | n/a | per-block | fixture-roundtrip,cli-smoke | done | Native z3ds probe/extract/create landed with parallel extract support. |
| CTR-011 | container | rar | done | done | n/a | n/a | n/a | per-entry | fixture-roundtrip,cli-smoke | done | Native rar probe/extract landed; create remains intentionally unsupported. |
| CTR-012 | container | gz | done | done | done | n/a | n/a | stream | fixture-roundtrip,cli-smoke | done | Standalone gzip stream support (non-tar) landed. |
| CTR-013 | container | bz2 | done | done | done | n/a | n/a | stream | fixture-roundtrip,cli-smoke | done | Standalone bzip2 stream support (non-tar) landed. |
| CTR-014 | container | xz | done | done | done | n/a | n/a | stream | fixture-roundtrip,cli-smoke | done | Standalone xz stream support (non-tar) landed. |
| CTR-015 | container | zst | done | done | done | n/a | n/a | stream | fixture-roundtrip,cli-smoke | done | Standalone zstd stream support (non-tar) landed. |
| CTR-016 | container | xiso | n/a | n/a | n/a | n/a | n/a | per-file | fixture-roundtrip,cli-smoke | done | XISO is trim-only in this phase: container probe/extract/create remain intentionally unsupported, and XISO operations are handled via the `trim` command. |
| CTR-017 | container | rvz-threading-parity | done | done | done | n/a | n/a | per-block,codec-mapped | fixture-roundtrip,cli-smoke,json-contract | done | RVZ extract/create now negotiate parallel capability and forward thread budgets into `nod` preloader/processor options so `thread_execution` reporting matches runtime behavior. |
| CTR-018 | container | z3ds-create-thread-capability | done | done | done | n/a | n/a | per-block | fixture-roundtrip,cli-smoke,json-contract | done | Z3DS create capability metadata now reports parallel threading, matching the existing parallel create runtime behavior and JSON thread reporting. |
| CTR-019 | container | wua | n/a | n/a | n/a | n/a | n/a | n/a | n/a | dropped | WUA support was removed from the active registry and CLI surfaces; `.wua`/`.zar` are no longer supported formats. |
| CTR-020 | container | pbp | done | done | n/a | n/a | n/a | per-file | fixture-roundtrip,cli-smoke | done | Native PS1 `EBOOT.PBP` probe/extract landed with deterministic outputs (`<stem>.cue/.bin` for single-disc, `<stem>.discNN.cue/.bin` for multi-disc). `--select` remains the only targeting surface (exact/prefix/glob), and selecting a disc CUE automatically extracts its paired BIN. |
| CTR-021 | container | chd-create-default-codec-sets | n/a | n/a | done | n/a | n/a | codec-policy | cli-smoke,fixture-roundtrip | done | CHD create default codec sets landed: CD defaults to `cdlz`,`cdzl`,`cdfl`, DVD defaults to `lzma`,`zlib`,`huff`,`flac`, with regression coverage in container tests and CLI smoke paths. |
| CTR-022 | container | wbfs | done | done | done | n/a | n/a | per-block | fixture-roundtrip,cli-smoke | done | Native WBFS probe/extract/create landed with deterministic `<stem>.iso` extract output, single-target `--select` support, and explicit `--format wbfs` compression while auto format recommendation still prefers RVZ for Wii/GC discs. |
| CTR-023 | container | wia | done | done | done | n/a | n/a | per-block,codec-mapped | fixture-roundtrip,cli-smoke | done | Native WIA probe/extract/create landed with deterministic `<stem>.iso` output, single-target `--select` support, and codec routing (`store`,`bzip2`,`lzma`,`lzma2`,`zstd`) backed by `nod`. |
| CTR-024 | container | tgc | done | done | done | n/a | n/a | per-file | cli-smoke | done | Native TGC probe/extract/create landed; create is explicitly uncompressed (`store` only) and expects valid GameCube filesystem metadata in the source image. |
| CTR-025 | container | nfs | done | done | n/a | n/a | n/a | per-file | cli-smoke | done | NFS probe/extract support landed through `nod` path-based loaders (including external key-file requirements); create remains intentionally unsupported. |
| CTR-026 | container | cso-ciso-create | done | done | done | n/a | n/a | per-block | fixture-roundtrip,cli-smoke | done | CSO/CISO support now includes create in addition to extract, with explicit `store`-only codec routing and single-input output semantics. |
| CTR-027 | container | nsz | todo | todo | n/a | n/a | n/a | block,crypto-aware | fixture-roundtrip,cli-smoke | todo | Add native NSZ container probe/extract support for decompression to NSP semantics, using `nicoboss/nsz` behavior as the parity reference. |
| CTR-028 | container | xcz | todo | todo | n/a | n/a | n/a | block,crypto-aware | fixture-roundtrip,cli-smoke | todo | Add native XCZ container probe/extract support for decompression to XCI semantics, with NSZ-compatible mixed NCZ or NCA entry handling. |
| CTR-029 | container | ncz | n/a | todo | n/a | n/a | n/a | block,crypto-aware | fixture-roundtrip,cli-smoke | todo | Add native NCZ payload decompression support (header plus section or block handling) so NSZ or XCZ extraction can reconstruct original NCA payloads. |

## Patch Formats

| ID | Family | Name | Probe | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PAT-001 | patch | IPS | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with round-trip fixture coverage and CLI smoke coverage; create now supports deterministic threaded diff generation for large inputs and parse now uses read-only mmap instead of full-buffer `fs::read`. |
| PAT-002 | patch | BPS | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with round-trip fixture coverage and CLI smoke coverage. |
| PAT-003 | patch | UPS | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with reversible apply validation and CLI smoke coverage. |
| PAT-004 | patch | VCDIFF | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with round-trip fixture coverage and CLI smoke coverage, including VCD_TARGET windows and custom code-table headers; create now runs baseline/secondary encode candidates in parallel when thread budget allows. |
| PAT-005 | patch | xdelta | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Shares the VCDIFF parser, uses threaded per-window xdelta decode (with sequential fallback for VCD_TARGET windows), and creates patches with optional secondary compression when it wins; create now runs baseline/secondary candidates in parallel with thread-aware reporting. |
| PAT-006 | patch | APS | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | APS parse/apply/create landed via APSGBA-compatible handler wiring; create now supports deterministic threaded diff generation with chunk-boundary run merge. |
| PAT-007 | patch | APSGBA | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | APSGBA parse/apply/create landed with module-level round-trip coverage; create now supports deterministic threaded block diff generation and thread-aware reporting. |
| PAT-008 | patch | RUP | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with MD5-matched forward/undo apply, overflow mode handling (`A`/`M`), and round-trip fixture coverage. |
| PAT-009 | patch | PPF | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | PPF parse/apply/create landed (PPF1/2/3 parse, PPF3 create). |
| PAT-010 | patch | EBP | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Implemented as IPS-compatible records with EBP JSON metadata trailers for parse/apply/create support. |
| PAT-011 | patch | BDF/BSDIFF40 | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with BSDIFF40-compatible patch bytes plus `bdf`/`bsdiff` alias coverage. |
| PAT-012 | patch | PMSR | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Implemented through the MOD handler with `pmsr` alias support and `.pmsr` extension probing; create now supports deterministic threaded diff generation for large inputs. |
| PAT-013 | patch | MOD | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed for Star Rod/Paper Mario `.mod` patches (PMSR magic), including CLI smoke and module coverage; create still rejects shrinking outputs and now supports deterministic threaded diff generation for large inputs. |
| PAT-014 | patch | FFP/PAT | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native FireFlower/`fc /b`-style text patch support landed for `.pat`/`.ffp`, including reversible apply semantics and CLI smoke round-trip coverage. |
| PAT-015 | patch | DLDI | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed for `.dldi` patches with relocation-aware driver slot updates and CLI + module round-trip coverage. |
| PAT-016 | patch | PDS | n/a | n/a | n/a | n/a | n/a | n/a | cli-smoke | dropped | Explicitly unsupported: `.pds` name/extension are intentionally not routed because no surviving ecosystem patches are known in practical use. |
| PAT-017 | patch | SPATCH (Double IPS) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | dropped | Support intentionally removed: `.spatch` probing and `double-ips`/`doubleips` alias routing are no longer registered. |
| PAT-018 | patch | IPS32 | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with 32-bit offset support via `IPS32`/`EEOF`, plus signature-aware `.ips` probe routing (IPS vs IPS32) and CLI smoke coverage. |
| PAT-019 | patch | SOLID | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native SOLID v4 parse/apply/create landed with source MD5 validation, base-address primitive decoding, and `solid`/`solidpatch`/`solid-patch` format name support. |
| PAT-020 | patch | DPS | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed for Deufeufeu `.dps` patches using fixed-size header metadata and mode-based copy/data records. |
| PAT-021 | patch | bdf-threaded-create | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke,thread-model | done | Replace qbsdiff `ParallelScheme::Never` in the BDF create path with thread-budget-aware configuration and verify deterministic output parity. |
| PAT-022 | patch | buffered-to-streaming-migration-wave-1 | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke,large-file | done | Migrated heavy patch handlers (`UPS`, `APSGBA`, `RUP`, `PMSR`, `DPS`, `DLDI`, `SOLID`, `BDF`) off direct `fs::read` full-buffer apply/create paths where feasible, using chunked readers, in-place output writes, and file-backed mappings. |
| PAT-023 | patch | GDIFF | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native GDIFF v4 parse/apply/create landed with DATA/COPY opcode coverage and CLI smoke round-trip coverage. |
| PAT-024 | patch | BSP | done | n/a | n/a | done | n/a | scan,write flags | unit,cli-smoke | done | BSP apply landed as a distinct scripted format (`.bsp`) via embedded BSP VM runtime execution; patch creation is intentionally unsupported and out of scope. |
| PAT-025 | patch | cheat-patch-create | n/a | n/a | n/a | n/a | todo | scan,diff,write flags | fixture-parity,cli-smoke,json-contract | todo | Add cheat patch creation support that emits deterministic cheat-code outputs from original/modified inputs. |
| PAT-026 | patch | HDiffPatch/HPatchZ | done | n/a | n/a | done | n/a | scan,diff,write flags | fixture-parity,cli-smoke | done | Native `.hdiff`/`.hpatchz` parse/apply landed with HDIFF13 and HDIFFSF20 single-file support; apply supports nocomp, zstd, zlib, bz2, lzma, and lzma2 with upstream fixture parity coverage (including HDIFFSF20 zstd). HDIFF13 apply parallelizes independent chunk decode when multiple chunks are present; HDIFFSF20 apply parallelizes independent step rendering when the payload has multiple steps and falls back to sequential when it does not. HDIFF19 directory patches remain intentionally unsupported for patch-apply. Patch creation is intentionally disabled (use upstream hdiffz/hpatchz tooling). |

| PAT-027 | patch | DCP (Dreamcast) | done | n/a | n/a | done | todo | streaming write | unit,crate-roundtrip (no cli-smoke yet) | partial | Universal Dreamcast Patcher apply landed (disc input → rebuild GD-ROM data track → reassemble → CHD/GDI), validated byte-correct per file on the real Space Channel 5 disc. NOT a `PatchHandler` (separate disc-rebuild path via `rom-weaver-gdrom` + `rom-weaver-dcp`). Remaining work tracked below. |

### Dreamcast `.dcp` — remaining work

Apply is implemented and engine-tested; these items are not done:

**Tests**
- `cli_smoke` end-to-end `.dcp` fixture: synthesize a disc (`.gdi` + a `MODE1/2352` data track authored via `rom-weaver-gdrom` + dummy low-density tracks) plus a synthetic `.dcp` (a real xdelta delta + a verbatim file), run `patch apply`, and assert the rebuilt disc's files. Currently the whole CLI path (`run_dcp_apply`, data-track auto-select, staging, compress) is only validated manually against a local disc.
- Boot-sector *replacement* path in `rebuild_track_to_writer`: a `.dcp` carrying `bootsector/IP.BIN` (32768 bytes) → assert the rebuilt boot area matches and `boot_sector_replaced` is set; plus the wrong-size IP.BIN error path. SC5 has no boot sector, so this branch is untested.
- Direct `rom_weaver_xdelta::vcdiff_output_size` unit test (create a patch, assert reported size == target length); currently only covered indirectly.
- CLI validation-error paths: `.dcp` with a non-disc input, `.dcp` chained with another patch, and `.dcp` combined with `--strip-header`/`--add-header`/`--repair-checksum`/`--n64-byte-order` (all currently rejected in `run_dcp_apply`, untested).
- `mode1` real-track byte-for-byte test is `#[ignore]` (needs a local disc); no committed real-vector fixture.
- Lock the streaming writer against the in-memory builder: assert `write_track` output, when mode1-decoded, equals `build_iso` (a 0-byte-file regression already has a targeted test).

**Webapp / browser (Phase 6)**
- DONE: `.dcp` added to the shared patch-extension list (`PATCH_FILTER_FILE_EXTENSIONS` in `rom-weaver-core/src/common_files.rs`), regenerated into `rom-weaver-format-metadata.ts`; the webapp classifier, file-picker `accept`, and patch-probe tolerance all derive from it, so a dropped `.dcp` routes to the patch bucket automatically (tsc + biome clean). No hardcoded patch list or format gate elsewhere.
- TODO (form wiring — the main webapp gap): the only `.dcp` reference in `packages/rom-weaver-react/src` is the generated extension list; there is **no UI that pairs a `.dcp` with its disc source or dispatches the apply**. A `.dcp` is byte-stream→byte-stream-incompatible (it rebuilds a whole disc, not a single ROM), so the standard apply form's patch→ROM pairing does not model it. Needs: recognize a `.dcp` in the patch bucket as a disc-rebuild patch, require/pair a grouped disc ROM (`.gdi`/`.cue` + tracks, the disc-as-single-ROM grouping) as its source, and dispatch `run_dcp_apply` (same wasm CLI entry the native path uses) → CHD/GDI. Until this exists, `.dcp` apply is CLI-only despite the file routing to the right bucket.
- TODO: end-to-end browser validation via the dev server (user-driven, after the form wiring above) — drop a disc (`.gdi` + tracks) + a `.dcp`, confirm it stages to OPFS, runs `run_dcp_apply` in the wasm CLI, and produces a CHD. Measure peak browser memory (the per-file VCDIFF apply is the floor — see Memory/perf). Check mobile Safari.
- TODO: needs a fresh DCP-capable wasm build (`mise run build-wasm`) — the local/built wasm artifact must be rebuilt to include DCP.

**Parity / correctness**
- Byte-identical-to-UDP disc image: current output is *file-level* parity (every rebuilt file byte-correct), not the same `.gdi`/CHD bytes UDP emits. Would require reproducing DiscUtils' ISO9660 layout exactly and a UDP reference output to diff against.
- Playability validation on an emulator / real hardware (path tables are correct-by-construction but unverified).

**Memory / perf**
- Per-file VCDIFF apply is still fully in-memory, so a single large patched file (e.g. SC5's ~174 MB `MAKUMA.AFS`) dominates peak RSS (~1.14 GB). The rebuild itself no longer scales with disc size; streaming the xdelta decode would lower the per-file floor.

**Format coverage**
- DCP *create* (generate a `.dcp` from two discs: diff the file trees, emit per-file xdelta deltas + verbatim files + optional `IP.BIN`, zip) — not implemented.
- ZIP64 `.dcp` archives are rejected (large patches); Joliet/Rock Ridge in the source ISO is ignored (primary-descriptor only); non-45000 start LBAs / CDI layouts unsupported; xdelta-LZMA-secondary deltas are rejected (stock UDP uses `flags=0`, so unaffected).

## Codecs

| ID | Family | Name | Probe | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| COD-001 | codec | store | n/a | n/a | done | n/a | n/a | single-thread baseline | roundtrip,unit | done | Native passthrough encode/decode landed with single-thread capability reporting, roundtrip unit coverage, and level validation. |
| COD-002 | codec | deflate | n/a | n/a | done | n/a | n/a | block-ready | roundtrip,unit | done | Native deflate backend encode/decode landed with gzip-compatible streaming IO, default/validated level handling, and roundtrip unit coverage. |
| COD-003 | codec | zstd | n/a | n/a | done | n/a | n/a | block-ready | roundtrip,unit | done | Native zstd backend encode/decode landed with streaming IO, default/validated level handling, and roundtrip unit coverage. |
| COD-004 | codec | lzma2 | n/a | n/a | done | n/a | n/a | block-ready | roundtrip,unit | done | Native lzma2 backend encode/decode landed via xz streams with default/validated level handling and roundtrip unit coverage. |
| COD-005 | codec | bzip2 | n/a | n/a | done | n/a | n/a | block-ready | roundtrip,unit | done | Native bzip2 backend encode/decode landed with streaming IO, default/validated level handling, and roundtrip unit coverage. |
| COD-006 | codec | runtime-backend-implementation | n/a | n/a | done | n/a | n/a | thread-budget-aware | roundtrip,unit,cli-smoke | done | Replaced `StaticCodecBackend` placeholders with real encode/decode implementations (store/deflate/zstd/lzma2/bzip2), kept capability/thread reporting in codec reports, and wired stream container create/extract (`gz`/`bz2`/`xz`/`zst`) through codec backends. |

## Checksum Algorithms

| ID | Family | Name | Probe | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CHK-001 | checksum | crc32 | n/a | n/a | n/a | n/a | n/a | mmap,threaded-fanout | unit,cli-smoke,json-contract | done | Landed with mmap-backed reads and parallel fanout for large inputs. |
| CHK-002 | checksum | md5 | n/a | n/a | n/a | n/a | n/a | threaded-fanout | unit,cli-smoke,json-contract | done | Native checksum support landed. |
| CHK-003 | checksum | sha1 | n/a | n/a | n/a | n/a | n/a | threaded-fanout | unit,cli-smoke,json-contract | done | Native checksum support landed. |
| CHK-004 | checksum | crc16 | n/a | n/a | n/a | n/a | n/a | threaded-fanout | unit,cli-smoke,json-contract | done | Native checksum support landed. |
| CHK-005 | checksum | adler32 | n/a | n/a | n/a | n/a | n/a | threaded-fanout | unit,cli-smoke,json-contract | done | Native checksum support landed. |
| CHK-006 | checksum | sha256 | n/a | n/a | n/a | n/a | n/a | threaded-fanout | unit,cli-smoke,json-contract | done | Native checksum support landed in engine and CLI smoke coverage. |
| CHK-007 | checksum | blake3 | n/a | n/a | n/a | n/a | n/a | simd,threaded-tree | unit,cli-smoke,json-contract | done | Native checksum support landed in engine and CLI smoke coverage. |
| CHK-008 | checksum | crc32c | n/a | n/a | n/a | n/a | n/a | hw-accel,threaded-fanout | unit,cli-smoke,json-contract | done | Native checksum support landed in engine and CLI smoke coverage. |

## Observability

| ID | Family | Name | Probe | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OBS-001 | observability | log-level-and-trace-across-stack | done | done | done | done | done | context-plumbed,trace-spans | unit,cli-smoke,json-contract | done | Trace logging is wired across CLI/core/container/patch/codec/checksum layers with `--trace` plus `ROM_WEAVER_LOG`/`RUST_LOG` filter control, and JSON trace emission coverage in CLI tests. |

## Cross-Cutting Tests

| ID | Family | Name | Probe | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TEST-001 | test | cli-smoke | scaffolded | scaffolded | scaffolded | scaffolded | scaffolded | fallback-covered | integration | done | All six commands smoke-test the scaffolded CLI surface. |
| TEST-002 | test | json-contract | scaffolded | scaffolded | scaffolded | scaffolded | scaffolded | required-fields-covered | integration | done | Verifies command, family, format, stage, label, percent, thread, and status fields. |
| TEST-003 | test | thread-model | n/a | n/a | n/a | n/a | n/a | auto,1,N,fallback | unit | done | Core tests cover auto resolution and fallback negotiation. |
| TEST-004 | test | chunked-io-large-file | n/a | todo | todo | todo | todo | chunk-planning | fixture | todo | Add large-file IO fixtures with real path-backed reads in Phase 1. |
| TEST-005 | test | temp-output-cleanup | n/a | todo | todo | todo | todo | temp-path lifecycle | fixture | todo | Add cleanup assertions once commands start materializing temp files. |
| TEST-006 | test | container-fixture-roundtrip | done | done | done | n/a | n/a | real-handler coverage | fixture | done | CLI smoke coverage now includes round-trip container paths for landed handlers. |
| TEST-007 | test | patch-fixture-parity | n/a | n/a | n/a | done | done | real-handler coverage | fixture | done | CLI and module tests cover parity for implemented patch handlers. |
| TEST-008 | test | trim-parity | n/a | n/a | done | n/a | n/a | deterministic-output | fixture,cli-smoke | done | Deterministic trim parity coverage landed with NDSTokyoTrim-compatible DS(download-play cert) and DSi(NTR/TWL boundary) fixtures asserted byte-for-byte in CLI smoke tests. |
| TEST-009 | test | thread-capability-parity | done | done | done | done | done | requested/effective parity | unit,cli-smoke,json-contract | done | Thread capability/runtime parity assertions now cover IPS and VCDIFF/xdelta apply paths plus RVZ/Z3DS create paths, with requested/effective thread behavior validated across unit and CLI smoke coverage. |
| TEST-010 | test | large-input-memory-ceilings | n/a | todo | todo | todo | todo | bounded-buffer guarantees | fixture,benchmark | todo | Add large-input fixtures and memory-ceiling checks for migrated patch handlers to prevent regressions back to full-file buffering. |
