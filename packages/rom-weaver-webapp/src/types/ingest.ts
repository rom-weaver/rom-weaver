// Webapp-facing result shape for the `ingest` command (classify + nested-extract + checksum ROMs,
// describe patches). The generated wire types carry `u64` fields as `bigint`, but `JSON.parse`
// yields `number`; these `number`-based, camelCase types are what the apply workflow consumes. Kept
// in `types/` (not `lib/`) so the runtime adapter type can reference them without an import cycle.
import type { ChecksumMap, ChecksumVariant } from "./checksum.ts";

type IngestKind = "rom" | "patch";

export interface ParsedIngestRomAsset {
  path: string;
  fileName: string;
  sizeBytes: number;
  kind?: string;
  checksums: ChecksumMap;
  checksumVariants: ChecksumVariant[];
  platform?: string;
  discFormat?: string;
  recommendedFormat?: string;
  discGroupId?: string;
  trackNumber?: number;
  cueText?: string;
  gdiText?: string;
  /** Wall time (ms) of the extract step that produced this leaf; present only for nested leaves
   * (the archive level that emitted them). Absent for a depth-0/single-level leaf - callers fall
   * back to the run-level timing. */
  extractTimeMs?: number;
  copiedInPlace: boolean;
  /** Rust-reported hashing wall time (ms) for a bare ROM checksummed in place; absent for an
   * extracted leaf (whose hashing is folded into its extract timing). */
  checksumMs?: number;
}

export interface ParsedPatchDescriptor {
  leafPath: string;
  fileName: string;
  sizeBytes: number;
  format: string;
  patchCrc32?: number;
  sourceSize?: number;
  targetSize?: number;
  sourceCrc32?: number;
  targetCrc32?: number;
  minimumSourceSize?: number;
  recordCount?: number;
  filenameChecksums: ChecksumMap;
  filenameSize?: number;
  sidecarOrder?: number;
  /** Whether Rust recognized + parsed the patch magic (the validity the host no longer re-derives). */
  isValidPatch: boolean;
}

export interface ParsedIngestResult {
  kind: IngestKind;
  sourceFileName: string;
  isRom: boolean;
  assets: ParsedIngestRomAsset[];
  patches: ParsedPatchDescriptor[];
}
