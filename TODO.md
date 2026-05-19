# TODO

`TODO.md` is the canonical delivery board for `rom-weaver`. Add support rows here before implementation starts, keep exactly one support row `in-progress` after scaffolding, and do not move a row to `done` until fixture tests and CLI smoke coverage are green for that row.

## Recent Updates (2026-05-16)

- `2026-05-17 audit`: Added backlog rows for current threading/streaming gaps (RVZ/Z3DS capability parity, qbsdiff threading, patch streaming migrations off full-buffer reads, and real codec backend implementation).
- `this commit`: Added thread capability/runtime validation groundwork (`ThreadCapability::supports_execution`) and parity assertions for IPS/VCDIFF apply execution paths.
- `this commit`: Native SOLID v4 patch support landed (`.solid`, parse/apply/create, MD5 validation, primitive stream handling, and CLI smoke coverage).
- `this commit`: PDS parse/apply/create landed with `patch.dat` manifest validation and embedded BSDIFF40 payload round-trip support.
- `b9b66a5`: MOD/PMSR parse/apply/create support landed (`.mod`/`.pmsr`, `pmsr` alias) with module + CLI smoke coverage.
- `6e2e7d1`: Standalone stream container support landed for `gz`, `bz2`, `xz`, and `zst` (`inspect`/`extract`/`create`).
- `e4442c2`: PDS probe-only patch registration landed (`.pds` routing now reserved while apply/create remain pending).
- `edf17b0`: RUP parse/apply/create support landed with MD5-matched forward/undo apply validation.
- `70a1850`: Checksum command engine landed with mmap-backed hashing, parallel crc32 fanout, and CLI smoke coverage for baseline algorithms.
- `69bdce6`: APS parse/apply/create support landed (`.aps` via APSGBA-compatible handler).
- `0a0cf64`: APSGBA parse/apply/create support landed (`.apsgba`).
- `fc6829e`: PPF parse/apply/create support landed.
- `1526166`: RAR inspect/extract support landed.
- `8141281`: extract command now supports recursive nested archive extraction.
- `43ba2f3`: zip, zipx, 7z, and tar-family inspect/extract/create handlers landed.
- `78ae8b9`: z3ds inspect/extract/create landed (parallel extract path for large files).
- `67ef8fb`: rvz inspect/extract/create landed.
- `this commit`: inspect now supports `--list` archive entry output; patch-apply gained `--strip-header`/`--add-header`/`--repair-checksum`; checksum gained `--strip-header`.

## Commands

