import { getManagedOpfsFileHandle } from "../../../protocol/opfs-path.ts";
import type { EmscriptenWorkerModule } from "../../../shared/wasm/emscripten-types.ts";
import { createOpfsOutputManager } from "../../../shared/worker-storage/opfs-manager.ts";
import { getWorkerStorageBucketPath, WORKER_OPFS_MOUNTPOINT } from "../../../shared/worker-storage/storage-layout.ts";
import type { WorkerOpfsManager } from "../../../shared/worker-storage/types.ts";
import {
  ARCHIVE_TYPES,
  getArchiveMagicType,
  getArchiveType,
  getBlobSource,
  isArchiveFile,
  isWrappedArchiveType,
  toUint8Array,
} from "../../shared/archive-utils.ts";
import {
  baseName,
  collectFilePaths,
  isDirectoryMode,
  joinFsPath,
  mkdirTree,
  normalizeEntryPath,
  parentDir,
  pathExists,
  removeTree,
  sanitizeWorkFileName,
} from "./fs-utils.ts";
import {
  createMonotonicProgressEmitter,
  emitSevenZipProgressSequence,
  inspectSevenZipCliProgress,
  SEVEN_ZIP_PROGRESS_SWITCHES,
  SEVEN_ZIP_REPLAY_FRAME_DELAY_MS,
} from "./sevenzip-progress.ts";
import { runSevenZip, withFreshSevenZipRetry } from "./sevenzip-runtime.ts";
import type {
  ArchiveEntryList,
  ArchiveReadOptions,
  ArchiveSource,
  ArchiveSourceRecord,
  ExtractedArchiveEntryFile,
  ParsedSltArchive,
  SevenZipModuleLike,
} from "./types.ts";

const SEVEN_ZIP_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const LINE_BREAK_REGEX = /\n/;
const SEVEN_ZIP_SLT_PROPERTY_REGEX = /^([^=]+?) = (.*)$/;
const TRAILING_POSIX_SLASHES_REGEX = /\/+$/;
const ARCHIVE_EXTRACT_OPFS_MOUNTPOINT = WORKER_OPFS_MOUNTPOINT;
const MIN_RELIABLE_ARCHIVE_MTIME_SECONDS = 10_000_000;
const ARCHIVE_CONTENTS_EXTRACT_LABEL = "Extracting archive contents...";
const ARCHIVE_ENTRY_EXTRACT_LABEL = "Extracting archive entry...";

const GUESSED_ARCHIVE_FILE_NAME_BY_TYPE: Record<string, string> = {
  [ARCHIVE_TYPES.BROTLI]: "archive.tar.br",
  [ARCHIVE_TYPES.BZIP2]: "archive.tar.bz2",
  [ARCHIVE_TYPES.COMPRESS]: "archive.tar.z",
  [ARCHIVE_TYPES.GZIP]: "archive.tar.gz",
  [ARCHIVE_TYPES.LZ4]: "archive.tar.lz4",
  [ARCHIVE_TYPES.LZ5]: "archive.tar.lz5",
  [ARCHIVE_TYPES.LZIP]: "archive.tar.lz",
  [ARCHIVE_TYPES.LZMA]: "archive.tar.lzma",
  [ARCHIVE_TYPES.LIZARD]: "archive.tar.lizard",
  [ARCHIVE_TYPES.RAR]: "archive.rar",
  [ARCHIVE_TYPES.SEVEN_ZIP]: "archive.7z",
  [ARCHIVE_TYPES.TAR]: "archive.tar",
  [ARCHIVE_TYPES.XZ]: "archive.tar.xz",
  [ARCHIVE_TYPES.ZIP]: "archive.zip",
  [ARCHIVE_TYPES.ZSTD]: "archive.tar.zst",
  lzma86: "archive.lzma86",
  mslz: "archive.mslz",
  pmd: "archive.pmd",
};
let archiveReadWorkId = 0;
let archiveExtractOpfsManagerPromise: Promise<WorkerOpfsManager | null> | null = null;
const archiveWorkerPathSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let archiveWorkerPathId = 0;
let archiveDirectExtractId = 0;

const createArchiveWorkerPathId = (prefix: string) =>
  `${prefix}-${archiveWorkerPathSessionId}-${++archiveWorkerPathId}`;

