import type {
  ApplyWorkflowInputState,
  ApplyWorkflowParentCompression,
  ApplyWorkflowPatchState,
  ApplyWorkflowResolvedInput,
} from "../../types/apply-workflow.ts";
import type { SelectionFileCandidate } from "../../types/selection.ts";
import type { InputAsset } from "../input/input-assets.ts";
import { chdModeFromMetadata } from "../input/rom-specific-file-utils.ts";
import type {
  InternalPatchChecksumPreflight,
  InternalPatchRequirements,
  InternalPatchValidation,
  InternalSourceState,
  StagedSource,
} from "./apply-workflow-state.ts";
import { cloneCandidate, cloneValue, cloneWarning } from "./controller-utils.ts";
import {
  cloneChecksumRomProbe,
  cloneChecksumVariants,
  getAssetDecompressionTimeMs,
  getAssetParentCompressions,
  getAssetSourceSize,
  getInputAssetChecksums,
  getPrimaryInputAsset,
} from "./staged-source-checksums.ts";

const clonePatchRequirements = (
  requirements: InternalPatchRequirements | undefined,
): InternalPatchRequirements | undefined => (requirements ? { ...requirements } : undefined);

const clonePatchChecksumPreflight = (
  preflight: InternalPatchChecksumPreflight | undefined,
): InternalPatchChecksumPreflight | undefined => (preflight ? { ...preflight } : undefined);

const clonePatchValidation = (validation: InternalPatchValidation | undefined): InternalPatchValidation | undefined =>
  validation ? { ...validation } : undefined;

const cloneInputState = (
  state: InternalSourceState | null | undefined,
  parentCompressions: ApplyWorkflowParentCompression[],
  resolvedInputs?: ApplyWorkflowResolvedInput[],
) =>
  state
    ? ({
        candidates: state.candidates.map(cloneCandidate),
        chdMode: state.chdMode,
        checksums: state.checksums ? cloneValue(state.checksums) : undefined,
        checksumTimeMs: state.checksumTimeMs,
        checksumVariants: cloneChecksumVariants(state.checksumVariants),
        decompressionTimeMs: state.decompressionTimeMs,
        fileName: (() => {
          if (!(state.status === "needsSelection" && !state.selectedCandidateId)) return state.fileName;
          const selectableGroups = state.candidates.filter(
            (candidate) => candidate.type === "group" && candidate.selectable,
          );
          const selectableGroupIds = new Set(selectableGroups.map((candidate) => candidate.id));
          const romCandidates = state.candidates.filter(
            (candidate): candidate is SelectionFileCandidate =>
              candidate.type === "file" &&
              candidate.kind === "rom" &&
              candidate.selectable &&
              !selectableGroupIds.has(candidate.parentCandidateId || ""),
          );
          return romCandidates.length === 1 ? romCandidates[0]?.fileName || state.fileName : state.fileName;
        })(),
        id: state.id,
        parentCompressions: parentCompressions.map((entry) => ({ ...entry })),
        resolvedInputs: resolvedInputs?.map((entry) => ({
          ...entry,
          checksums: entry.checksums ? cloneValue(entry.checksums) : undefined,
          checksumVariants: cloneChecksumVariants(entry.checksumVariants),
          parentCompressions: entry.parentCompressions.map((parent) => ({
            ...parent,
          })),
          romProbe: cloneChecksumRomProbe(entry.romProbe),
          romType: entry.romType ? { ...entry.romType } : undefined,
        })),
        romProbe: cloneChecksumRomProbe(state.romProbe),
        romType: state.romType ? { ...state.romType } : undefined,
        selectedCandidateId: state.selectedCandidateId,
        size: state.size,
        sourceSize: state.sourceSize,
        status: state.status,
        warnings: state.warnings.map(cloneWarning),
        wasDecompressed: state.wasDecompressed,
      } satisfies ApplyWorkflowInputState)
    : null;

const clonePatchState = (
  state: InternalSourceState,
  parentCompressions: ApplyWorkflowParentCompression[],
): ApplyWorkflowPatchState => ({
  candidates: state.candidates.map(cloneCandidate),
  checksumPreflight: clonePatchChecksumPreflight(state.checksumPreflight),
  checksumTimeMs: state.checksumTimeMs,
  decompressionTimeMs: state.decompressionTimeMs,
  fileName: state.fileName,
  headerChoice: state.headerChoice,
  headerResolution: state.headerResolution ? { ...state.headerResolution } : undefined,
  id: state.id,
  parentCompressions: parentCompressions.map((entry) => ({ ...entry })),
  patchValidation: clonePatchValidation(state.patchValidation),
  requirements: clonePatchRequirements(state.requirements),
  selectedCandidateId: state.selectedCandidateId,
  size: state.size,
  sourceSize: state.sourceSize,
  status: state.status,
  targetInputFileName: state.targetInputFileName,
  targetInputId: state.targetInputId,
  validateInputChecksum: state.validateInputChecksum,
  validateOutputChecksum: state.validateOutputChecksum,
  warnings: state.warnings.map(cloneWarning),
  wasDecompressed: state.wasDecompressed,
});