| ID | Family | Name | Inspect | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CMD-001 | command | inspect | done | n/a | n/a | n/a | n/a | n/a | cli-smoke,json-contract | done | Routes inspect through container and patch registries with text/JSON reporting; `--list` surfaces selectable archive entry names for extraction workflows; unmatched files now report detected Igir-style ROM headers when present. |
| CMD-002 | command | extract | n/a | done | n/a | n/a | n/a | context-plumbed | cli-smoke,json-contract | done | Container extraction landed, including recursive nested archive extraction. |
| CMD-003 | command | checksum | n/a | n/a | n/a | n/a | n/a | context-plumbed | cli-smoke,json-contract,thread-model | done | Native engine now covers `crc32`, `md5`, `sha1`, `sha256`, `blake3`, `crc32c`, `crc16`, and `adler32` with mmap + threaded fanout; CLI `--strip-header` now supports Igir-style ROM header profiles (`.a78`, `.lnx`, `.nes`, `.fds`, `.smc`) with 512-byte fallback compatibility. |
| CMD-004 | command | compress | n/a | n/a | done | n/a | n/a | context-plumbed | cli-smoke,json-contract | done | Container create/compress routing is wired through registered handlers (`--format`, optional `--codec`/`--level`). |
| CMD-005 | command | patch-apply | n/a | n/a | n/a | done | n/a | context-plumbed | cli-smoke,json-contract | done | Patch apply routes through handler probing, emits thread-aware reports, supports compatibility flags `--strip-header`, `--add-header`, and `--repair-checksum`, auto-resolves container payload inputs by default with `--no-extract`/`--select`/`--no-ignore`, and now compresses output by default (with `--no-compress`, `--compress-format`, and `--compress-codec` controls); `--strip-header` is Igir-style profile-aware for `.a78/.lnx/.nes/.fds/.smc`, while checksum repair remains auto-detected for Sega Genesis/Game Boy targets. |
| CMD-006 | command | patch-create | n/a | n/a | n/a | n/a | done | context-plumbed | cli-smoke,json-contract | done | Patch create routes by format name through registered handlers. |
| CMD-007 | command | trim | n/a | n/a | done | n/a | n/a | context-plumbed | cli-smoke,json-contract,thread-model | done | Dedicated image/file trimming workflow landed with NDSTokyoTrim-compatible NDS/DSi boundaries plus GBA, 3DS, XISO, and NOD-disc RVZ-scrub trim handling (XISO and RVZ-scrub revert intentionally unsupported). |
| CMD-008 | command | extract-chd-splitbin | n/a | done | n/a | n/a | n/a | context-plumbed | fixture-roundtrip,cli-smoke,json-contract | done | CHD extract now supports `--split-bin` parity for `chdman extractcd -ob` style output, including deterministic per-track BIN naming, CUE metadata rewriting, and JSON labels that report emitted files. |
| CMD-009 | command | patch-apply-splitbin-target | n/a | n/a | n/a | todo | n/a | context-plumbed | fixture-roundtrip,cli-smoke,json-contract | todo | When the extracted image is split into multiple BIN files, allow patch-apply to target a specific BIN (explicit selector) and fail clearly on ambiguous targets. |
| CMD-010 | command | patch-apply-compress-level-controls | n/a | n/a | n/a | todo | n/a | context-plumbed | cli-smoke,json-contract | todo | Add output compression level controls for patch-apply so users can set compression strength directly (for example `--compress-level` / easy presets) alongside existing `--compress-format` and `--compress-codec` options. |
| CMD-011 | command | n64-format-converter | n/a | n/a | todo | n/a | n/a | context-plumbed | cli-smoke,fixture-roundtrip,json-contract | todo | Convert between `.z64`, `.n64`, and `.v64` byte orders with auto-detection of the input format. |
| CMD-012 | command | save-file-converter | n/a | n/a | todo | n/a | n/a | context-plumbed | cli-smoke,fixture-roundtrip,json-contract | todo | Convert between save formats (`.sav`, `.srm`, `.eep`, `.fla`, `.sra`), swap endianness, and pad/trim output for flash-cart compatibility. |
| CMD-013 | command | snes-copier-header-tool | n/a | n/a | todo | n/a | n/a | context-plumbed | cli-smoke,fixture-roundtrip,json-contract | todo | Detect, add, and remove 512-byte copier headers. |
| CMD-014 | command | batch-header-fixer | n/a | n/a | todo | n/a | n/a | context-plumbed | cli-smoke,fixture-roundtrip,json-contract | todo | Fix headers for 19 systems (SNES, NES, GB/GBC, GBA, Mega Drive, N64, DS, and more), based on RetroMultiTools reference behavior. |

## Threading Groundwork

