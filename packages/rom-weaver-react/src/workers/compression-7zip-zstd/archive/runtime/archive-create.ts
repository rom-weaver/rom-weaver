import type { EmscriptenWorkerModule } from "../../../shared/wasm/emscripten-types.ts";
import { createCoveredByteRangeTracker, mapBytesToPercentRange } from "../../../shared/wasm-tool-runtime-utils.ts";
import { createOpfsOutputManager } from "../../../shared/worker-storage/opfs-manager.ts";
import { getWorkerStorageBucketPath, WORKER_OPFS_MOUNTPOINT } from "../../../shared/worker-storage/storage-layout.ts";
import type { WorkerOpfsManager } from "../../../shared/worker-storage/types.ts";
import { toUint8Array } from "../../shared/archive-utils.ts";
import {
  baseName,
  isDirectoryMode,
  joinFsPath,
  mkdirTree,
  normalizeEntryPath,
  parentDir,
  removeTree,
  TEXT_ENCODER,
} from "./fs-utils.ts";
import {
  createMonotonicProgressEmitter,
  emitSevenZipProgressSequence,
  inspectSevenZipCliProgress,
  SEVEN_ZIP_PROGRESS_SWITCHES,
  SEVEN_ZIP_REPLAY_FRAME_DELAY_MS,
} from "./sevenzip-progress.ts";
import { normalizeThreadCount, runSevenZip, withSevenZip } from "./sevenzip-runtime.ts";
import type {
  ArchiveCreatedFile,
  ArchiveCreateEntry,
  ArchiveCreateOptions,
  BlobLike,
  MaterializedCreateEntry,
} from "./types.ts";

const TRAILING_POSIX_SLASHES_REGEX = /\/+$/;
const LEADING_SLASHES_REGEX = /^\/+/;
const UNSUPPORTED_DIRECTORY_WRITE_ERROR_REGEX = /errno=138|not supported/i;
const MEMORY_FAILURE_ERROR_REGEX = /status 8|not enough memory|cannot allocate memory|out of memory|memory/i;
const ARCHIVE_OPFS_MOUNTPOINT = WORKER_OPFS_MOUNTPOINT;
const SEVEN_ZIP_READ_PROGRESS_END_PERCENT = 95;

let archiveCreateWorkId = 0;
let archiveCreateOpfsManagerPromise: Promise<WorkerOpfsManager | null> | null = null;

type ArchiveFs = Parameters<typeof mkdirTree>[0];
type ArchiveRead = NonNullable<ArchiveFs["read"]>;
type ArchiveReadStream = Parameters<ArchiveRead>[0];
type SevenZipModule = Parameters<Parameters<typeof withSevenZip>[0]>[0];
type MonotonicProgressEmitter = ReturnType<typeof createMonotonicProgressEmitter>;
type SevenZipCreateProgressCommand = {
  endPercent: number;
  inputRoot: string;
  outputPath: string;
  relativePaths: string[];
  retryWithoutThreadSwitch?: boolean;
  run: (runtime?: { threaded?: boolean | null } | null) => ReturnType<typeof runSevenZip>;
  startPercent: number;
};

const getNavigatorObject = (): Navigator | null => (typeof navigator === "undefined" ? null : (navigator as Navigator));

const asEmscriptenModule = (sevenZip: Parameters<Parameters<typeof withSevenZip>[0]>[0]) =>
  sevenZip as unknown as EmscriptenWorkerModule;

