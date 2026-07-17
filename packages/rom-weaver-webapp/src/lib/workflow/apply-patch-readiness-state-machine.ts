import { RomWeaverError, toRomWeaverError } from "../errors.ts";
import type { InputAsset } from "../input/input-assets.ts";
import { resolveApplyHeaderMode, toNormalizedCrc32 } from "./apply-header-resolution.ts";
import type { InternalPatchChecksumPreflight, StagedSource } from "./apply-workflow-state.ts";
import { getInputAssetChecksums } from "./staged-source-checksums.ts";

type PatchReadinessAdapters<TSource> = {
  getPatchableInputAssets: () => InputAsset[];
  /** Invoked when the patch is staged and parsed but has no ROM to verify against yet (the input is
   * still being prepared). Lets the row replace its lingering staging label with a "waiting on the
   * ROM" status instead of the misleading "checking nested archives in extracted outputs". */
  notifyAwaitingInputTarget?: (stage: StagedSource<TSource>) => void;
  parsePatch: (stage: StagedSource<TSource>) => Promise<void>;
  prepareSelectedSource: (stage: StagedSource<TSource>) => Promise<void>;
  pushWarning: (
    stage: StagedSource<TSource>,
    error: Error & { code?: string; details?: Record<string, unknown> },
  ) => void;
};

const PATCH_TARGET_SELECTION_ERROR_CODES = new Set(["AMBIGUOUS_SELECTION", "PATCH_TARGET_MISMATCH"]);

const clearApplyPatchTarget = <TSource>(stage: StagedSource<TSource>) => {
  stage.state.checksumTimeMs = undefined;
  stage.state.targetInputId = undefined;
  stage.state.targetInputFileName = undefined;
  stage.state.checksumPreflight = undefined;
  stage.state.patchValidation = undefined;
  stage.state.headerResolution = undefined;
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
  // A user-typed expected input CRC32 (8 hex chars; longer hashes are enforced by
  // the engine at apply time) joins the patch's own requirements: it feeds the
  // header auto-resolution and the preflight verdict exactly like a filename token.
  const userInputCrc32 =
    stage.state.validateInputChecksum && /^(0x)?[0-9a-f]{8}$/i.test(stage.state.validateInputChecksum.trim())
      ? stage.state.validateInputChecksum.trim()
      : undefined;
  // Header decision first: when the effective handling is "strip" (auto-decided from the
  // patch's required checksum, or user-chosen in the drawer), the apply runs against the
  // headerless bytes - so the preflight must compare those, not the raw file.
  const headerResolution = resolveApplyHeaderMode(
    {
      ...(requirements?.sourceCrc32 === undefined ? {} : { sourceCrc32: requirements.sourceCrc32 }),
      filenameCrc32: requirements?.filenameCrc32 ?? userInputCrc32,
    },
    {
      checksums: getInputAssetChecksums(target),
      checksumVariants: target.checksumVariants,
    },
  );
  stage.state.headerResolution = headerResolution;
  const effectiveHeaderMode = stage.state.headerChoice ?? headerResolution?.mode ?? "keep";
  const headerRemoved = effectiveHeaderMode === "strip" && !!headerResolution;
  const strippedBytes = headerResolution?.strippedBytes;
  const rawSize = typeof target.size === "number" && Number.isFinite(target.size) ? target.size : undefined;
  const actualSize =
    headerRemoved && rawSize !== undefined && strippedBytes !== undefined ? rawSize - strippedBytes : rawSize;
  const actualCrc32 = headerRemoved
    ? headerResolution?.headerlessCrc32
    : toNormalizedCrc32(getInputAssetChecksums(target)?.crc32);
  const requiredSize =
    typeof requirements?.sourceSize === "number" && Number.isFinite(requirements.sourceSize)
      ? requirements.sourceSize
      : undefined;
  const minimumSourceSize =
    typeof requirements?.minimumSourceSize === "number" && Number.isFinite(requirements.minimumSourceSize)
      ? requirements.minimumSourceSize
      : undefined;
  const requiredCrc32 =
    toNormalizedCrc32(requirements?.sourceCrc32) ??
    toNormalizedCrc32(requirements?.filenameCrc32) ??
    toNormalizedCrc32(userInputCrc32);
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
      // The resolved input file's staging path uniquely identifies the selected candidate. Folding it
      // into the key forces re-validation when the input candidate is switched to a different staged
      // file that happens to share the same id/name/size (e.g. same-named entries in an archive),
      // which id/name/size alone would treat as an unchanged target and skip.
      sourcePath: (target.file as { filePath?: string } | undefined)?.filePath,
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
    // The patch itself is fully prepared - it's only blocked because no ROM is ready to verify
    // against yet. Surface that explicitly so the row stops showing its stale extract label.
    if (!assets.length && stage.parsedPatch && stage.preparedPatchFile) adapters.notifyAwaitingInputTarget?.(stage);
    return previousStatus !== stage.state.status;
  }
  try {
    const target = await resolveApplyPatchTargetForStage(stage, assets);
    stage.state.status = target ? "ready" : "needsSelection";
    const preflight = target ? createApplyPatchChecksumPreflight(stage, target) : undefined;
    stage.state.checksumPreflight = preflight;
    if (target && preflight) {
      // The deep dry-run validation is deferred so the patch card can surface its info + cheap
      // preflight verdict immediately (a slow full-ROM validation no longer makes a freshly-dropped
      // patch look like it is hanging); it runs as its own pass via `validatePatches`. Drop any cached
      // verdict that no longer matches this target/preflight so the row falls back to the preflight
      // result until the background dry-run refreshes it.
      const validationKey = createApplyPatchValidationKey(stage, target, preflight);
      if (stage.state.patchValidation && stage.state.patchValidation.validationKey !== validationKey)
        stage.state.patchValidation = undefined;
    } else {
      stage.state.patchValidation = undefined;
    }
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