| ID | Family | Name | Inspect | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TG-001 | threading | shared-thread-pool | n/a | n/a | n/a | n/a | n/a | rayon-backed pool wrapper | unit | done | Implemented in `rom-weaver-core` for command-wide reuse. |
| TG-002 | threading | chunk-scheduler | n/a | n/a | n/a | n/a | n/a | chunk-plan contract | unit | done | Path-backed chunk planning lives in `rom-weaver-core`. |
| TG-003 | threading | thread-capability-reporting | n/a | n/a | n/a | n/a | n/a | requested vs effective threads | unit,json-contract | done | Reports fallback vs actual parallelism consistently. |
| TG-004 | threading | json-reporting | n/a | n/a | n/a | n/a | n/a | stable event schema | cli-smoke,json-contract | done | All commands can emit progress-compatible JSON records. |
| TG-005 | threading | temp-file-concurrency-safety | n/a | n/a | n/a | n/a | n/a | unique temp paths | unit | done | Temp path allocator namespaces per operation context. |
| TG-006 | threading | capability-runtime-parity | n/a | n/a | n/a | n/a | n/a | capability assertions vs real execution paths | unit,json-contract | done | Added `ThreadCapability::supports_execution` validation and parity assertions, including RVZ/Z3DS create-path runtime capability checks. |

## Containers

| ID | Family | Name | Inspect | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CTR-001 | container | zip | done | done | done | n/a | n/a | per-entry | fixture-roundtrip,cli-smoke | done | Native zip inspect/extract/create landed. |
| CTR-002 | container | zipx | done | done | done | n/a | n/a | per-entry,codec-mapped | fixture-roundtrip,cli-smoke | done | Native zipx inspect/extract/create landed with zstd-backed path support. |
| CTR-003 | container | 7z | done | done | done | n/a | n/a | per-entry,codec-mapped | fixture-roundtrip,cli-smoke | done | Native 7z inspect/extract/create landed. |
| CTR-004 | container | tar | done | done | done | n/a | n/a | per-entry | fixture-roundtrip,cli-smoke | done | Native tar inspect/extract/create landed. |
| CTR-005 | container | tar.gz | done | done | done | n/a | n/a | per-entry,codec-mapped | fixture-roundtrip,cli-smoke | done | Native tar.gz inspect/extract/create landed. |
| CTR-006 | container | tar.bz2 | done | done | done | n/a | n/a | per-entry,codec-mapped | fixture-roundtrip,cli-smoke | done | Native tar.bz2 inspect/extract/create landed. |
| CTR-007 | container | tar.xz | done | done | done | n/a | n/a | per-entry,codec-mapped | fixture-roundtrip,cli-smoke | done | Native tar.xz inspect/extract/create landed. |
| CTR-008 | container | chd | done | done | done | n/a | n/a | per-block | fixture-roundtrip,cli-smoke | done | Native chd inspect/extract/create landed. |
| CTR-009 | container | rvz | done | done | done | n/a | n/a | per-block,codec-mapped | fixture-roundtrip,cli-smoke | done | Native rvz inspect/extract/create landed. |
| CTR-010 | container | z3ds | done | done | done | n/a | n/a | per-block | fixture-roundtrip,cli-smoke | done | Native z3ds inspect/extract/create landed with parallel extract support. |
| CTR-011 | container | rar | done | done | n/a | n/a | n/a | per-entry | fixture-roundtrip,cli-smoke | done | Native rar inspect/extract landed; create remains intentionally unsupported. |
| CTR-012 | container | gz | done | done | done | n/a | n/a | stream | fixture-roundtrip,cli-smoke | done | Standalone gzip stream support (non-tar) landed. |
| CTR-013 | container | bz2 | done | done | done | n/a | n/a | stream | fixture-roundtrip,cli-smoke | done | Standalone bzip2 stream support (non-tar) landed. |
| CTR-014 | container | xz | done | done | done | n/a | n/a | stream | fixture-roundtrip,cli-smoke | done | Standalone xz stream support (non-tar) landed. |
| CTR-015 | container | zst | done | done | done | n/a | n/a | stream | fixture-roundtrip,cli-smoke | done | Standalone zstd stream support (non-tar) landed. |
| CTR-016 | container | xiso | n/a | n/a | n/a | n/a | n/a | per-file | fixture-roundtrip,cli-smoke | done | XISO is trim-only in this phase: container inspect/extract/create remain intentionally unsupported, and XISO operations are handled via the `trim` command. |
| CTR-017 | container | rvz-threading-parity | done | done | done | n/a | n/a | per-block,codec-mapped | fixture-roundtrip,cli-smoke,json-contract | done | RVZ extract/create now negotiate parallel capability and forward thread budgets into `nod` preloader/processor options so `thread_execution` reporting matches runtime behavior. |
| CTR-018 | container | z3ds-create-thread-capability | done | done | done | n/a | n/a | per-block | fixture-roundtrip,cli-smoke,json-contract | done | Z3DS create capability metadata now reports parallel threading, matching the existing parallel create runtime behavior and JSON thread reporting. |
| CTR-019 | container | wua | n/a | n/a | n/a | n/a | n/a | n/a | n/a | dropped | WUA support was removed from the active registry and CLI surfaces; `.wua`/`.zar` are no longer supported formats. |
| CTR-020 | container | pbp | done | done | n/a | n/a | n/a | per-file | fixture-roundtrip,cli-smoke | done | Native PS1 `EBOOT.PBP` inspect/extract landed with deterministic outputs (`<stem>.cue/.bin` for single-disc, `<stem>.discNN.cue/.bin` for multi-disc). `--select` remains the only targeting surface (exact/prefix/glob), and selecting a disc CUE automatically extracts its paired BIN. |
| CTR-021 | container | chd-create-default-codec-sets | n/a | n/a | done | n/a | n/a | codec-policy | cli-smoke,fixture-roundtrip | done | CHD create default codec sets landed: CD defaults to `cdzs`,`cdzl`,`cdfl`, DVD defaults to `zstd`,`zlib`,`huff`,`flac`, with regression coverage in container tests and CLI smoke paths. |
| CTR-022 | container | wbfs | done | done | done | n/a | n/a | per-block | fixture-roundtrip,cli-smoke | done | Native WBFS inspect/extract/create landed with deterministic `<stem>.iso` extract output, single-target `--select` support, and explicit `--format wbfs` compression while auto format recommendation still prefers RVZ for Wii/GC discs. |
| CTR-023 | container | wia | done | done | done | n/a | n/a | per-block,codec-mapped | fixture-roundtrip,cli-smoke | done | Native WIA inspect/extract/create landed with deterministic `<stem>.iso` output, single-target `--select` support, and codec routing (`store`,`bzip2`,`lzma`,`lzma2`,`zstd`) backed by `nod`. |
| CTR-024 | container | tgc | done | done | done | n/a | n/a | per-file | cli-smoke | done | Native TGC inspect/extract/create landed; create is explicitly uncompressed (`store` only) and expects valid GameCube filesystem metadata in the source image. |
| CTR-025 | container | nfs | done | done | n/a | n/a | n/a | per-file | cli-smoke | done | NFS inspect/extract support landed through `nod` path-based loaders (including external key-file requirements); create remains intentionally unsupported. |
| CTR-026 | container | cso-ciso-create | done | done | done | n/a | n/a | per-block | fixture-roundtrip,cli-smoke | done | CSO/CISO support now includes create in addition to extract, with explicit `store`-only codec routing and single-input output semantics. |

