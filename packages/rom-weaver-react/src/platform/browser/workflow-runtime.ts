import {
  getChdExtractedFileName,
  getRvzExtractedFileName,
  getZ3dsExtractedFileName,
  replaceCuePatchFileName,
} from "../../lib/input/disc-file-utils.ts";
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
  WorkflowRuntimeLog,
} from "../../types/workflow-runtime-adapter.ts";
import { parseCueFile } from "../../workers/protocol/cue-file-utils.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../workers/shared/worker-storage/storage-layout.ts";
import { forwardArchiveProgress, forwardDiscProgress } from "../shared/workflow-runtime-progress.ts";
import { triggerBrowserDownload } from "./browser-download.ts";
import { createBrowserRuntimeVfsIo } from "./browser-runtime-vfs.ts";

const FILE_CAPTURE_REGEX = /^(.+[/\\])?([^/\\]+)$/;
const FILE_EXTENSION_REGEX = /\.[^./\\\s]+$/;
const CHD_SINGLE_BIN_OUTPUT_REGEX = /\.bin$/i;
const LEVEL_PROFILE_REGEX = /^(min|very-low|low|medium|high|very-high|max)$/i;
const BROWSER_VFS_PATH_RETRY_ATTEMPTS = 6;
const EXTRACT_CHECKSUM_ALGORITHMS = ["crc32", "md5", "sha1"] as const;
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

const getChdCdOutputFileName = (fileName: string, extension: "bin" | "cue"): string =>
  `${getFileStem(getPathBaseName(fileName, "input.chd")) || "input"}.${extension}`;

const getChdCreateFormat = (requestedMode: string): string => {
  if (requestedMode === "dvd") return "chd-dvd";
  if (requestedMode === "raw") return "chd-raw";
  if (requestedMode === "hd") return "chd-hd";
  return "chd";
};

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

const uniqueNonEmptyStrings = (values: string[]): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!(normalized && !seen.has(normalized))) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

const getPathDerivedFileName = (filePath: string, fallback: string): string => getPathBaseName(filePath, fallback);

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

