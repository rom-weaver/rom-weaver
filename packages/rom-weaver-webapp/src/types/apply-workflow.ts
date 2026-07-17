import type { ChecksumRomProbe, ChecksumVariant, RomTypeTag } from "./checksum.ts";
import type { SelectionCandidate } from "./selection.ts";
import type { SourceRef } from "./source.ts";
import type { WorkflowWarning } from "./workflow-controller.ts";

type ApplyWorkflowSourceStatus = "empty" | "failed" | "loading" | "needsSelection" | "ready";

type ApplyWorkflowChecksums = Record<string, string>;
type ApplyN64ByteOrderMode = "keep" | "big-endian" | "little-endian" | "byte-swapped";

type ApplyWorkflowParentCompression = {
  depth: number;
  kind: string;
  fileName: string;
  sourceSize?: number;
  outputSize?: number;
  decompressionTimeMs?: number;
};

type ApplyWorkflowBundleSource = {
  /** The already-prepared leaf used by apply (usually an OPFS/VFS path). */
  source: SourceRef;
  /** The original dropped source, retained for optional ROM bundling. */
  originalSource: SourceRef;
  fileName: string;
  size?: number;
};

type ApplyWorkflowBundleRomSource = ApplyWorkflowBundleSource & {
  checksums?: ApplyWorkflowChecksums;
  recommendedFormat?: string;
};

type ApplyWorkflowBundleSources = {
  rom: ApplyWorkflowBundleRomSource | null;
  patches: ApplyWorkflowBundleSource[];
};

type ApplyWorkflowResolvedInput = {
  id: string;
  fileName?: string;
  kind?: "rom" | "cue" | "gdi" | "track";
  patchable?: boolean;
  checksums?: ApplyWorkflowChecksums;
  checksumVariants?: ChecksumVariant[];
  checksumTimeMs?: number;
  romProbe?: ChecksumRomProbe;
  romType?: RomTypeTag;
  parentCompressions: ApplyWorkflowParentCompression[];
  selected: boolean;
  selectedCandidateId?: string;
  order?: number;
  groupId?: string;
  size?: number;
  sourceSize?: number;
  chdMode?: string;
  splitBinAvailable?: boolean;
  cueText?: string;
  gdiText?: string;
  decompressionTimeMs?: number;
  wasDecompressed?: boolean;
};

type ApplyWorkflowInputState = {
  id: string;
  fileName?: string;
  status: ApplyWorkflowSourceStatus;
  candidates: SelectionCandidate[];
  checksums?: ApplyWorkflowChecksums;
  checksumVariants?: ChecksumVariant[];
  checksumTimeMs?: number;
  romProbe?: ChecksumRomProbe;
  romType?: RomTypeTag;
  resolvedInputs?: ApplyWorkflowResolvedInput[];
  selectedCandidateId?: string;
  size?: number;
  sourceSize?: number;
  chdMode?: string;
  decompressionTimeMs?: number;
  wasDecompressed?: boolean;
  warnings: WorkflowWarning[];
  parentCompressions: ApplyWorkflowParentCompression[];
};

type ApplyWorkflowPatchState = {
  id: string;
  fileName?: string;
  status: ApplyWorkflowSourceStatus;
  candidates: SelectionCandidate[];
  checksumTimeMs?: number;
  decompressionTimeMs?: number;
  parentCompressions: ApplyWorkflowParentCompression[];
  selectedCandidateId?: string;
  targetInputId?: string;
  targetInputFileName?: string;
  size?: number;
  sourceSize?: number;
  wasDecompressed?: boolean;
  warnings: WorkflowWarning[];
  requirements?: {
    /** Required input crc32 parsed from the patch file name's `[crc32:..]` token. */
    filenameCrc32?: string;
    format?: string;
    minimumSourceSize?: number;
    patchCrc32?: string;
    recordCount?: number;
    sourceCrc32?: string;
    sourceSize?: number;
    targetCrc32?: string;
    targetSize?: number;
  };
  checksumPreflight?: {
    actualCrc32?: string;
    actualSize?: number;
    mismatchReason?: "crc32" | "size" | "size+crc32";
    minimumSourceSize?: number;
    requiredCrc32?: string;
    requiredSize?: number;
    status: "invalid" | "pending" | "unknown" | "valid";
  };
  patchValidation?: {
    message?: string;
    /** `deferred`: a previous-basis mid-chain patch whose input state is only provable during the
     * apply itself - deliberately NOT dry-run against the original ROM (that reports false
     * failures). Terminal for caching, advisory in the UI. */
    status: "deferred" | "invalid" | "pending" | "unknown" | "valid";
    targetInputId?: string;
    validationKey?: string;
  };
  /** User-pasted checksum (raw hex) to validate the patch target input before apply. */
  validateInputChecksum?: string;
  /** User-pasted checksum (raw hex) to validate the patched output after apply. */
  validateOutputChecksum?: string;
  /** Computed header decision for this patch against its target ROM (absent when the ROM
   * has no strippable copier header). */
  headerResolution?: {
    mode: "keep" | "strip";
    decided: boolean;
    strippedBytes?: number;
    headerlessCrc32?: string;
    headerlessChecksums?: Record<string, string>;
    retainOnOutput?: boolean;
    headeredExtension?: string;
    headerlessExtension?: string;
  };
  /** User override from the patch Options drawer; `undefined` means the resolved default. */
  headerChoice?: "keep" | "strip";
  /** Computed N64 byte-order decision for this patch against its target ROM. */
  n64Resolution?: {
    mode: ApplyN64ByteOrderMode;
    decided: boolean;
    sourceOrder: Exclude<ApplyN64ByteOrderMode, "keep">;
    checksums?: Record<string, string>;
  };
  /** User override from the patch Options drawer; `undefined` means Auto. */
  n64ByteOrderChoice?: ApplyN64ByteOrderMode;
};

export type {
  ApplyWorkflowBundleSources,
  ApplyWorkflowChecksums,
  ApplyN64ByteOrderMode,
  ApplyWorkflowInputState,
  ApplyWorkflowParentCompression,
  ApplyWorkflowPatchState,
  ApplyWorkflowResolvedInput,
};