## Patch Formats

| ID | Family | Name | Inspect | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PAT-001 | patch | IPS | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with round-trip fixture coverage and CLI smoke coverage. |
| PAT-002 | patch | BPS | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with round-trip fixture coverage and CLI smoke coverage. |
| PAT-003 | patch | UPS | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with reversible apply validation and CLI smoke coverage. |
| PAT-004 | patch | VCDIFF | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with round-trip fixture coverage and CLI smoke coverage, including VCD_TARGET windows and custom code-table headers. |
| PAT-005 | patch | xdelta | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Shares the VCDIFF parser, uses threaded per-window xdelta decode (with sequential fallback for VCD_TARGET windows), and creates patches with optional secondary compression when it wins. |
| PAT-006 | patch | APS | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | APS parse/apply/create landed via APSGBA-compatible handler wiring. |
| PAT-007 | patch | APSGBA | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | APSGBA parse/apply/create landed with module-level round-trip coverage. |
| PAT-008 | patch | RUP | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with MD5-matched forward/undo apply, overflow mode handling (`A`/`M`), and round-trip fixture coverage. |
| PAT-009 | patch | PPF | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | PPF parse/apply/create landed (PPF1/2/3 parse, PPF3 create). |
| PAT-010 | patch | EBP | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Implemented as IPS-compatible records with EBP JSON metadata trailers for parse/apply/create support. |
| PAT-011 | patch | BDF/BSDIFF40 | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with BSDIFF40-compatible patch bytes plus `bdf`/`bsdiff` alias coverage. |
| PAT-012 | patch | PMSR | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Implemented through the MOD handler with `pmsr` alias support and `.pmsr` extension probing. |
| PAT-013 | patch | MOD | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed for Star Rod/Paper Mario `.mod` patches (PMSR magic), including CLI smoke and module coverage; create currently rejects shrinking outputs. |
| PAT-014 | patch | FFP/PAT | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native FireFlower/`fc /b`-style text patch support landed for `.pat`/`.ffp`, including reversible apply semantics and CLI smoke round-trip coverage. |
| PAT-015 | patch | DLDI | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed for `.dldi` patches with relocation-aware driver slot updates and CLI + module round-trip coverage. |
| PAT-016 | patch | PDS | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed for `.pds` archives via `patch.dat` manifest + embedded BSDIFF40 payload handling, with module and CLI smoke coverage. |
| PAT-017 | patch | SPATCH (Double IPS) | todo | n/a | n/a | todo | todo | scan,diff,write flags | n/a | todo | Support intentionally removed: `.spatch` probing and `double-ips`/`doubleips` alias routing are no longer registered. |
| PAT-018 | patch | IPS32 | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with 32-bit offset support via `IPS32`/`EEOF`, plus signature-aware `.ips` probe routing (IPS vs IPS32) and CLI smoke coverage. |
| PAT-019 | patch | SOLID | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native SOLID v4 parse/apply/create landed with source MD5 validation, base-address primitive decoding, and `solid`/`solidpatch`/`solid-patch` format name support. |
| PAT-020 | patch | DPS | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed for Deufeufeu `.dps` patches using fixed-size header metadata and mode-based copy/data records. |
| PAT-021 | patch | bdf-pds-threaded-create | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke,thread-model | done | Replace qbsdiff `ParallelScheme::Never` in BDF and PDS create paths with thread-budget-aware configuration and verify deterministic output parity. |
| PAT-022 | patch | buffered-to-streaming-migration-wave-1 | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke,large-file | done | Migrated heavy patch handlers (`UPS`, `APSGBA`, `RUP`, `PMSR`, `DPS`, `DLDI`, `SOLID`, `BDF`, `PDS`) off direct `fs::read` full-buffer apply/create paths where feasible, using chunked readers, in-place output writes, and file-backed mappings. |
| PAT-023 | patch | GDIFF | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native GDIFF v4 parse/apply/create landed with DATA/COPY opcode coverage and CLI smoke round-trip coverage. |
| PAT-024 | patch | BSP | done | n/a | n/a | done | todo | scan,write flags | unit,cli-smoke | todo | BSP apply landed as a distinct scripted format (`.bsp`) via embedded BSP VM runtime execution; patch creation is still unsupported. |

