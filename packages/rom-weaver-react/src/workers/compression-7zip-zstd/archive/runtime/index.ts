import { createBrowserOpfsSourceRef } from "../../../protocol/browser-opfs-source-ref.ts";
import { getManagedOpfsFileHandle } from "../../../protocol/opfs-path.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../../shared/worker-storage/storage-layout.ts";
import {
  filterValidPatchEntries as filterValidPatchArchiveEntries,
  filterValidPatchEntriesFromFile as filterValidPatchArchiveEntriesFromFile,
} from "../../shared/archive-patch-validation.ts";
import {
  ARCHIVE_TYPES,
  filterPatchEntries,
  filterRomEntries,
  getArchiveType,
  getBlobSource,
  isArchiveFile,
  SUPPORTED_ARCHIVE_EXTENSION_VALUES,
  toArrayBuffer,
} from "../../shared/archive-utils.ts";
import { isEncryptionUnsupportedError } from "../archive-error-utils.ts";
import { createArchive, createArchiveToFile } from "./archive-create.ts";
import {
  assertFileBackedArchiveSource,
  cleanupExtractedArchiveFiles,
  extractArchivePath,
  extractArchivePathToFile,
  getArchiveSourceFileName,
  listArchivePath,
  withStagedArchiveSource,
} from "./archive-read.ts";
import { isBrowserMainThread } from "./browser-runtime.ts";
import { baseName } from "./fs-utils.ts";
import { configureSevenZip, getSevenZip } from "./sevenzip-runtime.ts";
import type {
  ArchiveEntryList,
  ArchiveReadOptions,
  ArchiveSource,
  ExtractedArchiveEntryFile,
  RootWithSevenZip,
} from "./types.ts";

const root = (typeof globalThis === "undefined" ? self : globalThis) as RootWithSevenZip;
const ARCHIVE_OPFS_MOUNTPOINT = WORKER_OPFS_MOUNTPOINT;

const cleanupFiles = (filePaths?: string[]) => cleanupExtractedArchiveFiles(filePaths);

const isFileSystemFileHandleSource = (source: RuntimeValue): source is FileSystemFileHandle =>
  typeof FileSystemFileHandle !== "undefined" && source instanceof FileSystemFileHandle;

const getBrowserMainThreadArchiveSource = async (
  source: ArchiveSource,
): Promise<{ cleanup: () => Promise<void>; fileName: string; filePath: string } | null> => {
  if (!isBrowserMainThread()) return null;
  if (isFileSystemFileHandleSource(source)) {
    const file = await source.getFile();
    const fileName = getArchiveSourceFileName(source, file.name || "archive.bin");
    return createBrowserOpfsSourceRef(source, fileName, {
      bucket: "input",
      mountPoint: ARCHIVE_OPFS_MOUNTPOINT,
      pathPrefix: "7zip-zstd-runtime-input",
    });
  }
  const blobSource = getBlobSource(source);
  if (!(typeof Blob !== "undefined" && blobSource instanceof Blob)) return null;
  return createBrowserOpfsSourceRef(blobSource, getArchiveSourceFileName(source), {
    bucket: "input",
    mountPoint: ARCHIVE_OPFS_MOUNTPOINT,
    pathPrefix: "7zip-zstd-runtime-input",
  });
};

const extractEntryInBrowserWorker = async (
  source: ArchiveSource,
  entryName: string,
  options?: ArchiveReadOptions,
): Promise<Uint8Array | null> => {
  const archiveSource = await getBrowserMainThreadArchiveSource(source);
  if (!archiveSource) return null;
  const { extractArchiveEntryInBrowserWorker } = await import("../../../protocol/compression-archive-worker.ts");
  let result: Awaited<ReturnType<typeof extractArchiveEntryInBrowserWorker>> | null = null;
  try {
    result = await extractArchiveEntryInBrowserWorker(
      {
        entryName,
        fileName: archiveSource.fileName,
        filePath: archiveSource.filePath,
      },
      options?.onProgress,
    );
    if (result.file) throw new Error("Archive worker returned a binary payload");
    const outputFilePath = result.outputRef?.filePath || result.filePath;
    if (!(outputFilePath && result.outputRef?.kind === "opfs"))
      throw new Error(`Archive entry not found: ${entryName}`);
    const fileHandle = await getManagedOpfsFileHandle(outputFilePath, {
      navigatorObject: navigator,
    });
    if (!fileHandle) throw new Error(`Archive entry not found: ${entryName}`);
    const file = await fileHandle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } finally {
    await Promise.resolve(result?.cleanup?.()).catch(() => undefined);
    await archiveSource.cleanup().catch(() => undefined);
  }
};

