import {
  getRomSpecificExtractedFileName,
  ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRY,
} from "../../lib/compression/container-format-registry.ts";
import { replaceCuePatchFileName } from "../../lib/input/rom-specific-file-utils.ts";
import { getPathBaseName } from "../../lib/path-utils.ts";
import { createRomWeaverOutputScope } from "../../lib/runtime/run-output-paths.ts";
import { romTypeFromEmittedFile } from "../../lib/runtime/run-result-parsing.ts";
import {
  invokeRomWeaverCompressionCreateWorker,
  invokeRomWeaverIngestWorker,
  normalizeCodecEntries,
} from "../../lib/runtime/wasm-command-runtime.ts";
import type { RomSpecificRuntimeAdapter } from "../../lib/runtime/workflow-runtime-core.ts";
import {
  attachRomSpecificOutputMetadata,
  createCompressionExtractResult,
} from "../../lib/runtime/workflow-runtime-worker-helpers.ts";
import type { RuntimeWorkerIo } from "../../types/workflow-runtime-adapter.ts";
import {
  type BrowserVirtualFileSource,
  getBrowserVirtualFileSource,
  updateBrowserVirtualFileSource,
} from "../../workers/protocol/browser-virtual-files.ts";
import { parseCueFile } from "../../workers/protocol/cue-file-utils.ts";
import {
  EXTRACT_CHECKSUM_ALGORITHMS,
  type ExtractedFileEntry,
  emitBrowserWorkflowTrace,
  findExtractedFile,
  getFileStem,
  getPathDerivedFileName,
  getPathDirectory,
  joinPath,
  normalizeEntryPath,
  normalizeRomSpecificEntryNameForSource,
  uniqueNonEmptyStrings,
} from "./workflow-runtime-helpers.ts";
import { browserVfs, readTextFromBrowserVfs, writeTextToBrowserVfs } from "./workflow-runtime-vfs-cleanup.ts";

const CHD_SINGLE_BIN_OUTPUT_REGEX = /\.bin$/i;
const CHD_ROM_SPECIFIC_FORMAT = ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRY.chd;

const getChdCdOutputFileName = (fileName: string, extension: "bin" | "cue"): string =>
  `${getFileStem(getPathBaseName(fileName, "input.chd")) || "input"}.${extension}`;

const stripPrimaryChdTrackSuffix = (fileName: string): string => fileName.replace(/ \(Track 0*1\)(?=\.bin$)/i, "");

const getChdCreateFormat = (requestedMode: string): string => {
  if (requestedMode === "cd" || requestedMode === "chd-cd") return "chd-cd";
  if (requestedMode === "gd" || requestedMode === "chd-gd") return "chd-gd";
  if (requestedMode === "dvd" || requestedMode === "chd-dvd") return "chd-dvd";
  if (requestedMode === "raw" || requestedMode === "chd-raw") return "chd-raw";
  if (requestedMode === "hd" || requestedMode === "chd-hd") return "chd-hd";
  if (requestedMode === "av" || requestedMode === "ld" || requestedMode === "chd-av" || requestedMode === "chd-ld") {
    return "chd-av";
  }
  return "chd";
};

// Read a staged input's text whether it lives on OPFS or as an in-memory virtual file. File/Blob cue
// sources are served as virtual files (never written to OPFS), so the OPFS VFS `stat`/`read` returns
// nothing for them - the registry is the only place their bytes exist on the main thread.
const virtualSourceToText = async (source: BrowserVirtualFileSource): Promise<string> => {
  if (source instanceof Uint8Array) return new TextDecoder().decode(source);
  if (source instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(source));
  return source.text();
};

const readStagedCueText = async (cuePath: string): Promise<string> => {
  const virtualSource = getBrowserVirtualFileSource(cuePath);
  if (virtualSource) return virtualSourceToText(virtualSource);
  return readTextFromBrowserVfs(cuePath);
};

const rewriteCueFileBinaryReference = async (cuePath: string, targetPath: string) => {
  const virtualSource = getBrowserVirtualFileSource(cuePath);
  if (virtualSource) {
    const contents = await virtualSourceToText(virtualSource);
    const updatedContents = replaceCuePatchFileName(contents, targetPath);
    if (updatedContents !== contents) {
      updateBrowserVirtualFileSource(cuePath, new Blob([updatedContents], { type: "application/x-cue" }));
    }
    return;
  }
  const contents = await readTextFromBrowserVfs(cuePath);
  const updatedContents = replaceCuePatchFileName(contents, targetPath);
  if (updatedContents !== contents) await writeTextToBrowserVfs(cuePath, updatedContents);
};