const normalizeDiscEntryNameForSource = (entryName: string, stagedFileName: string, sourceFileName: string): string => {
  const normalized = normalizeDiscListEntries(
    [{ fileName: entryName, filename: entryName, name: entryName }],
    stagedFileName,
    sourceFileName,
  )[0];
  return String(normalized?.fileName || entryName || "");
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

type ExtractedFileEntry = {
  checksums?: Record<string, string>;
  fileName: string;
  kind?: string;
  path: string;
  sizeBytes?: number;
};

const findExtractedFile = (emittedFiles: ExtractedFileEntry[], entryName: string) => {
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

const getBrowserDestinationHandle = (destination: unknown) => {
  if (!destination || typeof destination === "string") return undefined;
  if (typeof destination === "object" && "createWritable" in destination) return destination as FileSystemFileHandle;
  if (typeof destination === "object" && "fileHandle" in destination)
    return (destination as { fileHandle?: FileSystemFileHandle }).fileHandle;
  return undefined;
};

const getBrowserDestinationFileName = (destination: unknown) => {
  if (!destination || typeof destination !== "object" || !("fileName" in destination)) return "";
  const fileName = (destination as { fileName?: unknown }).fileName;
  return typeof fileName === "string" ? fileName.trim() : "";
};

const createBrowserPublicOutputAdapter = (): RuntimePublicOutputAdapter => ({
  getBlob: (output) => readRuntimeOutputBlob(output),
  getSize: (output) => output.size,
  getStorage: (output) => getRuntimeOutputStorage(output),
  saveAs: async (output, destination) => {
    const fileHandle = getBrowserDestinationHandle(destination);
    const fileName = getBrowserDestinationFileName(destination);
    if (fileHandle || fileName || destination == null) {
      await output.saveAs(fileHandle || (fileName ? { fileName } : undefined));
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

const toSizeByteCount = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
};

const withExtractedFileSize = async (entry: ExtractedFileEntry): Promise<ExtractedFileEntry> => {
  const knownSize = toSizeByteCount(entry.sizeBytes);
  if (knownSize !== null) return { ...entry, sizeBytes: knownSize };
  const stat = await waitForBrowserVfsPath(entry.path).catch(() => null);
  const statSize = toSizeByteCount(stat?.size);
  return statSize === null ? entry : { ...entry, sizeBytes: statSize };
};

const isTraceLogLevel = (value: unknown) =>
  String(value || "")
    .trim()
    .toLowerCase() === "trace";

const emitBrowserWorkflowTrace = (
  input: { logLevel?: unknown; onLog?: (log: WorkflowRuntimeLog) => void },
  message: string,
  details?: Record<string, unknown>,
) => {
  if (!isTraceLogLevel(input.logLevel)) return;
  input.onLog?.({
    details: details || {},
    level: "trace",
    message,
    namespace: "runtime:browser-workflow",
    timestamp: new Date().toISOString(),
  });
};

const selectPreferredExtractedFile = async (input: {
  emittedFiles: ExtractedFileEntry[];
  logLevel?: unknown;
  onLog?: (log: WorkflowRuntimeLog) => void;
  preferredEntryNames: Array<string | null | undefined>;
  traceLabel: string;
}): Promise<ExtractedFileEntry | null> => {
  const preferred: ExtractedFileEntry[] = [];
  const seenPreferredPaths = new Set<string>();
  for (const name of input.preferredEntryNames) {
    const normalizedName = String(name || "").trim();
    if (!normalizedName) continue;
    const matched = findExtractedFile(input.emittedFiles, normalizedName);
    if (!matched) continue;
    const pathKey = normalizeEntryPath(matched.path);
    if (pathKey && seenPreferredPaths.has(pathKey)) continue;
    if (pathKey) seenPreferredPaths.add(pathKey);
    preferred.push(matched);
  }
  const hasPreferred = (entry: ExtractedFileEntry) => seenPreferredPaths.has(normalizeEntryPath(entry.path));
  const nonPreferred = input.emittedFiles.filter((entry) => !hasPreferred(entry));
  const preferredWithSizes = await Promise.all(preferred.map((entry) => withExtractedFileSize(entry)));
  const nonPreferredWithSizes = await Promise.all(nonPreferred.map((entry) => withExtractedFileSize(entry)));
  const firstPreferredNonEmpty = preferredWithSizes.find((entry) => (entry.sizeBytes || 0) > 0) || null;
  const firstAnyNonEmpty =
    firstPreferredNonEmpty || nonPreferredWithSizes.find((entry) => (entry.sizeBytes || 0) > 0) || null;
  const fallback =
    preferredWithSizes[0] ||
    nonPreferredWithSizes[0] ||
    (input.emittedFiles[0] ? await withExtractedFileSize(input.emittedFiles[0]) : null);
  const selected = firstAnyNonEmpty || fallback;
  emitBrowserWorkflowTrace(
    {
      logLevel: input.logLevel,
      onLog: input.onLog,
    },
    `extract selection ${input.traceLabel}`,
    {
      emitted: input.emittedFiles.map((entry) => ({
        fileName: entry.fileName,
        path: entry.path,
        sizeBytes: entry.sizeBytes,
      })),
      preferredCandidates: preferredWithSizes.map((entry) => ({
        fileName: entry.fileName,
        path: entry.path,
        sizeBytes: entry.sizeBytes,
      })),
      selected: selected
        ? {
            fileName: selected.fileName,
            path: selected.path,
            sizeBytes: selected.sizeBytes,
          }
        : null,
    },
  );
  return selected;
};

const ensureBrowserVfsOutputPath = async (filePath: string) => {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) return;
  await browserVfs.truncate(normalizedPath, 0);
};

const ensureBrowserVfsOutputPaths = async (filePaths: string[], blockedPaths: string[] = []) => {
  const seen = new Set<string>();
  const blocked = new Set(
    blockedPaths.map((filePath) => String(filePath || "").trim()).filter((filePath) => !!filePath),
  );
  for (const filePath of filePaths) {
    const normalizedPath = String(filePath || "").trim();
    if (!normalizedPath || seen.has(normalizedPath)) continue;
    if (blocked.has(normalizedPath)) {
      throw new Error(`Browser output path conflicts with an active input or patch: ${normalizedPath}`);
    }
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
  if (bytes.byteLength > 0) await browserVfs.write(filePath, bytes, { fileOffset: 0 });
};

const rewriteCueFileBinaryReference = async (cuePath: string, targetPath: string) => {
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
  const contents = await readTextFromBrowserVfs(normalizedCuePath).catch(() => "");
  if (!contents) return [];
  const parsed = parseCueFile(contents);
  const sidecarPaths: string[] = [];
  for (const file of parsed.files) {
    const sidecarPath = resolveCueSidecarPath(normalizedCuePath, file.name);
    if (!sidecarPath || sidecarPath === normalizedCuePath) continue;
    const stat = await browserVfs.stat(sidecarPath).catch(() => null);
    if (stat) sidecarPaths.push(sidecarPath);
  }
  return uniqueNonEmptyStrings(sidecarPaths);
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
      const fallbackOutputPathSource = staged.stagedEntries[0]?.filePath || `${WORKER_OPFS_MOUNTPOINT}/archive.bin`;
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
              invalidateMountCacheBeforeRun: true,
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
      trace: { logLevel: workflowInput.options?.logLevel, onLog: workflowInput.options?.onLog },
    });
    try {
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
          await ensureBrowserVfsOutputPaths(outputPathCandidates, [archive.filePath]);
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
                ...(extractChecksumAlgorithms.length ? { checksumAlgorithms: extractChecksumAlgorithms } : {}),
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
          const createOutput = (matched: {
            checksums?: Record<string, string>;
            fileName: string;
            path: string;
            sizeBytes?: number;
          }) =>
            workerIo.createWorkerOutput(
              {
                checksums: matched.checksums,
                cleanup: () => cleanupExtractedFiles([matched.path]),
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
    cueFilePath,
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
      trace: { logLevel, onLog },
    });
    const stagedImageSources = imageFiles?.length
      ? await workerIo.stageSources(
          imageFiles.map((entry, index) => ({
            fallbackFileName: entry.fileName || `track-${index + 1}.bin`,
            pathPrefix: `chd-track-${index + 1}`,
            scope: "chd" as const,
            source: entry.source,
            trace: { logLevel, onLog },
          })),
        )
      : [];

    try {
      const stagedInputPaths = [workerInput.filePath, ...stagedImageSources.map((entry) => entry.filePath)];
      let chdInputPath = workerInput.filePath;
      const requestedMode = String(chdSourceMode || mode || "")
        .trim()
        .toLowerCase();
      const normalizedCueFilePath = String(cueFilePath || "").trim();
      if (normalizedCueFilePath) {
        if (!stagedInputPaths.includes(normalizedCueFilePath)) stagedInputPaths.push(normalizedCueFilePath);
        chdInputPath = normalizedCueFilePath;
        if (workerInput.filePath !== normalizedCueFilePath) {
          await rewriteCueFileBinaryReference(normalizedCueFilePath, workerInput.filePath);
        }
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
      const outputPath = selectRomWeaverOutputPath(workerInput.filePath, outputFileName, [
        ...stagedInputPaths,
        ...(chdInputPath === workerInput.filePath ? [] : [chdInputPath]),
      ]);
      await ensureBrowserVfsOutputPath(outputPath);
      const codecs = normalizeCodecEntries(compressionCodecs);
      const result = await invokeRomWeaverCompressionCreateWorker(
        {
          codecs,
          format: getChdCreateFormat(requestedMode),
          inputPaths: [chdInputPath],
          invalidateMountCacheBeforeRun: true,
          knownInputPaths: stagedInputPaths,
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
            invalidateMountCacheBeforeRun: true,
            knownInputPaths: [workerSource.filePath],
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
      trace: { logLevel, onLog },
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
            invalidateMountCacheBeforeRun: true,
            knownInputPaths: [workerSource.filePath],
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
      trace: { logLevel, onLog },
    }),
  extractChd: async ({ source, fileName, outputName, mode, splitBin, threads, logLevel, onLog, onProgress }) => {
    const workerSource = await workerIo.stageSource({
      fallbackFileName: fileName,
      pathPrefix: "chd-input",
      scope: "chd",
      source,
      trace: { logLevel, onLog },
    });
    try {
      const outDirPath = getPathDirectory(workerSource.filePath);
      const stagedSourceFileName = getPathDerivedFileName(workerSource.filePath, workerSource.fileName || fileName);
      const shouldPreseedSingleBinCdOutputs = mode !== "cd" && CHD_SINGLE_BIN_OUTPUT_REGEX.test(outputName || "");
      const actualOutputFileName =
        mode === "cd"
          ? ""
          : shouldPreseedSingleBinCdOutputs
            ? getChdCdOutputFileName(fileName, "bin")
            : getChdExtractedFileName({ _chdMode: mode || undefined, fileName });
      const stagedOutputFileName =
        mode === "cd"
          ? ""
          : shouldPreseedSingleBinCdOutputs
            ? getChdCdOutputFileName(stagedSourceFileName, "bin")
            : getChdExtractedFileName({
                _chdMode: mode || undefined,
                fileName: stagedSourceFileName,
              });
      const stagedCueOutputFileName = shouldPreseedSingleBinCdOutputs
        ? getChdCdOutputFileName(stagedSourceFileName, "cue")
        : "";
      const shouldSplitBin = mode === "cd" && splitBin !== false;
      const directOutputFileName = outputName || actualOutputFileName;
      const directOutputPath = stagedOutputFileName ? joinPath(outDirPath, stagedOutputFileName) : "";
      if (directOutputPath) {
        const outputPathCandidates = shouldPreseedSingleBinCdOutputs
          ? [directOutputPath, stagedCueOutputFileName ? joinPath(outDirPath, stagedCueOutputFileName) : ""]
          : [
              directOutputPath,
              actualOutputFileName ? joinPath(outDirPath, actualOutputFileName) : "",
              outputName ? joinPath(outDirPath, outputName) : "",
            ];
        await ensureBrowserVfsOutputPaths(uniqueNonEmptyStrings(outputPathCandidates), [workerSource.filePath]);
      }
      const runExtract = () =>
        invokeRomWeaverExtractWorker(
          {
            checksumAlgorithms: [...EXTRACT_CHECKSUM_ALGORITHMS],
            invalidateMountCacheBeforeRun: !!directOutputPath || !!workerSource.virtual,
            logLevel,
            outDirPath,
            scratchFilePoolSize: directOutputPath ? (shouldPreseedSingleBinCdOutputs ? 2 : 1) : undefined,
            select: [],
            sourcePath: workerSource.filePath,
            splitBin: shouldSplitBin,
            workerThreads: threads,
          },
          onProgress ? forwardDiscProgress(onProgress) : undefined,
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
          value.emittedFiles.find((entry) => entry.kind === "cue") ||
          value.emittedFiles.find((entry) => /\.cue$/i.test(entry.fileName));
        const dataFiles = value.emittedFiles.filter((entry) => !isChdCueOutput(entry));
        const primary =
          (outputName ? findExtractedFile(value.emittedFiles, outputName) : null) ||
          (actualOutputFileName ? findExtractedFile(value.emittedFiles, actualOutputFileName) : null) ||
          (stagedOutputFileName ? findExtractedFile(value.emittedFiles, stagedOutputFileName) : null) ||
          dataFiles[0] ||
          (directOutputPath
            ? {
                fileName: directOutputFileName || stagedOutputFileName || actualOutputFileName || fileName,
                path: directOutputPath,
              }
            : null) ||
          value.emittedFiles[0];
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
        const cleanupPaths = uniqueNonEmptyStrings(outputFiles.map((entry) => entry.path));
        let cleanupDone = false;
        const cleanupAllOutputs = async () => {
          if (cleanupDone) return;
          cleanupDone = true;
          await Promise.all(cleanupPaths.map((path) => browserVfs.remove(path).catch(() => undefined)));
        };
        const outputs = await Promise.all(
          outputFiles.map(async (entry) => {
            const isCue = isChdCueOutput(entry);
            const normalizedFileName = normalizeDiscEntryNameForSource(entry.fileName, stagedSourceFileName, fileName);
            const fileNameForOutput =
              !(isCue || shouldSplitBin) && sameExtractedFile(entry, primaryFile) && outputName
                ? outputName
                : normalizedFileName || entry.fileName || directOutputFileName || fileName;
            const output = await workerIo.createWorkerOutput(
              {
                checksums: isCue ? undefined : entry.checksums,
                cleanup: cleanupAllOutputs,
                fileName: fileNameForOutput,
                filePath: entry.path,
                size: entry.sizeBytes,
              },
              fileNameForOutput,
              "CHD extraction worker did not return browser output",
            );
            return isCue ? output : attachDiscOutputMetadata(output, { chdCuePath: cueFile?.path });
          }),
        );
        return createCompressionExtractResult(outputs);
      };

      let extracted = await runExtract();
      let selected = selectChdOutputs(extracted);
      try {
        return await createChdOutputs(selected.cueFile, selected.outputFiles, selected.primaryFile);
      } catch (error) {
        if (!isMissingBrowserVfsOutputError(error)) throw error;
        await ensureBrowserVfsOutputPaths(extracted.emittedFiles.map((entry) => entry.path));
        extracted = await runExtract();
        selected = selectChdOutputs(extracted);
        return createChdOutputs(selected.cueFile, selected.outputFiles, selected.primaryFile);
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
      const actualOutputFileName = getRvzExtractedFileName({ fileName });
      const stagedOutputFileName = getRvzExtractedFileName({
        fileName: getPathDerivedFileName(workerSource.filePath, workerSource.fileName || fileName),
      });
      const outputFileName = outputName || actualOutputFileName;
      const outputPath = joinPath(outDirPath, stagedOutputFileName);
      await ensureRvzSourceExists();
      await ensureBrowserVfsOutputPaths(
        uniqueNonEmptyStrings([
          outputPath,
          actualOutputFileName ? joinPath(outDirPath, actualOutputFileName) : "",
          outputName ? joinPath(outDirPath, outputName) : "",
        ]),
        [workerSource.filePath],
      );
      const extracted = await invokeRomWeaverExtractWorker(
        {
          checksumAlgorithms: [...EXTRACT_CHECKSUM_ALGORITHMS],
          invalidateMountCacheBeforeRun: true,
          logLevel,
          outDirPath,
          scratchFilePoolSize: 1,
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
      const primaryFile = await selectPreferredExtractedFile({
        emittedFiles: extracted.emittedFiles,
        logLevel,
        onLog,
        preferredEntryNames: [outputFileName, actualOutputFileName, stagedOutputFileName, outputName],
        traceLabel: "rvz",
      });
      return await workerIo.createWorkerOutput(
        {
          checksums: primaryFile?.checksums,
          fileName: outputFileName,
          filePath: primaryFile?.path || outputPath,
          size: primaryFile?.sizeBytes,
        },
        outputFileName,
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
      trace: { logLevel, onLog },
    });
    try {
      const outDirPath = getPathDirectory(workerSource.filePath);
      const actualOutputFileName = getZ3dsExtractedFileName({ fileName });
      const stagedOutputFileName = getZ3dsExtractedFileName({
        fileName: getPathDerivedFileName(workerSource.filePath, workerSource.fileName || fileName),
      });
      const outputFileName = outputName || actualOutputFileName;
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
      const listedOutputFileName = getPathBaseName(
        String(listed?.entries?.[0]?.fileName || listed?.entries?.[0]?.filename || listed?.entries?.[0]?.name || ""),
      );
      const outputPath = joinPath(outDirPath, listedOutputFileName || stagedOutputFileName || actualOutputFileName);
      if (outputName) preseedPaths.push(...getBrowserExtractOutputPathCandidates(outDirPath, outputName));
      if (stagedOutputFileName)
        preseedPaths.push(...getBrowserExtractOutputPathCandidates(outDirPath, stagedOutputFileName));
      preseedPaths.push(outputPath);
      preseedPaths.push(joinPath(outDirPath, actualOutputFileName));
      await ensureBrowserVfsOutputPaths(filterOutputCandidatesAwayFromSource(preseedPaths, workerSource.filePath), [
        workerSource.filePath,
      ]);
      const extracted = await invokeRomWeaverExtractWorker(
        {
          checksumAlgorithms: [...EXTRACT_CHECKSUM_ALGORITHMS],
          invalidateMountCacheBeforeRun: true,
          logLevel,
          outDirPath,
          scratchFilePoolSize: 1,
          select: [],
          sourcePath: workerSource.filePath,
          workerThreads: threads,
        },
        onProgress ? forwardDiscProgress(onProgress) : undefined,
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
          size: primaryFile?.sizeBytes,
        },
        outputFileName,
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
      trace: { logLevel, onLog },
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
      return annotateChdListEntries(
        normalizeDiscListEntries(
          result.entries,
          getPathDerivedFileName(workerSource.filePath, workerSource.fileName || fileName),
          fileName,
        ),
      );
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
      trace: { logLevel, onLog },
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
  return createSharedCompressionRuntime(archiveRuntime, discRuntime);
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