const normalizeFsPath = (FS: ArchiveFs, filePath: string | null | undefined) => {
  const rawPath = String(filePath || "");
  if (!rawPath) return "";
  const absolutePath = rawPath.startsWith("/") ? rawPath : joinFsPath(FS.cwd(), rawPath);
  const parts: string[] = [];
  for (const part of absolutePath.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
};

const getReadStreamPath = (FS: ArchiveFs, stream: ArchiveReadStream) => {
  if (stream?.node && typeof FS.getPath === "function") {
    try {
      const nodePath = FS.getPath(stream.node);
      if (nodePath) return normalizeFsPath(FS, nodePath);
    } catch (_error) {
      /* fall back to stream.path */
    }
  }
  return normalizeFsPath(FS, stream?.path);
};

const installSevenZipReadProgress = (
  sevenZip: SevenZipModule,
  inputRoot: string,
  relativePaths: string[],
  options: ArchiveCreateOptions | undefined,
  progressEmitter: MonotonicProgressEmitter,
  range: { endPercent: number; startPercent: number },
) => {
  const FS = sevenZip.FS;
  const originalRead = FS.read;
  if (!(options?.onProgress && typeof originalRead === "function")) return () => undefined;

  const trackedFiles = new Map<
    string,
    {
      coveredBytes: number;
      tracker: ReturnType<typeof createCoveredByteRangeTracker>;
    }
  >();
  let totalBytes = 0;
  let totalCoveredBytes = 0;
  for (const relativePath of relativePaths) {
    const filePath = normalizeFsPath(FS, joinFsPath(inputRoot, relativePath));
    try {
      const stat = FS.stat(filePath);
      if (isDirectoryMode(FS, stat.mode)) continue;
      const size = Math.max(0, Number(stat.size || 0));
      if (!(size > 0)) continue;
      trackedFiles.set(filePath, {
        coveredBytes: 0,
        tracker: createCoveredByteRangeTracker(size),
      });
      totalBytes += size;
    } catch (_error) {
      /* ignore files 7-Zip can resolve but the progress tracker cannot stat */
    }
  }

  if (!(totalBytes > 0 && trackedFiles.size > 0)) return () => undefined;

  FS.read = function trackedRead(this: ArchiveFs, stream, buffer, offset, length, position) {
    let readStart = 0;
    if (typeof position === "number") readStart = position;
    else if (typeof stream?.position === "number") readStart = Math.max(0, stream.position);
    const bytesRead = originalRead.call(this || FS, stream, buffer, offset, length, position);
    if (bytesRead > 0) {
      const tracked = trackedFiles.get(getReadStreamPath(FS, stream));
      if (tracked) {
        const nextCoveredBytes = tracked.tracker.add(readStart, readStart + bytesRead);
        if (nextCoveredBytes !== null && nextCoveredBytes > tracked.coveredBytes) {
          totalCoveredBytes += nextCoveredBytes - tracked.coveredBytes;
          tracked.coveredBytes = nextCoveredBytes;
          progressEmitter.emit(
            mapBytesToPercentRange(totalCoveredBytes, totalBytes, range.startPercent, range.endPercent),
            {
              loaded: totalCoveredBytes,
              progressSource: "7zip-read",
              total: totalBytes,
            },
          );
        }
      }
    }
    return bytesRead;
  };

  return () => {
    FS.read = originalRead;
  };
};

const getArchiveCreateOpfsManager = async (sevenZip: Parameters<Parameters<typeof withSevenZip>[0]>[0]) => {
  if (!archiveCreateOpfsManagerPromise) {
    archiveCreateOpfsManagerPromise = createOpfsOutputManager({
      moduleObject: asEmscriptenModule(sevenZip),
      mountPoint: ARCHIVE_OPFS_MOUNTPOINT,
      navigatorObject: getNavigatorObject(),
    }).catch(() => null);
  }
  const manager = await archiveCreateOpfsManagerPromise;
  if (!(manager && manager.ensureMounted(asEmscriptenModule(sevenZip)))) return null;
  return manager;
};

const parseWriterOptions = (options?: string | null) => {
  const result: Record<string, string> = {};
  for (const part of String(options || "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) result[trimmed.toLowerCase()] = "true";
    else result[trimmed.slice(0, separatorIndex).trim().toLowerCase()] = trimmed.slice(separatorIndex + 1).trim();
  }
  return result;
};

const normalizeArchiveCreateFormat = (format?: string | null) => {
  const normalized = String(format || "zip")
    .trim()
    .toLowerCase();
  if (normalized === "7zip" || normalized === "7z") return "7z";
  if (normalized === "zip" || normalized === "zipx") return "zip";
  if (normalized === "tar" || normalized === "ustar" || normalized === "pax") return "tar";
  if (normalized === "cpio") return "cpio";
  throw new Error(`Unsupported archive format: ${format}`);
};

const normalizeArchiveFilter = (filter?: string | null) => {
  const normalized = String(filter || "none")
    .trim()
    .toLowerCase();
  if (normalized === "none" || normalized === "") return null;
  if (normalized === "gzip" || normalized === "gz") return "gzip";
  if (normalized === "bzip2" || normalized === "bz2") return "bzip2";
  if (normalized === "xz") return "xz";
  if (normalized === "lzma") return "lzma";
  throw new Error(`Unsupported archive filter: ${filter}`);
};

const getArchiveOutputPath = (workDir: string, format: string, filter?: string | null) => {
  if (format === "7z") return joinFsPath(workDir, "archive.7z");
  if (format === "zip") return joinFsPath(workDir, "archive.zip");
  if (format === "cpio") return joinFsPath(workDir, "archive.cpio");
  if (filter === "gzip") return joinFsPath(workDir, "archive.tar.gz");
  if (filter === "bzip2") return joinFsPath(workDir, "archive.tar.bz2");
  if (filter === "xz") return joinFsPath(workDir, "archive.tar.xz");
  if (filter === "lzma") return joinFsPath(workDir, "archive.tar.lzma");
  return joinFsPath(workDir, "archive.tar");
};

const getThreadSwitchValue = (
  threads: string | undefined,
  runtime?: { threaded?: boolean | null } | null,
): number | null => {
  if (!threads) return null;
  const normalizedThreads = normalizeThreadCount(threads) || 1;
  if (runtime?.threaded === false) return null;
  return normalizedThreads;
};

const hasMultiThreadSwitchRequest = (options?: string | null) => {
  const threads = parseWriterOptions(options).threads;
  if (!threads) return false;
  try {
    return (normalizeThreadCount(threads) || 1) > 1;
  } catch (_error) {
    return false;
  }
};

const shouldRetryWithoutThreadSwitch = (err: unknown, options?: string | null) => {
  if (!hasMultiThreadSwitchRequest(options)) return false;
  const status =
    err && typeof err === "object" && "wasmTool" in err
      ? Number((err as { wasmTool?: { status?: number | null } }).wasmTool?.status)
      : NaN;
  if (status === 8) return true;
  const message = err instanceof Error ? err.message : String(err || "");
  return UNSUPPORTED_DIRECTORY_WRITE_ERROR_REGEX.test(message) || MEMORY_FAILURE_ERROR_REGEX.test(message);
};

const getCompressionSwitches = (
  format: string,
  options?: string | null,
  runtime?: { threaded?: boolean | null } | null,
) => {
  const parsed = parseWriterOptions(options);
  const compression = String(parsed.compression || (format === "zip" ? "deflate" : "lzma2")).toLowerCase();
  const level = parsed["compression-level"];
  const password = parsed.password ?? parsed.passphrase;
  const threads = getThreadSwitchValue(parsed.threads, runtime);
  const switches: string[] = [];
  if (format === "zip") {
    if (compression === "store" || compression === "none") switches.push("-mx0");
    else if (compression === "zstd") switches.push("-mm=ZSTD", `-mx=${level || 9}`);
    else if (compression === "deflate") switches.push("-mm=Deflate", `-mx=${level || 9}`);
    else throw new Error(`Unsupported ZIP compression: ${compression}`);
  } else if (format === "7z") {
    if (compression === "zstd") switches.push("-m0=zstd", `-mx=${level || 9}`);
    else if (compression === "lzma2") switches.push("-m0=lzma2", `-mx=${level || 9}`);
    else if (compression === "store" || compression === "copy" || compression === "none") switches.push("-m0=Copy");
    else throw new Error(`Unsupported 7z compression: ${compression}`);
  }
  if ((format === "zip" || format === "7z") && password !== undefined) switches.push(`-p${String(password)}`);
  if (threads) switches.push(`-mmt=${threads}`);
  return switches;
};

const materializeCreateEntry = async (entry: ArchiveCreateEntry): Promise<MaterializedCreateEntry> => {
  const filename = normalizeEntryPath(String(entry.filename || entry.fileName || entry.name || ""));
  const directory = entry.directory === true || filename.endsWith("/");
  const mtime =
    typeof entry.mtime === "number"
      ? entry.mtime
      : (() => {
          if (typeof entry.lastModified === "number") {
            return Math.floor(entry.lastModified / 1000);
          }
          return Math.floor(Date.now() / 1000);
        })();
  if (directory) return { data: new Uint8Array(0), directory, filename, mtime };
  if (entry.filePath)
    return {
      data: new Uint8Array(0),
      directory,
      filename,
      filePath: entry.filePath,
      mtime,
    };
  if (entry.data && typeof (entry.data as BlobLike).arrayBuffer === "function")
    return {
      data: new Uint8Array(await (entry.data as BlobLike).arrayBuffer()),
      directory,
      filename,
      mtime,
    };
  if (entry.data !== undefined)
    return {
      data: Uint8Array.from(toUint8Array(entry.data)),
      directory,
      filename,
      mtime,
    };
  if (entry.arrayBuffer !== undefined)
    return {
      data: Uint8Array.from(toUint8Array(entry.arrayBuffer)),
      directory,
      filename,
      mtime,
    };
  if (entry.u8array !== undefined) return { data: Uint8Array.from(entry.u8array), directory, filename, mtime };
  if (entry.text !== undefined)
    return {
      data: TEXT_ENCODER.encode(String(entry.text)),
      directory,
      filename,
      mtime,
    };
  if (entry.file && typeof entry.file.arrayBuffer === "function")
    return {
      data: new Uint8Array(await entry.file.arrayBuffer()),
      directory,
      filename,
      mtime,
    };
  return { data: new Uint8Array(0), directory, filename, mtime };
};

const materializeCreateEntries = (entries: ArchiveCreateEntry[]) => Promise.all(entries.map(materializeCreateEntry));

const reportCreateProgress = (
  onProgress: ArchiveCreateOptions["onProgress"],
  loaded: number,
  total: number,
  complete = false,
  maxPercent = 95,
) => {
  if (!onProgress) return;
  const percent = complete
    ? 100
    : (() => {
        if (total > 0) {
          return Math.min(maxPercent, (loaded / total) * maxPercent);
        }
        return 0;
      })();
  onProgress({ loaded, percent, total });
};

const getCreateEntriesDataByteLength = (entries: MaterializedCreateEntry[]) =>
  entries.reduce((sum, entry) => sum + (entry.directory ? 0 : entry.fileSize || entry.data.byteLength), 0);

const stageCreateEntries = async (
  sevenZip: Parameters<Parameters<typeof withSevenZip>[0]>[0],
  FS: Parameters<typeof mkdirTree>[0],
  inputRoot: string,
  entries: MaterializedCreateEntry[],
) => {
  const relativePaths: string[] = [];
  const cleanupPaths: string[] = [];
  const manager: WorkerOpfsManager | null = entries.some((entry) => entry.filePath)
    ? await getArchiveCreateOpfsManager(sevenZip)
    : null;
  const activeInputRoot = manager
    ? getWorkerStorageBucketPath(
        manager.outputDirectory,
        "input",
        `create-input/${String(archiveCreateWorkId)}`,
        String(archiveCreateWorkId),
      )
    : inputRoot;
  const applyMtime = (entryPath: string, mtime: number) => {
    if (typeof FS.utime !== "function") return;
    const timestamp = Math.max(0, mtime);
    const runtimeTimestamp = typeof FS.isDir === "function" ? timestamp * 1000 : timestamp;
    FS.utime(entryPath, runtimeTimestamp, runtimeTimestamp);
  };
  for (const entry of entries) {
    const entryPath = joinFsPath(activeInputRoot, entry.filename);
    if (entry.directory) {
      mkdirTree(FS, entryPath.replace(TRAILING_POSIX_SLASHES_REGEX, ""));
      relativePaths.push(entry.filename);
      continue;
    }
    mkdirTree(FS, parentDir(entryPath));
    if (entry.filePath) {
      const backend = manager ? await manager.openFile?.(entry.filePath) : null;
      const preparedTarget = manager ? await manager.prepareFile(entryPath) : null;
      if (!(manager && backend && preparedTarget && manager.linkFile?.(entry.filePath, entryPath))) {
        throw new Error(`Archive entry path is not available in worker filesystem storage: ${entry.filename}`);
      }
      entry.fileSize = backend.size || 0;
      cleanupPaths.push(entry.filePath, entryPath);
    } else {
      FS.writeFile(entryPath, entry.data);
      entry.fileSize = entry.data.byteLength;
    }
    applyMtime(entryPath, entry.mtime);
    relativePaths.push(entry.filename);
  }
  return {
    cleanup: async () => {
      if (manager) await manager.cleanup(cleanupPaths);
    },
    inputRoot: activeInputRoot,
    relativePaths,
  };
};

const encodeCpioHex = (value: number) =>
  Math.max(0, value >>> 0)
    .toString(16)
    .padStart(8, "0");

const pushCpioPadding = (chunks: Uint8Array[], length: number) => {
  const padding = (4 - (length % 4)) % 4;
  if (padding) chunks.push(new Uint8Array(padding));
};

const createCpioEntry = (entry: MaterializedCreateEntry, index: number) => {
  const chunks: Uint8Array[] = [];
  const filename = (
    entry.directory ? entry.filename.replace(TRAILING_POSIX_SLASHES_REGEX, "") : entry.filename
  ).replace(LEADING_SLASHES_REGEX, "");
  const nameBytes = TEXT_ENCODER.encode(`${filename}\0`);
  const mode = entry.directory ? 0o040755 : 0o100644;
  const header = [
    "070701",
    encodeCpioHex(index + 1),
    encodeCpioHex(mode),
    encodeCpioHex(0),
    encodeCpioHex(0),
    encodeCpioHex(entry.directory ? 2 : 1),
    encodeCpioHex(entry.mtime),
    encodeCpioHex(entry.directory ? 0 : entry.data.byteLength),
    encodeCpioHex(0),
    encodeCpioHex(0),
    encodeCpioHex(0),
    encodeCpioHex(0),
    encodeCpioHex(nameBytes.byteLength),
    encodeCpioHex(0),
  ].join("");
  chunks.push(TEXT_ENCODER.encode(header), nameBytes);
  pushCpioPadding(chunks, header.length + nameBytes.byteLength);
  if (!entry.directory && entry.data.byteLength) {
    chunks.push(entry.data);
    pushCpioPadding(chunks, entry.data.byteLength);
  }
  return chunks;
};

const createCpioArchive = (entries: MaterializedCreateEntry[], onProgress?: ArchiveCreateOptions["onProgress"]) => {
  const total = getCreateEntriesDataByteLength(entries);
  reportCreateProgress(onProgress, 0, total);
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry) chunks.push(...createCpioEntry(entry, index));
  }
  chunks.push(
    ...createCpioEntry(
      {
        data: new Uint8Array(0),
        directory: false,
        filename: "TRAILER!!!",
        mtime: 0,
      },
      entries.length,
    ),
  );
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const archive = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  reportCreateProgress(onProgress, total, total, true);
  return archive;
};

