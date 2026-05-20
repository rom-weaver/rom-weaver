import { createCleanupOnce } from "../../storage/shared/disposal.ts";
import type { ProgressEvent as SharedProgressEvent } from "../../types/runtime.ts";
import type { ApplyWorkflowOptions, PublicOutput } from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { CoreRomPatchFileLike, ParsedPatchLike } from "../../workers/protocol/patch-engine.ts";
import { RomWeaver } from "../../workers/protocol/patch-engine.ts";
import { BPS } from "../../workers/protocol/patch-formats.ts";
import {
  getPatchFileBytes,
  getPatchFileCleanup,
  getPatchFileExternalSource,
  isBlobBackedPatchFile,
  isLazyExternalPatchFile,
  type PatchFileInstance,
} from "../input/binary-service.ts";
import type { InputAsset } from "../input/input-assets.ts";
import { verifyPatchedOutputChecksum } from "../output/output-checksum-verification.ts";
import { normalizeApplyProgressInput, reportProgress } from "../progress/progress-reporting.ts";
import { createChecksumSource } from "../workflow/controller-utils.ts";

type PatchWithOriginalFile = {
  _originalPatchFile?: PatchFileInstance;
};

type PatchSourceValidator = {
  validateSourceAsync?: (file: PatchFileInstance) => boolean | Promise<boolean>;
};

type PatchValidationInfoLike = {
  targetChecksumScope?: unknown;
  targetValue?: unknown;
  targetValueScope?: unknown;
  type?: unknown;
  value?: unknown;
};

type WorkerParsedPatchSummary = {
  description?: string | null;
  validationInfo?: PatchValidationInfoLike | null;
};

