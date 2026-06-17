import { isRomSpecificCompressionFormat } from "../../lib/compression/container-format-registry.ts";
import { getPathBaseName } from "../../lib/path-utils.ts";
import { romTypeFromEmittedFile } from "../../lib/runtime/run-result-parsing.ts";
import {
  invokeRomWeaverCompressionCreateWorker,
  invokeRomWeaverExtractWorker,
  runRomWeaverListWorker,
  selectRomWeaverOutputPath,
} from "../../lib/runtime/wasm-command-runtime.ts";
import {
  createCompressionExtractResult,
  normalizeCompressionWorkerEntries,
} from "../../lib/runtime/workflow-runtime-worker-helpers.ts";
import {
  ensureBrowserStorageAvailableForOutput,
  withBrowserOutputStorageFailureContext,
} from "../../storage/browser/browser-output-storage-guard.ts";
import type {
  RuntimeArchiveCreateInput,
  RuntimeWorkerIo,
  WorkflowRuntime,
  WorkflowRuntimeLog,
} from "../../types/workflow-runtime-adapter.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../workers/shared/worker-storage/storage-layout.ts";
import { forwardArchiveProgress } from "../shared/workflow-runtime-progress.ts";
import { stripPrimaryChdTrackSuffix } from "./workflow-runtime-chd.ts";
import {
  EXTRACT_CHECKSUM_ALGORITHMS,
  emitBrowserWorkflowTrace,
  findExtractedFile,
  getListedOutputEntryName,
  getPathDerivedFileName,
  isCueEntryName,
  normalizeRomSpecificEntryNameForSource,
  normalizeRomSpecificListEntries,
  toLevelProfile,
  uniqueNonEmptyStrings,
  withCodecLevel,
} from "./workflow-runtime-helpers.ts";
import {
  browserVfs,
  filterOutputCandidatesAwayFromSource,
  getBrowserExtractOutputPathCandidates,
  removeBrowserVfsOutputPaths,
  sumBrowserVfsPathBytes,
} from "./workflow-runtime-vfs-cleanup.ts";

const ZIP_LIKE_EXTENSION_REGEX = /\.(zip|jar|apk|cbz|epub|xpi)$/i;