const getArchiveOutputSize = (FS: Parameters<typeof mkdirTree>[0], outputPath: string) =>
  Math.max(0, Number(FS.stat(outputPath).size || 0));

const toArchiveCreatedFileResult = async (
  manager: WorkerOpfsManager,
  outputPath: string,
  outputFileName: string,
  FS: Parameters<typeof mkdirTree>[0],
): Promise<ArchiveCreatedFile> => {
  const file = await manager.getFile(outputPath).catch(() => null);
  const fileHandle = manager.getFileHandle?.(outputPath) || undefined;
  return {
    cleanupPaths: [outputPath],
    ...(file ? { file } : null),
    ...(fileHandle ? { fileHandle } : null),
    fileName: outputFileName,
    filePath: outputPath,
    size: file?.size || getArchiveOutputSize(FS, outputPath),
  };
};

export const createArchive = (entries: ArchiveCreateEntry[], options?: ArchiveCreateOptions) =>
  Promise.resolve().then(async () => {
    const materializedEntries = await materializeCreateEntries(entries || []);
    const format = normalizeArchiveCreateFormat(options?.format);
    const filter = normalizeArchiveFilter(options?.filter);
    if (format !== "tar" && filter) throw new Error(`Unsupported ${format} archive filter: ${filter}`);
    if (format === "cpio") return createCpioArchive(materializedEntries, options?.onProgress);
    return withSevenZip(async (sevenZip) => {
      const FS = sevenZip.FS;
      const workDir = `/rpjs-7zip-zstd-create-${++archiveCreateWorkId}`;
      const inputRoot = joinFsPath(workDir, "input");
      mkdirTree(FS, inputRoot);
      let stagedEntriesCleanup: (() => Promise<void>) | null = null;
      try {
        const stagedEntries = await stageCreateEntries(sevenZip, FS, inputRoot, materializedEntries);
        stagedEntriesCleanup = stagedEntries.cleanup;
        const sourceBytes = getCreateEntriesDataByteLength(materializedEntries);
        const relativePaths = stagedEntries.relativePaths;
        const archiveInputRoot = stagedEntries.inputRoot;
        if (!relativePaths.length) throw new Error("Archive creation requires at least one entry");
        const outputPath = getArchiveOutputPath(workDir, format, filter);
        if (format === "tar") {
          await runSevenZipTarCreateWithProgress(
            sevenZip,
            archiveInputRoot,
            workDir,
            outputPath,
            relativePaths,
            filter,
            options,
          );
        } else if (format === "7z" || format === "zip") {
          await runSevenZipArchiveCreateWithProgress(
            sevenZip,
            format,
            archiveInputRoot,
            outputPath,
            relativePaths,
            options,
          );
        } else {
          await runSevenZipCreateWithProgress(
            sevenZip,
            [
              {
                endPercent: SEVEN_ZIP_READ_PROGRESS_END_PERCENT,
                inputRoot: archiveInputRoot,
                outputPath,
                relativePaths,
                run: () =>
                  runSevenZip(
                    sevenZip,
                    [
                      "a",
                      `-t${format}`,
                      ...SEVEN_ZIP_PROGRESS_SWITCHES,
                      ...getCompressionSwitches(format, options?.options, sevenZip),
                      outputPath,
                      ...relativePaths,
                    ],
                    archiveInputRoot,
                  ),
                startPercent: 0,
              },
            ],
            options,
          );
        }
        const archive = FS.readFile(outputPath, { encoding: "binary" });
        reportCreateProgress(options?.onProgress, sourceBytes, sourceBytes, true);
        return archive instanceof Uint8Array ? archive : TEXT_ENCODER.encode(archive);
      } finally {
        await stagedEntriesCleanup?.().catch(() => undefined);
        removeTree(FS, workDir);
      }
    });
  });

