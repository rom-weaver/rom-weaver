import { RomWeaverError, toRomWeaverError } from "../errors.ts";
import type { InputAsset } from "../input/input-assets.ts";
import type { InternalPatchChecksumPreflight, StagedSource } from "./apply-workflow-state.ts";
import { getInputAssetChecksums } from "./staged-source-checksums.ts";

type PatchReadinessAdapters<TSource> = {
  getPatchableInputAssets: () => InputAsset[];
  parsePatch: (stage: StagedSource<TSource>) => Promise<void>;
  prepareSelectedSource: (stage: StagedSource<TSource>) => Promise<void>;
  pushWarning: (
    stage: StagedSource<TSource>,
    error: Error & { code?: string; details?: Record<string, unknown> },
  ) => void;
  validatePatchTarget: (
    stage: StagedSource<TSource>,
    target: InputAsset,
    preflight: InternalPatchChecksumPreflight,
  ) => Promise<void>;
};

const PATCH_TARGET_SELECTION_ERROR_CODES = new Set(["AMBIGUOUS_SELECTION", "PATCH_TARGET_MISMATCH"]);

const toNormalizedCrc32 = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return (value >>> 0).toString(16).padStart(8, "0");
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  if (!normalized) return undefined;
  if (/^[0-9a-f]+$/i.test(normalized) && normalized.length <= 8)
    return Number.parseInt(normalized, 16).toString(16).padStart(8, "0");
  if (/^\d+$/.test(normalized)) return (Number.parseInt(normalized, 10) >>> 0).toString(16).padStart(8, "0");
  return undefined;
};

const clearApplyPatchTarget = <TSource>(stage: StagedSource<TSource>) => {
  stage.state.checksumTimeMs = undefined;
  stage.state.targetInputId = undefined;
  stage.state.targetInputFileName = undefined;
  stage.state.checksumPreflight = undefined;
  stage.state.patchValidation = undefined;
};

const assignApplyPatchTarget = <TSource>(stage: StagedSource<TSource>, target: InputAsset) => {
  stage.state.targetInputId = target.id;
  stage.state.targetInputFileName = target.fileName;
};

const createApplyPatchChecksumPreflight = <TSource>(
  stage: StagedSource<TSource>,
  target: InputAsset,
): InternalPatchChecksumPreflight => {
  const requirements = stage.state.requirements;
  const actualSize = typeof target.size === "number" && Number.isFinite(target.size) ? target.size : undefined;
  const actualCrc32 = toNormalizedCrc32(getInputAssetChecksums(target)?.crc32);
  const requiredSize =
    typeof requirements?.sourceSize === "number" && Number.isFinite(requirements.sourceSize)
      ? requirements.sourceSize
      : undefined;
  const minimumSourceSize =
    typeof requirements?.minimumSourceSize === "number" && Number.isFinite(requirements.minimumSourceSize)
      ? requirements.minimumSourceSize
      : undefined;
  const requiredCrc32 = toNormalizedCrc32(requirements?.sourceCrc32);
  if (requiredSize === undefined && minimumSourceSize === undefined && !requiredCrc32) {
    return {
      actualCrc32,
      actualSize,
      status: "unknown",
    };
  }
  const sizeMismatch = requiredSize !== undefined && actualSize !== undefined && actualSize !== requiredSize;
  const minimumSizeMismatch =
    minimumSourceSize !== undefined && actualSize !== undefined && actualSize < minimumSourceSize;
  const crcMismatch = !!(requiredCrc32 && actualCrc32 && actualCrc32 !== requiredCrc32);
  if (sizeMismatch || minimumSizeMismatch || crcMismatch) {
    const hasSizeMismatch = sizeMismatch || minimumSizeMismatch;
    const mismatchReason = hasSizeMismatch && crcMismatch ? "size+crc32" : hasSizeMismatch ? "size" : "crc32";
    return {
      actualCrc32,
      actualSize,
      minimumSourceSize,
      mismatchReason,
      requiredCrc32,
      requiredSize,
      status: "invalid",
    };
  }
  const missingActual =
    ((requiredSize !== undefined || minimumSourceSize !== undefined) && actualSize === undefined) ||
    (requiredCrc32 && !actualCrc32);
  if (missingActual) {
    return {
      actualCrc32,
      actualSize,
      minimumSourceSize,
      requiredCrc32,
      requiredSize,
      status: "pending",
    };
  }
  return {
    actualCrc32,
    actualSize,
    minimumSourceSize,
    requiredCrc32,
    requiredSize,
    status: "valid",
  };
};

