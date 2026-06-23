import { createCleanupOnce } from "../../storage/shared/disposal.ts";
import type { ParsedPatchDescriptor } from "../../types/ingest.ts";
import type { ProgressEvent as SharedProgressEvent } from "../../types/runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { ApplyWorkflowOptions, PublicOutput } from "../../types/workflow-runtime-types.ts";
import type { ParsedPatchLike } from "../../workers/protocol/patch-engine.ts";
import {
  getPatchFileCleanup,
  getPatchFileExternalSource,
  isBlobBackedPatchFile,
  type PatchFileInstance,
} from "../input/binary-service.ts";
import type { InputAsset } from "../input/input-assets.ts";
import { verifyPatchedOutputChecksum } from "../output/output-checksum-verification.ts";
import { isXdeltaPatchExtension } from "../patch-format-classification.ts";
import { getExpectedPatchHeaderMagic } from "../patch-header-magic.ts";
import { getFileNameExtension } from "../path-utils.ts";
import { normalizeApplyProgressInput, reportProgress } from "../progress/progress-reporting.ts";

type PatchSourceValidator = {
  validateSourceAsync?: (file: PatchFileInstance) => boolean | Promise<boolean>;
};

type PatchProbeRequirements = {
  format?: string;
  minimumSourceSize?: number;
  patchCrc32?: string;
  recordCount?: number;
  sourceCrc32?: string;
  sourceSize?: number;
  targetCrc32?: string;
  targetSize?: number;
};

type ParsedPatchWithProbeRequirements = ParsedPatchLike & {
  __romWeaverPatchProbeRequirements?: PatchProbeRequirements;
};

const PATCH_PROBE_REQUIREMENTS_KEY = "__romWeaverPatchProbeRequirements";
const HEX_PREFIX_REGEX = /^0x/i;
const HEX_DIGITS_REGEX = /^[0-9a-f]+$/i;
const DECIMAL_DIGITS_REGEX = /^\d+$/;

const getPatchSummaryFormatName = (fileName: string | undefined) => {
  const extension = getFileNameExtension(fileName);
  if (extension === "ebp") return "IPS";
  if (isXdeltaPatchExtension(extension)) return "VCDIFF";
  return extension ? extension.toUpperCase() : "Patch";
};

const isXdeltaPatchFileName = (fileName: string | undefined) => isXdeltaPatchExtension(getFileNameExtension(fileName));

const getPatchFileExtension = (fileName: string | undefined) => getFileNameExtension(fileName);

const toOptionalFiniteInt = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!DECIMAL_DIGITS_REGEX.test(normalized)) return undefined;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
};

const toOptionalCrc32Hex = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return (value >>> 0).toString(16).padStart(8, "0");
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(HEX_PREFIX_REGEX, "");
  if (!normalized) return undefined;
  if (HEX_DIGITS_REGEX.test(normalized) && normalized.length <= 8)
    return Number.parseInt(normalized, 16).toString(16).padStart(8, "0");
  if (DECIMAL_DIGITS_REGEX.test(normalized))
    return (Number.parseInt(normalized, 10) >>> 0).toString(16).padStart(8, "0");
  return undefined;
};

const readPatchHeader = async (patchFile: PatchFileInstance, length: number): Promise<string | null> => {
  try {
    patchFile.littleEndian = false;
    patchFile.seek(0);
    const header = patchFile.readString(length);
    patchFile.seek(0);
    return header;
  } catch (error) {
    const source = getPatchFileExternalSource(patchFile, patchFile.fileName || "patch.bin")?.source;
    if (typeof Blob !== "undefined" && source instanceof Blob) {
      const buffer = await source.slice(0, length).arrayBuffer();
      return new TextDecoder().decode(new Uint8Array(buffer));
    }
    if (error instanceof Error && /cannot be read synchronously/i.test(error.message)) return null;
    throw error;
  }
};

const createParsedPatchProxy = async (
  patchFile: PatchFileInstance,
  probeRequirements?: PatchProbeRequirements,
): Promise<ParsedPatchLike | null> => {
  const extension = getPatchFileExtension(patchFile.fileName);
  if (!extension) return null;
  const expectedMagic = getExpectedPatchHeaderMagic(extension);
  if (expectedMagic) {
    const header = await readPatchHeader(patchFile, Math.max(8, expectedMagic.length));
    if (header !== null && !header.startsWith(expectedMagic)) return null;
  }
  const parsedPatch = {
    _originalPatchFile: patchFile,
    constructor: { name: getPatchSummaryFormatName(patchFile.fileName) },
    description: null,
    getDescription: () => null,
    getValidationInfo: () => null,
    isXdeltaPatch: isXdeltaPatchFileName(patchFile.fileName),
  } as unknown as ParsedPatchWithProbeRequirements;
  if (probeRequirements) parsedPatch[PATCH_PROBE_REQUIREMENTS_KEY] = probeRequirements;
  return parsedPatch as ParsedPatchLike;
};