export const createArchiveToFile = (entries: ArchiveCreateEntry[], options?: ArchiveCreateOptions) =>
  Promise.resolve().then(async () => {
    const outputPath = String(options?.outputPath || "").trim();
    if (!outputPath) throw new Error("Archive direct create sink requires an outputPath");
    const outputFileName = String(options?.outputFileName || baseName(outputPath) || "archive.bin");
    const materializedEntries = await materializeCreateEntries(entries || []);
    const format = normalizeArchiveCreateFormat(options?.format);
    const filter = normalizeArchiveFilter(options?.filter);
    if (format !== "tar" && filter) throw new Error(`Unsupported ${format} archive filter: ${filter}`);
    if (format === "cpio") throw new Error("Archive direct create sink does not support CPIO output");
    return withSevenZip(async (sevenZip) => {
      const manager = await getArchiveCreateOpfsManager(sevenZip);
      if (!manager)
        throw new Error(
          "Archive runtime direct create sink requires mounted managed storage; fallback materialization is disabled",
        );
      const preparedOutput = await manager.prepareFile(outputPath);
      if (!preparedOutput)
        throw new Error(`Archive create output path is not available in worker filesystem storage: ${outputPath}`);
      const FS = sevenZip.FS;
      mkdirTree(FS, parentDir(outputPath));
      try {
        // Keep the prepared backend, but remove any visible file node so 7-Zip creates a fresh archive.
        FS.unlink(outputPath);
      } catch (_error) {
        /* ignore missing output files */
      }
      const workDir = `/rpjs-7zip-zstd-create-${++archiveCreateWorkId}`;
      const inputRoot = joinFsPath(workDir, "input");
      mkdirTree(FS, inputRoot);
      let stagedEntriesCleanup: (() => Promise<void>) | null = null;
      let completed = false;
      try {
        const stagedEntries = await stageCreateEntries(sevenZip, FS, inputRoot, materializedEntries);
        stagedEntriesCleanup = stagedEntries.cleanup;
        const sourceBytes = getCreateEntriesDataByteLength(materializedEntries);
        const relativePaths = stagedEntries.relativePaths;
        const archiveInputRoot = stagedEntries.inputRoot;
        if (!relativePaths.length) throw new Error("Archive creation requires at least one entry");
        if (format === "tar") {
          await runSevenZipTarCreateWithProgress(
            sevenZip,
            archiveInputRoot,
            workDir,
            outputPath,
            relativePaths,
            filter,
            options,
          );
        } else if (format === "7z" || format === "zip") {
          await runSevenZipArchiveCreateWithProgress(
            sevenZip,
            format,
            archiveInputRoot,
            outputPath,
            relativePaths,
            options,
          );
        } else {
          await runSevenZipCreateWithProgress(
            sevenZip,
            [
              {
                endPercent: SEVEN_ZIP_READ_PROGRESS_END_PERCENT,
                inputRoot: archiveInputRoot,
                outputPath,
                relativePaths,
                run: () =>
                  runSevenZip(
                    sevenZip,
                    [
                      "a",
                      `-t${format}`,
                      ...SEVEN_ZIP_PROGRESS_SWITCHES,
                      ...getCompressionSwitches(format, options?.options, sevenZip),
                      outputPath,
                      ...relativePaths,
                    ],
                    archiveInputRoot,
                  ),
                startPercent: 0,
              },
            ],
            options,
          );
        }
        reportCreateProgress(options?.onProgress, sourceBytes, sourceBytes, true);
        const result = await toArchiveCreatedFileResult(manager, outputPath, outputFileName, FS);
        completed = true;
        return result;
      } finally {
        await stagedEntriesCleanup?.().catch(() => undefined);
        removeTree(FS, workDir);
        if (!completed) await manager.cleanup([outputPath]).catch(() => undefined);
      }
    });
  });

