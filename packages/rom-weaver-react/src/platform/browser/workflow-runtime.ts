import { getRvzExtractedFileName, replaceCuePatchFileName } from "../../lib/input/disc-file-utils.ts";
import {
  invokeRomWeaverCompressionCreateWorker,
  invokeRomWeaverCreatePatchWorker,
  invokeRomWeaverExtractWorker,
  invokeRomWeaverPatchApplyWorker,
  normalizeCodecEntries,
  runRomWeaverChecksumWorker,
  runRomWeaverInspectListWorker,
  selectRomWeaverOutputPath,
} from "../../lib/runtime/rom-weaver-runtime.ts";
import { assertBrowserBinarySource } from "../../lib/runtime/source-normalization.ts";
import {
  createRuntimePreload,
  createSharedCompressionRuntime,
  createSharedPatchRuntime,
  createWorkerChecksumRuntime,
  type DiscRuntimeAdapter,
} from "../../lib/runtime/workflow-runtime-core.ts";
import {
  attachDiscOutputMetadata,
  createCompressionExtractResult,
  normalizeCompressionWorkerEntries,
} from "../../lib/runtime/workflow-runtime-worker-helpers.ts";
import { createBrowserLargeFileVfs } from "../../storage/browser/browser-large-file-vfs.ts";
import { configureBrowserSourcePrimitives } from "../../storage/browser/browser-source-primitives.ts";
import {
  createRuntimeOutputFromBytes,
  createRuntimeOutputFromSource,
  getRuntimeOutputStorage,
  readRuntimeOutputBlob,
} from "../../storage/vfs/runtime-output.ts";
import type {
  RuntimeArchiveCreateInput,
  RuntimePublicOutputAdapter,
  RuntimeWorkerIo,
  WorkflowRuntime,
} from "../../types/workflow-runtime-adapter.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../workers/shared/worker-storage/storage-layout.ts";
import { forwardArchiveProgress, forwardDiscProgress } from "../shared/workflow-runtime-progress.ts";
import { triggerBrowserDownload } from "./browser-download.ts";
import { createBrowserRuntimeVfsIo } from "./browser-runtime-vfs.ts";

const FILE_CAPTURE_REGEX = /^(.+[/\\])?([^/\\]+)$/;
const FILE_EXTENSION_REGEX = /\.[^./\\\s]+$/;
const LEVEL_PROFILE_REGEX = /^(min|very-low|low|medium|high|very-high|max)$/i;
const ARCHIVE_STAGE_COPY_CHUNK_SIZE = 8 * 1024 * 1024;
const BROWSER_VFS_PATH_RETRY_ATTEMPTS = 6;
const ZIP_LIKE_EXTENSION_REGEX = /\.(zip|jar|apk|cbz|epub|xpi)$/i;

const toFileBlobPart = (source: ArrayBufferLike | Uint8Array): BlobPart => {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const getPathBaseName = (filePath: string, fallback = ""): string => {
  const parts = String(filePath || "")
    .split(/[/\\]+/)
    .filter((part) => !!part);
  if (!parts.length) return fallback;
  return parts[parts.length - 1] || fallback;
};

const getFileStem = (fileName: string) => String(fileName || "").replace(FILE_EXTENSION_REGEX, "");

const getPathDirectory = (filePath: string): string => {
  const match = String(filePath || "").match(FILE_CAPTURE_REGEX);
  return match?.[1] || "";
};

const joinPath = (directory: string, fileName: string): string => {
  const normalizedDirectory = String(directory || "").trim();
  if (!normalizedDirectory) return fileName;
  const separator = normalizedDirectory.includes("\\") && !normalizedDirectory.includes("/") ? "\\" : "/";
  if (normalizedDirectory.endsWith("/") || normalizedDirectory.endsWith("\\"))
    return `${normalizedDirectory}${fileName}`;
  return `${normalizedDirectory}${separator}${fileName}`;
};

const toNumericLevel = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
};

const toLevelProfile = (value: unknown): string | null => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  return LEVEL_PROFILE_REGEX.test(normalized) ? normalized : null;
};