const normalizePatchOptions = (options?: ApplyWorkflowOptions) => {
  return {
    addHeader: !!options?.compatibility?.addHeader,
    appendOutputSuffix: !!options?.output?.suffix,
    fixChecksum: !!options?.compatibility?.fixChecksum,
    onProgress: (
      progress: SharedProgressEvent | string | number | boolean | null | undefined | object,
      total?: string | number | null | undefined,
    ) => {
      const normalized = normalizeApplyProgressInput(progress, total);
      reportProgress(options, {
        details: normalized.details,
        label: normalized.label,
        percent: normalized.percent,
        stage: "apply",
      });
    },
    outputExtension: options?.output?.extension,
    outputName: options?.output?.outputName,
    removeHeader: !!options?.compatibility?.removeHeader,
    requireValidation:
      typeof options?.validation?.requireInputChecksumMatch === "boolean"
        ? options.validation.requireInputChecksumMatch
        : false,
    workerThreads: options?.workers?.threads,
  };
};

const getPatchProbeRequirements = (patch: ParsedPatchLike | null | undefined): PatchProbeRequirements | undefined => {
  if (!patch || typeof patch !== "object") return undefined;
  const requirements = (patch as ParsedPatchWithProbeRequirements)[PATCH_PROBE_REQUIREMENTS_KEY];
  return requirements ? { ...requirements } : undefined;
};

const INGEST_PATCH_REQUIREMENTS_KEY = "__romWeaverIngestPatchRequirements";

// A staging step that already ran `ingest` over a patch leaf (the archive patch enumeration) stashes
// the mapped requirements on the leaf file so the later parse reuses them instead of re-ingesting.
const attachIngestPatchRequirements = (
  patchFile: PatchFileInstance,
  requirements: PatchProbeRequirements | undefined,
): void => {
  if (requirements) (patchFile as Record<string, unknown>)[INGEST_PATCH_REQUIREMENTS_KEY] = requirements;
};

const getAttachedIngestPatchRequirements = (patchFile: PatchFileInstance): PatchProbeRequirements | undefined => {
  const requirements = (patchFile as Record<string, unknown>)[INGEST_PATCH_REQUIREMENTS_KEY];
  return requirements && typeof requirements === "object" ? { ...(requirements as PatchProbeRequirements) } : undefined;
};

// Map an ingest `PatchDescriptor`'s embedded fields onto the apply-preflight requirements shape. The
// descriptor parser already coerced crc32/size to numbers, so the shared hex/int helpers render them.
const patchProbeRequirementsFromDescriptor = (
  descriptor: ParsedPatchDescriptor | undefined,
): PatchProbeRequirements | undefined => {
  if (!descriptor) return undefined;
  const format = descriptor.format && descriptor.format !== "unknown" ? descriptor.format.toUpperCase() : undefined;
  const minimumSourceSize = toOptionalFiniteInt(descriptor.minimumSourceSize);
  const sourceSize = toOptionalFiniteInt(descriptor.sourceSize);
  const targetSize = toOptionalFiniteInt(descriptor.targetSize);
  const recordCount = toOptionalFiniteInt(descriptor.recordCount);
  const sourceCrc32 = toOptionalCrc32Hex(descriptor.sourceCrc32);
  const targetCrc32 = toOptionalCrc32Hex(descriptor.targetCrc32);
  const patchCrc32 = toOptionalCrc32Hex(descriptor.patchCrc32);
  if (
    !(
      format ||
      minimumSourceSize !== undefined ||
      sourceSize !== undefined ||
      targetSize !== undefined ||
      sourceCrc32 ||
      targetCrc32 ||
      patchCrc32
    )
  )
    return undefined;
  return {
    ...(format ? { format } : {}),
    ...(minimumSourceSize === undefined ? {} : { minimumSourceSize }),
    ...(patchCrc32 ? { patchCrc32 } : {}),
    ...(recordCount === undefined ? {} : { recordCount }),
    ...(sourceCrc32 ? { sourceCrc32 } : {}),
    ...(sourceSize === undefined ? {} : { sourceSize }),
    ...(targetCrc32 ? { targetCrc32 } : {}),
    ...(targetSize === undefined ? {} : { targetSize }),
  };
};