const runSevenZipCreateWithProgress = async (
  sevenZip: SevenZipModule,
  commands: SevenZipCreateProgressCommand[],
  options?: ArchiveCreateOptions,
) => {
  const progressEmitter = createMonotonicProgressEmitter(options, "Creating archive...", {
    baseFields: { type: "progress" },
    minIntervalMs: SEVEN_ZIP_REPLAY_FRAME_DELAY_MS,
    minPercentDelta: 1,
  });
  const sevenZipOutput = sevenZip.__romWeaverSevenZipZstdOutput;
  const previousStderrProgress = sevenZipOutput?.onStderrProgress || null;
  const setLiveStderrProgress = (command: SevenZipCreateProgressCommand) => {
    if (!sevenZipOutput) return;
    sevenZipOutput.onStderrProgress = (percent) => {
      progressEmitter.emit(
        mapBytesToPercentRange(Math.max(0, Math.min(100, percent)), 100, command.startPercent, command.endPercent),
        { progressSource: "7zip-stderr" },
      );
    };
  };
  const restoreLiveStderrProgress = () => {
    if (sevenZipOutput) sevenZipOutput.onStderrProgress = previousStderrProgress;
  };
  const removePartialOutput = (command: SevenZipCreateProgressCommand) => {
    try {
      sevenZip.FS.unlink(command.outputPath);
    } catch (_error) {
      /* ignore cleanup errors */
    }
  };
  const runWithProgress = (command: SevenZipCreateProgressCommand) => {
    setLiveStderrProgress(command);
    const restoreReadProgress = installSevenZipReadProgress(
      sevenZip,
      command.inputRoot,
      command.relativePaths,
      options,
      progressEmitter,
      {
        endPercent: command.endPercent,
        startPercent: command.startPercent,
      },
    );
    try {
      return command.run();
    } catch (err) {
      if (!(command.retryWithoutThreadSwitch && shouldRetryWithoutThreadSwitch(err, options?.options))) throw err;
      removePartialOutput(command);
      return command.run({ threaded: false });
    } finally {
      restoreReadProgress();
      restoreLiveStderrProgress();
    }
  };

  for (const command of commands) {
    const result = runWithProgress(command);
    if (progressEmitter.hasIntermediate()) continue;
    const cliProgress = inspectSevenZipCliProgress(result);
    if (cliProgress.useful) {
      await emitSevenZipProgressSequence(options?.onProgress, "Creating archive...", cliProgress.percents, {
        endPercent: command.endPercent,
        progressSource: "7zip-cli",
        progressStream: cliProgress.stream,
        startPercent: command.startPercent,
      });
    }
  }
};

