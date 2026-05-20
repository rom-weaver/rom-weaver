import type { ArchiveSourceValue } from "../../storage/browser/archive-source.ts";
import { createPatchFileFromSource } from "../../storage/shared/binary/binary-source-utils.ts";
import {
  getNamedSource,
  getNamedSourceFileName,
  getNamedSourcePath,
  getNamedSourceSize,
} from "../../storage/shared/binary/source-file-utils.ts";
import { createCleanupOnce as createStorageCleanupOnce } from "../../storage/shared/disposal.ts";
import { isVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type { ArchiveEntry, ArchiveExtractionResult, ProgressCallback } from "../../types/runtime.ts";
import type { DirectSource, SourceRef } from "../../types/source.ts";
import type { CompressionEntryInfo } from "../../types/workflow-runtime.ts";
import {
  configure as configureArchiveCapabilities,
  createArchive,
  extractEntryFromFile,
  extractEntryToFile,
  filterValidPatchEntries as filterValidPatchArchiveEntries,
  filterValidPatchEntriesFromFile,
  listEntriesFromFile,
  toArrayBuffer,
  warmup,
} from "../../workers/protocol/archive-runtime.ts";
import type {
  PatchFileInstance,
  PatchFileConstructor as SharedPatchFileType,
} from "../../workers/protocol/patch-engine.ts";
import { PatchFile as SharedPatchFile } from "../../workers/protocol/patch-engine.ts";
import type { createArchiveOutputData } from "../output/archive-output.ts";
import { normalizeArchiveEntryBytes } from "../output/archive-output.ts";
import { extractArchiveBufferEntry, type listArchiveBufferEntries } from "./archive-input.ts";
import type { filterValidPatchEntries } from "./archive-patch-validation.ts";
import { getFileNameWithoutExtension } from "./path-utils.ts";

type ArchiveBufferCapabilities = Parameters<typeof listArchiveBufferEntries>[0]["ArchiveManager"];
type PatchValidationArchiveCapabilities = Parameters<typeof filterValidPatchEntries>[0]["archiveCapabilities"];
type ArchiveOutputCapabilities = Parameters<typeof createArchiveOutputData>[0]["ArchiveManager"];
type ArchiveCapabilitiesWithArrayBuffer = ArchiveBufferCapabilities &
  PatchValidationArchiveCapabilities & {
    createArchive: ArchiveOutputCapabilities["createArchive"];
    configure?: ArchiveOutputCapabilities["configure"];
    extractEntryToFile: (
      source: string | Blob | FileSystemFileHandle | { _file?: Blob | null },
      entryName: string,
      options?: { onProgress?: ProgressCallback },
    ) => Promise<ArchiveExtractionResult>;
    filterValidPatchEntriesFromFile: (
      source: string | Blob | { _file?: Blob | null },
      entries: ArchiveEntry[],
    ) => Promise<ArchiveEntry[]>;
    toArrayBuffer: (
      data: Blob | ArrayBuffer | Uint8Array | ArrayBufferView,
    ) => ArrayBuffer | Uint8Array | ArrayBufferView;
  };
type ServicePatchFileConstructor = SharedPatchFileType<PatchFileInstance> &
  Parameters<typeof createPatchFileFromSource>[1] &
  (new (
    source: ArrayBuffer | ArrayBufferView | Blob | File | number | string | PatchFileInstance,
  ) => PatchFileInstance);
type CleanablePatchFile = PatchFileInstance & {
  _browserFileBacked?: boolean;
  _cleanup?: () => Promise<void> | void;
  _lazyExternalSource?: boolean;
  _file?: Blob;
  _fileHandle?: FileSystemFileHandle | null;
  _sourceRef?: PatchFileSourceRef | null;
};
type BlobBackedPatchFileOptions = {
  materialize?: boolean;
};

type PatchFileSourceRef = {
  fileName: string;
  size?: number;
  source: DirectSource;
};

type LazyExternalPatchFileOptions = {
  cleanup?: () => Promise<void> | void;
  fileHandle?: FileSystemFileHandle | null;
  filePath?: string;
  fileType?: string;
  size?: number;
};
type ExternalSourceOptions = {
  preferDirectBrowserSource?: boolean;
};
type PatchFileSourceAccess = {
  fileName: string;
  size?: number;
  getBlob: () => Blob | null;
  getExternalSource: (options?: ExternalSourceOptions) => PatchFileSourceRef | null;
  getFileHandle: () => FileSystemFileHandle | null;
  getFilePath: () => string | null;
};

const ArchiveCapabilities = {
  configure: configureArchiveCapabilities,
  createArchive,
  extractEntryFromFile,
  extractEntryToFile,
  filterValidPatchEntries: filterValidPatchArchiveEntries,
  filterValidPatchEntriesFromFile,
  listEntriesFromFile,
  toArrayBuffer,
  warmup,
} as RuntimeValue as ArchiveCapabilitiesWithArrayBuffer;
const PatchFile = SharedPatchFile as RuntimeValue as ServicePatchFileConstructor;

const createPatchFile = async (
  source: Parameters<typeof createPatchFileFromSource>[0],
  fallbackFileName: string,
): Promise<PatchFileInstance> => {
  return createPatchFileFromSource(source, PatchFile, {
    fallback: fallbackFileName,
  }) as Promise<PatchFileInstance>;
};

const getDefaultCreatePatchOutputFileName = (fileName: string | undefined, format: string) => {
  const normalizedFileName = String(fileName || "").trim();
  if (!normalizedFileName) return `patch.${format}`;
  return `${getFileNameWithoutExtension(normalizedFileName)}.${format}`;
};

const isFileSystemFileHandleLike = (value: unknown): value is FileSystemFileHandle =>
  !!value &&
  typeof value === "object" &&
  (value as { kind?: unknown }).kind === "file" &&
  typeof (value as { getFile?: unknown }).getFile === "function";

const decodeUtf8 = (data: Uint8Array) => new TextDecoder().decode(data);

const normalizePatchFileSourceRef = (
  sourceRef: PatchFileSourceRef | null | undefined,
  fallbackFileName?: string,
  fallbackSize?: number,
): PatchFileSourceRef | null => {
  if (!(sourceRef && typeof sourceRef === "object")) return null;
  const directSource = sourceRef.source;
  if (
    !(
      (typeof directSource === "string" && directSource.trim()) ||
      (typeof Blob !== "undefined" && directSource instanceof Blob) ||
      isFileSystemFileHandleLike(directSource) ||
      isVfsFileRef(directSource)
    )
  )
    return null;
  const fileName =
    (typeof sourceRef.fileName === "string" && sourceRef.fileName) ||
    (typeof fallbackFileName === "string" && fallbackFileName) ||
    "";
  if (!fileName) return null;
  const size =
    typeof sourceRef.size === "number" && Number.isFinite(sourceRef.size)
      ? Math.max(0, Math.floor(sourceRef.size))
      : typeof fallbackSize === "number" && Number.isFinite(fallbackSize)
        ? Math.max(0, Math.floor(fallbackSize))
        : undefined;
  return {
    ...(size === undefined ? {} : { size }),
    fileName,
    source: directSource,
  };
};

const attachPatchFileSourceRef = (
  file: PatchFileInstance,
  sourceRef: PatchFileSourceRef | null | undefined,
): PatchFileInstance => {
  const normalizedSourceRef = normalizePatchFileSourceRef(sourceRef, file.fileName || undefined, file.fileSize);
  const cleanable = file as CleanablePatchFile;
  if (normalizedSourceRef) cleanable._sourceRef = normalizedSourceRef;
  else delete cleanable._sourceRef;
  return file;
};

const getPatchFileSourceRef = (file: PatchFileInstance, fallbackFileName?: string): PatchFileSourceRef | null =>
  normalizePatchFileSourceRef(
    (file as CleanablePatchFile)._sourceRef,
    file.fileName || fallbackFileName,
    file.fileSize,
  );

const clonePatchFile = (file: PatchFileInstance, fileName?: string): PatchFileInstance => {
  const cloned = new PatchFile(file);
  cloned.fileName = fileName || file.fileName;
  const original = file as CleanablePatchFile;
  const clonedCleanable = cloned as CleanablePatchFile;
  if (original._browserFileBacked) clonedCleanable._browserFileBacked = true;
  if (original._cleanup) clonedCleanable._cleanup = original._cleanup;
  if (original._file) clonedCleanable._file = original._file;
  if (original._fileHandle) clonedCleanable._fileHandle = original._fileHandle;
  if (original._lazyExternalSource) clonedCleanable._lazyExternalSource = true;
  attachPatchFileSourceRef(cloned, getPatchFileSourceRef(file, cloned.fileName));
  return cloned;
};

const createCleanupOnce = (cleanup?: () => Promise<void> | void) =>
  typeof cleanup === "function" ? createStorageCleanupOnce(cleanup) : undefined;

const attachPatchFileCleanup = (file: PatchFileInstance, cleanup?: () => Promise<void> | void): PatchFileInstance => {
  const cleanupOnce = createCleanupOnce(cleanup);
  if (!cleanupOnce) return file;
  const cleanable = file as CleanablePatchFile;
  const previousCleanup = cleanable._cleanup;
  cleanable._cleanup = createCleanupOnce(async () => {
    await Promise.resolve(previousCleanup?.());
    await cleanupOnce();
  });
  return file;
};

const getPatchFileCleanup = (file: PatchFileInstance): (() => Promise<void> | void) | undefined =>
  (file as CleanablePatchFile)._cleanup;

const getPatchFileBlob = (file: PatchFileInstance): Blob | null => {
  const blob = (file as CleanablePatchFile)._file;
  return typeof Blob !== "undefined" && blob instanceof Blob ? blob : null;
};

const getPatchFileHandle = (file: PatchFileInstance): FileSystemFileHandle | null =>
  (file as CleanablePatchFile)._fileHandle || null;

const toNamedBlobSource = (blob: Blob, fileName: string): Blob => {
  if (typeof File !== "undefined" && blob instanceof File) {
    if (blob.name === fileName) return blob;
    return new File([blob], fileName, {
      lastModified: blob.lastModified,
      type: blob.type || "application/octet-stream",
    });
  }
  if (typeof File !== "undefined") return new File([blob], fileName, { type: blob.type || "application/octet-stream" });
  return blob;
};

const createPatchFileSourceRef = (fileName: string, source: DirectSource, size?: number): PatchFileSourceRef => ({
  ...(size === undefined ? {} : { size }),
  fileName,
  source,
});

const createPatchFileSourceAccess = ({
  blob,
  directSource,
  fileHandle,
  fileName,
  filePath,
  size,
  sourceRef,
}: {
  blob?: Blob | null;
  directSource?: DirectSource | null;
  fileHandle?: FileSystemFileHandle | null;
  fileName: string;
  filePath?: string | null;
  size?: number;
  sourceRef?: PatchFileSourceRef | null;
}): PatchFileSourceAccess => ({
  ...(size === undefined ? {} : { size }),
  fileName,
  getBlob: () => (typeof Blob !== "undefined" && blob instanceof Blob ? blob : null),
  getExternalSource: (options: ExternalSourceOptions = {}) => {
    if (options.preferDirectBrowserSource && fileHandle) return createPatchFileSourceRef(fileName, fileHandle, size);
    if (blob && options.preferDirectBrowserSource)
      return createPatchFileSourceRef(fileName, toNamedBlobSource(blob, fileName), size);
    if (sourceRef) return sourceRef;
    if (directSource) return createPatchFileSourceRef(fileName, directSource, size);
    if (blob) return createPatchFileSourceRef(fileName, toNamedBlobSource(blob, fileName), size);
    if (fileHandle) return createPatchFileSourceRef(fileName, fileHandle, size);
    if (filePath) return createPatchFileSourceRef(fileName, filePath, size);
    return null;
  },
  getFileHandle: () => fileHandle || null,
  getFilePath: () => (filePath ? filePath : null),
});

const createSourceAccessFromSource = (source: SourceRef, fallbackFileName?: string): PatchFileSourceAccess => {
  const fileName =
    getNamedSourceFileName(source, { fallback: fallbackFileName || "source.bin" }) || fallbackFileName || "source.bin";
  const sizeValue = getNamedSourceSize(source);
  const size =
    typeof sizeValue === "number" && Number.isFinite(sizeValue) ? Math.max(0, Math.floor(sizeValue)) : undefined;
  const directSource = getNamedSource(source as Parameters<typeof getNamedSource>[0]) as RuntimeValue;
  const sourceRef = normalizePatchFileSourceRef(
    directSource &&
      ((typeof directSource === "string" && directSource.trim()) ||
        (typeof Blob !== "undefined" && directSource instanceof Blob) ||
        isFileSystemFileHandleLike(directSource) ||
        isVfsFileRef(directSource))
      ? { fileName, ...(size === undefined ? {} : { size }), source: directSource as DirectSource }
      : null,
    fileName,
    size,
  );
  const blob = typeof Blob !== "undefined" && directSource instanceof Blob ? directSource : null;
  const fileHandle = isFileSystemFileHandleLike(directSource) ? directSource : null;
  const filePath = getNamedSourcePath(source as Parameters<typeof getNamedSourcePath>[0]) || "";
  return createPatchFileSourceAccess({
    blob,
    directSource: sourceRef?.source || null,
    fileHandle,
    fileName,
    filePath,
    size,
    sourceRef,
  });
};

const getPatchFileSourceAccess = (file: PatchFileInstance, fallbackFileName?: string): PatchFileSourceAccess => {
  const fileName = file.fileName || fallbackFileName || "source.bin";
  const size =
    typeof file.fileSize === "number" && Number.isFinite(file.fileSize)
      ? Math.max(0, Math.floor(file.fileSize))
      : undefined;
  const fileHandle = getPatchFileHandle(file);
  const blob = getPatchFileBlob(file);
  const sourceRef = getPatchFileSourceRef(file, fallbackFileName);
  return createPatchFileSourceAccess({
    blob,
    fileHandle,
    fileName,
    filePath: typeof file.filePath === "string" && file.filePath.trim() ? file.filePath : null,
    size,
    sourceRef,
  });
};

const getPatchFileExternalSource = (
  file: PatchFileInstance,
  fallbackFileName?: string,
  options: ExternalSourceOptions = {},
): PatchFileSourceRef | null => getPatchFileSourceAccess(file, fallbackFileName).getExternalSource(options);

const isBlobBackedPatchFile = (file: PatchFileInstance): boolean => !!getPatchFileBlob(file);

const isLazyExternalPatchFile = (file: PatchFileInstance): boolean =>
  !!(file as CleanablePatchFile)._lazyExternalSource;

const throwLazyExternalRead = (): never => {
  throw new Error("Browser-backed file cannot be read synchronously; stage it in a worker first");
};

const createLazyExternalPatchFile = (fileName: string, options: LazyExternalPatchFileOptions = {}) => {
  const resolvedFileName = fileName || "output.bin";
  const file = new PatchFile(0) as PatchFileInstance;
  const lazyFile = file as CleanablePatchFile & {
    _byteSource?: unknown;
    _u8array?: Uint8Array;
  };
  file.fileName = resolvedFileName;
  file.fileSize =
    typeof options.size === "number" && Number.isFinite(options.size) ? Math.max(0, Math.floor(options.size)) : 0;
  file.fileType = options.fileType || "application/octet-stream";
  if (options.filePath) file.filePath = options.filePath;
  delete lazyFile._byteSource;
  delete lazyFile._u8array;
  lazyFile._browserFileBacked = true;
  lazyFile._lazyExternalSource = true;
  if (options.fileHandle) lazyFile._fileHandle = options.fileHandle;
  file.readIntoAt = throwLazyExternalRead as PatchFileInstance["readIntoAt"];
  file.readBytesAt = throwLazyExternalRead as NonNullable<PatchFileInstance["readBytesAt"]>;
  file.readU8At = throwLazyExternalRead as NonNullable<PatchFileInstance["readU8At"]>;
  file.materialize = throwLazyExternalRead as PatchFileInstance["materialize"];
  file.slice = throwLazyExternalRead as PatchFileInstance["slice"];
  attachPatchFileCleanup(file, options.cleanup);
  if (options.filePath || options.fileHandle) {
    attachPatchFileSourceRef(file, {
      fileName: resolvedFileName,
      size: file.fileSize,
      source: options.filePath || options.fileHandle!,
    });
  }
  return file;
};

const createLazyBlobBackedPatchFile = (
  blob: Blob,
  fileName: string,
  cleanup?: () => Promise<void> | void,
  fileHandle?: FileSystemFileHandle | null,
) => {
  const resolvedFileName = fileName || (blob as Blob & { name?: string }).name || "output.bin";
  const file = createLazyExternalPatchFile(resolvedFileName, {
    cleanup,
    fileHandle,
    fileType: blob.type || "application/octet-stream",
    size: blob.size,
  });
  const lazyFile = file as CleanablePatchFile;
  lazyFile._file = blob;
  attachPatchFileSourceRef(file, {
    fileName: resolvedFileName,
    size: blob.size,
    source: blob,
  });
  return file;
};

const createBlobBackedPatchFile = async (
  blob: Blob,
  fileName: string,
  cleanup?: () => Promise<void> | void,
  fileHandle?: FileSystemFileHandle | null,
  options: BlobBackedPatchFileOptions = {},
) => {
  if (options.materialize === false) return createLazyBlobBackedPatchFile(blob, fileName, cleanup, fileHandle);
  const file = (await createPatchFile(
    blob as Blob & { name?: string; type?: string },
    fileName || (blob as Blob & { name?: string }).name || "output.bin",
  )) as PatchFileInstance;
  file.fileName = fileName || (blob as Blob & { name?: string }).name || "output.bin";
  (file as CleanablePatchFile)._file = blob;
  if (fileHandle) (file as CleanablePatchFile)._fileHandle = fileHandle;
  attachPatchFileCleanup(file, cleanup);
  attachPatchFileSourceRef(file, {
    fileName: file.fileName,
    size: blob.size,
    source: blob,
  });
  return file;
};

const getPatchFileBytes = (file: PatchFileInstance): Uint8Array => {
  if (isLazyExternalPatchFile(file)) throwLazyExternalRead();
  const bytes =
    ((file as { _u8array?: Uint8Array })._u8array as Uint8Array) || new Uint8Array(Math.max(0, file.fileSize || 0));
  if (!(file as { _u8array?: Uint8Array })._u8array && bytes.byteLength && typeof file.readIntoAt === "function")
    file.readIntoAt(bytes, 0, bytes.byteLength, 0);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
};

const normalizeArchiveEntryInfo = (entry: ArchiveEntry): CompressionEntryInfo => ({
  fileName: typeof entry.fileName === "string" ? entry.fileName : undefined,
  filename: String(entry.filename || entry.fileName || entry.name || ""),
  fileType: typeof entry.fileType === "string" ? entry.fileType : undefined,
  lastModified: typeof entry.lastModified === "number" ? entry.lastModified : undefined,
  mtime: typeof entry.mtime === "number" ? entry.mtime : undefined,
  name: typeof entry.name === "string" ? entry.name : undefined,
  size: typeof entry.size === "number" ? entry.size : undefined,
});

const getArchiveSourceTransport = (
  source: SourceRef,
  fallbackFileName: string,
): { archiveSource: ArchiveSourceValue; fileName: string } => ({
  archiveSource: getNamedSource(source) as ArchiveSourceValue,
  fileName: getNamedSourceFileName(source, { fallback: fallbackFileName }) || fallbackFileName,
});

const createOutputFile = (bytes: Uint8Array, fileName: string): PatchFileInstance => {
  const file = new PatchFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  file.fileName = fileName;
  return file as PatchFileInstance;
};

export type { PatchFileInstance };
export {
  ArchiveCapabilities,
  attachPatchFileCleanup,
  attachPatchFileSourceRef,
  clonePatchFile,
  createBlobBackedPatchFile,
  createLazyExternalPatchFile,
  createOutputFile,
  createPatchFile,
  createSourceAccessFromSource,
  decodeUtf8,
  extractArchiveBufferEntry,
  getArchiveSourceTransport,
  getDefaultCreatePatchOutputFileName,
  getPatchFileBlob,
  getPatchFileBytes,
  getPatchFileCleanup,
  getPatchFileExternalSource,
  getPatchFileHandle,
  getPatchFileSourceAccess,
  getPatchFileSourceRef,
  isBlobBackedPatchFile,
  isLazyExternalPatchFile,
  normalizeArchiveEntryBytes,
  normalizeArchiveEntryInfo,
  PatchFile,
};
