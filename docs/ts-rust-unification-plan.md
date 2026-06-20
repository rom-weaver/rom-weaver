# TS → Rust logic unification

Working plan for removing TypeScript logic that re-implements decisions the Rust
core already owns. Background: `docs/ARCHITECTURE.md` (the Rust⇄TypeScript
boundary). This file is transient — delete it when the branch lands.

## Framing

The wasm boundary is async (Web Worker + JSON-over-stdin, untyped `details`
JSON back). That splits "duplication" into three buckets:

- **Move logic into Rust** — only cheap when the call site is already on the
  async command path. Real unification.
- **Unify the data** — a hardcoded literal in TS that duplicates generated
  metadata. The JS decision loop stays (it may be on a synchronous UI hot path),
  but the literal is replaced by the typegen'd source of truth. Kills drift.
- **Leave alone** — already delegated to Rust, or genuinely UI-only, or just
  deserializing a Rust response (the contract, not a copy).

Only the first two are actionable. This branch does the highest-confidence,
self-contained ones; the larger lifts are documented as deferred.

## Status — branch `refactor/ts-rust-unify`

Landed: typegen export-gap fix (`MatchSidecarsCommand`), Task A (patch-create
checksum name moved into Rust), Task F (z3ds extension mapping), Task G
(disc-image sector policy). Task E **deferred** (see its note — needs a new
`PatchHandler` trait method, disproportionate to the win). Tasks B/C/D/H remain
deferred as below.

## Tasks — this branch

### 1. Drop the TS crc32 filename mirror (Task A)

- **Problem.** `packages/rom-weaver-react/src/lib/create/patch-checksum-name.ts`
  re-implements (crc32-only) the Rust filename-requirement parser/embedder in
  `crates/rom-weaver-app/src/patch_filename_checksum.rs`
  (`parse_filename_requirements`, `embed_checksum_in_filename` — both
  `pub(super)`, and they cover crc32 + md5 + sha1 + size). The TS doc-comment
  admits it is a mirror kept "closely enough" in sync by hand.
- **Call site.** Exactly one: `lib/create/workflow.ts:128`
  (`embedSourceCrc32InPatchName(basePatchFileName, input.originalCrc32)`),
  which names the create output before the patch-create command runs.
- **Lever.** `PatchCreateCommand` already exposes `checksum_name: bool`
  (`crates/rom-weaver-app/src/command_args.rs:919`) — when set, Rust embeds the
  source checksum into the output filename itself.
- **Approach.** Make Rust the single source of truth: drive the embed via
  `patch create --checksum-name` and read the canonical output name back from
  the command result instead of pre-computing it in JS. If the create UI needs
  the embedded name before the command returns, expose
  `parse_filename_requirements` as a no-I/O command (the `match-sidecars`
  command is the template) rather than re-deriving it. Then delete
  `patch-checksum-name.ts`.
- **Locations.** Rust: `patch_filename_checksum.rs`, `command_args.rs`,
  `command_dispatch.rs`, `lib.rs` (only if a new command is needed). TS:
  `lib/create/workflow.ts`; delete `lib/create/patch-checksum-name.ts`. Regen
  typegen.

### 2. Patch magic via generated metadata (Task E) — DEFERRED

- **Why deferred.** The magics exist only as private handler consts
  (`IPS_MAGIC`/`BPS_MAGIC`/`UPS_MAGIC`), not on `FormatDescriptor`. Exposing them
  to typegen needs a new `PatchHandler::header_magic()` trait method overridden
  per handler — disproportionate to removing two small literals. Revisit if a
  patch-magic consumer in Rust appears.
- **Problem.** The patch magic table `{ bps: "BPS1", ips: "PATCH", ups: "UPS1" }`
  is hardcoded in two TS files —
  `lib/input/input-archive-patch-validity.ts` and
  `lib/apply/patch-apply-service.ts` — while generated
  `ROM_WEAVER_PATCH_FORMATS` carries only `name` + `extensions` (no magic),
  unlike `ROM_WEAVER_CONTAINER_FORMATS` which already carries `magic`.
- **Approach.** Add the magic bytes to the patch-format metadata on the Rust
  side (mirror how container metadata exposes `magic`), regen typegen so
  `ROM_WEAVER_PATCH_FORMATS` carries it, and have both TS files read the
  generated value. Removes both hardcoded copies.
- **Locations.** Rust: the patch-format metadata producer + the typegen tool
  (`tools/rom-weaver-typegen/src/main.rs`). Generated:
  `packages/rom-weaver-react/src/wasm/generated/rom-weaver-format-metadata.ts`.
  TS: the two files above.

### 3. Typegen export gap — `MatchSidecarsCommand` (freebie bug)

- **Problem.** `tools/rom-weaver-typegen/src/main.rs` `render_types()` never
  calls `export_decl::<MatchSidecarsCommand>` (unlike its peer
  `PlanExtractBatchCommand`), so the generated `Commands` union in
  `rom-weaver-rust-types.d.ts` references a TS type that is never declared.
  `typegen --check` does not catch it.
- **Approach.** Add the missing `export_decl` next to `PlanExtractBatchCommand`,
  regen, commit the regenerated bindings.

## Tasks — bonus (TS-internal data dedup, no Rust change)

### 4. z3ds subtype dedup (Task F)

Point the hardcoded subtype regexes in `lib/input/input-archive-z3ds-paths.ts`
and `lib/output/output-files.ts` (`Z3DS_EXTENSION_REGEX`) at the generated
`lib/compression/z3ds-subtypes.ts` map, which is the canonical typegen'd source.

### 5. Disc-sector heuristic dedup (Task G)

Route the hardcoded `size % 2352 / % 2048` disc-image check in
`lib/compression/output-compression-manager.ts` through
`ROM_WEAVER_DISC_IMAGE_POLICY.cdSectorSizes` (already consumed by
`lib/compression/container-format-registry.ts`), so the two `.bin`-is-disc
checks share one canonical policy.

## Deferred — documented, not in this branch

- **B. Output filename prediction.** TS re-derives extracted/output names
  (`container-format-registry.ts` getChd/Rvz/Z3dsExtractedFileName,
  `lib/output/*`) that Rust already returns in extract results. Surface the
  canonical name from Rust. Medium lift, touches many naming paths.
- **C. zstd thread/memory planner.** `lib/runtime/compression-thread-budget.ts`
  + `lib/runtime/op-memory-estimate.ts` port zstd's internal strategy table and
  workspace math to JS. Highest parity hazard (must track the linked zstd).
  Unify behind a Rust planning command, mirroring `plan-extract-batch`.
- **D. Archive magic + extension detector.** `workers/protocol/archive-shared-utils.ts`
  hand-maintains ~30 magic signatures + ~150 extensions. Generate the table from
  the Rust container registry, or probe via Rust on the worker path.
- **H. CHD codec presets.** `lib/compression/codec-fields.ts` hardcodes the
  CD-vs-DVD codec matrix as JS strings; source it from compression metadata.

## Verification (whole branch)

- `cargo test --workspace` (or scoped to `rom-weaver-app` + patch crates).
- `cargo run -p rom-weaver-typegen -- --write`, then commit the regenerated
  `packages/rom-weaver-react/src/wasm/generated/*`.
- `npm --prefix packages/rom-weaver-react run lint` (biome + tsc + browser-compat
  + knip).
- Relevant `crates/rom-weaver-cli/tests/cli_smoke/` and the React create/apply
  browser tests.
- **Byte-identical parity unaffected** — none of these change compression/patch
  *output* bytes; they change how names/metadata are sourced, not what is
  produced.

## Cleanup

Delete this file when the branch lands.
