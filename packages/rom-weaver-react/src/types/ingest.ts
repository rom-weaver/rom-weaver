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
  discGroupId?: string;
  trackNumber?: number;
  cueText?: string;
  gdiText?: string;
  copiedInPlace: boolean;
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