const runSevenZipArchiveCreateWithProgress = (
  sevenZip: SevenZipModule,
  format: "7z" | "zip",
  inputRoot: string,
  outputPath: string,
  relativePaths: string[],
  options?: ArchiveCreateOptions,
) =>
  runSevenZipCreateWithProgress(
    sevenZip,
    [
      {
        endPercent: SEVEN_ZIP_READ_PROGRESS_END_PERCENT,
        inputRoot,
        outputPath,
        relativePaths,
        retryWithoutThreadSwitch: true,
        run: (runtime) =>
          runSevenZip(
            sevenZip,
            [
              "a",
              `-t${format}`,
              ...SEVEN_ZIP_PROGRESS_SWITCHES,
              ...getCompressionSwitches(format, options?.options, runtime || sevenZip),
              outputPath,
              ...relativePaths,
            ],
            inputRoot,
          ),
        startPercent: 0,
      },
    ],
    options,
  );

const runSevenZipTarCreateWithProgress = (
  sevenZip: SevenZipModule,
  inputRoot: string,
  workDir: string,
  outputPath: string,
  relativePaths: string[],
  filter: string | null,
  options?: ArchiveCreateOptions,
) => {
  const tarPath = filter ? joinFsPath(workDir, "archive.tar") : outputPath;
  const tarEndPercent = filter ? 50 : SEVEN_ZIP_READ_PROGRESS_END_PERCENT;
  const commands: SevenZipCreateProgressCommand[] = [
    {
      endPercent: tarEndPercent,
      inputRoot,
      outputPath: tarPath,
      relativePaths,
      run: () =>
        runSevenZip(sevenZip, ["a", "-ttar", ...SEVEN_ZIP_PROGRESS_SWITCHES, tarPath, ...relativePaths], inputRoot),
      startPercent: 0,
    },
  ];
  if (filter) {
    const tarFileName = baseName(tarPath);
    commands.push({
      endPercent: SEVEN_ZIP_READ_PROGRESS_END_PERCENT,
      inputRoot: workDir,
      outputPath,
      relativePaths: [tarFileName],
      run: () =>
        runSevenZip(
          sevenZip,
          ["a", `-t${filter === "bzip2" ? "bzip2" : filter}`, ...SEVEN_ZIP_PROGRESS_SWITCHES, outputPath, tarFileName],
          workDir,
        ),
      startPercent: tarEndPercent,
    });
  }
  return runSevenZipCreateWithProgress(sevenZip, commands, options);
};