const resolveCueSidecarPath = (cuePath: string, referencedName: string): string => {
  const normalizedName = String(referencedName || "").trim();
  if (!normalizedName) return "";
  // Absolute references already point at the staged file.
  if (normalizedName.startsWith("/") || normalizedName.startsWith("\\")) return normalizedName;
  return joinPath(getPathDirectory(cuePath), getPathBaseName(normalizedName, normalizedName));
};

// A cue describes a disc layout that references sibling track files (.bin) by name. The browser WASI
// runtime only hydrates OPFS files it is told about up front (command inputs + knownInputPaths); worker
// threads cannot open OPFS handles on demand. Enumerate the cue's referenced tracks so they are hydrated
// alongside the cue, otherwise the disc-layout read fails with "No such file or directory (os error 44)".
const collectCueSidecarPaths = async (cuePath: string): Promise<string[]> => {
  const normalizedCuePath = String(cuePath || "").trim();
  if (!(normalizedCuePath && /\.cue$/i.test(normalizedCuePath))) return [];
  const contents = await readStagedCueText(normalizedCuePath).catch(() => "");
  if (!contents) return [];
  const parsed = parseCueFile(contents);
  const sidecarPaths: string[] = [];
  for (const file of parsed.files) {
    const sidecarPath = resolveCueSidecarPath(normalizedCuePath, file.name);
    if (!sidecarPath || sidecarPath === normalizedCuePath) continue;
    // A referenced track is available if it is on OPFS or registered as a virtual input.
    const exists =
      !!getBrowserVirtualFileSource(sidecarPath) || !!(await browserVfs.stat(sidecarPath).catch(() => null));
    if (exists) sidecarPaths.push(sidecarPath);
  }
  return uniqueNonEmptyStrings(sidecarPaths);
};