const extractEntryToFileInBrowserWorker = async (
  source: ArchiveSource,
  entryName: string,
  options?: ArchiveReadOptions,
): Promise<ExtractedArchiveEntryFile | null> => {
  const archiveSource = await getBrowserMainThreadArchiveSource(source);
  if (!archiveSource) return null;
  const { extractArchiveEntryInBrowserWorker } = await import("../../../protocol/compression-archive-worker.ts");
  try {
    const result = await extractArchiveEntryInBrowserWorker(
      {
        entryName,
        fileName: archiveSource.fileName,
        filePath: archiveSource.filePath,
      },
      options?.onProgress,
    );
    if (result.file) throw new Error("Archive worker returned a binary payload");
    const outputFilePath = result.outputRef?.filePath || result.filePath;
    let outputFile: File | undefined;
    let outputFileHandle: FileSystemFileHandle | undefined;
    if (outputFilePath && result.outputRef?.kind === "opfs") {
      const fileHandle = await getManagedOpfsFileHandle(outputFilePath, {
        navigatorObject: navigator,
      });
      if (!fileHandle) throw new Error(`Archive entry not found: ${entryName}`);
      outputFileHandle = fileHandle;
      outputFile = await fileHandle.getFile();
    }
    if (!outputFile) throw new Error(`Archive entry not found: ${entryName}`);
    return {
      cleanup: result.cleanup,
      cleanupPaths: result.cleanupPaths || undefined,
      ...(outputFile ? { file: outputFile } : null),
      ...(outputFileHandle ? { fileHandle: outputFileHandle } : null),
      fileName: result.fileName || baseName(entryName) || "archive-entry.bin",
      ...(outputFilePath ? { filePath: outputFilePath } : null),
      size: outputFile?.size || result.outputRef?.size || 0,
    };
  } finally {
    await archiveSource.cleanup().catch(() => undefined);
  }
};

const extractEntryFromFile = (source: ArchiveSource, entryName: string, options?: ArchiveReadOptions) =>
  Promise.resolve()
    .then(() => assertFileBackedArchiveSource(source))
    .then(async () => {
      const extractedInWorker = await extractEntryInBrowserWorker(source, entryName, options);
      if (extractedInWorker) return extractedInWorker;
      return null;
    })
    .then(
      (extractedInWorker) =>
        extractedInWorker ||
        withStagedArchiveSource(source, (sevenZip, archivePath, workDir) =>
          extractArchivePath(sevenZip, archivePath, entryName, workDir, options),
        ),
    );

const extractEntryToFile = (source: ArchiveSource, entryName: string, options?: ArchiveReadOptions) =>
  Promise.resolve()
    .then(() => assertFileBackedArchiveSource(source))
    .then(async () => {
      const workerResult = await extractEntryToFileInBrowserWorker(source, entryName, options);
      if (workerResult) return workerResult;
      return withStagedArchiveSource(source, (sevenZip, archivePath, workDir) =>
        extractArchivePathToFile(sevenZip, archivePath, entryName, workDir, options),
      ).then((result): Promise<ExtractedArchiveEntryFile> | ExtractedArchiveEntryFile => {
        if (result.cleanupPaths?.length && !result.cleanup) result.cleanup = () => cleanupFiles(result.cleanupPaths);
        if (result.file || result.fileHandle) return result;
        const data = result.data;
        if (!data) return result;
        const archiveData = data as Uint8Array;
        const fileName = baseName(entryName) || "archive-entry.bin";
        const FileConstructor = root?.File || (typeof File === "function" ? File : null);
        if (FileConstructor) {
          return {
            ...result,
            data: archiveData,
            file: new FileConstructor([archiveData as BlobPart], fileName, {
              type: "application/octet-stream",
            }),
            fileName,
            size: archiveData.byteLength,
          };
        }
        return {
          ...result,
          data: archiveData,
          fileName,
          size: archiveData.byteLength,
        };
      });
    });

const listEntriesFromFile = (source: ArchiveSource, options?: ArchiveReadOptions) =>
  Promise.resolve()
    .then(() => assertFileBackedArchiveSource(source))
    .then(async () => {
      const archiveSource = await getBrowserMainThreadArchiveSource(source);
      if (!archiveSource) return null;
      const { readArchiveDirectoryInBrowserWorker } = await import("../../../protocol/compression-archive-worker.ts");
      try {
        return await readArchiveDirectoryInBrowserWorker({
          fileName: archiveSource.fileName,
          filePath: archiveSource.filePath,
        });
      } finally {
        await archiveSource.cleanup().catch(() => undefined);
      }
    })
    .then(
      (entries) =>
        entries ||
        withStagedArchiveSource(source, (sevenZip, archivePath, workDir, fileName) =>
          listArchivePath(sevenZip, archivePath, workDir, fileName, 0, options),
        ),
    );

const archivePatchValidationCapabilities = {
  extractEntryFromFile,
  extractEntryToFile,
};

const filterValidPatchEntries = (arrayBuffer: ArrayBufferLike, entries: ArchiveEntryList) =>
  filterValidPatchArchiveEntries({
    archiveCapabilities: archivePatchValidationCapabilities as Parameters<
      typeof filterValidPatchArchiveEntries
    >[0]["archiveCapabilities"],
    arrayBuffer,
    entries,
  });

const filterValidPatchEntriesFromFile = (source: ArchiveSource, entries: ArchiveEntryList) =>
  filterValidPatchArchiveEntriesFromFile({
    archiveCapabilities: archivePatchValidationCapabilities as Parameters<
      typeof filterValidPatchArchiveEntriesFromFile
    >[0]["archiveCapabilities"],
    entries,
    source: source as string | Blob | { _file?: Blob | null },
  });

const warmup = () => getSevenZip().then(() => undefined);

export {
  ARCHIVE_TYPES,
  cleanupFiles,
  configureSevenZip as configure,
  createArchive,
  createArchiveToFile,
  extractEntryFromFile,
  extractEntryToFile,
  filterPatchEntries,
  filterRomEntries,
  filterValidPatchEntries,
  filterValidPatchEntriesFromFile,
  getArchiveType,
  isArchiveFile,
  isEncryptionUnsupportedError,
  listEntriesFromFile,
  SUPPORTED_ARCHIVE_EXTENSION_VALUES,
  toArrayBuffer,
  warmup,
};