const toFileBlobPart = (source: ArrayBufferLike | Uint8Array): BlobPart => {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const toZipAliasFileName = (value: string): string | null => {
  const normalized = String(value || "").trim();
  if (!(normalized && ZIP_LIKE_EXTENSION_REGEX.test(normalized)) || /\.zip$/i.test(normalized)) return null;
  return normalized.replace(/\.[^./\\]+$/, ".zip");
};

const resolveArchiveSourceFileName = (source: unknown): string => {
  if (typeof File !== "undefined" && source instanceof File) return source.name || "";
  if (!source || typeof source !== "object") return "";
  const record = source as Record<string, unknown>;
  if (typeof record.fileName === "string" && record.fileName.trim()) return record.fileName.trim();
  if (typeof record.name === "string" && record.name.trim()) return record.name.trim();
  if (typeof File !== "undefined" && record.source instanceof File) return record.source.name || "";
  return "";
};

const normalizeZipLikeArchiveSource = (source: unknown): unknown => {
  const fileName = resolveArchiveSourceFileName(source);
  const aliasFileName = toZipAliasFileName(fileName);
  if (!aliasFileName) return source;
  if (typeof File !== "undefined" && source instanceof File) {
    return new File([source], aliasFileName, {
      lastModified: source.lastModified,
      type: source.type || "application/zip",
    });
  }
  if (!source || typeof source !== "object") return source;
  return {
    ...(source as Record<string, unknown>),
    fileName: aliasFileName,
    name: aliasFileName,
  };
};

const stageCompressionEntryForRomWeaver = async (
  workerIo: RuntimeWorkerIo,
  entry: ReturnType<typeof normalizeCompressionWorkerEntries>[number],
  fileName: string,
  index: number,
): Promise<{ cleanup: () => Promise<void>; filePath: string }> => {
  const source = createArchiveEntrySource(entry, fileName);
  if (!source) throw new Error(`Archive entry data was not provided: ${fileName}`);
  const staged = await workerIo.stageSource({
    fallbackFileName: fileName,
    pathPrefix: `archive-entry-${index + 1}`,
    scope: "archive",
    source,
  });

  return {
    cleanup: async () => {
      await staged.cleanup().catch(() => undefined);
    },
    filePath: staged.filePath,
  };
};

const createArchiveEntrySource = (
  entry: ReturnType<typeof normalizeCompressionWorkerEntries>[number],
  fileName: string,
): Blob | File | string | Uint8Array | ArrayBufferLike | null => {
  if (entry.filePath) return entry.filePath;
  if (entry.file) return entry.file;
  if (entry.text !== undefined) {
    if (typeof File !== "undefined") return new File([String(entry.text)], fileName, { type: "text/plain" });
    return new Blob([String(entry.text)], { type: "text/plain" });
  }
  if (entry.u8array) {
    if (typeof File !== "undefined")
      return new File([toFileBlobPart(entry.u8array)], fileName, {
        type: "application/octet-stream",
      });
    return new Blob([toFileBlobPart(entry.u8array)], {
      type: "application/octet-stream",
    });
  }
  if (entry.arrayBuffer) {
    if (typeof File !== "undefined")
      return new File([toFileBlobPart(entry.arrayBuffer)], fileName, {
        type: "application/octet-stream",
      });
    return new Blob([toFileBlobPart(entry.arrayBuffer)], {
      type: "application/octet-stream",
    });
  }
  return null;
};

const getDescendOutputPlan = async ({
  archivePath,
  fileName,
  format,
  logLevel,
  onLog,
  outDirPath,
  signal,
}: {
  archivePath: string;
  fileName: string;
  format?: string;
  logLevel?: unknown;
  onLog?: (log: WorkflowRuntimeLog) => void;
  outDirPath: string;
  signal?: AbortSignal;
}): Promise<{ chdSplitBinEligible: boolean; preopenOutputPaths: string[] }> => {
  const normalizedFormat = String(format || "")
    .trim()
    .toLowerCase();
  if (!isRomSpecificCompressionFormat(normalizedFormat)) {
    return { chdSplitBinEligible: false, preopenOutputPaths: [] };
  }
  const listed = await runRomWeaverListWorker(
    {
      logLevel: logLevel as Parameters<typeof runRomWeaverListWorker>[0]["logLevel"],
      signal,
      sourcePath: archivePath,
    },
    undefined,
    onLog,
  ).catch(() => null);
  const sourceFileName = fileName || getPathBaseName(archivePath, "archive.bin");
  const stagedSourceFileName = getPathDerivedFileName(archivePath, sourceFileName);
  const listedEntries = normalizeRomSpecificListEntries(listed?.entries || [], stagedSourceFileName, sourceFileName);
  const chdSplitBinEligible = normalizedFormat === "chd" && listed?.chdMediaKind === "cd";
  const preopenOutputPaths = filterOutputCandidatesAwayFromSource(
    uniqueNonEmptyStrings(
      listedEntries.flatMap((entry) =>
        getBrowserExtractOutputPathCandidates(outDirPath, getListedOutputEntryName(entry)),
      ),
    ),
    archivePath,
  );
  emitBrowserWorkflowTrace({ logLevel, onLog }, "archive descend output preopen candidates", {
    archivePath,
    chdSplitBinEligible,
    format: normalizedFormat,
    preopenOutputPaths,
  });
  return { chdSplitBinEligible, preopenOutputPaths };
};

const stageBrowserCompressionEntries = async (
  entries: RuntimeArchiveCreateInput["entries"],
  workerIo: RuntimeWorkerIo,
) => {
  const normalizedEntries = normalizeCompressionWorkerEntries(entries);
  const stagedEntries: Array<{
    cleanup: () => Promise<void>;
    filePath: string;
  }> = [];
  try {
    const inputPaths: string[] = [];
    for (let index = 0; index < normalizedEntries.length; index++) {
      const entry = normalizedEntries[index];
      if (!entry) continue;
      const fileName = entry.fileName || entry.filename || entry.name || `entry-${index + 1}.bin`;
      const stagedEntry = await stageCompressionEntryForRomWeaver(workerIo, entry, fileName, index);
      stagedEntries.push(stagedEntry);
      inputPaths.push(stagedEntry.filePath);
    }

    return {
      cleanup: async () => {
        await Promise.all(stagedEntries.map((entry) => entry.cleanup().catch(() => undefined)));
      },
      inputPaths,
      stagedEntries,
    };
  } catch (error) {
    await Promise.all(stagedEntries.map((entry) => entry.cleanup().catch(() => undefined)));
    throw error;
  }
};

const createBrowserArchiveRuntime = (workerIo: RuntimeWorkerIo): Partial<WorkflowRuntime["compression"]> => ({
  create: async (workflowInput) => {
    if (!("entries" in workflowInput)) throw new Error("archive runtime received non-archive create input");
    const trace = { logLevel: workflowInput.options?.logLevel, onLog: workflowInput.options?.onLog };
    const staged = await stageBrowserCompressionEntries(workflowInput.entries, workerIo);
    try {
      const format = workflowInput.format || workflowInput.options?.compression || "7z";
      const codec = format === "zip" ? workflowInput.options?.zipCodec : workflowInput.options?.sevenZipCodec;
      const level = format === "zip" ? workflowInput.options?.zipLevel : workflowInput.options?.sevenZipLevel;
      const levelProfile = toLevelProfile(level);
      const codecEntries = withCodecLevel(codec, level);
      const inputTotalBytes = await sumBrowserVfsPathBytes(staged.inputPaths);
      const fallbackOutputPathSource = staged.stagedEntries[0]?.filePath || `${WORKER_OPFS_MOUNTPOINT}/archive.bin`;
      const outputFileName = workflowInput.options?.outputName || (format === "zip" ? "archive.zip" : "archive.7z");
      const outputPath = selectRomWeaverOutputPath(fallbackOutputPathSource, outputFileName, staged.inputPaths);
      emitBrowserWorkflowTrace(trace, "archive create names resolved", {
        codec,
        entryFileNames: normalizeCompressionWorkerEntries(workflowInput.entries).map(
          (entry) => entry.fileName || entry.filename || entry.name || "",
        ),
        format,
        inputPaths: staged.inputPaths,
        inputTotalBytes,
        outputFileName,
        outputPath,
      });
      await removeBrowserVfsOutputPaths([outputPath], staged.inputPaths);
      return {
        output: await workerIo.createWorkerOutput(
          await invokeRomWeaverCompressionCreateWorker(
            {
              codecs: codecEntries,
              format,
              inputPaths: staged.inputPaths,
              invalidateMountCacheBeforeRun: true,
              knownInputPaths: staged.inputPaths,
              levelProfile,
              logLevel: workflowInput.options?.logLevel,
              outputFileName,
              outputPath,
              preopenOutputPaths: [outputPath],
              signal: workflowInput.options?.signal,
              totalBytes: inputTotalBytes,
              workerThreads: workflowInput.options?.workerThreads,
            },
            forwardArchiveProgress("output", workflowInput.options?.onProgress),
            workflowInput.options?.onLog,
          ),
          outputFileName,
          "archive create worker did not return browser output",
        ),
      };
    } finally {
      await staged.cleanup().catch(() => undefined);
    }
  },
  extract: async (workflowInput) => {
    const archive = await workerIo.stageSource({
      fallbackFileName: "archive.bin",
      pathPrefix: "archive-input",
      scope: "archive",
      source: normalizeZipLikeArchiveSource(workflowInput.source),
      trace: { logLevel: workflowInput.options?.logLevel, onLog: workflowInput.options?.onLog },
    });
    try {
      if (workflowInput.descendSinglePayload) {
        const outDirPath = WORKER_OPFS_MOUNTPOINT;
        const selectedEntries = Array.isArray(workflowInput.entries)
          ? workflowInput.entries.map((entryName) => String(entryName || "").trim()).filter((entryName) => !!entryName)
          : [];
        const cleanupExtractedFiles = async (filePaths: string[]) => {
          await Promise.all(filePaths.map((filePath) => browserVfs.remove(filePath).catch(() => undefined)));
        };
        const outputPlan = await getDescendOutputPlan({
          archivePath: archive.filePath,
          fileName: archive.fileName,
          format: workflowInput.format,
          logLevel: workflowInput.options?.logLevel,
          onLog: workflowInput.options?.onLog,
          outDirPath,
          signal: workflowInput.options?.signal,
        });
        await removeBrowserVfsOutputPaths(outputPlan.preopenOutputPaths, [archive.filePath]);
        const extractChecksumAlgorithms = Array.isArray(workflowInput.options?.extractChecksumAlgorithms)
          ? workflowInput.options.extractChecksumAlgorithms
              .map((algorithm) =>
                String(algorithm || "")
                  .trim()
                  .toLowerCase(),
              )
              .filter((algorithm) => !!algorithm)
          : [...EXTRACT_CHECKSUM_ALGORITHMS];
        const extracted = await invokeRomWeaverExtractWorker(
          {
            // ROM/general extraction hashes only ROM-like outputs (safe to always run, skips
            // sidecars); patch extraction keeps full per-output checksums.
            ...(extractChecksumAlgorithms.length
              ? workflowInput.options?.patchFilter
                ? { checksumAlgorithms: extractChecksumAlgorithms }
                : { checksumRomAlgorithms: extractChecksumAlgorithms }
              : {}),
            ...(typeof workflowInput.options?.interactiveSelectionEnabled === "boolean"
              ? { interactiveSelectionEnabled: workflowInput.options.interactiveSelectionEnabled }
              : {}),
            knownInputPaths: [archive.filePath],
            logLevel: workflowInput.options?.logLevel,
            noNestedExtract: false,
            outDirPath,
            patchFilter: workflowInput.options?.patchFilter,
            preopenOutputPaths: outputPlan.preopenOutputPaths,
            romFilter: workflowInput.options?.romFilter,
            select: selectedEntries,
            signal: workflowInput.options?.signal,
            sourcePath: archive.filePath,
            splitBin: outputPlan.chdSplitBinEligible && workflowInput.options?.chdSplitBin === true,
            workerThreads: workflowInput.options?.workerThreads,
          },
          forwardArchiveProgress("input", workflowInput.options?.onProgress, `Extracting ${archive.fileName}...`),
          workflowInput.options?.onLog,
        );
        const normalizedFormat = String(workflowInput.format || "")
          .trim()
          .toLowerCase();
        const sourceFileName = archive.fileName || getPathBaseName(archive.filePath, "archive.bin");
        const stagedSourceFileName = getPathDerivedFileName(archive.filePath, sourceFileName);
        const primaryDataEntry = extracted.emittedFiles.find((entry) => {
          const entryKind = String(entry.kind || "").toLowerCase();
          const entryName = entry.fileName || getPathBaseName(entry.path, entry.path);
          return entryKind !== "cue" && !isCueEntryName(entryName);
        });
        const descendOutputs = await Promise.all(
          extracted.emittedFiles.map((entry) => {
            const extractedFileName = entry.fileName || getPathBaseName(entry.path, entry.path);
            const normalizedFileName = isRomSpecificCompressionFormat(normalizedFormat)
              ? normalizeRomSpecificEntryNameForSource(extractedFileName, stagedSourceFileName, sourceFileName)
              : extractedFileName;
            const fileName =
              outputPlan.chdSplitBinEligible && entry === primaryDataEntry
                ? stripPrimaryChdTrackSuffix(normalizedFileName)
                : normalizedFileName;
            return workerIo.createWorkerOutput(
              {
                checksums: entry.checksums,
                checksumVariants: entry.checksumVariants,
                cleanup: () => cleanupExtractedFiles([entry.path]),
                fileName,
                filePath: entry.path,
                romType: romTypeFromEmittedFile(entry),
                size: entry.sizeBytes,
                // Per-file extract time (the step that produced this leaf); falls back to the whole
                // extract's elapsed time when the runtime did not report a per-file value.
                timing: typeof entry.extractTimeMs === "number" ? { elapsedMs: entry.extractTimeMs } : extracted.timing,
              },
              fileName,
              "archive descend extract worker did not return browser output",
            );
          }),
        );
        return createCompressionExtractResult(descendOutputs);
      }
      const outputs = [];
      for (const entryName of workflowInput.entries) {
        const outDirPath = WORKER_OPFS_MOUNTPOINT;
        const cleanupExtractedFiles = async (filePaths: string[]) => {
          await Promise.all(filePaths.map((filePath) => browserVfs.remove(filePath).catch(() => undefined)));
        };
        const outputPathCandidates = filterOutputCandidatesAwayFromSource(
          getBrowserExtractOutputPathCandidates(outDirPath, entryName),
          archive.filePath,
        );
        if (!outputPathCandidates.length) {
          throw new Error(`Browser extract output path conflicts with the active input: ${entryName}`);
        }
        try {
          await removeBrowserVfsOutputPaths(outputPathCandidates, [archive.filePath]);
          const extractChecksumAlgorithms = Array.isArray(workflowInput.options?.extractChecksumAlgorithms)
            ? workflowInput.options.extractChecksumAlgorithms
                .map((algorithm) =>
                  String(algorithm || "")
                    .trim()
                    .toLowerCase(),
                )
                .filter((algorithm) => !!algorithm)
            : [...EXTRACT_CHECKSUM_ALGORITHMS];
          const runExtract = () =>
            invokeRomWeaverExtractWorker(
              {
                // ROM/general extraction hashes only ROM-like outputs (safe to always run, skips
                // sidecars); patch extraction keeps full per-output checksums.
                ...(extractChecksumAlgorithms.length
                  ? workflowInput.options?.patchFilter
                    ? { checksumAlgorithms: extractChecksumAlgorithms }
                    : { checksumRomAlgorithms: extractChecksumAlgorithms }
                  : {}),
                logLevel: workflowInput.options?.logLevel,
                outDirPath,
                patchFilter: workflowInput.options?.patchFilter,
                romFilter: workflowInput.options?.romFilter,
                select: [entryName],
                signal: workflowInput.options?.signal,
                sourcePath: archive.filePath,
                workerThreads: workflowInput.options?.workerThreads,
              },
              forwardArchiveProgress("input", workflowInput.options?.onProgress, `Extracting ${entryName}...`),
              workflowInput.options?.onLog,
            );
          const requiredBytes = null;
          const operationLabel = `extract \`${entryName}\``;
          await ensureBrowserStorageAvailableForOutput({
            operationLabel,
            requiredBytes,
          });
          const runExtractWithStorageContext = async () => {
            try {
              return await runExtract();
            } catch (error) {
              throw await withBrowserOutputStorageFailureContext(error, {
                operationLabel,
                requiredBytes,
              });
            }
          };
          const selectMatchedOutput = async (extracted: Awaited<ReturnType<typeof runExtract>>) => {
            let matched = findExtractedFile(extracted.emittedFiles, entryName);
            if (!matched) {
              for (const fallbackPath of outputPathCandidates) {
                const fallbackStat = await browserVfs.stat(fallbackPath);
                if (!fallbackStat) continue;
                matched = {
                  fileName: getPathBaseName(fallbackPath, entryName),
                  path: fallbackPath,
                  sizeBytes: fallbackStat.size,
                };
                break;
              }
            }
            if (matched) return matched;
            const emittedNames = extracted.emittedFiles.map(
              (entry) => entry.fileName || getPathBaseName(entry.path, entry.path),
            );
            throw new Error(
              `Archive entry was not extracted: ${entryName} (emitted: ${emittedNames.join(", ") || "none"})`,
            );
          };
          const createOutput = (matched: {
            checksums?: Record<string, string>;
            discFormat?: string;
            fileName: string;
            path: string;
            platform?: string;
            sizeBytes?: number;
          }) =>
            workerIo.createWorkerOutput(
              {
                checksums: matched.checksums,
                cleanup: () => cleanupExtractedFiles([matched.path]),
                fileName: entryName,
                filePath: matched.path,
                romType: romTypeFromEmittedFile(matched),
                size: matched.sizeBytes,
              },
              entryName,
              "archive extract worker did not return browser output",
            );

          const extracted = await runExtractWithStorageContext();
          const matched = await selectMatchedOutput(extracted);
          outputs.push(await createOutput(matched));
        } catch (error) {
          await cleanupExtractedFiles(outputPathCandidates).catch(() => undefined);
          throw error;
        }
      }
      return createCompressionExtractResult(outputs);
    } finally {
      await archive.cleanup().catch(() => undefined);
    }
  },
  list: async (workflowInput) => {
    const archive = await workerIo.stageSource({
      fallbackFileName: "archive.bin",
      pathPrefix: "archive-input",
      scope: "archive",
      source: normalizeZipLikeArchiveSource(workflowInput.source),
      trace: { logLevel: workflowInput.options?.logLevel, onLog: workflowInput.options?.onLog },
    });
    try {
      return await runRomWeaverListWorker(
        {
          logLevel: workflowInput.options?.logLevel,
          patchFilter: workflowInput.options?.patchFilter,
          romFilter: workflowInput.options?.romFilter,
          signal: workflowInput.options?.signal,
          sourcePath: archive.filePath,
        },
        forwardArchiveProgress("input", workflowInput.options?.onProgress, `Reading ${archive.fileName}...`),
        workflowInput.options?.onLog,
      );
    } finally {
      await archive.cleanup().catch(() => undefined);
    }
  },
});

export { createBrowserArchiveRuntime };
