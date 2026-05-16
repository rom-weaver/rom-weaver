# TODO

`TODO.md` is the canonical delivery board for `rom-weaver`. Add support rows here before implementation starts, keep exactly one support row `in-progress` after scaffolding, and do not move a row to `done` until fixture tests and CLI smoke coverage are green for that row.

## Commands

| ID | Family | Name | Inspect | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CMD-001 | command | inspect | scaffolded | n/a | n/a | n/a | n/a | n/a | cli-smoke,json-contract | todo | CLI surface exists; backend delivery follows family rows. |
| CMD-002 | command | extract | n/a | scaffolded | n/a | n/a | n/a | context-plumbed | cli-smoke,json-contract | todo | CLI surface exists; container rows gate real extraction work. |
| CMD-003 | command | checksum | n/a | n/a | n/a | n/a | n/a | context-plumbed | cli-smoke,json-contract,thread-model | in-progress | Phase 1 target. Thread budget, JSON, and chunk planning are scaffolded. |
| CMD-004 | command | compress | n/a | n/a | scaffolded | n/a | n/a | context-plumbed | cli-smoke,json-contract | todo | CLI surface exists; container and codec rows gate real compression. |
| CMD-005 | command | patch-apply | n/a | n/a | n/a | scaffolded | n/a | context-plumbed | cli-smoke,json-contract | todo | CLI surface exists; patch rows gate real apply support. |
| CMD-006 | command | patch-create | n/a | n/a | n/a | n/a | scaffolded | context-plumbed | cli-smoke,json-contract | todo | CLI surface exists; patch rows gate real patch creation. |

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
| CTR-001 | container | zip | todo | todo | todo | n/a | n/a | per-entry | fixture-roundtrip,cli-smoke | todo | Shared registry entry exists. |
| CTR-002 | container | zipx | todo | todo | todo | n/a | n/a | per-entry,codec-mapped | fixture-roundtrip,cli-smoke | todo | Shared zstd backend should map here where possible. |
| CTR-003 | container | 7z | todo | todo | todo | n/a | n/a | per-entry,codec-mapped | fixture-roundtrip,cli-smoke | todo | Shared zstd backend should map here where possible. |
| CTR-004 | container | tar | todo | todo | todo | n/a | n/a | per-entry | fixture-roundtrip,cli-smoke | todo | Base tar container row. |
| CTR-005 | container | tar.gz | todo | todo | todo | n/a | n/a | per-entry,codec-mapped | fixture-roundtrip,cli-smoke | todo | Codec delivery depends on `deflate`. |
| CTR-006 | container | tar.bz2 | todo | todo | todo | n/a | n/a | per-entry,codec-mapped | fixture-roundtrip,cli-smoke | todo | Codec delivery depends on `bzip2`. |
| CTR-007 | container | tar.xz | todo | todo | todo | n/a | n/a | per-entry,codec-mapped | fixture-roundtrip,cli-smoke | todo | Codec delivery depends on `lzma2`. |
| CTR-008 | container | chd | todo | todo | todo | n/a | n/a | per-block | fixture-roundtrip,cli-smoke | todo | Phase 4 container target. |
| CTR-009 | container | rvz | todo | todo | todo | n/a | n/a | per-block,codec-mapped | fixture-roundtrip,cli-smoke | todo | Phase 4 container target with shared zstd backend. |
| CTR-010 | container | z3ds | todo | todo | todo | n/a | n/a | per-block | fixture-roundtrip,cli-smoke | todo | Phase 6 container target. |

## Patch Formats