const createDirectExtractPathId = () => `extract-${archiveWorkerPathSessionId}-${++archiveDirectExtractId}`;

export const isArchiveSourceRecord = (source: RuntimeValue): source is ArchiveSourceRecord =>
  !!source && typeof source === "object";

export const isFileSystemFileHandle = (source: RuntimeValue): source is FileSystemFileHandle =>
  typeof FileSystemFileHandle !== "undefined" && source instanceof FileSystemFileHandle;

export const isByteBackedArchiveSource = (source: RuntimeValue) =>
  source instanceof ArrayBuffer ||
  ArrayBuffer.isView(source) ||
  (isArchiveSourceRecord(source) &&
    (!!source._u8array || typeof source.materialize === "function" || typeof source.readIntoAt === "function"));

export const assertFileBackedArchiveSource = (source: RuntimeValue) => {
  if (typeof source === "string" && source) return;
  if (getBlobSource(source)) return;
  if (isFileSystemFileHandle(source)) return;
  if (isByteBackedArchiveSource(source))
    throw new Error("ArchiveManager read APIs require a file-backed source; raw bytes are not supported");
  throw new Error("ArchiveManager read APIs require a file-backed source");
};

export const assertByteBackedArchiveSource = (source: RuntimeValue) => {
  if (isByteBackedArchiveSource(source)) return;
  throw new Error("ArchiveManager internal byte reader requires an ArrayBuffer or typed array source");
};

const getPassphraseSwitches = (options?: ArchiveReadOptions) =>
  options && options.passphrase !== null && options.passphrase !== undefined ? [`-p${String(options.passphrase)}`] : [];

const asEmscriptenModule = (sevenZip: SevenZipModuleLike) => sevenZip as unknown as EmscriptenWorkerModule;

const getNavigatorObject = (): Navigator | null => (typeof navigator === "undefined" ? null : (navigator as Navigator));

const getArchiveExtractOpfsManager = async (sevenZip: SevenZipModuleLike) => {
  if (!archiveExtractOpfsManagerPromise) {
    archiveExtractOpfsManagerPromise = createOpfsOutputManager({
      moduleObject: asEmscriptenModule(sevenZip),
      mountPoint: ARCHIVE_EXTRACT_OPFS_MOUNTPOINT,
      navigatorObject: getNavigatorObject(),
    }).catch(() => null);
  }
  const manager = await archiveExtractOpfsManagerPromise;
  if (!(manager && manager.ensureMounted(asEmscriptenModule(sevenZip)))) return null;
  return manager;
};

export const cleanupExtractedArchiveFiles = async (filePaths?: string[]) => {
  await archiveExtractOpfsManagerPromise?.then((manager) => manager?.cleanup(filePaths));
};

const parseSevenZipDate = (value: string | undefined) => {
  if (!value) return undefined;
  const match = value.match(SEVEN_ZIP_DATE_REGEX);
  if (!match) return undefined;
  const timestamp =
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    ) +
    new Date().getTimezoneOffset() * 60 * 1000;
  if (!Number.isFinite(timestamp)) return undefined;
  const seconds = Math.floor(timestamp / 1000);
  return seconds >= MIN_RELIABLE_ARCHIVE_MTIME_SECONDS ? seconds : undefined;
};

const parseSevenZipSlt = (stdout: string): ParsedSltArchive => {
  const lines = stdout.split(LINE_BREAK_REGEX);
  const entries: ParsedSltArchive["entries"] = [];
  let archiveType = "";
  let inEntries = false;
  let block: Record<string, string> = {};

  const flushBlock = () => {
    if (!Object.keys(block).length) return;
    const filename = block.Path || "";
    if (filename) {
      const isDirectory = block.Folder === "+";
      const normalizedFilename = isDirectory && !filename.endsWith("/") ? `${filename}/` : filename;
      const size = Number(block.Size || 0);
      const mtime = parseSevenZipDate(block.Modified);
      entries.push({
        fileName: normalizedFilename,
        filename: normalizedFilename,
        fileType: isDirectory ? "Directory" : "File",
        size: Number.isFinite(size) ? size : 0,
        ...(mtime === undefined ? null : { lastModified: mtime * 1000, mtime }),
        ...(block.Encrypted === "+" ? { encrypted: true } : null),
        ...(block.Method ? { method: block.Method } : null),
      });
    }
    block = {};
  };

  for (const line of lines) {
    if (line.trim() === "----------") {
      flushBlock();
      inEntries = true;
      continue;
    }
    if (inEntries && line.trim() === "") {
      flushBlock();
      continue;
    }
    const match = line.match(SEVEN_ZIP_SLT_PROPERTY_REGEX);
    if (!match) continue;
    const key = match[1]?.trim();
    const value = match[2] ?? "";
    if (!key) continue;
    if (!inEntries) {
      if (key === "Type") archiveType = value.trim();
      continue;
    }
    block[key] = value;
  }
  flushBlock();
  return { archiveType, entries };
};