const FILE_EXTENSION_REGEX = /\.([^./\\\s?#]+)(?:[?#].*)?$/;
const HEX_PREFIX_REGEX = /^0x/i;

const getPatchValidationType = (type: unknown) =>
  String(type || "")
    .trim()
    .toUpperCase()
    .replace(/[-_]/g, "");

const getPatchSummaryFormatName = (fileName: string | undefined) => {
  const extension =
    String(fileName || "")
      .match(FILE_EXTENSION_REGEX)?.[1]
      ?.toLowerCase() || "";
  if (extension === "ebp") return "IPS";
  if (extension === "xdelta" || extension === "vcdiff") return "VCDIFF";
  return extension ? extension.toUpperCase() : "Patch";
};

const isXdeltaPatchFileName = (fileName: string | undefined) => {
  const extension =
    String(fileName || "")
      .match(FILE_EXTENSION_REGEX)?.[1]
      ?.toLowerCase() || "";
  return extension === "xdelta" || extension === "vcdiff";
};

const normalizePatchSummaryChecksumValue = (type: unknown, value: unknown): string | null => {
  const normalizedType = getPatchValidationType(type);
  if (normalizedType === "CRC32" || normalizedType === "ADLER32") {
    if (typeof value === "number" && Number.isFinite(value)) return (value >>> 0).toString(16).padStart(8, "0");
    if (typeof value !== "string") return null;
    const normalized = value.trim().replace(HEX_PREFIX_REGEX, "").toLowerCase();
    if (!normalized) return null;
    const parsed = /^[0-9a-f]+$/i.test(normalized) ? parseInt(normalized, 16) : Number(value);
    return Number.isFinite(parsed) ? (parsed >>> 0).toString(16).padStart(8, "0") : null;
  }
  if (normalizedType === "MD5" || normalizedType === "SHA1") {
    const expectedLength = normalizedType === "MD5" ? 32 : 40;
    const normalized = String(value || "")
      .trim()
      .replace(HEX_PREFIX_REGEX, "")
      .toLowerCase();
    return new RegExp(`^[0-9a-f]{${expectedLength}}$`, "i").test(normalized) ? normalized : null;
  }
  return null;
};

const getPatchSummaryChecksumAlgorithm = (type: unknown): "adler32" | "crc32" | "md5" | "sha1" | null => {
  const normalizedType = getPatchValidationType(type);
  if (normalizedType === "ADLER32") return "adler32";
  if (normalizedType === "CRC32") return "crc32";
  if (normalizedType === "MD5") return "md5";
  if (normalizedType === "SHA" || normalizedType === "SHA1") return "sha1";
  return null;
};

const createWorkerParsedPatchSummaryProxy = (
  patchFile: PatchFileInstance,
  summary: WorkerParsedPatchSummary,
  runtime?: WorkflowRuntime,
): ParsedPatchLike => {
  const validationInfo = summary.validationInfo || null;
  const checksumAlgorithm = getPatchSummaryChecksumAlgorithm(validationInfo?.type);
  const expectedValues = (Array.isArray(validationInfo?.value) ? validationInfo.value : [validationInfo?.value])
    .map((value) => normalizePatchSummaryChecksumValue(validationInfo?.type, value))
    .filter((value): value is string => !!value);

  const proxy = {
    _originalPatchFile: patchFile,
    constructor: { name: getPatchSummaryFormatName(patchFile.fileName) },
    description: summary.description || null,
    getDescription: () => summary.description || null,
    getValidationInfo: () => validationInfo,
    isXdeltaPatch: isXdeltaPatchFileName(patchFile.fileName),
    validateSourceAsync: async (sourceFile: PatchFileInstance) => {
      if (!(runtime?.checksum.calculate && checksumAlgorithm && expectedValues.length)) return false;
      const checksums = await runtime.checksum.calculate({
        algorithms: [checksumAlgorithm],
        source: createChecksumSource(sourceFile, sourceFile.fileName) as Parameters<
          NonNullable<WorkflowRuntime["checksum"]["calculate"]>
        >[0]["source"],
      });
      const actualValue = normalizePatchSummaryChecksumValue(validationInfo?.type, checksums[checksumAlgorithm]);
      return !!actualValue && expectedValues.includes(actualValue);
    },
  } satisfies PatchSourceValidator & PatchWithOriginalFile & Record<string, unknown>;

  return proxy as unknown as ParsedPatchLike;
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

const parsePatchForApply = async (
  patchFile: PatchFileInstance,
  runtime?: WorkflowRuntime,
): Promise<ParsedPatchLike | null> => {
  if (runtime?.name === "browser" && isLazyExternalPatchFile(patchFile)) {
    const parsePatchFileName = patchFile.fileName || "patch.bin";
    let parsePatchFilePath = typeof patchFile.filePath === "string" ? patchFile.filePath.trim() : "";
    let stagedCleanup: (() => Promise<void>) | undefined;
    if (!parsePatchFilePath) {
      const externalSource = getPatchFileExternalSource(patchFile, parsePatchFileName);
      if (!(externalSource && runtime.workerIo?.stageSource))
        throw new Error(`Patch parsing requires filesystem-backed sources: ${parsePatchFileName}`);
      const stagedSource = await runtime.workerIo.stageSource({
        fallbackFileName: parsePatchFileName,
        pathBucket: "patches",
        pathPrefix: "parse-patch",
        scope: "apply",
        source: externalSource,
      });
      parsePatchFilePath = stagedSource.filePath;
      stagedCleanup = stagedSource.cleanup;
    }
    try {
      const { parsePatchInBrowserWorker } = await import("../../workers/protocol/patch-worker.ts");
      const summary = (await parsePatchInBrowserWorker({
        patchFileName: parsePatchFileName,
        patchFilePath: parsePatchFilePath,
      })) as WorkerParsedPatchSummary | null;
      return summary ? createWorkerParsedPatchSummaryProxy(patchFile, summary, runtime) : null;
    } finally {
      await stagedCleanup?.().catch(() => undefined);
    }
  }
  patchFile.littleEndian = false;
  patchFile.seek(0);
  const header = patchFile.readString(8);
  patchFile.seek(0);
  if (header.startsWith(BPS.MAGIC)) {
    const patch = await BPS.fromFileAsync(patchFile as object as Parameters<typeof BPS.fromFileAsync>[0], {
      lazyTargetRead: true,
      streamActions: true,
    });
    (patch as PatchWithOriginalFile)._originalPatchFile = patchFile;
    return patch as object as ParsedPatchLike;
  }
  return RomWeaver.parsePatchFile(patchFile as object as CoreRomPatchFileLike) as Promise<ParsedPatchLike | null>;
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
  normalizePatchOptions,
  parsePatchForApply,
  RomWeaver,
  resolvePatchTargets,
  toPublicOutput,
  verifyPatchedOutputIfRequired,
};
