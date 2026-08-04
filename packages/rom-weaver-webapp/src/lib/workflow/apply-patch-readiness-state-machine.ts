import { RomWeaverError, toRomWeaverError } from "../errors.ts";
import type { InputAsset } from "../input/input-assets.ts";
import { resolveApplyHeaderMode, resolveApplyN64ByteOrder, toNormalizedCrc32 } from "./apply-header-resolution.ts";
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
  stage.state.n64Resolution = undefined;
};

const assignApplyPatchTarget = <TSource>(stage: StagedSource<TSource>, target: InputAsset) => {
  stage.state.targetInputId = target.id;
  stage.state.targetInputFileName = target.fileName;
};

const toFiniteSize = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Which declared requirement the staged bytes fail, or "" when they satisfy all of them. */
const resolvePreflightMismatch = ({
  actualCrc32,
  actualSize,
  minimumSourceSize,
  requiredCrc32,
  requiredSize,
}: Pick<
  InternalPatchChecksumPreflight,
  "actualCrc32" | "actualSize" | "minimumSourceSize" | "requiredCrc32" | "requiredSize"
>): "" | "crc32" | "size" | "size+crc32" => {
  const sizeMismatch =
    (requiredSize !== undefined && actualSize !== undefined && actualSize !== requiredSize) ||
    (minimumSourceSize !== undefined && actualSize !== undefined && actualSize < minimumSourceSize);
  const crcMismatch = !!(requiredCrc32 && actualCrc32 && actualCrc32 !== requiredCrc32);
  if (sizeMismatch && crcMismatch) return "size+crc32";
  if (sizeMismatch) return "size";
  return crcMismatch ? "crc32" : "";
};