const parseArchivePath = (sevenZip: SevenZipModuleLike, archivePath: string, options?: ArchiveReadOptions) =>
  parseSevenZipSlt(runSevenZip(sevenZip, ["l", "-slt", ...getPassphraseSwitches(options), archivePath]).stdout);

const withArchiveFileName = (entries: ArchiveEntryList, archiveFileName: string) =>
  entries.map((entry) => ({ ...entry, archiveFileName }));

const createWrappedFileEntry = (
  sevenZip: SevenZipModuleLike,
  innerPath: string,
  archiveFileName: string,
): ArchiveEntryList => {
  const size = Math.max(0, Number(sevenZip.FS.stat(innerPath).size || 0));
  const filename = baseName(innerPath) || baseName(archiveFileName) || "archive";
  return [
    {
      archiveFileName,
      fileName: filename,
      filename,
      fileType: "File",
      size,
    },
  ];
};

const getWrappedInnerArchiveType = (sevenZip: SevenZipModuleLike, innerPath: string) => {
  try {
    const bytes = sevenZip.FS.readFile(innerPath, { encoding: "binary" });
    return getArchiveMagicType(Uint8Array.from(bytes as Uint8Array | ArrayLike<number>));
  } catch (_error) {
    return null;
  }
};

const matchesWrappedEntry = (entries: ArchiveEntryList, entryName: string) => {
  if (!entries.length) return true;
  const normalizedEntryName = normalizeEntryPath(entryName);
  return entries.some((entry) => {
    const filename = normalizeEntryPath(entry.filename || entry.fileName || "");
    return filename === normalizedEntryName || baseName(filename) === baseName(normalizedEntryName);
  });
};

const notifyWrappedExtractStart = (options?: ArchiveReadOptions) => {
  options?.onProgress?.({
    hasProgress: false,
    label: ARCHIVE_CONTENTS_EXTRACT_LABEL,
    percent: null,
    progressSource: "7zip-wrapper",
  });
};

const notifyArchiveEntryExtractStart = (options?: ArchiveReadOptions) => {
  options?.onProgress?.({
    hasProgress: false,
    label: ARCHIVE_ENTRY_EXTRACT_LABEL,
    percent: null,
    progressSource: "7zip-extract",
  });
};

const notifyArchiveEntryExtractComplete = (options?: ArchiveReadOptions) => {
  options?.onProgress?.({
    label: ARCHIVE_ENTRY_EXTRACT_LABEL,
    percent: 100,
    progressSource: "7zip-extract",
  });
};

