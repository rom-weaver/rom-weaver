import { createCleanupOnce } from "../../storage/shared/disposal.ts";
import type { ProgressEvent as SharedProgressEvent } from "../../types/runtime.ts";
import type { ApplyWorkflowOptions, PublicOutput } from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { ParsedPatchLike } from "../../workers/protocol/patch-engine.ts";
import {
  getPatchFileCleanup,
  getPatchFileExternalSource,
  isBlobBackedPatchFile,
  type PatchFileInstance,
} from "../input/binary-service.ts";
import type { InputAsset } from "../input/input-assets.ts";
import { verifyPatchedOutputChecksum } from "../output/output-checksum-verification.ts";
import { getFileNameExtension } from "../path-utils.ts";
import { normalizeApplyProgressInput, reportProgress } from "../progress/progress-reporting.ts";

type PatchSourceValidator = {
  validateSourceAsync?: (file: PatchFileInstance) => boolean | Promise<boolean>;
};

type PatchInspectRequirements = {
  format?: string;
  minimumSourceSize?: number;
  patchCrc32?: string;
  recordCount?: number;
  sourceCrc32?: string;
  sourceSize?: number;
  targetCrc32?: string;
  targetSize?: number;
};

type ParsedPatchWithInspectRequirements = ParsedPatchLike & {
  __romWeaverPatchInspectRequirements?: PatchInspectRequirements;
};

const PATCH_INSPECT_REQUIREMENTS_KEY = "__romWeaverPatchInspectRequirements";
const HEX_PREFIX_REGEX = /^0x/i;
const HEX_DIGITS_REGEX = /^[0-9a-f]+$/i;
const DECIMAL_DIGITS_REGEX = /^\d+$/;

const PATCH_MAGIC_BY_EXTENSION = {
  bps: "BPS1",
  ips: "PATCH",
  ups: "UPS1",
} as const;

const getPatchSummaryFormatName = (fileName: string | undefined) => {
  const extension = getFileNameExtension(fileName);
  if (extension === "ebp") return "IPS";
  if (extension === "xdelta" || extension === "vcdiff") return "VCDIFF";
  return extension ? extension.toUpperCase() : "Patch";
};

const isXdeltaPatchFileName = (fileName: string | undefined) => {
  const extension = getFileNameExtension(fileName);
  return extension === "xdelta" || extension === "vcdiff";
};

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

const normalizePatchInspectRequirements = (
  details: Awaited<ReturnType<NonNullable<WorkflowRuntime["patch"]["inspectPatch"]>>> | null | undefined,
): PatchInspectRequirements | undefined => {
  if (!details || typeof details !== "object") return undefined;
  const detailRecord = details as Record<string, unknown>;
  const format =
    typeof details.format === "string" && details.format.trim() ? details.format.trim().toUpperCase() : undefined;
  const minimumSourceSize = toOptionalFiniteInt(detailRecord.minimum_source_size ?? detailRecord.minimumSourceSize);
  const sourceSize = toOptionalFiniteInt(details.source_size);
  const targetSize = toOptionalFiniteInt(details.target_size);
  const recordCount = toOptionalFiniteInt(details.record_count);
  const sourceCrc32 = toOptionalCrc32Hex(details.source_crc32);
  const targetCrc32 = toOptionalCrc32Hex(details.target_crc32);
  const patchCrc32 = toOptionalCrc32Hex(details.patch_crc32);
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
  inspectRequirements?: PatchInspectRequirements,
): Promise<ParsedPatchLike | null> => {
  const extension = getPatchFileExtension(patchFile.fileName);
  if (!extension) return null;
  const expectedMagic = PATCH_MAGIC_BY_EXTENSION[extension as keyof typeof PATCH_MAGIC_BY_EXTENSION];
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
  } as unknown as ParsedPatchWithInspectRequirements;
  if (inspectRequirements) parsedPatch[PATCH_INSPECT_REQUIREMENTS_KEY] = inspectRequirements;
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

const getPatchInspectRequirements = (
  patch: ParsedPatchLike | null | undefined,
): PatchInspectRequirements | undefined => {
  if (!patch || typeof patch !== "object") return undefined;
  const requirements = (patch as ParsedPatchWithInspectRequirements)[PATCH_INSPECT_REQUIREMENTS_KEY];
  return requirements ? { ...requirements } : undefined;
};

const inspectPatchRequirementsForApply = async (
  patchFile: PatchFileInstance,
  runtime?: WorkflowRuntime,
): Promise<PatchInspectRequirements | undefined> => {
  const inspectPatch = runtime?.patch.inspectPatch;
  if (!inspectPatch) return undefined;
  const externalSource = getPatchFileExternalSource(patchFile, patchFile.fileName || "patch.bin");
  if (!externalSource) return undefined;
  try {
    const details = await inspectPatch({
      patch: externalSource.source,
      patchFileName: patchFile.fileName || "patch.bin",
    });
    return normalizePatchInspectRequirements(details);
  } catch (_error) {
    return undefined;
  }
};

const parsePatchForApply = async (
  patchFile: PatchFileInstance,
  runtime?: WorkflowRuntime,
): Promise<ParsedPatchLike | null> => {
  const inspectRequirements = await inspectPatchRequirementsForApply(patchFile, runtime);
  return createParsedPatchProxy(patchFile, inspectRequirements);
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
  getPatchInspectRequirements,
  normalizePatchOptions,
  parsePatchForApply,
  resolvePatchTargets,
  toPublicOutput,
  verifyPatchedOutputIfRequired,
};