const withCodecLevel = (codec: unknown, level: unknown): string[] => {
  const codecName = String(codec || "").trim();
  if (!codecName) return [];
  const numericLevel = toNumericLevel(level);
  if (numericLevel === null || codecName.includes(":")) return [codecName];
  return [`${codecName}:${numericLevel}`];
};

const normalizeEntryPath = (value: string) =>
  String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

const normalizeDiscListEntries = <TEntry extends { fileName?: string; filename?: string; name?: string }>(
  entries: TEntry[],
  stagedFileName: string,
  sourceFileName: string,
): TEntry[] => {
  const stagedBaseName = getPathBaseName(stagedFileName, stagedFileName);
  const sourceBaseName = getPathBaseName(sourceFileName, sourceFileName);
  const stagedStem = getFileStem(stagedBaseName);
  const sourceStem = getFileStem(sourceBaseName);
  if (!(stagedStem && sourceStem)) return entries;
  return entries.map((entry) => {
    const entryName = String(entry?.fileName || entry?.filename || entry?.name || "").trim();
    if (!entryName) return entry;
    const normalizedEntryName = normalizeEntryPath(entryName);
    const pathParts = normalizedEntryName.split("/");
    const leafName = pathParts.pop() || normalizedEntryName;
    let normalizedLeafName = leafName;
    if (leafName === stagedBaseName) normalizedLeafName = sourceBaseName;
    else if (leafName === stagedStem) normalizedLeafName = sourceStem;
    else if (leafName.startsWith(`${stagedStem}.`))
      normalizedLeafName = `${sourceStem}${leafName.slice(stagedStem.length)}`;
    else {
      const sourceStemWithExtension = `${sourceStem}.`;
      const sourceStemIndex = leafName.indexOf(sourceStemWithExtension);
      if (sourceStemIndex > 0) normalizedLeafName = leafName.slice(sourceStemIndex);
      else if (sourceStemIndex === -1) {
        const sourceStemSuffix = `-${sourceStem}`;
        const sourceStemSuffixIndex = leafName.lastIndexOf(sourceStemSuffix);
        if (sourceStemSuffixIndex > 0 && sourceStemSuffixIndex + sourceStemSuffix.length === leafName.length)
          normalizedLeafName = sourceStem;
      }
    }
    if (normalizedLeafName === leafName) return entry;
    const normalizedName = pathParts.length ? `${pathParts.join("/")}/${normalizedLeafName}` : normalizedLeafName;
    return {
      ...entry,
      fileName: normalizedName,
      filename: normalizedName,
      name: getPathBaseName(normalizedName, normalizedName),
    };
  });
};

const annotateChdListEntries = <
  TEntry extends {
    archiveEntryType?: string;
    fileName?: string;
    filename?: string;
    name?: string;
  },
>(
  entries: TEntry[],
): TEntry[] =>
  entries.map((entry) => {
    const currentType = String(entry.archiveEntryType || "")
      .trim()
      .toLowerCase();
    if (currentType === "cue" || currentType === "track") return entry;
    const entryName = String(entry.fileName || entry.filename || entry.name || "").trim();
    if (!entryName) return entry;
    const archiveEntryType = /\.cue$/i.test(getPathBaseName(entryName, entryName)) ? "cue" : "track";
    return {
      ...entry,
      archiveEntryType,
    };
  });