## Codecs

| ID | Family | Name | Inspect | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| COD-001 | codec | store | n/a | n/a | done | n/a | n/a | single-thread baseline | roundtrip,unit | done | Native passthrough encode/decode landed with single-thread capability reporting, roundtrip unit coverage, and level validation. |
| COD-002 | codec | deflate | n/a | n/a | done | n/a | n/a | block-ready | roundtrip,unit | done | Native deflate backend encode/decode landed with gzip-compatible streaming IO, default/validated level handling, and roundtrip unit coverage. |
| COD-003 | codec | zstd | n/a | n/a | done | n/a | n/a | block-ready | roundtrip,unit | done | Native zstd backend encode/decode landed with streaming IO, default/validated level handling, and roundtrip unit coverage. |
| COD-004 | codec | lzma2 | n/a | n/a | done | n/a | n/a | block-ready | roundtrip,unit | done | Native lzma2 backend encode/decode landed via xz streams with default/validated level handling and roundtrip unit coverage. |
| COD-005 | codec | bzip2 | n/a | n/a | done | n/a | n/a | block-ready | roundtrip,unit | done | Native bzip2 backend encode/decode landed with streaming IO, default/validated level handling, and roundtrip unit coverage. |
| COD-006 | codec | runtime-backend-implementation | n/a | n/a | done | n/a | n/a | thread-budget-aware | roundtrip,unit,cli-smoke | done | Replaced `StaticCodecBackend` placeholders with real encode/decode implementations (store/deflate/zstd/lzma2/bzip2), kept capability/thread reporting in codec reports, and wired stream container create/extract (`gz`/`bz2`/`xz`/`zst`) through codec backends. |