const extractWrappedArchive = (
  sevenZip: SevenZipModuleLike,
  archivePath: string,
  workDir: string,
  depth: number,
  options?: ArchiveReadOptions,
) => {
  const FS = sevenZip.FS;
  const outputDir = joinFsPath(workDir, `wrapped-${depth}`);
  mkdirTree(FS, outputDir);
  const progressEmitter = createMonotonicProgressEmitter(options, ARCHIVE_CONTENTS_EXTRACT_LABEL, {
    baseFields: { progressSource: "7zip-stderr", type: "progress" },
    minIntervalMs: SEVEN_ZIP_REPLAY_FRAME_DELAY_MS,
    minPercentDelta: 1,
  });
  const sevenZipOutput = sevenZip.__romWeaverSevenZipZstdOutput;
  const previousStderrProgress = sevenZipOutput?.onStderrProgress || null;
  notifyWrappedExtractStart(options);
  try {
    if (sevenZipOutput) {
      sevenZipOutput.onStderrProgress = (percent) => {
        progressEmitter.emit(Math.max(0, Math.min(100, percent)));
      };
    }
    runSevenZip(sevenZip, [
      "x",
      "-y",
      ...SEVEN_ZIP_PROGRESS_SWITCHES,
      ...getPassphraseSwitches(options),
      `-o${outputDir}`,
      archivePath,
    ]);
  } finally {
    if (sevenZipOutput) sevenZipOutput.onStderrProgress = previousStderrProgress;
  }
  progressEmitter.emit(100, { progressSource: "7zip-wrapper" });
  const files = collectFilePaths(FS, outputDir);
  if (!files.length) throw new Error(`Wrapped archive did not produce an inner file: ${archivePath}`);
  const innerPath = files[0];
  if (!innerPath) throw new Error(`Wrapped archive did not produce an inner file: ${archivePath}`);
  return innerPath;
};

export const listArchivePath = (
  sevenZip: SevenZipModuleLike,
  archivePath: string,
  workDir: string,
  archiveFileName: string,
  depth = 0,
  options?: ArchiveReadOptions,
): ArchiveEntryList => {
  if (depth > 4) throw new Error(`Archive nesting is too deep: ${archivePath}`);
  const parsed = parseArchivePath(sevenZip, archivePath, options);
  if (isWrappedArchiveType(parsed.archiveType)) {
    const innerPath = extractWrappedArchive(sevenZip, archivePath, workDir, depth, options);
    const namedArchiveType = getArchiveType(archiveFileName);
    const innerArchiveType = getWrappedInnerArchiveType(sevenZip, innerPath);
    if (
      (typeof namedArchiveType === "string" && namedArchiveType.startsWith("tar.")) ||
      innerArchiveType === ARCHIVE_TYPES.TAR
    ) {
      return listArchivePath(sevenZip, innerPath, workDir, archiveFileName, depth + 1, options);
    }
    return createWrappedFileEntry(sevenZip, innerPath, archiveFileName);
  }
  return withArchiveFileName(parsed.entries, archiveFileName);
};

const findExtractedFile = (sevenZip: SevenZipModuleLike, outputDir: string, entryName: string) => {
  const FS = sevenZip.FS;
  const exactPath = joinFsPath(outputDir, entryName);
  if (pathExists(FS, exactPath) && !isDirectoryMode(FS, FS.stat(exactPath).mode)) return exactPath;

  const normalizedEntry = normalizeEntryPath(entryName).replace(TRAILING_POSIX_SLASHES_REGEX, "");
  const files = collectFilePaths(FS, outputDir);
  return (
    files.find((filePath) => filePath.replace(`${outputDir}/`, "") === normalizedEntry) ||
    files.find((filePath) => baseName(filePath) === baseName(entryName)) ||
    null
  );
};

const getDirectExtractOutputTarget = async (
  manager: WorkerOpfsManager,
  entryName: string,
): Promise<{ fileName: string; outputDir: string; outputPath: string }> => {
  const normalizedEntryName = normalizeEntryPath(entryName);
  const fileName = baseName(normalizedEntryName) || "archive-entry.bin";
  const outputId = createDirectExtractPathId();
  const outputDir = getWorkerStorageBucketPath(manager.outputDirectory, "output", outputId, outputId);
  const outputPath = getWorkerStorageBucketPath(
    manager.outputDirectory,
    "output",
    `${outputId}/${normalizedEntryName}`,
    fileName,
  );
  const preparedTarget = await manager.prepareFile(outputPath);
  if (!(preparedTarget && manager.ensureNode(outputPath))) {
    await manager.cleanup([outputPath]).catch(() => undefined);
    throw new Error(`Archive extract output could not be prepared for direct sink: ${entryName}`);
  }
  return { fileName, outputDir, outputPath };
};