const createApplyPatchValidationKey = <TSource>(
  stage: StagedSource<TSource>,
  target: InputAsset,
  preflight: InternalPatchChecksumPreflight,
): string =>
  JSON.stringify({
    patch: {
      fileName: stage.preparedPatchFile?.fileName || stage.state.fileName,
      size: stage.preparedPatchFile?.fileSize ?? stage.state.size,
    },
    preflight: {
      actualCrc32: preflight.actualCrc32,
      actualSize: preflight.actualSize,
      minimumSourceSize: preflight.minimumSourceSize,
      requiredCrc32: preflight.requiredCrc32,
      requiredSize: preflight.requiredSize,
    },
    requirements: stage.state.requirements || null,
    target: {
      fileName: target.fileName,
      id: target.id,
      size: target.size,
    },
  });

const resolveApplyPatchTargetForStage = async <TSource>(
  stage: StagedSource<TSource>,
  assets: InputAsset[],
): Promise<InputAsset | null> => {
  if (!assets.length) {
    clearApplyPatchTarget(stage);
    return null;
  }
  if (assets.length === 1) {
    const [target] = assets;
    if (!target) return null;
    assignApplyPatchTarget(stage, target);
    return target;
  }
  if (stage.state.targetInputId) {
    const existing = assets.find(
      (asset) => asset.id === stage.state.targetInputId || asset.fileName === stage.state.targetInputId,
    );
    if (existing) {
      assignApplyPatchTarget(stage, existing);
      return existing;
    }
  }
  clearApplyPatchTarget(stage);
  return null;
};

const evaluateApplyPatchReadiness = async <TSource>(
  stage: StagedSource<TSource>,
  adapters: PatchReadinessAdapters<TSource>,
): Promise<boolean> => {
  const previousStatus = stage.state.status;
  stage.state.warnings = stage.state.warnings.filter(
    (warning) => !PATCH_TARGET_SELECTION_ERROR_CODES.has(String(warning.code || "")),
  );
  if (stage.state.status === "loading" && !stage.preparedPatchFile && !stage.state.candidates.length) return false;
  if (!stage.state.selectedCandidateId) {
    clearApplyPatchTarget(stage);
    stage.state.status = "needsSelection";
    return previousStatus !== stage.state.status;
  }
  if (!stage.preparedPatchFile) await adapters.prepareSelectedSource(stage);
  if (!stage.parsedPatch) await adapters.parsePatch(stage);
  const assets = adapters.getPatchableInputAssets();
  if (!(assets.length && stage.parsedPatch)) {
    clearApplyPatchTarget(stage);
    stage.state.status = "needsSelection";
    return previousStatus !== stage.state.status;
  }
  try {
    const target = await resolveApplyPatchTargetForStage(stage, assets);
    stage.state.status = target ? "ready" : "needsSelection";
    const preflight = target ? createApplyPatchChecksumPreflight(stage, target) : undefined;
    stage.state.checksumPreflight = preflight;
    if (target && preflight) await adapters.validatePatchTarget(stage, target, preflight);
    else stage.state.patchValidation = undefined;
    if (!target) {
      adapters.pushWarning(
        stage,
        new RomWeaverError("AMBIGUOUS_SELECTION", `${stage.state.fileName || "Patch"} target selection is required`),
      );
    }
  } catch (error) {
    const normalized = toRomWeaverError(error);
    if (normalized.code === "AMBIGUOUS_SELECTION" || normalized.code === "PATCH_TARGET_MISMATCH") {
      clearApplyPatchTarget(stage);
      stage.state.status = "needsSelection";
      adapters.pushWarning(stage, normalized);
    } else {
      throw normalized;
    }
  }
  return previousStatus !== stage.state.status;
};

export { assignApplyPatchTarget, clearApplyPatchTarget, createApplyPatchValidationKey, evaluateApplyPatchReadiness };