const createBrowserChdRuntime = (
  workerIo: RuntimeWorkerIo,
): Pick<RomSpecificRuntimeAdapter, "createChd" | "extractChd"> => ({
  createChd: async ({
    source,
    fileName,
    outputName,
    imageFiles,
    mode,
    sourceMode,
    cueFilePath,
    threads,
    compressionCodecs,
    logLevel,
    onLog,
    onProgress,
    signal,
  }) => {
    const workerInput = await workerIo.stageSource({
      fallbackFileName: fileName || "input.bin",
      pathPrefix: CHD_ROM_SPECIFIC_FORMAT.pathPrefix.create,
      scope: CHD_ROM_SPECIFIC_FORMAT.scope,
      source,
      trace: { logLevel, onLog },
    });
    const stagedImageSources = imageFiles?.length
      ? await workerIo.stageSources(
          imageFiles.map((entry, index) => ({
            fallbackFileName: entry.fileName || `track-${index + 1}.bin`,
            pathPrefix: `${CHD_ROM_SPECIFIC_FORMAT.pathPrefix.sidecar}-${index + 1}`,
            scope: CHD_ROM_SPECIFIC_FORMAT.scope,
            source: entry.source,
            trace: { logLevel, onLog },
          })),
        )
      : [];

    try {
      const stagedInputPaths = [workerInput.filePath, ...stagedImageSources.map((entry) => entry.filePath)];
      let chdInputPath = workerInput.filePath;
      const requestedMode = String(sourceMode || mode || "")
        .trim()
        .toLowerCase();
      const normalizedCueFilePath = String(cueFilePath || "").trim();
      if (normalizedCueFilePath) {
        if (!stagedInputPaths.includes(normalizedCueFilePath)) stagedInputPaths.push(normalizedCueFilePath);
        chdInputPath = normalizedCueFilePath;
        if (workerInput.filePath !== normalizedCueFilePath) {
          await rewriteCueFileBinaryReference(normalizedCueFilePath, workerInput.filePath);
        }
      } else if (/\.cue$/i.test(chdInputPath) && stagedImageSources.length === 1) {
        // The cue is the main input and its track staged separately. Staging can land the track on
        // a collision-suffixed path (e.g. `disc-2.bin`) that no longer matches the name the cue
        // references, so point the cue at the staged file or the disc-layout read fails with
        // "No such file or directory (os error 44)".
        const stagedImagePath = stagedImageSources[0]?.filePath || "";
        if (stagedImagePath) await rewriteCueFileBinaryReference(chdInputPath, stagedImagePath);
      }

      // When the CHD input is a cue, hydrate every sibling track file it references so worker
      // threads can read the full disc layout from OPFS.
      if (/\.cue$/i.test(chdInputPath)) {
        const cueSidecarPaths = await collectCueSidecarPaths(chdInputPath);
        for (const sidecarPath of cueSidecarPaths) {
          if (!stagedInputPaths.includes(sidecarPath)) stagedInputPaths.push(sidecarPath);
        }
        emitBrowserWorkflowTrace({ logLevel, onLog }, "chd cue sidecars hydrated", {
          cuePath: chdInputPath,
          sidecarPaths: cueSidecarPaths,
        });
      }

      const outputFileName = outputName || "output.chd";
      const codecs = normalizeCodecEntries(compressionCodecs);
      const result = await invokeRomWeaverCompressionCreateWorker(
        {
          codecs,
          format: getChdCreateFormat(requestedMode),
          inputPaths: [chdInputPath],
          invalidateMountCacheBeforeRun: true,
          knownInputPaths: uniqueNonEmptyStrings([...stagedInputPaths, chdInputPath]),
          logLevel,
          outputFileName,
          signal,
          workerThreads: threads,
        },
        onProgress,
        onLog,
      );
      return workerIo.createWorkerOutput(
        outputName ? { ...result, fileName: outputName } : result,
        outputName || outputFileName,
        "CHD compression worker did not return browser output",
      );
    } finally {
      await workerInput.cleanup().catch(() => undefined);
      await Promise.all(stagedImageSources.map((imageSource) => imageSource.cleanup().catch(() => undefined)));
    }
  },
  extractChd: async ({
    source,
    fileName,
    outputName,
    mode,
    splitBin,
    threads,
    logLevel,
    onLog,
    onProgress,
    signal,
  }) => {
    const workerSource = await workerIo.stageSource({
      fallbackFileName: fileName,
      pathPrefix: CHD_ROM_SPECIFIC_FORMAT.pathPrefix.extract,
      scope: CHD_ROM_SPECIFIC_FORMAT.scope,
      source,
      trace: { logLevel, onLog },
    });
    const outputScope = createRomWeaverOutputScope();
    let outputScopeAdopted = false;
    try {
      const outDirPath = outputScope.rootPath;
      const stagedSourceFileName = getPathDerivedFileName(workerSource.filePath, workerSource.fileName || fileName);
      const shouldPreseedSingleBinCdOutputs = mode !== "cd" && CHD_SINGLE_BIN_OUTPUT_REGEX.test(outputName || "");
      const actualOutputFileName =
        mode === "cd"
          ? ""
          : shouldPreseedSingleBinCdOutputs
            ? getChdCdOutputFileName(fileName, "bin")
            : getRomSpecificExtractedFileName("chd", { fileName, metadata: { format: mode || undefined } });
      const stagedOutputFileName =
        mode === "cd"
          ? ""
          : shouldPreseedSingleBinCdOutputs
            ? getChdCdOutputFileName(stagedSourceFileName, "bin")
            : getRomSpecificExtractedFileName("chd", {
                fileName: stagedSourceFileName,
                metadata: { format: mode || undefined },
              });
      const shouldSplitBin = mode === "cd" && splitBin !== false;
      const directOutputFileName = outputName || actualOutputFileName;
      const directOutputPath = stagedOutputFileName ? joinPath(outDirPath, stagedOutputFileName) : "";
      const runExtract = () =>
        invokeRomWeaverIngestWorker(
          {
            checksumAlgorithms: [...EXTRACT_CHECKSUM_ALGORITHMS],
            invalidateMountCacheBeforeRun: !!workerSource.virtual,
            knownInputPaths: uniqueNonEmptyStrings([workerSource.filePath]),
            logLevel,
            outDirPath,
            select: [],
            signal,
            sourcePath: workerSource.filePath,
            splitBin: shouldSplitBin,
            workerThreads: threads,
          },
          onProgress,
          onLog,
        );
      const isChdCueOutput = (entry: ExtractedFileEntry | null | undefined) =>
        !!entry &&
        (String(entry.kind || "").toLowerCase() === "cue" || /\.cue$/i.test(entry.fileName || entry.path || ""));
      const sameExtractedFile = (
        left: ExtractedFileEntry | null | undefined,
        right: ExtractedFileEntry | null | undefined,
      ) =>
        !!(left && right) &&
        normalizeEntryPath(left.path || left.fileName) === normalizeEntryPath(right.path || right.fileName);
      const pushUniqueExtractedFile = (entries: ExtractedFileEntry[], entry: ExtractedFileEntry | null | undefined) => {
        if (!entry) return;
        if (entries.some((candidate) => sameExtractedFile(candidate, entry))) return;
        entries.push(entry);
      };
      const selectChdOutputs = (value: Awaited<ReturnType<typeof runExtract>>) => {
        const cue =
          value.assets.find((entry) => entry.kind === "cue") ||
          value.assets.find((entry) => /\.cue$/i.test(entry.fileName));
        const dataFiles = value.assets.filter((entry) => !isChdCueOutput(entry));
        const primary =
          (outputName ? findExtractedFile(value.assets, outputName) : null) ||
          (actualOutputFileName ? findExtractedFile(value.assets, actualOutputFileName) : null) ||
          (stagedOutputFileName ? findExtractedFile(value.assets, stagedOutputFileName) : null) ||
          dataFiles[0] ||
          (directOutputPath
            ? {
                fileName: directOutputFileName || stagedOutputFileName || actualOutputFileName || fileName,
                path: directOutputPath,
              }
            : null) ||
          value.assets[0];
        const outputFiles: ExtractedFileEntry[] = [];
        pushUniqueExtractedFile(outputFiles, cue);
        if (!isChdCueOutput(primary)) pushUniqueExtractedFile(outputFiles, primary);
        for (const entry of dataFiles) pushUniqueExtractedFile(outputFiles, entry);
        return {
          cueFile: cue,
          outputFiles,
          primaryFile: primary,
        };
      };
      const createChdOutputs = async (
        cueFile: ReturnType<typeof selectChdOutputs>["cueFile"],
        outputFiles: ReturnType<typeof selectChdOutputs>["outputFiles"],
        primaryFile: ReturnType<typeof selectChdOutputs>["primaryFile"],
      ) => {
        if (!outputFiles.length) throw new Error("CHD extraction did not emit any output files");
        const outputPaths = outputFiles.map((entry) => String(entry.path || "").trim());
        if (outputPaths.some((filePath) => !filePath)) {
          throw new Error("CHD extraction returned an output without a browser VFS path");
        }
        const outputCleanups = await outputScope.createOutputCleanups(outputPaths, (filePath) =>
          browserVfs.remove(filePath),
        );
        const outputs = [];
        try {
          for (const [index, entry] of outputFiles.entries()) {
            const isCue = isChdCueOutput(entry);
            const normalizedFileName = normalizeRomSpecificEntryNameForSource(
              entry.fileName,
              stagedSourceFileName,
              fileName,
            );
            const isPrimaryDataOutput = !isCue && sameExtractedFile(entry, primaryFile);
            const primaryOutputName =
              isPrimaryDataOutput && outputName
                ? stripPrimaryChdTrackSuffix(outputName)
                : isPrimaryDataOutput && shouldSplitBin
                  ? stripPrimaryChdTrackSuffix(normalizedFileName || entry.fileName || "")
                  : "";
            const fileNameForOutput =
              primaryOutputName ||
              (isPrimaryDataOutput && !shouldSplitBin && outputName
                ? outputName
                : normalizedFileName || entry.fileName || directOutputFileName || fileName);
            const output = await workerIo.createWorkerOutput(
              {
                checksums: isCue ? undefined : entry.checksums,
                cleanup: outputCleanups[index],
                fileName: fileNameForOutput,
                filePath: entry.path,
                romType: isCue ? undefined : romTypeFromEmittedFile(entry),
                size: entry.sizeBytes,
              },
              fileNameForOutput,
              "CHD extraction worker did not return browser output",
            );
            outputs.push(output);
            if (!isCue) attachRomSpecificOutputMetadata(output, { chdCuePath: cueFile?.path });
          }
        } catch (error) {
          await Promise.all(outputs.map((output) => output.dispose().catch(() => undefined)));
          await outputScope.cleanup().catch(() => undefined);
          throw error;
        }
        return createCompressionExtractResult(outputs);
      };

      const extracted = await runExtract();
      const selected = selectChdOutputs(extracted);
      const result = await createChdOutputs(selected.cueFile, selected.outputFiles, selected.primaryFile);
      outputScopeAdopted = true;
      return result;
    } finally {
      if (!outputScopeAdopted) await outputScope.cleanup().catch(() => undefined);
      await workerSource.cleanup().catch(() => undefined);
    }
  },
});

export { createBrowserChdRuntime, stripPrimaryChdTrackSuffix };