const createChecksumPreflightVerdict = ({
  actualCrc32,
  actualSize,
  minimumSourceSize,
  requiredCrc32,
  requiredSize,
}: Pick<
  InternalPatchChecksumPreflight,
  "actualCrc32" | "actualSize" | "minimumSourceSize" | "requiredCrc32" | "requiredSize"
>): InternalPatchChecksumPreflight => {
  if (requiredSize === undefined && minimumSourceSize === undefined && !requiredCrc32) {
    return { actualCrc32, actualSize, status: "unknown" };
  }
  const mismatchReason = resolvePreflightMismatch({
    actualCrc32,
    actualSize,
    minimumSourceSize,
    requiredCrc32,
    requiredSize,
  });
  if (mismatchReason) {
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
  return {
    actualCrc32,
    actualSize,
    minimumSourceSize,
    requiredCrc32,
    requiredSize,
    status: missingActual ? "pending" : "valid",
  };
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
  const wanted = {
    ...(requirements?.sourceCrc32 === undefined ? {} : { sourceCrc32: requirements.sourceCrc32 }),
    filenameCrc32: requirements?.filenameCrc32 ?? userInputCrc32,
  };
  const available = { checksums: getInputAssetChecksums(target), checksumVariants: target.checksumVariants };
  const headerResolution = resolveApplyHeaderMode(wanted, available);
  stage.state.headerResolution = headerResolution;
  const n64Resolution = resolveApplyN64ByteOrder(wanted, available);
  stage.state.n64Resolution = n64Resolution;
  const effectiveHeaderMode = stage.state.headerChoice ?? headerResolution?.mode ?? "keep";
  const headerRemoved = effectiveHeaderMode === "strip" && !!headerResolution;
  const effectiveN64Mode = stage.state.n64ByteOrderChoice ?? n64Resolution?.mode ?? "keep";
  const n64Checksums =
    effectiveN64Mode === "keep"
      ? getInputAssetChecksums(target)
      : target.checksumVariants?.find(
          (variant) =>
            (variant.applyCompatibility?.n64ByteOrder || variant.applyCompatibility?.n64_byte_order) ===
            effectiveN64Mode,
        )?.checksums;
  const strippedBytes = headerResolution?.strippedBytes;
  const rawSize = typeof target.size === "number" && Number.isFinite(target.size) ? target.size : undefined;
  const actualSize =
    headerRemoved && rawSize !== undefined && strippedBytes !== undefined ? rawSize - strippedBytes : rawSize;
  const actualCrc32 = headerRemoved
    ? headerResolution?.headerlessCrc32
    : toNormalizedCrc32(n64Checksums?.crc32 ?? getInputAssetChecksums(target)?.crc32);
  const requiredSize = toFiniteSize(requirements?.sourceSize);
  const minimumSourceSize = toFiniteSize(requirements?.minimumSourceSize);
  const requiredCrc32 =
    toNormalizedCrc32(requirements?.sourceCrc32) ??
    toNormalizedCrc32(requirements?.filenameCrc32) ??
    toNormalizedCrc32(userInputCrc32);
  return createChecksumPreflightVerdict({
    actualCrc32,
    actualSize,
    minimumSourceSize,
    requiredCrc32,
    requiredSize,
  });
};

/** Separates the target/preflight key from the chain fingerprint the validation pass appends. */
const VALIDATION_CHAIN_KEY_SEPARATOR = "|chain:";

/**
 * Compose the stored validation key. The chain fingerprint is a second, independent invalidation
 * axis owned by the validation pass; readiness compares only the base half (see
 * `getApplyPatchValidationBaseKey`), so both sides must go through these helpers or a stored verdict
 * can never match and is dropped on every readiness pass.
 */
const composeApplyPatchValidationKey = (baseKey: string, chainFingerprint?: string): string =>
  chainFingerprint ? `${baseKey}${VALIDATION_CHAIN_KEY_SEPARATOR}${chainFingerprint}` : baseKey;

/** Strip the chain fingerprint so a chained verdict still matches its target/preflight key. */
const getApplyPatchValidationBaseKey = (validationKey: string | undefined): string | undefined =>
  validationKey?.split(VALIDATION_CHAIN_KEY_SEPARATOR)[0] ?? validationKey;

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
    compatibility: {
      header: stage.state.headerChoice ?? stage.state.headerResolution?.mode ?? "keep",
      n64ByteOrder: stage.state.n64ByteOrderChoice ?? stage.state.n64Resolution?.mode ?? "keep",
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

/**
 * The deep dry-run validation is deferred so the patch card can surface its info
 * and cheap preflight verdict immediately - a slow full-ROM validation no longer
 * makes a freshly-dropped patch look like it is hanging. It runs as its own pass
 * via `validatePatches`, so any cached verdict that no longer matches this
 * target/preflight is dropped and the row falls back to the preflight result.
 *
 * Compare BASE keys only: the validation pass stores its key with a `|chain:`
 * fingerprint appended and owns re-running the dry run when that fingerprint
 * moves. Comparing the composed key here would never match a chained verdict,
 * silently discarding a good result and stranding the row on "verifying" with
 * nothing left to refresh it.
 */
const dropStaleValidation = <TSource>(
  stage: StagedSource<TSource>,
  target: InputAsset | null | undefined,
  preflight: InternalPatchChecksumPreflight | undefined,
) => {
  if (!(target && preflight)) {
    stage.state.patchValidation = undefined;
    return;
  }
  const validationKey = createApplyPatchValidationKey(stage, target, preflight);
  const cachedKey = stage.state.patchValidation?.validationKey;
  if (cachedKey !== undefined && getApplyPatchValidationBaseKey(cachedKey) !== validationKey) {
    stage.state.patchValidation = undefined;
  }
};

/**
 * Resolve which input the patch applies to and record its preflight verdict. An
 * ambiguous or mismatched target is a normal outcome that leaves the row asking
 * for a selection; anything else is a real failure and propagates.
 */
const settleApplyPatchTarget = async <TSource>(
  stage: StagedSource<TSource>,
  adapters: PatchReadinessAdapters<TSource>,
  assets: InputAsset[],
) => {
  try {
    const target = await resolveApplyPatchTargetForStage(stage, assets);
    stage.state.status = target ? "ready" : "needsSelection";
    const preflight = target ? createApplyPatchChecksumPreflight(stage, target) : undefined;
    stage.state.checksumPreflight = preflight;
    dropStaleValidation(stage, target, preflight);
    if (target) return;
    adapters.pushWarning(
      stage,
      new RomWeaverError("AMBIGUOUS_SELECTION", `${stage.state.fileName || "Patch"} target selection is required`),
    );
  } catch (error) {
    const normalized = toRomWeaverError(error);
    if (normalized.code !== "AMBIGUOUS_SELECTION" && normalized.code !== "PATCH_TARGET_MISMATCH") throw normalized;
    clearApplyPatchTarget(stage);
    stage.state.status = "needsSelection";
    adapters.pushWarning(stage, normalized);
  }
};

const evaluateApplyPatchReadiness = async <TSource>(
  stage: StagedSource<TSource>,
  adapters: PatchReadinessAdapters<TSource>,
): Promise<boolean> => {
  const previousStatus = stage.state.status;
  stage.state.warnings = stage.state.warnings.filter(
    (warning) => !PATCH_TARGET_SELECTION_ERROR_CODES.has(String(warning.code || "")),
  );
  const changed = () => previousStatus !== stage.state.status;
  if (stage.state.status === "loading" && !stage.preparedPatchFile && !stage.state.candidates.length) return false;
  if (!stage.state.selectedCandidateId) {
    clearApplyPatchTarget(stage);
    stage.state.status = "needsSelection";
    return changed();
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
    return changed();
  }
  await settleApplyPatchTarget(stage, adapters, assets);
  return changed();
};

export {
  assignApplyPatchTarget,
  clearApplyPatchTarget,
  composeApplyPatchValidationKey,
  createApplyPatchValidationKey,
  evaluateApplyPatchReadiness,
};