const findExtractedFile = (
  emittedFiles: Array<{
    fileName: string;
    kind?: string;
    path: string;
    sizeBytes?: number;
  }>,
  entryName: string,
) => {
  const normalizedEntry = normalizeEntryPath(entryName);
  const normalizedBase = getPathBaseName(normalizedEntry, normalizedEntry);
  for (const emitted of emittedFiles) {
    const emittedName = normalizeEntryPath(emitted.fileName);
    const emittedPath = normalizeEntryPath(emitted.path);
    const emittedPathBase = getPathBaseName(emittedPath, emittedPath);
    if (emittedName === normalizedEntry) return emitted;
    if (getPathBaseName(emittedName, emittedName) === normalizedBase) return emitted;
    if (emittedPathBase === normalizedBase) return emitted;
    if (normalizedEntry.endsWith(`/${emittedName}`)) return emitted;
    if (normalizedEntry.endsWith(`/${emittedPath}`)) return emitted;
  }
  return null;
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

const copyBrowserVfsPath = async (sourcePath: string, targetPath: string) => {
  const sourceStat = await browserVfs.stat(sourcePath);
  const sourceSize = Math.max(0, Math.floor(sourceStat?.size || 0));
  await browserVfs.truncate(targetPath, 0);
  if (sourceSize === 0) return;
  const buffer = new Uint8Array(ARCHIVE_STAGE_COPY_CHUNK_SIZE);
  let offset = 0;
  while (offset < sourceSize) {
    const nextLength = Math.min(buffer.byteLength, sourceSize - offset);
    const bytesRead = await browserVfs.read(sourcePath, buffer, {
      fileOffset: offset,
      length: nextLength,
    });
    if (!bytesRead) break;
    await browserVfs.write(targetPath, buffer.subarray(0, bytesRead), {
      fileOffset: offset,
    });
    offset += bytesRead;
  }
};

let archiveStageBatchId = 0;
let archiveExtractDirectoryId = 0;

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

  const batchDirectory = joinPath(
    getPathDirectory(staged.filePath) || `${WORKER_OPFS_MOUNTPOINT}/input/`,
    `.rom-weaver-entry-batch-${++archiveStageBatchId}`,
  );
  const canonicalPath = joinPath(batchDirectory, fileName);
  await copyBrowserVfsPath(staged.filePath, canonicalPath);
  const canonicalStat = await waitForBrowserVfsPath(canonicalPath);
  if (!canonicalStat) throw new Error(`Browser VFS staged input is not available: ${canonicalPath}`);

  return {
    cleanup: async () => {
      await staged.cleanup().catch(() => undefined);
      await browserVfs.remove(canonicalPath).catch(() => undefined);
    },
    filePath: canonicalPath,
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

const getBrowserDestinationHandle = (destination: unknown) => {
  if (!destination || typeof destination === "string") return undefined;
  if (typeof destination === "object" && "createWritable" in destination) return destination as FileSystemFileHandle;
  if (typeof destination === "object" && "fileHandle" in destination)
    return (destination as { fileHandle?: FileSystemFileHandle }).fileHandle;
  return undefined;
};

const createBrowserPublicOutputAdapter = (): RuntimePublicOutputAdapter => ({
  getBlob: (output) => readRuntimeOutputBlob(output),
  getSize: (output) => output.size,
  getStorage: (output) => getRuntimeOutputStorage(output),
  saveAs: async (output, destination) => {
    const fileHandle = getBrowserDestinationHandle(destination);
    if (fileHandle || destination == null) {
      await output.saveAs(fileHandle);
      return;
    }
    const blob = await readRuntimeOutputBlob(output);
    triggerBrowserDownload(blob, output.fileName);
  },
});

const browserVfs = createBrowserLargeFileVfs({
  rootPath: WORKER_OPFS_MOUNTPOINT,
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForBrowserVfsPath = async (filePath: string) => {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) return null;
  let stat = await browserVfs.stat(normalizedPath);
  if (stat) return stat;
  for (let attempt = 0; attempt < BROWSER_VFS_PATH_RETRY_ATTEMPTS; attempt += 1) {
    await wait(25 * (attempt + 1));
    stat = await browserVfs.stat(normalizedPath);
    if (stat) return stat;
  }
  return null;
};

const ensureBrowserVfsOutputPath = async (filePath: string) => {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) return;
  await browserVfs.truncate(normalizedPath, 0);
};

const ensureBrowserVfsOutputPaths = async (filePaths: string[]) => {
  const seen = new Set<string>();
  for (const filePath of filePaths) {
    const normalizedPath = String(filePath || "").trim();
    if (!normalizedPath || seen.has(normalizedPath)) continue;
    seen.add(normalizedPath);
    await ensureBrowserVfsOutputPath(normalizedPath);
  }
};

const filterOutputCandidatesAwayFromSource = (filePaths: string[], sourcePath: string) => {
  const normalizedSourcePath = String(sourcePath || "").trim();
  if (!normalizedSourcePath) return filePaths;
  return filePaths.filter((filePath) => String(filePath || "").trim() !== normalizedSourcePath);
};

const getBrowserExtractOutputPathCandidates = (outDirPath: string, entryName: string): string[] => {
  const normalizedEntryName = normalizeEntryPath(entryName);
  const baseName = getPathBaseName(normalizedEntryName, normalizedEntryName);
  const candidates = [
    normalizedEntryName ? joinPath(outDirPath, normalizedEntryName) : "",
    baseName ? joinPath(outDirPath, baseName) : "",
  ];
  const seen = new Set<string>();
  return candidates
    .map((value) => String(value || "").trim())
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
};

const isMissingBrowserVfsOutputError = (error: unknown) =>
  String(error instanceof Error ? error.message : error || "").includes("Browser VFS output is not available");

const createBrowserChecksumRuntime = (workerIo: RuntimeWorkerIo): WorkflowRuntime["checksum"] =>
  createWorkerChecksumRuntime(workerIo, runRomWeaverChecksumWorker);

const readTextFromBrowserVfs = async (filePath: string): Promise<string> => {
  const stat = await browserVfs.stat(filePath);
  const size = stat?.size || 0;
  if (!size) return "";
  const bytes = new Uint8Array(size);
  await browserVfs.read(filePath, bytes, {
    bufferOffset: 0,
    fileOffset: 0,
    length: bytes.byteLength,
  });
  return new TextDecoder().decode(bytes);
};

const writeTextToBrowserVfs = async (filePath: string, text: string) => {
  const bytes = new TextEncoder().encode(text);
  await browserVfs.truncate(filePath, 0);
  if (bytes.byteLength) {
    await browserVfs.write(filePath, bytes, {
      fileOffset: 0,
    });
  }
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
    const staged = await stageBrowserCompressionEntries(workflowInput.entries, workerIo);
    try {
      const format = workflowInput.format || workflowInput.options?.compression || "7z";
      const codec = format === "zip" ? workflowInput.options?.zipCodec : workflowInput.options?.sevenZipCodec;
      const level = format === "zip" ? workflowInput.options?.zipLevel : workflowInput.options?.sevenZipLevel;
      const levelProfile = toLevelProfile(level);
      const codecEntries = withCodecLevel(codec, level);
      const fallbackOutputPathSource =
        staged.stagedEntries[0]?.filePath || `${WORKER_OPFS_MOUNTPOINT}/input/archive.bin`;
      const outputFileName = workflowInput.options?.outputName || (format === "zip" ? "archive.zip" : "archive.7z");
      const outputPath = selectRomWeaverOutputPath(fallbackOutputPathSource, outputFileName, staged.inputPaths);
      await ensureBrowserVfsOutputPath(outputPath);
      return {
        output: await workerIo.createWorkerOutput(
          await invokeRomWeaverCompressionCreateWorker(
            {
              codecs: codecEntries,
              format,
              inputPaths: staged.inputPaths,
              levelProfile,
              logLevel: workflowInput.options?.logLevel,
              outputFileName,
              outputPath,
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
    });
    try {
      const baseOutDirPath = getPathDirectory(archive.filePath) || `${WORKER_OPFS_MOUNTPOINT}/input/`;
      const outputs = [];
      for (const entryName of workflowInput.entries) {
        const outDirPath = joinPath(baseOutDirPath, `.rom-weaver-extract-${++archiveExtractDirectoryId}`);
        const outputPathCandidates = filterOutputCandidatesAwayFromSource(
          getBrowserExtractOutputPathCandidates(outDirPath, entryName),
          archive.filePath,
        );
        await ensureBrowserVfsOutputPaths(outputPathCandidates);
        const runExtract = () =>
          invokeRomWeaverExtractWorker(
            {
              logLevel: workflowInput.options?.logLevel,
              outDirPath,
              select: [entryName],
              sourcePath: archive.filePath,
              workerThreads: workflowInput.options?.workerThreads,
            },
            forwardArchiveProgress("input", workflowInput.options?.onProgress),
            workflowInput.options?.onLog,
          );
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
        const createOutput = (matched: { fileName: string; path: string; sizeBytes?: number }) =>
          workerIo.createWorkerOutput(
            {
              fileName: entryName,
              filePath: matched.path,
              size: matched.sizeBytes,
            },
            entryName,
            "archive extract worker did not return browser output",
          );

        let extracted = await runExtract();
        let matched = await selectMatchedOutput(extracted);
        try {
          outputs.push(await createOutput(matched));
        } catch (error) {
          if (!isMissingBrowserVfsOutputError(error)) throw error;
          await ensureBrowserVfsOutputPaths(extracted.emittedFiles.map((entry) => entry.path));
          extracted = await runExtract();
          matched = await selectMatchedOutput(extracted);
          outputs.push(await createOutput(matched));
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
    });
    try {
      return await runRomWeaverInspectListWorker(
        {
          logLevel: workflowInput.options?.logLevel,
          sourcePath: archive.filePath,
        },
        forwardArchiveProgress("input", workflowInput.options?.onProgress),
        workflowInput.options?.onLog,
      );
    } finally {
      await archive.cleanup().catch(() => undefined);
    }
  },
});

const createBrowserDiscRuntime = (workerIo: RuntimeWorkerIo): DiscRuntimeAdapter => ({
  createChd: async ({
    source,
    fileName,
    outputName,
    imageFiles,
    mode,
    chdSourceMode,
    cueText,
    cueInputFileName,
    threads,
    compressionCodecs,
    logLevel,
    onLog,
    onProgress,
  }) => {
    const workerInput = await workerIo.stageSource({
      fallbackFileName: fileName || "input.bin",
      pathPrefix: "chd-image",
      scope: "chd",
      source,
    });
    const stagedImageSources = imageFiles?.length
      ? await workerIo.stageSources(
          imageFiles.map((entry, index) => ({
            fallbackFileName: entry.fileName || `track-${index + 1}.bin`,
            pathPrefix: `chd-track-${index + 1}`,
            scope: "chd" as const,
            source: entry.source,
          })),
        )
      : [];

    const transientPaths: string[] = [];
    const cleanupTransient = async () => {
      await Promise.all(transientPaths.map((transientPath) => browserVfs.remove(transientPath).catch(() => undefined)));
    };

    try {
      const inputPaths = [workerInput.filePath, ...stagedImageSources.map((entry) => entry.filePath)];
      const requestedMode = String(chdSourceMode || mode || "")
        .trim()
        .toLowerCase();
      const shouldCreateCue = !!cueText || requestedMode === "cd";
      if (shouldCreateCue) {
        const cueFileName =
          cueInputFileName ||
          `${getPathBaseName(workerInput.fileName || "disc.bin", "disc").replace(/\.[^./\\]*$/, "")}.cue`;
        const cuePath = selectRomWeaverOutputPath(workerInput.filePath, cueFileName, inputPaths);
        const cueTarget = workerInput.fileName || fileName || "disc.bin";
        let normalizedCueText = cueText
          ? String(cueText)
          : `FILE "${cueTarget}" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n`;
        if (cueText) {
          try {
            normalizedCueText = replaceCuePatchFileName(normalizedCueText, cueTarget);
          } catch (_error) {
            // Preserve multi-track cue sheets that do not match single-track replacement assumptions.
          }
        }
        await writeTextToBrowserVfs(cuePath, normalizedCueText);
        transientPaths.push(cuePath);
        inputPaths.unshift(cuePath);
      }

      const outputFileName = outputName || "output.chd";
      const outputPath = selectRomWeaverOutputPath(workerInput.filePath, outputFileName, inputPaths);
      await ensureBrowserVfsOutputPath(outputPath);
      const codecs = normalizeCodecEntries(compressionCodecs);
      const result = await invokeRomWeaverCompressionCreateWorker(
        {
          codecs,
          format: "chd",
          inputPaths,
          logLevel,
          outputFileName,
          outputPath,
          workerThreads: threads,
        },
        onProgress ? forwardDiscProgress(onProgress) : undefined,
        onLog,
      );
      return workerIo.createWorkerOutput(
        outputName ? { ...result, fileName: outputName } : result,
        outputName || outputFileName,
        "CHD compression worker did not return browser output",
      );
    } finally {
      await cleanupTransient();
      await workerInput.cleanup().catch(() => undefined);
      await Promise.all(stagedImageSources.map((imageSource) => imageSource.cleanup().catch(() => undefined)));
    }
  },
  createRvz: async ({
    source,
    fileName,
    outputName,
    rvzCompression,
    rvzCompressionLevel,
    threads,
    logLevel,
    onLog,
    onProgress,
  }) =>
    workerIo.runPathWorkerToOutput({
      failureMessage: "RVZ compression worker did not return browser output",
      fallbackFileName: fileName || "input.iso",
      outputName,
      pathPrefix: "rvz-image",
      run: async (workerSource) => {
        const outputFileName = outputName || "output.rvz";
        const outputPath = selectRomWeaverOutputPath(workerSource.filePath, outputFileName, [workerSource.filePath]);
        await ensureBrowserVfsOutputPath(outputPath);
        const codecs = withCodecLevel(rvzCompression || "zstd", rvzCompressionLevel);
        const result = await invokeRomWeaverCompressionCreateWorker(
          {
            codecs,
            format: "rvz",
            inputPaths: [workerSource.filePath],
            logLevel,
            outputFileName,
            outputPath,
            workerThreads: threads,
          },
          onProgress ? forwardDiscProgress(onProgress) : undefined,
          onLog,
        );
        return outputName ? { ...result, fileName: outputName } : result;
      },
      scope: "rvz",
      source,
    }),
  createZ3ds: async ({ source, fileName, outputName, threads, z3dsCompressionLevel, logLevel, onLog, onProgress }) =>
    workerIo.runPathWorkerToOutput({
      failureMessage: "Z3DS compression worker did not return browser output",
      fallbackFileName: fileName || "input.3ds",
      outputName,
      pathPrefix: "z3ds-image",
      run: async (workerSource) => {
        const outputFileName = outputName || "output.z3ds";
        const outputPath = selectRomWeaverOutputPath(workerSource.filePath, outputFileName, [workerSource.filePath]);
        await ensureBrowserVfsOutputPath(outputPath);
        const codecs = withCodecLevel("zstd", z3dsCompressionLevel);
        const result = await invokeRomWeaverCompressionCreateWorker(
          {
            codecs,
            format: "z3ds",
            inputPaths: [workerSource.filePath],
            logLevel,
            outputFileName,
            outputPath,
            workerThreads: threads,
          },
          onProgress ? forwardDiscProgress(onProgress) : undefined,
          onLog,
        );
        return outputName ? { ...result, fileName: outputName } : result;
      },
      scope: "z3ds",
      source,
    }),
  extractChd: async ({ source, fileName, outputName, mode, threads, logLevel, onLog, onProgress }) => {
    const workerSource = await workerIo.stageSource({
      fallbackFileName: fileName,
      pathPrefix: "chd-input",
      scope: "chd",
      source,
    });
    try {
      const outDirPath = getPathDirectory(workerSource.filePath);
      const runExtract = () =>
        invokeRomWeaverExtractWorker(
          {
            logLevel,
            outDirPath,
            select: [],
            sourcePath: workerSource.filePath,
            splitBin: mode === "cd",
            workerThreads: threads,
          },
          onProgress ? forwardDiscProgress(onProgress) : undefined,
          onLog,
        );
      const selectChdOutputs = (value: Awaited<ReturnType<typeof runExtract>>) => {
        const cue =
          value.emittedFiles.find((entry) => entry.kind === "cue") ||
          value.emittedFiles.find((entry) => /\.cue$/i.test(entry.fileName));
        const primary =
          (outputName ? findExtractedFile(value.emittedFiles, outputName) : null) ||
          value.emittedFiles.find((entry) => entry !== cue) ||
          value.emittedFiles[0];
        return {
          cueFile: cue,
          primaryFile: primary,
        };
      };
      const createChdOutput = async (
        cueFile: ReturnType<typeof selectChdOutputs>["cueFile"],
        primaryFile: ReturnType<typeof selectChdOutputs>["primaryFile"],
      ) => {
        if (!primaryFile) throw new Error("CHD extraction did not emit any output files");
        const cueText = cueFile ? await readTextFromBrowserVfs(cueFile.path).catch(() => "") : undefined;
        return attachDiscOutputMetadata(
          await workerIo.createWorkerOutput(
            {
              fileName: outputName || primaryFile.fileName,
              filePath: primaryFile.path,
              size: primaryFile.sizeBytes,
            },
            outputName || fileName,
            "CHD extraction worker did not return browser output",
          ),
          {
            chdCueFileName: cueFile?.fileName,
            chdCueText: cueText,
          },
        );
      };

      let extracted = await runExtract();
      let selected = selectChdOutputs(extracted);
      try {
        return await createChdOutput(selected.cueFile, selected.primaryFile);
      } catch (error) {
        if (!isMissingBrowserVfsOutputError(error)) throw error;
        await ensureBrowserVfsOutputPaths(extracted.emittedFiles.map((entry) => entry.path));
        extracted = await runExtract();
        selected = selectChdOutputs(extracted);
        return createChdOutput(selected.cueFile, selected.primaryFile);
      }
    } finally {
      await workerSource.cleanup().catch(() => undefined);
    }
  },
  extractRvz: async ({ source, fileName, outputName, threads, logLevel, onLog, onProgress }) => {
    const stageRvzSource = () =>
      workerIo.stageSource({
        fallbackFileName: fileName,
        pathPrefix: "rvz-input",
        scope: "rvz",
        source,
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
      const baseOutDirPath = getPathDirectory(workerSource.filePath) || `${WORKER_OPFS_MOUNTPOINT}/input/`;
      const outDirPath = joinPath(baseOutDirPath, `.rom-weaver-rvz-extract-${++archiveExtractDirectoryId}`);
      await ensureRvzSourceExists();
      const extracted = await invokeRomWeaverExtractWorker(
        {
          logLevel,
          outDirPath,
          select: [],
          sourcePath: workerSource.filePath,
          workerThreads: threads,
        },
        onProgress ? forwardDiscProgress(onProgress) : undefined,
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
      const primaryFile =
        (outputName ? findExtractedFile(extracted.emittedFiles, outputName) : null) || extracted.emittedFiles[0];
      if (!primaryFile) throw new Error("RVZ extraction did not emit any output files");
      return await workerIo.createWorkerOutput(
        {
          fileName: outputName || primaryFile.fileName,
          filePath: primaryFile.path,
          size: primaryFile.sizeBytes,
        },
        outputName || fileName,
        "RVZ extraction worker did not return browser output",
      );
    } finally {
      await workerSource.cleanup().catch(() => undefined);
    }
  },
  extractZ3ds: async ({ source, fileName, outputName, threads, logLevel, onLog, onProgress }) => {
    const workerSource = await workerIo.stageSource({
      fallbackFileName: fileName,
      pathPrefix: "z3ds-input",
      scope: "z3ds",
      source,
    });
    try {
      const outDirPath = getPathDirectory(workerSource.filePath);
      const listed = await runRomWeaverInspectListWorker(
        {
          logLevel,
          sourcePath: workerSource.filePath,
        },
        undefined,
        onLog,
      ).catch(() => null);
      const preseedPaths =
        listed?.entries
          .flatMap((entry) =>
            getBrowserExtractOutputPathCandidates(
              outDirPath,
              String(entry?.fileName || entry?.filename || entry?.name || ""),
            ),
          )
          .filter((entry) => !!entry) || [];
      if (outputName) preseedPaths.push(...getBrowserExtractOutputPathCandidates(outDirPath, outputName));
      await ensureBrowserVfsOutputPaths(filterOutputCandidatesAwayFromSource(preseedPaths, workerSource.filePath));
      const extracted = await invokeRomWeaverExtractWorker(
        {
          logLevel,
          outDirPath,
          select: [],
          sourcePath: workerSource.filePath,
          workerThreads: threads,
        },
        onProgress ? forwardDiscProgress(onProgress) : undefined,
        onLog,
      );
      const primaryFile =
        (outputName ? findExtractedFile(extracted.emittedFiles, outputName) : null) || extracted.emittedFiles[0];
      if (!primaryFile) throw new Error("Z3DS extraction did not emit any output files");
      return await workerIo.createWorkerOutput(
        {
          fileName: outputName || primaryFile.fileName,
          filePath: primaryFile.path,
          size: primaryFile.sizeBytes,
        },
        outputName || fileName,
        "Z3DS extraction worker did not return browser output",
      );
    } finally {
      await workerSource.cleanup().catch(() => undefined);
    }
  },
  listChd: async ({ source, fileName, logLevel, onLog, onProgress }) => {
    const workerSource = await workerIo.stageSource({
      fallbackFileName: fileName,
      pathPrefix: "chd-input",
      scope: "chd",
      source,
    });
    try {
      const result = await runRomWeaverInspectListWorker(
        {
          logLevel,
          sourcePath: workerSource.filePath,
        },
        onProgress ? forwardDiscProgress(onProgress) : undefined,
        onLog,
      );
      return annotateChdListEntries(normalizeDiscListEntries(result.entries, workerSource.fileName, fileName));
    } finally {
      await workerSource.cleanup().catch(() => undefined);
    }
  },
  listRvz: async ({ fileName }) => [
    {
      fileName: getRvzExtractedFileName({ fileName }),
      filename: getRvzExtractedFileName({ fileName }),
      name: getPathBaseName(getRvzExtractedFileName({ fileName }), getRvzExtractedFileName({ fileName })),
    },
  ],
  listZ3ds: async ({ source, fileName, logLevel, onLog, onProgress }) => {
    const workerSource = await workerIo.stageSource({
      fallbackFileName: fileName,
      pathPrefix: "z3ds-input",
      scope: "z3ds",
      source,
    });
    try {
      const result = await runRomWeaverInspectListWorker(
        {
          logLevel,
          sourcePath: workerSource.filePath,
        },
        onProgress ? forwardDiscProgress(onProgress) : undefined,
        onLog,
      );
      return normalizeDiscListEntries(result.entries, workerSource.fileName, fileName);
    } finally {
      await workerSource.cleanup().catch(() => undefined);
    }
  },
});

const createBrowserCompressionRuntime = (workerIo: RuntimeWorkerIo): WorkflowRuntime["compression"] => {
  const archiveRuntime = createBrowserArchiveRuntime(workerIo);
  const discRuntime = createBrowserDiscRuntime(workerIo);
  return createSharedCompressionRuntime(archiveRuntime, discRuntime, {
    createBytes: (bytes, fileName) =>
      createRuntimeOutputFromBytes(browserVfs, bytes, fileName, {
        pathPrefix: "compression-bytes",
      }),
  });
};

const createBrowserPatchRuntime = (workerIo: RuntimeWorkerIo): WorkflowRuntime["patch"] =>
  createSharedPatchRuntime({
    invokeApplyPatchWorker: (input, onProgress, onLog) =>
      invokeRomWeaverPatchApplyWorker(input, onProgress, onLog, (outputPath) => ensureBrowserVfsOutputPath(outputPath)),
    invokeCreatePatchWorker: (input, onProgress, onLog) =>
      invokeRomWeaverCreatePatchWorker(input, onProgress, onLog, (outputPath) =>
        ensureBrowserVfsOutputPath(outputPath),
      ),
    workerIo,
    workerOutputFailureMessage: "Patch worker did not return browser output",
  });

const createBrowserRuntime = (): WorkflowRuntime => {
  configureBrowserSourcePrimitives();
  const workerIo = createBrowserRuntimeVfsIo({
    mountPoint: WORKER_OPFS_MOUNTPOINT,
    vfs: browserVfs,
  });
  return {
    binary: {
      assertSource: assertBrowserBinarySource,
    },
    checksum: createBrowserChecksumRuntime(workerIo),
    compression: createBrowserCompressionRuntime(workerIo),
    name: "browser",
    output: {
      createBytes: (bytes, fileName) =>
        createRuntimeOutputFromBytes(browserVfs, bytes, fileName, {
          pathPrefix: "runtime-bytes",
        }),
      createSource: (source, fileName) =>
        createRuntimeOutputFromSource(browserVfs, source, fileName, {
          pathPrefix: "runtime-source",
        }),
    },
    patch: createBrowserPatchRuntime(workerIo),
    preload: createRuntimePreload(),
    publicOutput: createBrowserPublicOutputAdapter(),
    sidecars: {},
    useBlobOutput: true,
    vfs: browserVfs,
    workerIo,
  };
};

const browserRuntime = createBrowserRuntime();

export type { WorkflowRuntime };
export { browserRuntime, createBrowserRuntime };