// Resolve a staged patch's apply-preflight requirements from the consolidated `ingest` command
// (classify + parse in one call), which describes the embedded source/target metadata. Archive leaves
// already carry the descriptor's requirements (stashed by the patch enumeration); a bare patch runs
// ingest here once over its own bytes.
const resolvePatchRequirementsForApply = async (
  patchFile: PatchFileInstance,
  runtime?: WorkflowRuntime,
): Promise<PatchProbeRequirements | undefined> => {
  const attached = getAttachedIngestPatchRequirements(patchFile);
  if (attached) return attached;
  const ingestRun = runtime?.ingest?.run;
  if (!ingestRun) return undefined;
  const externalSource = getPatchFileExternalSource(patchFile, patchFile.fileName || "patch.bin");
  if (!externalSource) return undefined;
  try {
    const { result } = await ingestRun({
      fileName: patchFile.fileName || "patch.bin",
      source: externalSource.source,
    });
    return patchProbeRequirementsFromDescriptor(result.patches[0]);
  } catch (_error) {
    return undefined;
  }
};

const parsePatchForApply = async (
  patchFile: PatchFileInstance,
  runtime?: WorkflowRuntime,
): Promise<ParsedPatchLike | null> => {
  const requirements = await resolvePatchRequirementsForApply(patchFile, runtime);
  return createParsedPatchProxy(patchFile, requirements);
};

const verifyPatchedOutputIfRequired = async (
  patchedRom: PatchFileInstance,
  patches: Parameters<typeof verifyPatchedOutputChecksum>[0]["patches"],
  options: ApplyWorkflowOptions | undefined,
  runtime?: WorkflowRuntime,
) => {
  if (options?.validation?.requireOutputChecksumMatch !== true) return;
  const calculateChecksums = runtime?.checksum.calculate;
  const verificationResult = await verifyPatchedOutputChecksum({
    calculateChecksums: calculateChecksums
      ? ({ algorithms, source }) => calculateChecksums({ algorithms, source })
      : undefined,
    chunkSize: undefined,
    patchedAsset: patchedRom,
    patches,
    runtime,
  });
  if (verificationResult.available && !verificationResult.matched) throw new Error(verificationResult.message);
};

const toPublicOutput = async (file: PatchFileInstance, runtime: WorkflowRuntime): Promise<PublicOutput> => {
  const cleanup = getPatchFileCleanup(file);
  const outputName = file.fileName || "patched.bin";
  const externalSource = getPatchFileExternalSource(file, outputName);
  if (!(externalSource && typeof runtime.output.createSource === "function"))
    throw new Error(`Patched output is not filesystem-backed: ${outputName}`);
  const output = await runtime.output.createSource(externalSource, outputName);
  if (cleanup) {
    const baseDispose = output.dispose.bind(output);
    const dispose = createCleanupOnce(async () => {
      await baseDispose();
      await Promise.resolve(cleanup());
    });
    output.cleanup = dispose;
    output.dispose = dispose;
  }
  return output;
};

const hasChecksumMatch = async (asset: InputAsset, patch: ParsedPatchLike | PatchSourceValidator): Promise<boolean> => {
  if (!asset.patchable) return false;
  if (isBlobBackedPatchFile(asset.file)) return false;
  const validator = patch as PatchSourceValidator;
  if (typeof validator.validateSourceAsync === "function") return !!(await validator.validateSourceAsync(asset.file));
  return false;
};

const resolvePatchTargets = async (
  assets: InputAsset[],
  patches: ParsedPatchLike[],
  patchTargets: Array<"auto" | string> | undefined,
): Promise<InputAsset[]> => {
  const patchableAssets = assets.filter((asset) => asset.patchable);
  if (!patchableAssets.length) throw new Error("No patchable input was provided");

  const targets: InputAsset[] = [];
  for (let index = 0; index < patches.length; index++) {
    const manualTarget = patchTargets?.[index];
    if (manualTarget && manualTarget !== "auto") {
      const selected = patchableAssets.find((asset) => asset.id === manualTarget || asset.fileName === manualTarget);
      if (!selected) throw new Error(`Patch ${index + 1} target was not found: ${manualTarget}`);
      targets.push(selected);
      continue;
    }
    if (patchableAssets.length === 1) {
      targets.push(patchableAssets[0] as InputAsset);
      continue;
    }

    const matches: InputAsset[] = [];
    for (const asset of patchableAssets) {
      const patch = patches[index];
      if (patch && (await hasChecksumMatch(asset, patch))) matches.push(asset);
    }
    if (matches.length === 1) {
      targets.push(matches[0] as InputAsset);
      continue;
    }
    if (matches.length > 1) throw new Error(`Patch ${index + 1} matches multiple inputs; pass patchTargets[${index}]`);
    throw new Error(`Patch ${index + 1} does not match exactly one input; pass patchTargets[${index}]`);
  }
  return targets;
};

export {
  attachIngestPatchRequirements,
  getPatchProbeRequirements,
  normalizePatchOptions,
  parsePatchForApply,
  patchProbeRequirementsFromDescriptor,
  resolvePatchTargets,
  toPublicOutput,
  verifyPatchedOutputIfRequired,
};
