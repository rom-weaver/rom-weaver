import { COMPRESSION_DEFAULTS } from "../../lib/compression/compression-metadata.ts";
import {
  getRomSpecificExtractedFileName,
  ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRY,
} from "../../lib/compression/container-format-registry.ts";
import { getPathBaseName } from "../../lib/path-utils.ts";
import { romTypeFromEmittedFile } from "../../lib/runtime/run-result-parsing.ts";
import {
  invokeRomWeaverCompressionCreateWorker,
  invokeRomWeaverExtractWorker,
  runRomWeaverListWorker,
  selectRomWeaverOutputPath,
} from "../../lib/runtime/wasm-command-runtime.ts";
import type { RomSpecificRuntimeAdapter } from "../../lib/runtime/workflow-runtime-core.ts";
import type { RuntimeWorkerIo } from "../../types/workflow-runtime-adapter.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../workers/shared/worker-storage/storage-layout.ts";
import {
  EXTRACT_CHECKSUM_ALGORITHMS,
  emitBrowserWorkflowTrace,
  getPathDerivedFileName,
  getPathDirectory,
  joinPath,
  normalizeRomSpecificListEntries,
  normalizeZ3dsListEntriesForSource,
  replaceProgressSourceLabel,
  uniqueNonEmptyStrings,
  withCodecLevel,
} from "./workflow-runtime-helpers.ts";
import {
  filterOutputCandidatesAwayFromSource,
  getBrowserExtractOutputPathCandidates,
  removeBrowserVfsOutputPaths,
  selectPreferredExtractedFile,
  waitForBrowserVfsPath,
} from "./workflow-runtime-vfs-cleanup.ts";

const RVZ_ROM_SPECIFIC_FORMAT = ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRY.rvz;
const Z3DS_ROM_SPECIFIC_FORMAT = ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRY.z3ds;

const createBrowserDiscFormatsRuntime = (
  workerIo: RuntimeWorkerIo,
): Pick<
  RomSpecificRuntimeAdapter,
  "createRvz" | "createZ3ds" | "extractRvz" | "extractZ3ds" | "listRvz" | "listZ3ds"
