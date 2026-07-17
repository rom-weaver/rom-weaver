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
  /** Computed header decision for this patch against its target ROM. */
  headerResolution?: NonNullable<ApplyWorkflowPatchState["headerResolution"]>;
  /** User override from the patch Options drawer; `undefined` means the resolved default. */
  headerChoice?: "keep" | "strip";
  role: SourceRole;
};
type InternalCandidate<TSource> = SharedInternalCandidate<TSource, InternalSourceState>;
type StagedSource<TSource> = SharedRomStagedSource<TSource, InternalSourceState> & {
  preparedInputAssets?: InputAsset[];
  preparedPatchFile?: PatchFileInstance;
  parsedPatch?: ParsedPatchLike;
  /** In-flight `parsePatch` for this stage. The eager `stageSource` parse and the `setInput`
   * readiness re-evaluation can both reach `parsePatch` before either finishes; sharing one promise
   * keeps the patch from being ingested twice. Cleared once the parse settles. */
  parsePatchInFlight?: Promise<void>;
  selectedArchiveEntry?: string;
  outputLabel?: string;
  /** Patch candidate ids the user picked in an eagerly-opened multi-select dialog (a dropped patch
   * archive whose pick was surfaced ASAP, before the ROM finished checksumming). The queued addPatch
   * mutation applies them (fan-out + validation) once it runs, instead of re-opening the dialog. */
  pendingSelectedIds?: string[];
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