const extractArchiveEntryToDirectory = async ({
  archivePath,
  entryName,
  options,
  outputDir,
  sevenZip,
}: {
  archivePath: string;
  entryName: string;
  options?: ArchiveReadOptions;
  outputDir: string;
  sevenZip: SevenZipModuleLike;
}) => {
  const FS = sevenZip.FS;
  mkdirTree(FS, outputDir);
  const normalizedEntryName = normalizeEntryPath(entryName);
  const progressEmitter = createMonotonicProgressEmitter(options, ARCHIVE_ENTRY_EXTRACT_LABEL, {
    baseFields: { progressSource: "7zip-stderr", type: "progress" },
    minIntervalMs: SEVEN_ZIP_REPLAY_FRAME_DELAY_MS,
    minPercentDelta: 1,
  });
  const sevenZipOutput = sevenZip.__romWeaverSevenZipZstdOutput;
  const previousStderrProgress = sevenZipOutput?.onStderrProgress || null;
  const runWithProgress = () => {
    if (sevenZipOutput) {
      sevenZipOutput.onStderrProgress = (percent) => {
        progressEmitter.emit(Math.max(0, Math.min(100, percent)));
      };
    }
    try {
      return runSevenZip(sevenZip, [
        "x",
        "-y",
        ...SEVEN_ZIP_PROGRESS_SWITCHES,
        ...getPassphraseSwitches(options),
        `-o${outputDir}`,
        archivePath,
        normalizedEntryName,
      ]);
    } finally {
      if (sevenZipOutput) sevenZipOutput.onStderrProgress = previousStderrProgress;
    }
  };
  notifyArchiveEntryExtractStart(options);
  const result = runWithProgress();
  if (!progressEmitter.hasIntermediate()) {
    const cliProgress = inspectSevenZipCliProgress(result);
    if (cliProgress.useful) {
      await emitSevenZipProgressSequence(options?.onProgress, ARCHIVE_ENTRY_EXTRACT_LABEL, cliProgress.percents, {
        endPercent: 100,
        progressSource: "7zip-cli",
        progressStream: cliProgress.stream,
        startPercent: 0,
      });
    }
  }
  const extractedPath = findExtractedFile(sevenZip, outputDir, normalizedEntryName);
  if (!extractedPath) throw new Error(`Archive entry not found: ${entryName}`);
  return extractedPath;
};

export const extractArchivePath = async (
  sevenZip: SevenZipModuleLike,
  archivePath: string,
  entryName: string,
  workDir: string,
  options?: ArchiveReadOptions,
  depth = 0,
): Promise<Uint8Array> => {
  if (depth > 4) throw new Error(`Archive nesting is too deep: ${archivePath}`);
  const parsed = parseArchivePath(sevenZip, archivePath, options);
  if (isWrappedArchiveType(parsed.archiveType)) {
    const innerPath = extractWrappedArchive(sevenZip, archivePath, workDir, depth, options);
    const namedArchiveType = getArchiveType(baseName(archivePath) || "");
    const innerArchiveType = getWrappedInnerArchiveType(sevenZip, innerPath);
    if (
      (typeof namedArchiveType === "string" && namedArchiveType.startsWith("tar.")) ||
      innerArchiveType === ARCHIVE_TYPES.TAR
    ) {
      return extractArchivePath(sevenZip, innerPath, entryName, workDir, options, depth + 1);
    }
    const wrappedEntries = createWrappedFileEntry(sevenZip, innerPath, baseName(archivePath) || "archive.bin");
    if (!matchesWrappedEntry(wrappedEntries, entryName)) throw new Error(`Archive entry not found: ${entryName}`);
    notifyArchiveEntryExtractComplete(options);
    const extractedData = sevenZip.FS.readFile(innerPath, {
      encoding: "binary",
    });
    return Uint8Array.from(extractedData as Uint8Array | ArrayLike<number>);
  }

  const FS = sevenZip.FS;
  const outputDir = joinFsPath(workDir, `extract-${depth}`);
  const extractedPath = await extractArchiveEntryToDirectory({
    archivePath,
    entryName,
    options,
    outputDir,
    sevenZip,
  });
  notifyArchiveEntryExtractComplete(options);
  const extractedData = FS.readFile(extractedPath, { encoding: "binary" });
  return Uint8Array.from(extractedData as Uint8Array | ArrayLike<number>);
};