const cloneResolvedInputState = (
  state: InternalSourceState,
  parentCompressions: ApplyWorkflowParentCompression[],
  selected: boolean,
): ApplyWorkflowResolvedInput => ({
  chdMode: state.chdMode,
  checksums: state.checksums ? cloneValue(state.checksums) : undefined,
  checksumTimeMs: state.checksumTimeMs,
  checksumVariants: cloneChecksumVariants(state.checksumVariants),
  decompressionTimeMs: state.decompressionTimeMs,
  fileName: state.fileName,
  groupId: (() => {
    const selectedCandidate = state.candidates.find(
      (candidate) => candidate.id === state.selectedCandidateId && "parentCandidateId" in candidate,
    );
    return selectedCandidate && "parentCandidateId" in selectedCandidate
      ? selectedCandidate.parentCandidateId || undefined
      : undefined;
  })(),
  id: state.id,
  order: state.order,
  parentCompressions: parentCompressions.map((entry) => ({ ...entry })),
  romProbe: cloneChecksumRomProbe(state.romProbe),
  romType: state.romType ? { ...state.romType } : undefined,
  selected,
  selectedCandidateId: state.selectedCandidateId,
  size: state.size,
  sourceSize: state.sourceSize,
  wasDecompressed: state.wasDecompressed,
});

const cloneResolvedInputAssetState = (
  asset: InputAsset,
  order: number,
  parentCompressions: ApplyWorkflowParentCompression[],
  selected: boolean,
  selectedCandidateId?: string,
): ApplyWorkflowResolvedInput => {
  const checksums = getInputAssetChecksums(asset);
  return {
    chdMode: chdModeFromMetadata(asset.file.metadata) ?? (asset.file.metadata?.cuePath ? "cd" : undefined),
    checksums: checksums ? cloneValue(checksums) : undefined,
    checksumTimeMs: asset.checksumTimeMs,
    checksumVariants: cloneChecksumVariants(asset.checksumVariants),
    cueText: asset.file.metadata?.cueText,
    decompressionTimeMs: getAssetDecompressionTimeMs(asset),
    fileName: asset.fileName,
    gdiText: asset.file.metadata?.gdiText,
    groupId: asset.groupId,
    id: asset.id,
    kind: asset.kind,
    order,
    parentCompressions: getAssetParentCompressions(asset, parentCompressions),
    patchable: asset.patchable,
    romProbe: cloneChecksumRomProbe(asset.romProbe),
    romType: asset.romType ? { ...asset.romType } : undefined,
    selected,
    selectedCandidateId,
    size: asset.size,
    sourceSize: getAssetSourceSize(asset),
    splitBinAvailable: asset.file.metadata?.splitBinAvailable,
    wasDecompressed: asset.preparation?.wasDecompressed,
  };
};

const cloneResolvedInputStatesForStage = <TSource>(
  stage: StagedSource<TSource>,
  selectedStage: boolean,
): ApplyWorkflowResolvedInput[] => {
  // Disc sheets (cue/gdi) are not shown as their own rows; their text rides on the sibling
  // bin/track rows via `cueText`/`gdiText`. Output generation still reads `preparedInputAssets`
  // directly, so the sheet assets stay available there. Filter sheets out of the UI-facing
  // resolved inputs only.
  const assets = (stage.preparedInputAssets || []).filter((asset) => asset.kind !== "cue" && asset.kind !== "gdi");
  if (!assets.length) return [cloneResolvedInputState(stage.state, stage.parentCompressions, selectedStage)];
  const primaryAsset = getPrimaryInputAsset(assets);
  return assets.map((asset, index) =>
    cloneResolvedInputAssetState(
      asset,
      index,
      stage.parentCompressions,
      selectedStage && asset.id === primaryAsset?.id,
      stage.state.selectedCandidateId,
    ),
  );
};

export { cloneInputState, clonePatchRequirements, clonePatchState, cloneResolvedInputStatesForStage };
