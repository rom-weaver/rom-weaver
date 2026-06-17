import type {
  ApplyWorkflowChecksums,
  ApplyWorkflowInputState,
  ApplyWorkflowPatchState,
} from "../../types/apply-workflow.ts";
import type { ChecksumRomProbe, ChecksumVariant, RomTypeTag } from "../../types/checksum.ts";
import type { WorkflowWarning } from "../../types/workflow-controller.ts";
import type { ParsedPatchLike, PatchFileInstance } from "../../workers/protocol/patch-engine.ts";
import type { InputAsset } from "../input/input-assets.ts";
import type { SharedInternalCandidate, SharedRomSourceSession, SharedRomStagedSource } from "./staged-rom-source.ts";

type SourceValidator<TSource> = (sources: TSource | TSource[] | undefined) => void;
type SourceRole = "input" | "patch";
type SourceStatus = ApplyWorkflowInputState["status"];
type InternalPatchRequirements = NonNullable<ApplyWorkflowPatchState["requirements"]>;
type InternalPatchChecksumPreflight = NonNullable<ApplyWorkflowPatchState["checksumPreflight"]>;
type InternalPatchValidation = NonNullable<ApplyWorkflowPatchState["patchValidation"]>;
type InternalSourceState = {
  id: string;
  fileName?: string;
  order: number;
  status: SourceStatus;
  candidates: import("../../types/selection.ts").SelectionCandidate[];
  /** True when the pending candidate selection allows picking several patches at once. */
  multiSelect?: boolean;
  selectedCandidateId?: string;
  targetInputId?: string;
  targetInputFileName?: string;
  size?: number;
  sourceSize?: number;
  chdMode?: string;
  decompressionTimeMs?: number;
  wasDecompressed?: boolean;
  warnings: WorkflowWarning[];
  checksums?: ApplyWorkflowChecksums;
  checksumTimeMs?: number;
  checksumVariants?: ChecksumVariant[];
  romProbe?: ChecksumRomProbe;
  romType?: RomTypeTag;
  requirements?: InternalPatchRequirements;
  checksumPreflight?: InternalPatchChecksumPreflight;
  patchValidation?: InternalPatchValidation;
  /** User-pasted checksum (raw hex) to validate the patch target input before apply. */
  validateInputChecksum?: string;
  /** User-pasted checksum (raw hex) to validate the patched output after apply. */
  validateOutputChecksum?: string;
  /** User toggle for PPF undo-aware apply; `undefined` means "default on for PPF patches". */
  ppfUndo?: boolean;
  role: SourceRole;
};
type InternalCandidate<TSource> = SharedInternalCandidate<TSource, InternalSourceState>;
type StagedSource<TSource> = SharedRomStagedSource<TSource, InternalSourceState> & {
  preparedInputAssets?: InputAsset[];
  preparedPatchFile?: PatchFileInstance;
  parsedPatch?: ParsedPatchLike;
  selectedArchiveEntry?: string;
  outputLabel?: string;
};
type InputSession<TSource> = SharedRomSourceSession<TSource, InternalSourceState>;

export type {
  InputSession,
  InternalCandidate,
  InternalPatchChecksumPreflight,
  InternalPatchRequirements,
  InternalPatchValidation,
  InternalSourceState,
  SourceRole,
  SourceValidator,
  StagedSource,
};