| ID | Family | Name | Inspect | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PAT-001 | patch | IPS | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with round-trip fixture coverage and CLI smoke coverage. |
| PAT-002 | patch | BPS | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with round-trip fixture coverage and CLI smoke coverage. |
| PAT-003 | patch | UPS | probe-only | n/a | n/a | todo | todo | scan,diff,write flags | fixture-parity,cli-smoke | todo | Registry entry exists. |
| PAT-004 | patch | VCDIFF | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Native parse/apply/create landed with round-trip fixture coverage and CLI smoke coverage, including VCD_TARGET windows and custom code-table headers. |
| PAT-005 | patch | xdelta | done | n/a | n/a | done | done | scan,diff,write flags | fixture-parity,cli-smoke | done | Shares the VCDIFF parser, uses threaded per-window xdelta decode (with sequential fallback for VCD_TARGET windows), and creates patches with optional secondary compression when it wins. |
| PAT-006 | patch | APS | probe-only | n/a | n/a | todo | todo | scan,diff,write flags | fixture-parity,cli-smoke | todo | Registry entry exists. |
| PAT-007 | patch | APSGBA | probe-only | n/a | n/a | todo | todo | scan,diff,write flags | fixture-parity,cli-smoke | todo | Registry entry exists. |
| PAT-008 | patch | RUP | probe-only | n/a | n/a | todo | todo | scan,diff,write flags | fixture-parity,cli-smoke | todo | Registry entry exists. |
| PAT-009 | patch | PPF | probe-only | n/a | n/a | todo | todo | scan,diff,write flags | fixture-parity,cli-smoke | todo | Registry entry exists. |
| PAT-010 | patch | EBP | probe-only | n/a | n/a | todo | todo | scan,diff,write flags | fixture-parity,cli-smoke | todo | Registry entry exists. |
| PAT-011 | patch | BDF/BSDIFF40 | probe-only | n/a | n/a | todo | todo | scan,diff,write flags | fixture-parity,cli-smoke | todo | Registry entry exists. |
| PAT-012 | patch | PMSR | probe-only | n/a | n/a | todo | todo | scan,diff,write flags | fixture-parity,cli-smoke | todo | Registry entry exists. |

## Codecs

| ID | Family | Name | Inspect | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| COD-001 | codec | store | n/a | n/a | todo | n/a | n/a | single-thread baseline | roundtrip,unit | todo | Registry entry exists. |
| COD-002 | codec | deflate | n/a | n/a | todo | n/a | n/a | block-ready | roundtrip,unit | todo | Required for `zip` and `tar.gz`. |
| COD-003 | codec | zstd | n/a | n/a | todo | n/a | n/a | block-ready | roundtrip,unit | todo | Shared backend target for `zipx`, `7z`, `rvz`, and compatible flows. |
| COD-004 | codec | lzma2 | n/a | n/a | todo | n/a | n/a | block-ready | roundtrip,unit | todo | Required for `7z` and `tar.xz`. |
| COD-005 | codec | bzip2 | n/a | n/a | todo | n/a | n/a | block-ready | roundtrip,unit | todo | Required for `tar.bz2`. |

## Cross-Cutting Tests

| ID | Family | Name | Inspect | Extract | Create/Compress | Apply | Create Patch | Threads | Tests | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TEST-001 | test | cli-smoke | scaffolded | scaffolded | scaffolded | scaffolded | scaffolded | fallback-covered | integration | done | All six commands smoke-test the scaffolded CLI surface. |
| TEST-002 | test | json-contract | scaffolded | scaffolded | scaffolded | scaffolded | scaffolded | required-fields-covered | integration | done | Verifies command, family, format, stage, label, percent, thread, and status fields. |
| TEST-003 | test | thread-model | n/a | n/a | n/a | n/a | n/a | auto,1,N,fallback | unit | done | Core tests cover auto resolution and fallback negotiation. |
| TEST-004 | test | chunked-io-large-file | n/a | todo | todo | todo | todo | chunk-planning | fixture | todo | Add large-file IO fixtures with real path-backed reads in Phase 1. |
| TEST-005 | test | temp-output-cleanup | n/a | todo | todo | todo | todo | temp-path lifecycle | fixture | todo | Add cleanup assertions once commands start materializing temp files. |
| TEST-006 | test | container-fixture-roundtrip | todo | todo | todo | n/a | n/a | real-handler coverage | fixture | todo | Required before container rows move to `done`. |
| TEST-007 | test | patch-fixture-parity | n/a | n/a | n/a | todo | todo | real-handler coverage | fixture | todo | Required before patch rows move to `done`. |
