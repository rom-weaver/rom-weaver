# TODO

`TODO.md` is the canonical delivery board for `rom-weaver`. Add support rows here before implementation starts, keep exactly one support row `in-progress` after scaffolding, and do not move a row to `done` until fixture tests and CLI smoke coverage are green for that row.

## Recent Updates (2026-05-16)

- `6fd45bc`: BSPATCH alias probe support landed (`.bspatch`/`.bspatch40`, `bspatch`/`bspatch40` alias routing to BSDIFF40 compatibility paths).
- `uncommitted`: PDS parse/apply/create landed with `patch.dat` manifest validation and embedded BSDIFF40 payload round-trip support.
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

## Commands

| ID | Family | Name | Inspect | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CMD-001 | command | inspect | done | n/a | n/a | n/a | n/a | n/a | cli-smoke,json-contract | done | Routes inspect through container and patch registries with text/JSON reporting. |
| CMD-002 | command | extract | n/a | done | n/a | n/a | n/a | context-plumbed | cli-smoke,json-contract | done | Container extraction landed, including recursive nested archive extraction. |
| CMD-003 | command | checksum | n/a | n/a | n/a | n/a | n/a | context-plumbed | cli-smoke,json-contract,thread-model | done | Native engine now covers `crc32`, `md5`, `sha1`, `sha256`, `blake3`, `crc32c`, `crc16`, and `adler32` with mmap + threaded fanout. |
| CMD-004 | command | compress | n/a | n/a | done | n/a | n/a | context-plumbed | cli-smoke,json-contract | done | Container create/compress routing is wired through registered handlers (`--format`, optional `--codec`/`--level`). |
| CMD-005 | command | patch-apply | n/a | n/a | n/a | done | n/a | context-plumbed | cli-smoke,json-contract | done | Patch apply routes through handler probing and emits thread-aware reports. |
| CMD-006 | command | patch-create | n/a | n/a | n/a | n/a | done | context-plumbed | cli-smoke,json-contract | done | Patch create routes by format name through registered handlers. |
| CMD-007 | command | trim | n/a | n/a | scaffolded | n/a | n/a | context-plumbed | cli-smoke,json-contract,thread-model | todo | Dedicated image/file trimming workflow; target NDSTokyoTrim-compatible behavior for NDS/DSi trim boundaries and safety checks. |

## Threading Groundwork

| ID | Family | Name | Inspect | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TG-001 | threading | shared-thread-pool | n/a | n/a | n/a | n/a | n/a | rayon-backed pool wrapper | unit | done | Implemented in `rom-weaver-core` for command-wide reuse. |
| TG-002 | threading | chunk-scheduler | n/a | n/a | n/a | n/a | n/a | chunk-plan contract | unit | done | Path-backed chunk planning lives in `rom-weaver-core`. |
| TG-003 | threading | thread-capability-reporting | n/a | n/a | n/a | n/a | n/a | requested vs effective threads | unit,json-contract | done | Reports fallback vs actual parallelism consistently. |
| TG-004 | threading | json-reporting | n/a | n/a | n/a | n/a | n/a | stable event schema | cli-smoke,json-contract | done | All commands can emit progress-compatible JSON records. |
| TG-005 | threading | temp-file-concurrency-safety | n/a | n/a | n/a | n/a | n/a | unique temp paths | unit | done | Temp path allocator namespaces per operation context. |

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
| CTR-016 | container | xiso | todo | todo | todo | n/a | n/a | per-file | fixture-roundtrip,cli-smoke | todo | Original Xbox XISO support; prioritize inspect/extract first, then rebuild/create. |

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
| PAT-011 | patch | BDF/BSDIFF40 | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with BSDIFF40-compatible patch bytes plus `bdf`/`bsdiff`/`bspatch` alias coverage. |
| PAT-012 | patch | PMSR | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Implemented through the MOD handler with `pmsr` alias support and `.pmsr` extension probing. |
| PAT-013 | patch | MOD | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed for Star Rod/Paper Mario `.mod` patches (PMSR magic), including CLI smoke and module coverage; create currently rejects shrinking outputs. |
| PAT-014 | patch | BSPATCH alias | probe-only | n/a | n/a | todo | todo | scan,diff,write flags | fixture-parity,cli-smoke | done | Accept `.bspatch` and `.bspatch40` extensions plus `bspatch`/`bspatch40` format aliases as BSDIFF40-compatible probe paths. |
| PAT-015 | patch | DLDI | probe-only | n/a | n/a | todo | todo | scan,diff,write flags | fixture-parity,cli-smoke | todo | Nintendo DS homebrew patching compatibility target. |
| PAT-016 | patch | PDS | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed for `.pds` archives via `patch.dat` manifest + embedded BSDIFF40 payload handling, with module and CLI smoke coverage. |
| PAT-017 | patch | SPATCH (Double IPS) | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with `.spatch` probing plus `double-ips`/`doubleips` alias routing and dual-stream compatibility behavior. |
| PAT-018 | patch | IPS32 | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with 32-bit offset support via `IPS32`/`EEOF`, plus signature-aware `.ips` probe routing (IPS vs IPS32 vs SPATCH) and CLI smoke coverage. |

## Codecs

| ID | Family | Name | Inspect | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| COD-001 | codec | store | n/a | n/a | todo | n/a | n/a | single-thread baseline | roundtrip,unit | todo | Registry entry exists. |
| COD-002 | codec | deflate | n/a | n/a | todo | n/a | n/a | block-ready | roundtrip,unit | todo | Required for `zip` and `tar.gz`. |
| COD-003 | codec | zstd | n/a | n/a | todo | n/a | n/a | block-ready | roundtrip,unit | todo | Shared backend target for `zipx`, `7z`, `rvz`, and compatible flows. |
| COD-004 | codec | lzma2 | n/a | n/a | todo | n/a | n/a | block-ready | roundtrip,unit | todo | Required for `7z` and `tar.xz`. |
| COD-005 | codec | bzip2 | n/a | n/a | todo | n/a | n/a | block-ready | roundtrip,unit | todo | Required for `tar.bz2`. |

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
