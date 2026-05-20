# CHD Codec Dedupe Plan

## Goal
Reduce duplicated codec implementation paths in CHD create/extract by reusing shared `rom-weaver-codecs` byte-level helpers where behavior is equivalent.

## Scope
- In scope: CHD rust-native compression callsites in `crates/rom-weaver-containers/src/lib.rs` that duplicate deflate/zstd/lzma behavior.
- In scope: additive helper APIs in `crates/rom-weaver-codecs/src/lib.rs` needed by CHD.
- Out of scope: CHD map encoding format changes, metadata layout changes, CLI UX changes, or external backend swaps.

## Current Duplication Targets
- `compress_rust_hunk` duplicates:
  - zstd encode
  - zlib/deflate encode level mapping
  - lzma no-header encode options
- `compress_rust_cd_hunk` duplicates:
  - sector stream zstd/zlib/lzma encode
  - subcode stream zlib encode
- Error shaping and level normalization are re-implemented locally instead of shared.

## Implementation Plan
1. Add shared CHD-relevant helpers in `rom-weaver-codecs`.
- Add byte helpers with stable error messages and deterministic defaults:
  - `encode_deflate(payload, level)`
  - `encode_lzma_raw(payload, level, dict_size)`
  - keep existing `encode_zstd` as canonical zstd path
- Add focused tests for helper-level parity and invalid-level bounds.

2. Migrate CHD hunk compression to shared helpers.
- Replace direct `DeflateEncoder` and `LzmaWriter::new_no_header` usage in CHD create paths with helper calls.
- Keep CHD-specific frame splitting and output assembly local (only codec primitives move).
- Preserve CHD-specific dict-size policy via `chd_lzma_dict_size` and pass its result into shared helper.

3. Normalize CHD codec-level policy in one place.
- Keep media-specific codec selection in CHD handler.
- Move repeated level clamp/default logic into helper wrappers where possible to avoid drift.

4. Clean up container imports and dependency usage.
- Remove CHD-local codec primitives no longer needed after migration.
- Verify no accidental behavior change for non-CHD container formats.

## Verification Plan
- Build checks:
  - `cargo check -p rom-weaver-codecs`
  - `cargo check -p rom-weaver-containers`
  - `cargo check -p rom-weaver-cli`
- CHD-focused tests:
  - `cargo test -p rom-weaver-containers chd_runtime_threads_match_capabilities_for_create_and_extract -- --nocapture`
  - `cargo test -p rom-weaver-containers chd_rust_compressed_create_round_trip_matches_source_payload -- --nocapture`
  - `cargo test -p rom-weaver-containers chd_rust_only_create_supports_cd_compressed_round_trip -- --nocapture`
  - `cargo test -p rom-weaver-containers chd_rust_only_create_supports_cd_multi_codec_round_trip -- --nocapture`
- Regression spot-check:
  - `cargo test -p rom-weaver-containers tar_ -- --nocapture`

## Acceptance Criteria
- CHD create/extract behavior is unchanged for existing fixtures and round-trip tests.
- CHD compressed create still supports current codec matrix and level constraints.
- Thread execution reports remain capability-consistent.
- Duplicate codec logic in CHD paths is reduced in favor of shared helpers.

## Risks and Mitigations
- Risk: byte-level output differences can affect CHD map entry reuse or parent/self references.
- Mitigation: preserve existing CHD dict-size and level policy, run compressed CHD round-trip plus parented CHD tests.

- Risk: helper API over-generalization causes non-CHD behavior drift.
- Mitigation: keep helper surface minimal and CHD-focused; do not rewrite unrelated container handlers in this step.

## Follow-up (Optional)
- If this lands cleanly, evaluate a second pass to dedupe CHD decode-only helpers with existing codec decode utilities where representation constraints match.

## Related Dedupe Queue
- 1. CHD codec primitive dedupe in `compress_rust_hunk` and `compress_rust_cd_hunk` (zstd/zlib/lzma encode paths) via shared `rom-weaver-codecs` helpers.
- 2. PBP deflate block decode helper extraction from containers into `rom-weaver-codecs`.
- 3. Shared container codec-backend lookup plumbing dedupe between tar and stream handlers.
