import {
  createCompressionProgressLabel,
  getProgressEventPercent,
  getProgressEventThreadCount,
} from "../../presentation/workflow-presentation.ts";
import { isVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type { JsonValue, ProgressEvent as SharedProgressEvent } from "../../types/runtime.ts";
import type { CompressionOptionValue } from "../../types/workflow-compression.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { ApplyWorkflowOptions, CreateWorkflowOptions, ProgressEvent } from "../../types/workflow-runtime-types.ts";
import { replaceGdiFileReferences } from "../../workers/protocol/gdi-file-utils.ts";
import { emitTraceLog } from "../logging.ts";
import { COMPRESSION_DEFAULTS } from "../compression/compression-metadata.ts";
import { resolveCompressionLevels } from "../compression/compression-settings.ts";
import {
  getCompressionOutputExtension,
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
import { appendFileNameExtension, getBaseFileName, getFileNameWithoutExtension } from "../input/path-utils.ts";
import { sanitizeTypedOutputName } from "../path-utils.ts";
import {
  chdModeFromMetadata,
  getChdAutoCreateMode,
  isLooseChdAutoSource,
  replaceCuePatchFileName,
} from "../input/rom-specific-file-utils.ts";
import { reportProgress } from "../progress/progress-reporting.ts";
import { roundElapsedMs } from "../workflow/source-preparation.ts";
import {
  type ArchiveCompressionOverrides,
  type ArchiveOutputEntry,
  createArchiveEntryInputFromPatchFile,
  createArchivePatchFileOutput,
  createPatchFileFromRuntimeOutput,
} from "./archive-output-service.ts";
import { removeKnownOutputExtension, withOutputExtension } from "./output-name-validation.ts";
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
  !!(source?.metadata?.sourceFileName || source?.metadata?.cuePath || chdModeFromMetadata(source?.metadata));

const getOutputCompression = (options: OutputWorkflowOptions | undefined, source?: PatchFileInstance | null) => {
  if (options?.output?.compression !== undefined && options.output.compression !== null)
    return options.output.compression;
  return hasRomSpecificCompressionMetadata(source) ? "auto" : "7z";
};
const getCompressionProfile = (options: OutputWorkflowOptions | undefined) =>
  options?.output?.container?.profile || "max";
const getThreads = (options: OutputWorkflowOptions | undefined) => options?.workers?.threads;
const getLogLevel = (options: OutputWorkflowOptions | undefined) => options?.logging?.level;
const getContainerSettings = (options: OutputWorkflowOptions | undefined): OutputContainerSettings =>
  options?.output?.container || {};
const getRequestedOutputName = (options: OutputWorkflowOptions | undefined) => {
  return sanitizeTypedOutputName(options?.output?.outputName);
};

const traceOutputName = (
  options: OutputWorkflowOptions | undefined,
  message: string,
  details: Record<string, unknown>,
) => {
  if (getLogLevel(options) !== "trace") return;
  emitTraceLog({ logLevel: "trace", namespace: "workflow:apply", onLog: options?.onLog }, message, details);
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

const getOutputChdAutoMode = async (
  file: PatchFileInstance,
  options: OutputWorkflowOptions | undefined,
  runtime: WorkflowRuntime | undefined,
): Promise<string> => {
  const mode = getChdAutoCreateMode(file);
  // An unidentified `.iso` also needs its bytes: native `auto` reads UDF to pick DVD.
  const unidentifiedIso =
    /\.iso$/i.test(file.fileName) && !chdModeFromMetadata(file.metadata) && !file.metadata?.cuePath;
  if (!(isLooseChdAutoSource(file) || unidentifiedIso)) return mode;
  if (!(file.fileSize > 0)) return mode;
  if (!/\.(bin|iso)$/i.test(file.fileName) && /\.[^./\\]+$/.test(file.fileName)) return mode;
  // The patched bytes are new, so ask the engine which create mode native `auto` picks for them. A probe
  // failure (opaque bytes) keeps the structural/metadata mode, except for an unidentified `.iso`: the
  // engine may still infer CD from its size, so no codec set is sent (mode "auto") and native picks one.
  options?.signal?.throwIfAborted();
  try {
    const result = await runtime?.compression.probe?.({
      source: createRuntimeSourceFromPatchFile(file, file.fileName),
    });
    return result?.chdCreateMode || mode;
  } catch (error) {
    options?.signal?.throwIfAborted();
    traceOutputName(options, "output.chd.auto-mode.probe-failed", { error: String(error), fileName: file.fileName });
    return unidentifiedIso ? "auto" : mode;
  }
};

const createOutputPlan = async ({
  compression,
  options,
  patchedFileName,
  romFile,
  chdAutoModeFile = romFile,
  runtime,
}: {
  compression: string;
  options: OutputWorkflowOptions | undefined;
  patchedFileName: string;
  romFile: PatchFileInstance;
  chdAutoModeFile?: PatchFileInstance;
  runtime?: WorkflowRuntime;
}): Promise<PatchedOutputPlan> => {
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
  const chdAutoMode =
    compression === "chd" && (!archiveSettings.chdOutputMode || archiveSettings.chdOutputMode === "auto")
      ? await getOutputChdAutoMode(chdAutoModeFile, options, runtime)
      : "raw";
  return createPatchedOutputPlan({
    chdOutputMode: (archiveSettings.chdOutputMode as string | null | undefined) || "auto",
    compressionFormat: compression,
    compressionSettings: levels,
    patchedFileName,
    resolveChdCodecMode: (_fileName: string, mode: string | null) => (mode === "auto" ? chdAutoMode : mode),
    resolveChdCompressionCodecs: (mode: string | null) => getChdCompressionCodecs(mode, options),
    romFile,
    rvzOptions: getRvzOptions(archiveSettings, levels),
    z3dsOptions: {
      compressionLevel: levels.z3dsCompressionLevel,
    },
  });
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
  const formatLabel = compression.toUpperCase();
  const runtimeOptions = {
    logLevel: getLogLevel(options),
    onLog: options?.onLog,
    // Surface a descriptive "Compressing <name> to <format>" label (with the
    // thread count) rather than the runtime's generic per-stage label.
    onProgress: (progress: ProgressEvent) =>
      reportProgress(options, {
        ...progress,
        label: createCompressionProgressLabel({
          formatLabel,
          label: `Compressing ${inputFileName} to ${formatLabel}`,
          // Negotiated effective thread count from the runtime report.
          threads: getProgressEventThreadCount(progress),
        }),
      }),
    signal: options?.signal,
    threads: getThreads(options),
  };
  let request: RuntimeCompressionCreateRequest;
  if (compression === "chd") {
    request = {
      fileName: inputFileName,
      format: "chd",
      options: runtimeOptions,
      outputName: outputPlan.finalOutputFileName,
      romSpecific: {
        chd: {
          compressionCodecs: outputPlan.chdCompressionCodecs,
          compressionProfile: getCompressionProfile(options),
          cueFilePath: outputPlan.chdCuePath,
          mode: outputPlan.chdCreateMode,
          sourceMode: outputPlan.chdSourceMode,
        },
      },
      source,
    };
  } else if (compression === "rvz") {
    request = {
      fileName: inputFileName,
      format: "rvz",
      options: runtimeOptions,
      outputName: outputPlan.finalOutputFileName,
      romSpecific: {
        rvz: {
          blockSize: outputPlan.rvzOptions?.rvzBlockSize as string | number | null | undefined,
          codec: outputPlan.rvzOptions?.rvzCodec as string | null | undefined,
          compressionLevel: outputPlan.rvzOptions?.rvzCompressionLevel as string | number | null | undefined,
          mode: outputPlan.rvzMode,
          scrub: outputPlan.rvzOptions?.rvzScrub as boolean | string | number | null | undefined,
          sourceFileName: outputPlan.rvzSourceFileName,
        },
      },
      source,
    };
  } else {
    request = {
      fileName: inputFileName,
      format: "z3ds",
      options: runtimeOptions,
      outputName: outputPlan.finalOutputFileName,
      romSpecific: {
        z3ds: {
          compressionLevel: outputPlan.z3dsOptions?.compressionLevel as string | number | null | undefined,
          sourceFileName: outputPlan.z3dsSourceFileName,
          underlyingMagic: outputPlan.z3dsUnderlyingMagic,
        },
      },
      source,
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
  const outputPlan = await createOutputPlan({
    compression,
    options,
    patchedFileName: getRequestedOutputName(options) || outputFile.fileName || "output.bin",
    romFile: outputFile,
    runtime,
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

  const outputPlan = await createOutputPlan({
    compression,
    options,
    patchedFileName: patchedRom.fileName,
    romFile,
    chdAutoModeFile: patchedRom,
    runtime,
  });
  if (isArchiveCompressionFormat(compression)) {
    const archiveEntryFileName =
      "archiveEntryFileName" in outputPlan && typeof outputPlan.archiveEntryFileName === "string"
        ? outputPlan.archiveEntryFileName
        : patchedRom.fileName;
    const entries = [createArchiveEntryInputFromPatchFile(patchedRom, archiveEntryFileName || patchedRom.fileName)];
    traceOutputName(options, "output.archive.plan", {
      archiveEntryFileName,
      compression,
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

const resolveRawRequestedOutputName = (outputName: string, source: PatchFileInstance) =>
  withOutputExtension(outputName, typeof source.getExtension === "function" ? source.getExtension() : "");

const createArchiveEntryFromPatchFile = (
  asset: InputAsset,
  file: PatchFileInstance,
  outputFileName = asset.fileName,
  sheetTextOverride?: string,
): ArchiveOutputEntry => {
  if (asset.kind === "cue" || asset.kind === "gdi") {
    const metadataText = asset.kind === "cue" ? asset.file.metadata?.cueText : asset.file.metadata?.gdiText;
    const text = sheetTextOverride ?? metadataText ?? decodeUtf8(getPatchFileBytes(file));
    const data = new TextEncoder().encode(text);
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
  const cueOutput = outputAssets.find(({ asset }) => asset.kind === "cue");
  const trackOutputs = outputAssets.filter(({ asset }) => asset.kind === "track");
  const trackFileNames = new Map(
    trackOutputs.map(({ asset }) => [getBaseFileName(asset.fileName).toLowerCase(), getBaseFileName(asset.fileName)]),
  );
  const createEntry = (
    asset: InputAsset,
    file: PatchFileInstance,
    outputFileName = asset.fileName,
    sheetText?: string,
  ) => {
    if (asset.kind === "gdi") {
      const originalText = asset.file.metadata?.gdiText ?? decodeUtf8(getPatchFileBytes(file));
      sheetText = replaceGdiFileReferences(originalText, (name) =>
        trackFileNames.get(getBaseFileName(name).toLowerCase()),
      );
      // A text round trip turns non-UTF-8 track names into U+FFFD, so unchanged sheets keep their original bytes.
      if (sheetText === originalText) return createArchiveEntryInputFromPatchFile(file, outputFileName);
    }
    return createArchiveEntryFromPatchFile(asset, file, outputFileName, sheetText);
  };
  const createDefaultEntries = () => outputAssets.map(({ asset, file }) => createEntry(asset, file));
  const trackOutput = trackOutputs[0];
  if (cueOutput && trackOutput && trackOutputs.length === 1) {
    const trackExtension = getArchiveTrackExtension(trackOutput.file, trackOutput.asset.fileName);
    if (trackExtension.toLowerCase() !== "bin") return createDefaultEntries();
    // baseName may be a typed base name: keep a dotted version and drop only a known extension.
    const discBaseName = removeKnownOutputExtension(baseName) || baseName;
    const trackFileName = appendFileNameExtension(discBaseName, trackExtension);
    const cueFileName = appendFileNameExtension(discBaseName, "cue");
    let cueText: string;
    try {
      cueText = replaceCuePatchFileName(
        cueOutput.asset.file.metadata?.cueText || decodeUtf8(getPatchFileBytes(cueOutput.file)),
        trackFileName,
      );
    } catch {
      return createDefaultEntries();
    }
    trackFileNames.set(getBaseFileName(trackOutput.asset.fileName).toLowerCase(), trackFileName);
    return outputAssets.map(({ asset, file }) =>
      asset.kind === "cue"
        ? createEntry(asset, file, cueFileName, cueText)
        : asset.kind === "track"
          ? createEntry(asset, file, trackFileName)
          : createEntry(asset, file),
    );
  }
  return createDefaultEntries();
};

const getPatchFileRuntimeTimingMs = (file: PatchFileInstance | undefined): number | undefined =>
  roundElapsedMs((file as RuntimeTimedPatchFile | undefined)?._runtimeTiming);

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
        compression === "none" || !isArchiveCompressionFormat(compression)
          ? resolveRawRequestedOutputName(requestedOutputName, onlyOutput.asset.file)
          : requestedOutputName;
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

  const archiveCompression = compression === "none" ? "zip" : compression;
  const archiveOverrides: ArchiveCompressionOverrides | undefined =
    compression === "none" ? { zipCodec: "store" } : undefined;
  if (archiveCompression === "rvz") throw new Error("RVZ output is not supported for CD disc groups");
  if (archiveCompression === "z3ds") throw new Error("Z3DS output is not supported for CD disc groups");

  if (isArchiveCompressionFormat(archiveCompression)) {
    const files = [
      await createArchivePatchFileOutput({
        compression: archiveCompression,
        entries: entries.map((entry) => entry.entry),
        options,
        outputName: `${baseName}.${getCompressionOutputExtension(archiveCompression)}`,
        ...(archiveOverrides ? { overrides: archiveOverrides } : {}),
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
    // The CHD replaces the disc sheet, so a typed `x.cue` names `x.chd`, not `x.cue.chd`.
    const chdFileName = appendFileNameExtension(removeKnownOutputExtension(baseName) || baseName, "chd");
    const cueOutput = outputAssets.find(({ asset }) => asset.kind === "cue" || asset.kind === "gdi");
    const trackOutputs = outputAssets.filter(({ asset }) => asset.kind === "track");
    if (!cueOutput || trackOutputs.length < 1) throw new Error("CHD output requires a disc sheet group with tracks");
    const mode = cueOutput.asset.kind === "gdi" ? "gd" : "cd";
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
      fileName: cueOutput.asset.fileName,
      format: "chd",
      options: {
        logLevel: getLogLevel(options),
        onLog: options?.onLog,
        onProgress: (progress: SharedProgressEvent) =>
          reportProgress(options, {
            details: progress as RuntimeValue as JsonValue,
            label: createCompressionProgressLabel({
              formatLabel: "CHD",
              label: `Compressing ${cueOutput.asset.fileName} to CHD`,
              // Negotiated effective thread count from the runtime report.
              threads: getProgressEventThreadCount(progress),
            }),
            percent: getProgressEventPercent(progress),
            stage: "output",
          }),
        signal: options?.signal,
        threads: getThreads(options),
      },
      outputName: chdFileName,
      romSpecific: {
        chd: {
          compressionCodecs: getChdCompressionCodecs(mode, options),
          compressionProfile: getCompressionProfile(options),
          imageFiles,
          mode,
        },
      },
      source,
    });
    const output = "output" in result ? result.output : result;
    const file = await createPatchFileFromRuntimeOutput(output, chdFileName);
    await runPatchFileCleanups(outputAssetCleanups);
    return {
      compressionTimeMs: getPatchFileRuntimeTimingMs(file),
      files: [file],
      rawOutputSize,
    };
  }
  throw new Error(`Unsupported multi-file output compression: ${String(archiveCompression)}`);
};

export { buildSessionOutputFiles, createSingleFileRomSpecificOutput };