> => ({
  createRvz: async ({
    source,
    fileName,
    outputName,
    codec,
    compressionLevel,
    threads,
    logLevel,
    onLog,
    onProgress,
    signal,
  }) =>
    workerIo.runPathWorkerToOutput({
      failureMessage: "RVZ compression worker did not return browser output",
      fallbackFileName: fileName || "input.iso",
      outputName,
      pathPrefix: RVZ_ROM_SPECIFIC_FORMAT.pathPrefix.create,
      run: async (workerSource) => {
        const outputFileName = outputName || "output.rvz";
        const outputPath = selectRomWeaverOutputPath(workerSource.filePath, outputFileName, [workerSource.filePath]);
        await removeBrowserVfsOutputPaths([outputPath], [workerSource.filePath]);
        const codecs = withCodecLevel(codec || COMPRESSION_DEFAULTS.rvzCodec, compressionLevel);
        const result = await invokeRomWeaverCompressionCreateWorker(
          {
            codecs,
            format: "rvz",
            inputPaths: [workerSource.filePath],
            invalidateMountCacheBeforeRun: true,
            knownInputPaths: [workerSource.filePath],
            logLevel,
            outputFileName,
            outputPath,
            preopenOutputPaths: [outputPath],
            signal,
            workerThreads: threads,
          },
          onProgress,
          onLog,
        );
        return outputName ? { ...result, fileName: outputName } : result;
      },
      scope: RVZ_ROM_SPECIFIC_FORMAT.scope,
      source,
      trace: { logLevel, onLog },
    }),
  createZ3ds: async ({
    source,
    fileName,
    outputName,
    threads,
    compressionLevel,
    logLevel,
    onLog,
    onProgress,
    signal,
  }) =>
    workerIo.runPathWorkerToOutput({
      failureMessage: "Z3DS compression worker did not return browser output",
      fallbackFileName: fileName || "input.3ds",
      outputName,
      pathPrefix: Z3DS_ROM_SPECIFIC_FORMAT.pathPrefix.create,
      run: async (workerSource) => {
        const outputFileName = outputName || "output.z3ds";
        const outputPath = selectRomWeaverOutputPath(workerSource.filePath, outputFileName, [workerSource.filePath]);
        await removeBrowserVfsOutputPaths([outputPath], [workerSource.filePath]);
        const codecs = withCodecLevel(COMPRESSION_DEFAULTS.z3dsCodec, compressionLevel);
        const result = await invokeRomWeaverCompressionCreateWorker(
          {
            codecs,
            format: "z3ds",
            inputPaths: [workerSource.filePath],
            invalidateMountCacheBeforeRun: true,
            knownInputPaths: [workerSource.filePath],
            logLevel,
            outputFileName,
            outputPath,
            preopenOutputPaths: [outputPath],
            signal,
            workerThreads: threads,
          },
          onProgress,
          onLog,
        );
        return outputName ? { ...result, fileName: outputName } : result;
      },
      scope: Z3DS_ROM_SPECIFIC_FORMAT.scope,
      source,
      trace: { logLevel, onLog },
    }),
  extractRvz: async ({ source, fileName, outputName, threads, logLevel, onLog, onProgress, signal }) => {
    const stageRvzSource = () =>
      workerIo.stageSource({
        fallbackFileName: fileName,
        pathPrefix: RVZ_ROM_SPECIFIC_FORMAT.pathPrefix.extract,
        scope: RVZ_ROM_SPECIFIC_FORMAT.scope,
        source,
        trace: { logLevel, onLog },
      });
    let workerSource = await stageRvzSource();
    const ensureRvzSourceExists = async () => {
      if (workerSource.virtual) return;
      if (await waitForBrowserVfsPath(workerSource.filePath)) return;
      await workerSource.cleanup().catch(() => undefined);
      workerSource = await stageRvzSource();
      if (workerSource.virtual) return;
      if (await waitForBrowserVfsPath(workerSource.filePath)) return;
      throw new Error(`Browser VFS staged input is not available: ${workerSource.filePath}`);
    };
    try {
      const outDirPath = WORKER_OPFS_MOUNTPOINT;
      const sourceFileName = fileName || workerSource.fileName || RVZ_ROM_SPECIFIC_FORMAT.fallbackFileName;
      const stagedSourceFileName = getPathDerivedFileName(workerSource.filePath, sourceFileName);
      const actualOutputFileName = getRomSpecificExtractedFileName("rvz", { fileName: sourceFileName });
      const stagedOutputFileName = getRomSpecificExtractedFileName("rvz", {
        fileName: stagedSourceFileName,
      });
      await ensureRvzSourceExists();
      const listed = await runRomWeaverListWorker(
        {
          logLevel,
          signal,
          sourcePath: workerSource.filePath,
        },
        undefined,
        onLog,
      ).catch(() => null);
      const listedEntries = normalizeRomSpecificListEntries(
        listed?.entries || [],
        stagedSourceFileName,
        sourceFileName,
      );
      const listedOutputFileName = getPathBaseName(
        String(listedEntries[0]?.fileName || listedEntries[0]?.filename || listedEntries[0]?.name || ""),
      );
      const outputFileName = outputName || listedOutputFileName || actualOutputFileName;
      const outputPath = joinPath(outDirPath, listedOutputFileName || stagedOutputFileName || actualOutputFileName);
      const preopenOutputPaths = filterOutputCandidatesAwayFromSource(
        uniqueNonEmptyStrings([
          ...listedEntries.flatMap((entry) =>
            getBrowserExtractOutputPathCandidates(
              outDirPath,
              String(entry?.fileName || entry?.filename || entry?.name || ""),
            ),
          ),
          ...(outputName ? getBrowserExtractOutputPathCandidates(outDirPath, outputName) : []),
          ...(stagedOutputFileName ? getBrowserExtractOutputPathCandidates(outDirPath, stagedOutputFileName) : []),
          ...(actualOutputFileName ? getBrowserExtractOutputPathCandidates(outDirPath, actualOutputFileName) : []),
          outputPath,
        ]),
        workerSource.filePath,
      );
      await removeBrowserVfsOutputPaths(preopenOutputPaths, [workerSource.filePath]);
      if (outputPath === workerSource.filePath) {
        throw new Error(`RVZ output path conflicts with the active input: ${outputPath}`);
      }
      emitBrowserWorkflowTrace({ logLevel, onLog }, "rvz output precreated", {
        candidates: preopenOutputPaths,
        outputPath,
        sourcePath: workerSource.filePath,
      });
      const extracted = await invokeRomWeaverExtractWorker(
        {
          checksumAlgorithms: [...EXTRACT_CHECKSUM_ALGORITHMS],
          knownInputPaths: [workerSource.filePath],
          logLevel,
          outDirPath,
          preopenOutputPaths,
          scratchFilePoolSize: 1,
          select: [],
          signal,
          sourcePath: workerSource.filePath,
          workerThreads: threads,
        },
        onProgress,
        onLog,
      ).catch((error) => {
        const message = String(error instanceof Error ? error.message : error || "");
        if (/createWritable|not writable/i.test(message)) {
          throw new Error(
            `RVZ OPFS extraction is not writable for ${workerSource.filePath}; failing fast (${message})`,
          );
        }
        throw error;
      });
      const primaryFile = await selectPreferredExtractedFile({
        emittedFiles: extracted.emittedFiles,
        logLevel,
        onLog,
        preferredEntryNames: [
          outputFileName,
          actualOutputFileName,
          stagedOutputFileName,
          listedOutputFileName,
          outputName,
        ],
        traceLabel: "rvz",
      });
      return await workerIo.createWorkerOutput(
        {
          checksums: primaryFile?.checksums,
          fileName: outputFileName,
          filePath: primaryFile?.path || outputPath,
          romType: romTypeFromEmittedFile(primaryFile ?? undefined),
          size: primaryFile?.sizeBytes,
        },
        outputFileName,
        "RVZ extraction worker did not return browser output",
      );
    } finally {
      await workerSource.cleanup().catch(() => undefined);
    }
  },
  extractZ3ds: async ({ source, fileName, outputName, threads, logLevel, onLog, onProgress, signal }) => {
    const workerSource = await workerIo.stageSource({
      fallbackFileName: fileName,
      pathPrefix: Z3DS_ROM_SPECIFIC_FORMAT.pathPrefix.extract,
      scope: Z3DS_ROM_SPECIFIC_FORMAT.scope,
      source,
      trace: { logLevel, onLog },
    });
    try {
      const outDirPath = getPathDirectory(workerSource.filePath);
      const sourceFileName = fileName || workerSource.fileName || Z3DS_ROM_SPECIFIC_FORMAT.fallbackFileName;
      const displaySourceFileName = sourceFileName;
      const actualOutputFileName = getRomSpecificExtractedFileName("z3ds", { fileName: sourceFileName });
      const stagedSourceFileName = getPathDerivedFileName(workerSource.filePath, sourceFileName);
      const stagedOutputFileName = getRomSpecificExtractedFileName("z3ds", {
        fileName: stagedSourceFileName,
      });
      const listed = await runRomWeaverListWorker(
        {
          logLevel,
          signal,
          sourcePath: workerSource.filePath,
        },
        undefined,
        onLog,
      ).catch(() => null);
      const listedEntries = normalizeZ3dsListEntriesForSource(
        normalizeRomSpecificListEntries(listed?.entries || [], stagedSourceFileName, sourceFileName),
        sourceFileName,
      );
      const preseedPaths =
        listedEntries
          .flatMap((entry) =>
            getBrowserExtractOutputPathCandidates(
              outDirPath,
              String(entry?.fileName || entry?.filename || entry?.name || ""),
            ),
          )
          .filter((entry) => !!entry) || [];
      const listedOutputFileName = getPathBaseName(
        String(listedEntries[0]?.fileName || listedEntries[0]?.filename || listedEntries[0]?.name || ""),
      );
      // Prefer the container handler's authoritative extracted entry name (it maps the source
      // extension, e.g. `.zcci` -> `.cci`) so the saved/displayed name matches the file actually
      // written, instead of the request-filename guess that falls back to `.3ds`.
      const outputFileName = outputName || listedOutputFileName || actualOutputFileName;
      const outputPath = joinPath(outDirPath, listedOutputFileName || stagedOutputFileName || actualOutputFileName);
      if (outputName) preseedPaths.push(...getBrowserExtractOutputPathCandidates(outDirPath, outputName));
      if (stagedOutputFileName)
        preseedPaths.push(...getBrowserExtractOutputPathCandidates(outDirPath, stagedOutputFileName));
      preseedPaths.push(outputPath);
      preseedPaths.push(joinPath(outDirPath, actualOutputFileName));
      const preopenOutputPaths = filterOutputCandidatesAwayFromSource(
        uniqueNonEmptyStrings(preseedPaths),
        workerSource.filePath,
      );
      await removeBrowserVfsOutputPaths(preopenOutputPaths, [workerSource.filePath]);
      const extracted = await invokeRomWeaverExtractWorker(
        {
          checksumAlgorithms: [...EXTRACT_CHECKSUM_ALGORITHMS],
          knownInputPaths: [workerSource.filePath],
          logLevel,
          outDirPath,
          preopenOutputPaths,
          scratchFilePoolSize: 1,
          select: [],
          signal,
          sourcePath: workerSource.filePath,
          workerThreads: threads,
        },
        onProgress
          ? (progress) => onProgress(replaceProgressSourceLabel(progress, workerSource.filePath, displaySourceFileName))
          : undefined,
        onLog,
      );
      const primaryFile = await selectPreferredExtractedFile({
        emittedFiles: extracted.emittedFiles,
        logLevel,
        onLog,
        preferredEntryNames: [
          outputFileName,
          actualOutputFileName,
          stagedOutputFileName,
          listedOutputFileName,
          outputName,
        ],
        traceLabel: "z3ds",
      });
      return await workerIo.createWorkerOutput(
        {
          checksums: primaryFile?.checksums,
          fileName: outputFileName,
          filePath: primaryFile?.path || outputPath,
          romType: romTypeFromEmittedFile(primaryFile ?? undefined),
          size: primaryFile?.sizeBytes,
        },
        outputFileName,
        "Z3DS extraction worker did not return browser output",
      );
    } finally {
      await workerSource.cleanup().catch(() => undefined);
    }
  },
  listRvz: async ({ fileName }) => ({
    entries: [
      {
        fileName: getRomSpecificExtractedFileName("rvz", { fileName }),
        filename: getRomSpecificExtractedFileName("rvz", { fileName }),
        name: getPathBaseName(
          getRomSpecificExtractedFileName("rvz", { fileName }),
          getRomSpecificExtractedFileName("rvz", { fileName }),
        ),
      },
    ],
  }),
  listZ3ds: async ({ source, fileName, logLevel, onLog, onProgress, signal }) => {
    const workerSource = await workerIo.stageSource({
      fallbackFileName: fileName,
      pathPrefix: Z3DS_ROM_SPECIFIC_FORMAT.pathPrefix.extract,
      scope: Z3DS_ROM_SPECIFIC_FORMAT.scope,
      source,
      trace: { logLevel, onLog },
    });
    try {
      const result = await runRomWeaverListWorker(
        {
          logLevel,
          signal,
          sourcePath: workerSource.filePath,
        },
        onProgress,
        onLog,
      );
      const sourceFileName = fileName || workerSource.fileName || Z3DS_ROM_SPECIFIC_FORMAT.fallbackFileName;
      const stagedSourceFileName = getPathDerivedFileName(workerSource.filePath, sourceFileName);
      return {
        entries: normalizeZ3dsListEntriesForSource(
          normalizeRomSpecificListEntries(result.entries, stagedSourceFileName, sourceFileName),
          sourceFileName,
        ),
      };
    } finally {
      await workerSource.cleanup().catch(() => undefined);
    }
  },
});

export { createBrowserDiscFormatsRuntime };
