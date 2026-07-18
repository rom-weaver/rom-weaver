import { COMPRESSION_DEFAULTS } from "../../lib/compression/compression-metadata.ts";
import {
  getRomSpecificExtractedFileName,
  ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRY,
} from "../../lib/compression/container-format-registry.ts";
import { getPathBaseName } from "../../lib/path-utils.ts";
import { createRomWeaverOutputScope } from "../../lib/runtime/run-output-paths.ts";
import { romTypeFromEmittedFile } from "../../lib/runtime/run-result-parsing.ts";
import {
  invokeRomWeaverCompressionCreateWorker,
  invokeRomWeaverIngestWorker,
} from "../../lib/runtime/wasm-command-runtime.ts";
import type { RomSpecificRuntimeAdapter } from "../../lib/runtime/workflow-runtime-core.ts";
import type { RuntimeWorkerIo } from "../../types/workflow-runtime-adapter.ts";
import {
  EXTRACT_CHECKSUM_ALGORITHMS,
  getPathDerivedFileName,
  joinPath,
  normalizeRomSpecificEntryNameForSource,
  replaceProgressSourceLabel,
  withCodecLevel,
} from "./workflow-runtime-helpers.ts";
import { browserVfs, selectPreferredExtractedFile, waitForBrowserVfsPath } from "./workflow-runtime-vfs-cleanup.ts";

const RVZ_ROM_SPECIFIC_FORMAT = ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRY.rvz;
const Z3DS_ROM_SPECIFIC_FORMAT = ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRY.z3ds;

const createBrowserDiscFormatsRuntime = (
  workerIo: RuntimeWorkerIo,
): Pick<RomSpecificRuntimeAdapter, "createRvz" | "createZ3ds" | "extractRvz" | "extractZ3ds"> => ({
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
            signal,
            threads,
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
            signal,
            threads,
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
    const outputScope = createRomWeaverOutputScope();
    let outputScopeAdopted = false;
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
      const outDirPath = outputScope.rootPath;
      const sourceFileName = fileName || workerSource.fileName || RVZ_ROM_SPECIFIC_FORMAT.fallbackFileName;
      const stagedSourceFileName = getPathDerivedFileName(workerSource.filePath, sourceFileName);
      const actualOutputFileName = getRomSpecificExtractedFileName("rvz", { fileName: sourceFileName });
      const stagedOutputFileName = getRomSpecificExtractedFileName("rvz", {
        fileName: stagedSourceFileName,
      });
      await ensureRvzSourceExists();
      const extracted = await invokeRomWeaverIngestWorker(
        {
          checksumAlgorithms: [...EXTRACT_CHECKSUM_ALGORITHMS],
          knownInputPaths: [workerSource.filePath],
          logLevel,
          outDirPath,
          select: [],
          signal,
          sourcePath: workerSource.filePath,
          threads,
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
        emittedFiles: extracted.assets,
        logLevel,
        onLog,
        preferredEntryNames: [outputName, actualOutputFileName, stagedOutputFileName],
        traceLabel: "rvz",
      });
      // Name the output from the file the container handler actually emitted (rebased onto the logical
      // source name), so the saved name matches the bytes written. The Rust extract truncates its own
      // output, so no pre-clear/preopen is needed.
      const emittedOutputFileName = primaryFile
        ? normalizeRomSpecificEntryNameForSource(
            getPathBaseName(String(primaryFile.fileName || primaryFile.path || "")),
            stagedSourceFileName,
            sourceFileName,
          )
        : "";
      const outputFileName = outputName || emittedOutputFileName || actualOutputFileName;
      const outputFilePath = primaryFile?.path || joinPath(outDirPath, outputFileName);
      const [cleanup] = await outputScope.createOutputCleanups([outputFilePath], (filePath) =>
        browserVfs.remove(filePath),
      );
      const output = await workerIo.createWorkerOutput(
        {
          checksums: primaryFile?.checksums,
          cleanup,
          fileName: outputFileName,
          filePath: outputFilePath,
          romType: romTypeFromEmittedFile(primaryFile ?? undefined),
          size: primaryFile?.sizeBytes,
        },
        outputFileName,
        "RVZ extraction worker did not return browser output",
      );
      outputScopeAdopted = true;
      return output;
    } finally {
      if (!outputScopeAdopted) await outputScope.cleanup().catch(() => undefined);
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
    const outputScope = createRomWeaverOutputScope();
    let outputScopeAdopted = false;
    try {
      const outDirPath = outputScope.rootPath;
      const sourceFileName = fileName || workerSource.fileName || Z3DS_ROM_SPECIFIC_FORMAT.fallbackFileName;
      const displaySourceFileName = sourceFileName;
      const actualOutputFileName = getRomSpecificExtractedFileName("z3ds", { fileName: sourceFileName });
      const stagedSourceFileName = getPathDerivedFileName(workerSource.filePath, sourceFileName);
      const stagedOutputFileName = getRomSpecificExtractedFileName("z3ds", {
        fileName: stagedSourceFileName,
      });
      const extracted = await invokeRomWeaverIngestWorker(
        {
          checksumAlgorithms: [...EXTRACT_CHECKSUM_ALGORITHMS],
          knownInputPaths: [workerSource.filePath],
          logLevel,
          outDirPath,
          select: [],
          signal,
          sourcePath: workerSource.filePath,
          threads,
        },
        onProgress
          ? (progress) => onProgress(replaceProgressSourceLabel(progress, workerSource.filePath, displaySourceFileName))
          : undefined,
        onLog,
      );
      const primaryFile = await selectPreferredExtractedFile({
        emittedFiles: extracted.assets,
        logLevel,
        onLog,
        preferredEntryNames: [outputName, actualOutputFileName, stagedOutputFileName],
        traceLabel: "z3ds",
      });
      // Name the output from the file the handler actually emitted (rebased onto the logical source
      // name). The emitted name already carries the authoritative extension (e.g. `.zcci` -> `.cci`),
      // and the Rust extract truncates its own output, so no pre-clear/preopen is needed.
      const emittedOutputFileName = primaryFile
        ? normalizeRomSpecificEntryNameForSource(
            getPathBaseName(String(primaryFile.fileName || primaryFile.path || "")),
            stagedSourceFileName,
            sourceFileName,
          )
        : "";
      const outputFileName = outputName || emittedOutputFileName || actualOutputFileName;
      const outputFilePath = primaryFile?.path || joinPath(outDirPath, outputFileName);
      const [cleanup] = await outputScope.createOutputCleanups([outputFilePath], (filePath) =>
        browserVfs.remove(filePath),
      );
      const output = await workerIo.createWorkerOutput(
        {
          checksums: primaryFile?.checksums,
          cleanup,
          fileName: outputFileName,
          filePath: outputFilePath,
          romType: romTypeFromEmittedFile(primaryFile ?? undefined),
          size: primaryFile?.sizeBytes,
        },
        outputFileName,
        "Z3DS extraction worker did not return browser output",
      );
      outputScopeAdopted = true;
      return output;
    } finally {
      if (!outputScopeAdopted) await outputScope.cleanup().catch(() => undefined);
      await workerSource.cleanup().catch(() => undefined);
    }
  },
});

export { createBrowserDiscFormatsRuntime };