export const extractArchivePathToFile = async (
  sevenZip: SevenZipModuleLike,
  archivePath: string,
  entryName: string,
  workDir: string,
  options?: ArchiveReadOptions,
  depth = 0,
): Promise<ExtractedArchiveEntryFile> => {
  if (depth > 4) throw new Error(`Archive nesting is too deep: ${archivePath}`);
  const parsed = parseArchivePath(sevenZip, archivePath, options);
  const manager = await getArchiveExtractOpfsManager(sevenZip);
  if (!manager)
    throw new Error(
      "Archive runtime direct extract sink requires mounted managed storage; fallback materialization is disabled",
    );
  if (isWrappedArchiveType(parsed.archiveType)) {
    const innerPath = extractWrappedArchive(sevenZip, archivePath, workDir, depth, options);
    const namedArchiveType = getArchiveType(baseName(archivePath) || "");
    const innerArchiveType = getWrappedInnerArchiveType(sevenZip, innerPath);
    if (
      (typeof namedArchiveType === "string" && namedArchiveType.startsWith("tar.")) ||
      innerArchiveType === ARCHIVE_TYPES.TAR
    ) {
      return extractArchivePathToFile(sevenZip, innerPath, entryName, workDir, options, depth + 1);
    }
    const wrappedEntries = createWrappedFileEntry(sevenZip, innerPath, baseName(archivePath) || "archive.bin");
    if (!matchesWrappedEntry(wrappedEntries, entryName)) throw new Error(`Archive entry not found: ${entryName}`);
    throw new Error("Archive runtime direct extract sink does not support wrapped single-entry outputs");
  }

  const directTarget = await getDirectExtractOutputTarget(manager, entryName);
  try {
    const extractedPath = await extractArchiveEntryToDirectory({
      archivePath,
      entryName,
      options,
      outputDir: directTarget.outputDir,
      sevenZip,
    });
    notifyArchiveEntryExtractComplete(options);
    const extractedSize = Math.max(0, Number(sevenZip.FS.stat(extractedPath).size || 0));
    const extractedFile = await manager.getFile(extractedPath).catch(() => null);
    const extractedFileHandle = manager.getFileHandle?.(extractedPath) || undefined;
    return {
      cleanupPaths: [extractedPath],
      ...(extractedFile ? { file: extractedFile } : null),
      ...(extractedFileHandle ? { fileHandle: extractedFileHandle } : null),
      fileName: directTarget.fileName,
      filePath: extractedPath,
      size: extractedFile?.size || extractedSize,
    };
  } catch (error) {
    await manager.cleanup([directTarget.outputPath, parentDir(directTarget.outputPath)]).catch(() => undefined);
    throw error;
  }
};

export const getArchiveSourceFileName = (source: RuntimeValue, fallback = "archive.bin") => {
  if (typeof source === "string") return baseName(source) || fallback;
  if (isArchiveSourceRecord(source)) {
    if (typeof source.fileName === "string") return baseName(source.fileName) || fallback;
    if (typeof source.name === "string") return baseName(source.name) || fallback;
    if (source._file && typeof source._file.name === "string") return baseName(source._file.name) || fallback;
  }
  if (
    source &&
    typeof source === "object" &&
    "name" in source &&
    typeof (source as { name?: RuntimeValue }).name === "string"
  )
    return baseName((source as { name: string }).name) || fallback;
  return fallback;
};

export const guessArchiveFileName = (bytes: Uint8Array, fallback?: string | null) => {
  const fileName = fallback ? sanitizeWorkFileName(fallback) : "";
  if (isArchiveFile(fileName)) return fileName;
  const archiveType = getArchiveMagicType(bytes);
  if (archiveType && GUESSED_ARCHIVE_FILE_NAME_BY_TYPE[archiveType])
    return GUESSED_ARCHIVE_FILE_NAME_BY_TYPE[archiveType];
  return fileName || "archive.bin";
};

const getNodePath = (source: ArchiveSource) => (typeof source === "string" && source.trim() ? source : "");