## Checksum Algorithms

| ID | Family | Name | Inspect | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
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

| ID | Family | Name | Inspect | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OBS-001 | observability | log-level-and-trace-across-stack | todo | todo | todo | todo | todo | context-plumbed,trace-spans | unit,cli-smoke,json-contract | todo | Add configurable log levels and trace logs across CLI, core, container, codec, and patch layers with consistent context propagation and filtering. |

## Cross-Cutting Tests

| ID | Family | Name | Inspect | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TEST-001 | test | cli-smoke | scaffolded | scaffolded | scaffolded | scaffolded | scaffolded | fallback-covered | integration | done | All six commands smoke-test the scaffolded CLI surface. |
| TEST-002 | test | json-contract | scaffolded | scaffolded | scaffolded | scaffolded | scaffolded | required-fields-covered | integration | done | Verifies command, family, format, stage, label, percent, thread, and status fields. |
| TEST-003 | test | thread-model | n/a | n/a | n/a | n/a | n/a | auto,1,N,fallback | unit | done | Core tests cover auto resolution and fallback negotiation. |
| TEST-004 | test | chunked-io-large-file | n/a | todo | todo | todo | todo | chunk-planning | fixture | todo | Add large-file IO fixtures with real path-backed reads in Phase 1. |
| TEST-005 | test | temp-output-cleanup | n/a | todo | todo | todo | todo | temp-path lifecycle | fixture | todo | Add cleanup assertions once commands start materializing temp files. |
| TEST-006 | test | container-fixture-roundtrip | done | done | done | n/a | n/a | real-handler coverage | fixture | done | CLI smoke coverage now includes round-trip container paths for landed handlers. |
| TEST-007 | test | patch-fixture-parity | n/a | n/a | n/a | done | done | real-handler coverage | fixture | done | CLI and module tests cover parity for implemented patch handlers. |
| TEST-008 | test | trim-parity | n/a | n/a | todo | n/a | n/a | deterministic-output | fixture,cli-smoke | todo | Verify deterministic outputs and parity vs NDSTokyoTrim-compatible fixtures for representative NDS/DSi edge cases. |
| TEST-009 | test | thread-capability-parity | done | done | done | done | done | requested/effective parity | unit,cli-smoke,json-contract | done | Thread capability/runtime parity assertions now cover IPS and VCDIFF/xdelta apply paths plus RVZ/Z3DS create paths, with requested/effective thread behavior validated across unit and CLI smoke coverage. |
| TEST-010 | test | large-input-memory-ceilings | n/a | todo | todo | todo | todo | bounded-buffer guarantees | fixture,benchmark | todo | Add large-input fixtures and memory-ceiling checks for migrated patch handlers to prevent regressions back to full-file buffering. |
