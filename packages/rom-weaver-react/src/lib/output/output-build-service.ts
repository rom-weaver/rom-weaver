import {
  createCompressionProgressLabel,
  getProgressEventPercent,
  getRawProgressLabel,
} from "../../presentation/workflow-presentation.ts";
import { isVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type { JsonValue, ProgressEvent as SharedProgressEvent } from "../../types/runtime.ts";
import type { CompressionOptionValue } from "../../types/workflow-compression.ts";
import type { ApplyWorkflowOptions, CreateWorkflowOptions, ProgressEvent } from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { COMPRESSION_DEFAULTS } from "../compression/compression-metadata.ts";
import { resolveCompressionLevels } from "../compression/compression-settings.ts";
import {
  isArchiveCompressionFormat,
  isRomSpecificCompressionFormat,
  type RomSpecificCompressionFormat,
} from "../compression/container-format-registry.ts";
import OutputCompressionManager from "../compression/output-compression-manager.ts";
import type { PatchFileInstance } from "../input/binary-service.ts";
import {
  clonePatchFile,
  decodeUtf8,
  getPatchFileBytes,
  getPatchFileCleanup,
  getPatchFileExternalSource,
  isLazyExternalPatchFile,
} from "../input/binary-service.ts";
import type { InputAsset } from "../input/input-assets.ts";
import { getFileNameWithoutExtension, hasFileNameExtension, replaceFileNameExtension } from "../input/path-utils.ts";
import { getChdAutoCreateMode, replaceCuePatchFileName } from "../input/rom-specific-file-utils.ts";
import { reportProgress } from "../progress/progress-reporting.ts";
import {
  type ArchiveCompressionOverrides,
  type ArchiveOutputEntry,
  createArchiveEntryInputFromPatchFile,
  createArchivePatchFileOutput,
  createPatchFileFromRuntimeOutput,
} from "./archive-output-service.ts";
import { createPatchedOutputPlan, type PatchedOutputPlan } from "./patched-output-plan.ts";

type OutputWorkflowOptions = ApplyWorkflowOptions | CreateWorkflowOptions;
type OutputContainerSettings = NonNullable<NonNullable<OutputWorkflowOptions["output"]>["container"]> &
  Record<string, unknown>;
type ResolvedCompressionLevels = ReturnType<typeof resolveCompressionLevels>;
type RuntimeTimedPatchFile = PatchFileInstance & {
  _runtimeTiming?: {
    elapsedMs?: unknown;
  } | null;
};

const hasRomSpecificCompressionMetadata = (source: PatchFileInstance | null | undefined) =>
  !!(
    source?._chdSourceFileName ||
    source?._chdCuePath ||
    source?._chdCueText ||
    source?._chdMode === "cd" ||
    source?._chdMode === "dvd" ||
    source?._rvzSourceFileName ||
    source?._z3dsSourceFileName
  );

const getOutputCompression = (options: OutputWorkflowOptions | undefined, source?: PatchFileInstance | null) => {
  if (options?.output?.compression !== undefined && options.output.compression !== null)
    return options.output.compression;
  return hasRomSpecificCompressionMetadata(source) ? "auto" : "7z";
};
const getCompressionProfile = (options: OutputWorkflowOptions | undefined) =>
  options?.output?.container?.profile || "max";
const getWorkerThreads = (options: OutputWorkflowOptions | undefined) => options?.workers?.threads;
const getLogLevel = (options: OutputWorkflowOptions | undefined) => options?.logging?.level;
const getContainerSettings = (options: OutputWorkflowOptions | undefined): OutputContainerSettings =>
  options?.output?.container || {};
const getRequestedOutputName = (options: OutputWorkflowOptions | undefined) => {
  const outputName = options?.output?.outputName;
  return typeof outputName === "string" ? outputName.trim() : "";
};

const traceOutputName = (
  options: OutputWorkflowOptions | undefined,
  message: string,
  details: Record<string, unknown>,
) => {
  if (getLogLevel(options) !== "trace") return;
  options?.onLog?.({
    details,
    level: "trace",
    message,
    namespace: "workflow:apply",
    timestamp: new Date().toISOString(),
  });
};

const getStringOption = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim() ? value : fallback;

const getChdCompressionCodecs = (mode: string | null | undefined, options: OutputWorkflowOptions | undefined) => {
  const archiveSettings = getContainerSettings(options);
  return OutputCompressionManager.getChdCodecsForMode(mode, {
    chdCreateCdCodecs: getStringOption(archiveSettings.chdCreateCdCodecs, COMPRESSION_DEFAULTS.chdCreateCdCodecs),
    chdCreateDvdCodecs: getStringOption(archiveSettings.chdCreateDvdCodecs, COMPRESSION_DEFAULTS.chdCreateDvdCodecs),
    compressionProfile: String(getCompressionProfile(options)),
  });
};

const setCompressionOption = (
  options: Record<string, CompressionOptionValue>,
  key: string,
  value: CompressionOptionValue | undefined,
) => {
  if (value !== undefined) options[key] = value;
};

const getRvzOptions = (
  archiveSettings: OutputContainerSettings,
  levels: ResolvedCompressionLevels,
): Record<string, CompressionOptionValue> => {
  const options: Record<string, CompressionOptionValue> = {
    rvzCodec: levels.rvzCodec,
    rvzCompressionLevel: levels.rvzCompressionLevel,
  };
  setCompressionOption(options, "rvzBlockSize", archiveSettings.rvzBlockSize as CompressionOptionValue | undefined);
  setCompressionOption(options, "rvzScrub", archiveSettings.rvzScrub as CompressionOptionValue | undefined);
  return options;
};

const collectPatchFileCleanups = (files: PatchFileInstance[]): Array<() => Promise<void> | void> => {
  const seen = new Set<() => Promise<void> | void>();
  const output: Array<() => Promise<void> | void> = [];
  for (const file of files) {
    const cleanup = getPatchFileCleanup(file);
    if (!(cleanup && !seen.has(cleanup))) continue;
    seen.add(cleanup);
    output.push(cleanup);
  }
  return output;
};

const runPatchFileCleanups = async (cleanups: Array<() => Promise<void> | void>) => {
  for (const cleanup of cleanups) {
    await Promise.resolve(cleanup()).catch(() => undefined);
  }
};

const toBlobPart = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const createRuntimeSourceFromPatchFile = (file: PatchFileInstance, fallbackFileName: string) => {
  const sourceRef = isLazyExternalPatchFile(file) ? getPatchFileExternalSource(file, fallbackFileName) : null;
  if (sourceRef) {
    if (typeof sourceRef.source === "string" && sourceRef.source.trim()) return sourceRef.source;
    if (isVfsFileRef(sourceRef.source)) return sourceRef.source;
    if (typeof Blob !== "undefined" && sourceRef.source instanceof Blob) return sourceRef.source;
  }

  const bytes = getPatchFileBytes(file);
  if (typeof File !== "undefined")
    return new File([toBlobPart(bytes)], fallbackFileName, { type: "application/octet-stream" });
  return new Blob([toBlobPart(bytes)], { type: "application/octet-stream" });
};

const createRuntimeRomSpecificOutputFiles = async (
  compression: string,
  patchedRom: PatchFileInstance,
  outputPlan: PatchedOutputPlan,
  options: OutputWorkflowOptions | undefined,
  runtime?: WorkflowRuntime,
): Promise<PatchFileInstance[] | null> => {
  type RuntimeCompressionCreateRequest = Parameters<NonNullable<WorkflowRuntime["compression"]["create"]>>[0];

  if (!runtime?.compression.create) return null;
  if (!isRomSpecificCompressionFormat(compression)) return null;

  const inputFileName = outputPlan.inputFileName || patchedRom.fileName || "patched.bin";
  const source = createRuntimeSourceFromPatchFile(patchedRom, inputFileName);
  const runtimeOptions = {
    logLevel: getLogLevel(options),
    onLog: options?.onLog,
    onProgress: (progress: ProgressEvent) => reportProgress(options, progress),
    signal: options?.signal,
    workerThreads: getWorkerThreads(options),
  };
  let request: RuntimeCompressionCreateRequest;
  if (compression === "chd") {
    request = {
      chdSourceMode: outputPlan.chdSourceMode,
      compressionCodecs: outputPlan.chdCompressionCodecs,
      cueFilePath: outputPlan.chdCuePath,
      fileName: inputFileName,
      format: "chd",
      mode: outputPlan.chdCreateMode,
      options: runtimeOptions,
      outputName: outputPlan.finalOutputFileName,
      source,
    };
  } else if (compression === "rvz") {
    request = {
      fileName: inputFileName,
      format: "rvz",
      options: runtimeOptions,
      outputName: outputPlan.finalOutputFileName,
      rvzBlockSize: outputPlan.rvzOptions?.rvzBlockSize as string | number | null | undefined,
      rvzCodec: outputPlan.rvzOptions?.rvzCodec as string | null | undefined,
      rvzCompressionLevel: outputPlan.rvzOptions?.rvzCompressionLevel as string | number | null | undefined,
      rvzMode: outputPlan.rvzMode,
      rvzScrub: outputPlan.rvzOptions?.rvzScrub as boolean | string | number | null | undefined,
      rvzSourceFileName: outputPlan.rvzSourceFileName,
      source,
    };
  } else {
    request = {
      fileName: inputFileName,
      format: "z3ds",
      options: runtimeOptions,
      outputName: outputPlan.finalOutputFileName,
      source,
      z3dsCompressionLevel: outputPlan.z3dsOptions?.compressionLevel as string | number | null | undefined,
      z3dsMetadata: outputPlan.z3dsMetadata,
      z3dsSourceFileName: outputPlan.z3dsSourceFileName,
      z3dsUnderlyingMagic: outputPlan.z3dsUnderlyingMagic,
    };
  }
  const result = await runtime.compression.create(request);
  const output = "output" in result ? result.output : result;
  return [await createPatchFileFromRuntimeOutput(output, outputPlan.finalOutputFileName)];
};

const createSingleFileRomSpecificOutput = async ({
  compression,
  outputFile,
  options,
  runtime,
}: {
  compression: RomSpecificCompressionFormat;
  outputFile: PatchFileInstance;
  options: OutputWorkflowOptions | undefined;
  runtime?: WorkflowRuntime;
}): Promise<PatchFileInstance | null> => {
  const archiveSettings = getContainerSettings(options);
  const levels = resolveCompressionLevels({
    compressionProfile: String(getCompressionProfile(options)),
    rvzCodec: archiveSettings.rvzCodec as string | null | undefined,
    rvzCompressionLevel: archiveSettings.rvzCompressionLevel as string | number | null | undefined,
    sevenZipCodec: archiveSettings.sevenZipCodec as string | null | undefined,
    sevenZipLevel: archiveSettings.sevenZipLevel as string | number | null | undefined,
    z3dsCompressionLevel: archiveSettings.z3dsCompressionLevel as string | number | "default" | null | undefined,
    zipCodec: archiveSettings.zipCodec as string | null | undefined,
    zipLevel: archiveSettings.zipLevel as string | number | null | undefined,
  });
  const outputPlan = createPatchedOutputPlan({
    chdOutputMode: (archiveSettings.chdOutputMode as string | null | undefined) || "auto",
    compressionFormat: compression,
    compressionSettings: levels,
    patchedFileName: getRequestedOutputName(options) || outputFile.fileName || "output.bin",
    replaceCuePatchFileName: (cueText: string, outputName: string) => replaceCuePatchFileName(cueText, outputName),
    resolveChdCodecMode: (_fileName: string, mode: string | null) =>
      mode === "auto" ? getChdAutoCreateMode(outputFile) : mode,
    resolveChdCompressionCodecs: (mode: string | null) => getChdCompressionCodecs(mode, options),
    romFile: outputFile,
    rvzOptions: getRvzOptions(archiveSettings, levels),
    z3dsOptions: {
      compressionLevel: levels.z3dsCompressionLevel,
    },
  });
  const outputs = await createRuntimeRomSpecificOutputFiles(compression, outputFile, outputPlan, options, runtime);
  if (!outputs?.[0]) return null;
  await Promise.resolve(getPatchFileCleanup(outputFile)?.()).catch(() => undefined);
  return outputs[0];
};

const buildOutputFiles = async (
  romFile: PatchFileInstance,
  patchedRom: PatchFileInstance,
  options: ApplyWorkflowOptions | undefined,
  runtime?: WorkflowRuntime,
): Promise<PatchFileInstance[]> => {
  const patchedCleanup = getPatchFileCleanup(patchedRom);
  const compression = OutputCompressionManager.resolveOutputCompression(romFile, {
    compressionFormat: getOutputCompression(options, romFile),
  });
  if (compression === "none") return [patchedRom];

  const archiveSettings = getContainerSettings(options);
  const levels = resolveCompressionLevels({
    compressionProfile: String(getCompressionProfile(options)),
    rvzCodec: archiveSettings.rvzCodec as string | null | undefined,
    rvzCompressionLevel: archiveSettings.rvzCompressionLevel as string | number | null | undefined,
    sevenZipCodec: archiveSettings.sevenZipCodec as string | null | undefined,
    sevenZipLevel: archiveSettings.sevenZipLevel as string | number | null | undefined,
    z3dsCompressionLevel: archiveSettings.z3dsCompressionLevel as string | number | "default" | null | undefined,
    zipCodec: archiveSettings.zipCodec as string | null | undefined,
    zipLevel: archiveSettings.zipLevel as string | number | null | undefined,
  });
  const outputPlan = createPatchedOutputPlan({
    chdOutputMode: (archiveSettings.chdOutputMode as string | null | undefined) || "auto",
    compressionFormat: compression,
    compressionSettings: levels,
    patchedFileName: patchedRom.fileName,
    replaceCuePatchFileName: (cueText: string, outputName: string) => replaceCuePatchFileName(cueText, outputName),
    resolveChdCodecMode: (_fileName: string, mode: string | null) =>
      mode === "auto" ? getChdAutoCreateMode(patchedRom) : mode,
    resolveChdCompressionCodecs: (mode: string | null) => getChdCompressionCodecs(mode, options),
    romFile,
    rvzOptions: getRvzOptions(archiveSettings, levels),
    z3dsOptions: {
      compressionLevel: levels.z3dsCompressionLevel,
    },
  });
  if (isArchiveCompressionFormat(compression)) {
    const archiveEntryFileName =
      "archiveEntryFileName" in outputPlan && typeof outputPlan.archiveEntryFileName === "string"
        ? outputPlan.archiveEntryFileName
        : patchedRom.fileName;
    const entries = [createArchiveEntryInputFromPatchFile(patchedRom, archiveEntryFileName || patchedRom.fileName)];
    if (outputPlan.cueOutput) {
      const data = new TextEncoder().encode(outputPlan.cueOutput.text);
      entries.push({
        entry: { data, filename: outputPlan.cueOutput.fileName },
        size: data.byteLength,
      });
    }
    traceOutputName(options, "output.archive.plan", {
      archiveEntryFileName,
      compression,
      cueOutputFileName: outputPlan.cueOutput?.fileName || "",
      entryFileNames: entries.map((entry) => entry.entry.filename || entry.entry.fileName || entry.entry.name || ""),
      finalOutputFileName: outputPlan.finalOutputFileName,
      patchedRomFileName: patchedRom.fileName,
      requestedOutputName: getRequestedOutputName(options),
      romFileName: romFile?.fileName || "",
      sourceExtension: typeof romFile?.getExtension === "function" ? romFile.getExtension() : "",
    });
    const compressed = await createArchivePatchFileOutput({
      compression,
      entries: entries.map((entry) => entry.entry),
      options,
      outputName: outputPlan.finalOutputFileName,
      runtime,
      trace: (message, details) => traceOutputName(options, message, details),
    });
    await Promise.resolve(patchedCleanup?.()).catch(() => undefined);
    return [compressed];
  }
  const runtimeRomSpecificOutputs = await createRuntimeRomSpecificOutputFiles(
    compression,
    patchedRom,
    outputPlan,
    options,
    runtime,
  );
  if (runtimeRomSpecificOutputs) {
    await Promise.resolve(patchedCleanup?.()).catch(() => undefined);
    return runtimeRomSpecificOutputs;
  }
  throw new Error("Runtime disc compression create capability is unavailable");
};

const getOutputBaseName = (assets: InputAsset[]) => {
  const cueAsset = assets.find((asset) => asset.kind === "cue");
  const firstAsset = cueAsset || assets[0];
  const name = firstAsset?.fileName || "patched.bin";
  return getFileNameWithoutExtension(name) || "patched";
};

const resolveRawRequestedOutputName = (outputName: string, source: PatchFileInstance) => {
  if (hasFileNameExtension(outputName)) return outputName;
  const sourceExtension = typeof source.getExtension === "function" ? source.getExtension() : "";
  return sourceExtension ? replaceFileNameExtension(outputName, sourceExtension) : outputName;
};

const createArchiveEntryFromPatchFile = (
  asset: InputAsset,
  file: PatchFileInstance,
  outputFileName = asset.fileName,
  cueTextOverride?: string,
): ArchiveOutputEntry => {
  if (asset.kind === "cue") {
    const cueText = cueTextOverride ?? asset.disc?.cueText ?? decodeUtf8(getPatchFileBytes(file));
    const data = new TextEncoder().encode(cueText);
    return {
      entry: { data, filename: outputFileName },
      size: data.byteLength,
    };
  }

  return createArchiveEntryInputFromPatchFile(file, outputFileName);
};

const getArchiveTrackExtension = (file: PatchFileInstance, fallbackFileName: string) => {
  const extension = typeof file.getExtension === "function" ? file.getExtension() : "";
  if (extension) return extension;
  const match = String(fallbackFileName || "").match(/\.([^./?#]+)(?:[?#].*)?$/);
  return match?.[1] || "bin";
};

const createArchiveEntriesFromOutputAssets = (
  outputAssets: Array<{ asset: InputAsset; file: PatchFileInstance }>,
  baseName: string,
) => {
  const createDefaultEntries = () =>
    outputAssets.map(({ asset, file }) => createArchiveEntryFromPatchFile(asset, file));
  const cueOutput = outputAssets.find(({ asset }) => asset.kind === "cue");
  const trackOutputs = outputAssets.filter(({ asset }) => asset.kind === "track");
  const trackOutput = trackOutputs[0];
  if (cueOutput && trackOutput && trackOutputs.length === 1) {
    const trackExtension = getArchiveTrackExtension(trackOutput.file, trackOutput.asset.fileName);
    if (trackExtension.toLowerCase() !== "bin") return createDefaultEntries();
    const trackFileName = replaceFileNameExtension(baseName, trackExtension);
    const cueFileName = replaceFileNameExtension(baseName, "cue");
    let cueText: string;
    try {
      cueText = replaceCuePatchFileName(
        cueOutput.asset.disc?.cueText || decodeUtf8(getPatchFileBytes(cueOutput.file)),
        trackFileName,
      );
    } catch (_error) {
      return createDefaultEntries();
    }
    return outputAssets.map(({ asset, file }) =>
      asset.kind === "cue"
        ? createArchiveEntryFromPatchFile(asset, file, cueFileName, cueText)
        : asset.kind === "track"
          ? createArchiveEntryFromPatchFile(asset, file, trackFileName)
          : createArchiveEntryFromPatchFile(asset, file),
    );
  }
  return createDefaultEntries();
};

const assertOutputSizeLimit = (rawOutputSize: number, options: ApplyWorkflowOptions | undefined) => {
  const maxOutputBytes = Number(options?.limits?.maxOutputBytes);
  if (Number.isFinite(maxOutputBytes) && maxOutputBytes >= 0 && rawOutputSize > maxOutputBytes) {
    throw new Error("Output size exceeds configured limit");
  }
};

const getPatchFileRuntimeTimingMs = (file: PatchFileInstance | undefined): number | undefined => {
  const elapsedMs = (file as RuntimeTimedPatchFile | undefined)?._runtimeTiming?.elapsedMs;
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) return undefined;
  return Math.round(elapsedMs);
};

const getPatchFilesRuntimeTimingMs = (files: PatchFileInstance[]): number | undefined => {
  let total = 0;
  let hasTiming = false;
  for (const file of files) {
    const elapsedMs = getPatchFileRuntimeTimingMs(file);
    if (elapsedMs === undefined) continue;
    total += elapsedMs;
    hasTiming = true;
  }
  return hasTiming ? total : undefined;
};

const buildSessionOutputFiles = async (
  assets: InputAsset[],
  patchedById: Map<string, PatchFileInstance>,
  options: ApplyWorkflowOptions | undefined,
  runtime?: WorkflowRuntime,
): Promise<{ compressionTimeMs?: number; files: PatchFileInstance[]; rawOutputSize: number }> => {
  const outputAssets = assets.map((asset) => {
    const patched = patchedById.get(asset.id);
    const file = patched ? patched : clonePatchFile(asset.file);
    if (!file.fileName) file.fileName = asset.fileName;
    return { asset, file };
  });
  const compressionSource =
    outputAssets.find(({ asset }) => asset.patchable)?.asset.file || outputAssets[0]?.asset.file;
  const compression = OutputCompressionManager.resolveOutputCompression(compressionSource, {
    compressionFormat: getOutputCompression(options, compressionSource),
  });
  const requestedOutputName = getRequestedOutputName(options);
  const outputAssetCleanups = collectPatchFileCleanups(outputAssets.map(({ file }) => file));
  if (outputAssets.length === 1) {
    const onlyOutput = outputAssets[0];
    if (!onlyOutput) throw new Error("No output file was produced");
    const onlyFile = onlyOutput.file;
    if (requestedOutputName)
      onlyFile.fileName =
        compression === "none"
          ? resolveRawRequestedOutputName(requestedOutputName, onlyOutput.asset.file)
          : requestedOutputName;
    assertOutputSizeLimit(onlyFile.fileSize, options);
    if (compression === "none") return { files: [onlyFile], rawOutputSize: onlyFile.fileSize };
    const builtFiles = await buildOutputFiles(onlyOutput.asset.file, onlyFile, options, runtime);
    return {
      compressionTimeMs: getPatchFilesRuntimeTimingMs(builtFiles),
      files: builtFiles,
      rawOutputSize: onlyFile.fileSize,
    };
  }

  const baseName = requestedOutputName || getOutputBaseName(assets);
  const entries = createArchiveEntriesFromOutputAssets(outputAssets, baseName);
  const rawOutputSize = entries.reduce((total, entry) => total + entry.size, 0);
  assertOutputSizeLimit(rawOutputSize, options);

  const archiveCompression = compression === "none" ? "zip" : compression;
  const archiveOverrides: ArchiveCompressionOverrides | undefined =
    compression === "none" ? { zipCodec: "store" } : undefined;
  if (archiveCompression === "rvz") throw new Error("RVZ output is not supported for CD disc groups");
  if (archiveCompression === "z3ds") throw new Error("Z3DS output is not supported for CD disc groups");

  if (archiveCompression === "zip") {
    const files = [
      await createArchivePatchFileOutput({
        compression: "zip",
        entries: entries.map((entry) => entry.entry),
        options,
        outputName: `${baseName}.zip`,
        overrides: archiveOverrides,
        runtime,
        trace: (message, details) => traceOutputName(options, message, details),
      }),
    ];
    await runPatchFileCleanups(outputAssetCleanups);
    return {
      compressionTimeMs: getPatchFilesRuntimeTimingMs(files),
      files,
      rawOutputSize,
    };
  }
  if (archiveCompression === "7z") {
    const files = [
      await createArchivePatchFileOutput({
        compression: "7z",
        entries: entries.map((entry) => entry.entry),
        options,
        outputName: `${baseName}.7z`,
        runtime,
        trace: (message, details) => traceOutputName(options, message, details),
      }),
    ];
    await runPatchFileCleanups(outputAssetCleanups);
    return {
      compressionTimeMs: getPatchFilesRuntimeTimingMs(files),
      files,
      rawOutputSize,
    };
  }
  if (archiveCompression === "chd") {
    const cueOutput = outputAssets.find(({ asset }) => asset.kind === "cue");
    const trackOutputs = outputAssets.filter(({ asset }) => asset.kind === "track");
    if (!cueOutput || trackOutputs.length < 1) throw new Error("CHD output requires a CUE disc group with tracks");
    if (!runtime?.compression.create) throw new Error("Runtime CHD compression capability is unavailable");
    const cueFile = clonePatchFile(cueOutput.file, cueOutput.asset.fileName);
    const source = createRuntimeSourceFromPatchFile(cueFile, cueOutput.asset.fileName);
    const imageFiles = trackOutputs.map(({ asset, file }) => {
      const imageFile = clonePatchFile(file, asset.fileName);
      return {
        fileName: asset.fileName,
        source: createRuntimeSourceFromPatchFile(imageFile, asset.fileName),
      };
    });
    const result = await runtime.compression.create({
      compressionCodecs: getChdCompressionCodecs("cd", options),
      fileName: cueOutput.asset.fileName,
      format: "chd",
      imageFiles,
      mode: "cd",
      options: {
        logLevel: getLogLevel(options),
        onLog: options?.onLog,
        onProgress: (progress: SharedProgressEvent) =>
          reportProgress(options, {
            details: progress as RuntimeValue as JsonValue,
            label: getRawProgressLabel(
              progress,
              createCompressionProgressLabel({
                fallbackLabel: "Compressing to CHD",
                formatLabel: "CHD",
                threads: getWorkerThreads(options),
              }),
            ),
            percent: getProgressEventPercent(progress),
            stage: "output",
          }),
        signal: options?.signal,
        workerThreads: getWorkerThreads(options),
      },
      outputName: `${baseName}.chd`,
      source,
    });
    const output = "output" in result ? result.output : result;
    const file = await createPatchFileFromRuntimeOutput(output, `${baseName}.chd`);
    await runPatchFileCleanups(outputAssetCleanups);
    return {
      compressionTimeMs: getPatchFileRuntimeTimingMs(file),
      files: [file],
      rawOutputSize,
    };
  }
  const files = [
    await createArchivePatchFileOutput({
      compression: "7z",
      entries: entries.map((entry) => entry.entry),
      options,
      outputName: `${baseName}.7z`,
      runtime,
      trace: (message, details) => traceOutputName(options, message, details),
    }),
  ];
  await runPatchFileCleanups(outputAssetCleanups);
  return {
    compressionTimeMs: getPatchFilesRuntimeTimingMs(files),
    files,
    rawOutputSize,
  };
};

export { buildSessionOutputFiles, createRuntimeRomSpecificOutputFiles, createSingleFileRomSpecificOutput };