const stageOpfsArchivePath = async (
  sevenZip: SevenZipModuleLike,
  opfsPath: string,
  _workDir: string,
): Promise<{
  archivePath: string;
  cleanup: () => Promise<void>;
  fileName: string;
} | null> => {
  const manager = await getArchiveExtractOpfsManager(sevenZip);
  if (!manager) return null;
  const fileName = sanitizeWorkFileName(baseName(opfsPath) || "archive.bin");
  const inputPath = getWorkerStorageBucketPath(
    manager.outputDirectory,
    "input",
    `${createArchiveWorkerPathId("source")}/${fileName}`,
    fileName,
  );
  const fileHandle = await getManagedOpfsFileHandle(opfsPath, {
    navigatorObject: getNavigatorObject(),
  });
  const archiveFile = await fileHandle?.getFile().catch(() => null);
  if (!(archiveFile && (await manager.writeBlob(inputPath, archiveFile)))) return null;
  return {
    archivePath: inputPath,
    cleanup: async () => {
      await manager.cleanup([inputPath]);
    },
    fileName,
  };
};

const mountArchiveSource = async (
  sevenZip: SevenZipModuleLike,
  source: ArchiveSource,
  workDir: string,
): Promise<{
  archivePath: string;
  cleanup: () => void | Promise<void>;
  fileName: string;
}> => {
  const nodePath = getNodePath(source);
  if (nodePath) {
    const opfsSource = await stageOpfsArchivePath(sevenZip, nodePath, workDir);
    if (opfsSource) return opfsSource;
    const manager = await getArchiveExtractOpfsManager(sevenZip);
    if (manager) {
      const fileName = sanitizeWorkFileName(baseName(nodePath) || "archive.bin");
      const inputPath = getWorkerStorageBucketPath(
        manager.outputDirectory,
        "input",
        `${createArchiveWorkerPathId("source")}/${fileName}`,
        fileName,
      );
      if (manager.linkFile?.(nodePath, inputPath)) {
        return {
          archivePath: inputPath,
          cleanup: async () => {
            await manager.cleanup([inputPath]);
          },
          fileName,
        };
      }
    }
    throw new Error("Archive source path is not available in worker OPFS storage");
  }

  const blobSource = isFileSystemFileHandle(source) ? await source.getFile() : getBlobSource(source);
  if (blobSource) {
    const fileName = sanitizeWorkFileName(getArchiveSourceFileName(source));
    const manager = await getArchiveExtractOpfsManager(sevenZip);
    if (manager) {
      const archivePath = getWorkerStorageBucketPath(
        manager.outputDirectory,
        "input",
        `${createArchiveWorkerPathId("worker-source")}/${fileName}`,
        fileName,
      );
      if (!(await manager.writeBlob(archivePath, blobSource as Blob)))
        throw new Error("Archive runtime could not stage Blob/File-backed archive input");
      return {
        archivePath,
        cleanup: async () => {
          await manager.cleanup([archivePath]);
        },
        fileName,
      };
    }
    throw new Error("Archive runtime does not support OPFS Blob/File-backed archive input");
  }

  throw new Error("Archive source must be path-backed or Blob/File-backed; byte-backed archive input is not allowed");
};

export const withStagedArchiveBytes = <T>(
  _bytes: Uint8Array,
  _fileName: string,
  _callback: (sevenZip: SevenZipModuleLike, archivePath: string, workDir: string) => Promise<T> | T,
) =>
  Promise.reject(new Error("Archive byte staging is disabled; use a mounted path-backed or Blob/File-backed source"));

export const withStagedArchiveSource = async <T>(
  source: ArchiveSource,
  callback: (sevenZip: SevenZipModuleLike, archivePath: string, workDir: string, fileName: string) => Promise<T> | T,
) => {
  return withFreshSevenZipRetry(async (sevenZip) => {
    const FS = sevenZip.FS;
    const workDir = `/rpjs-7zip-zstd-${++archiveReadWorkId}`;
    mkdirTree(FS, workDir);
    let mountedSource: Awaited<ReturnType<typeof mountArchiveSource>> | null = null;
    try {
      mountedSource = await mountArchiveSource(sevenZip, source, workDir);
      return await callback(sevenZip, mountedSource.archivePath, workDir, mountedSource.fileName);
    } finally {
      try {
        await mountedSource?.cleanup();
      } finally {
        removeTree(FS, workDir);
      }
    }
  });
};

export const bytesToArchiveArray = (arrayBuffer: ArrayBufferLike) => Uint8Array.from(toUint8Array(arrayBuffer));
