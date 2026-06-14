import type { PatchFileLike as CorePatchFileLike } from "../../../workers/protocol/patch-engine.ts";
import { getNamedSource, getNamedSourceFileName, getNamedSourcePath } from "./source-file-utils.ts";
import {
  type BinaryObjectLike,
  type ByteSourceRecordLike,
  DEFAULT_SOURCE_FILE_NAME,
  isBinaryObjectLike,
  isFileSystemFileHandleLike,
  isRecord,
  materializeByteSourceRecord,
  normalizeRange,
  readBinaryObjectRange,
  toArrayBufferViewUint8Array,
  toByteSourceUint8Array,
  toOwnedArrayBuffer,
} from "./source-shared.ts";

type SourceValue = RuntimeValue;

type ByteSourceRecord = ByteSourceRecordLike & {
  _file?: BinaryObjectLike;
  data?: unknown;
  fileName?: string;
  filePath?: string;
  name?: string;
  source?: unknown;
};

type BinarySourceReader = {
  lastModified?: number;
  name: string;
  readInto: (
    buffer: Uint8Array,
    bufferOffset?: number,
    len?: number,
    sourceOffset?: number,
  ) => Promise<number> | number;
  readRange: (offset?: number, length?: number) => Promise<Uint8Array>;
  size: number;
  type?: string;
};

type ObjectBinarySourceReaderFactory = (
  source: unknown,
  name: string,
  fallbackName: string,
) => Promise<BinarySourceReader | null> | BinarySourceReader | null;

let objectBinarySourceReaderFactories: ObjectBinarySourceReaderFactory[] = [];

const configureObjectBinarySourceReaderFactories = (factories: ObjectBinarySourceReaderFactory[]) => {
  objectBinarySourceReaderFactories = factories;
};

type MaterializeOptions = {
  allowFullMaterialization: true;
  preserveWholeBuffer?: boolean;
};

type PatchFileLike = Partial<Pick<CorePatchFileLike, "fileName">>;
type PatchFileConstructorLike = new (source: SourceValue) => PatchFileLike;

const DEFAULT_NAME = DEFAULT_SOURCE_FILE_NAME;

const toUint8Array = (source: unknown, invalidLabel?: string): Uint8Array => {
  const directSource = getNamedSource(source as Parameters<typeof getNamedSource>[0]) as unknown;
  if (isRecord(directSource)) {
    const materialized = materializeByteSourceRecord(
      directSource as ByteSourceRecord,
      invalidLabel || "Invalid byte source",
    );
    if (materialized) return materialized;
  }
  return toByteSourceUint8Array(directSource, invalidLabel || "Invalid byte source");
};

const normalizeReadIntoRequest = ({
  buffer,
  bufferOffset,
  len,
  fileOffset,
  fileSize,
  invalidLabel,
}: {
  buffer: ArrayBuffer | ArrayBufferView | ArrayLike<number>;
  bufferOffset?: number;
  len?: number;
  fileOffset?: number;
  fileSize: number;
  invalidLabel?: string;
}) => {
  const target = toUint8Array(buffer, invalidLabel || "Invalid read target");
  const targetOffset = typeof bufferOffset === "number" && bufferOffset > 0 ? Math.floor(bufferOffset) : 0;
  const sourceOffset = typeof fileOffset === "number" && fileOffset > 0 ? Math.floor(fileOffset) : 0;
  const readLength =
    typeof len === "number"
      ? Math.max(0, Math.min(Math.floor(len), target.byteLength - targetOffset, fileSize - sourceOffset))
      : Math.max(0, Math.min(target.byteLength - targetOffset, fileSize - sourceOffset));
  return {
    readLength,
    sourceOffset,
    target,
    targetOffset,
  };
};

const readRangeIntoTarget = async ({
  buffer,
  bufferOffset,
  len,
  sourceOffset,
  fileSize,
  readRange,
}: {
  buffer: ArrayBuffer | ArrayBufferView | ArrayLike<number>;
  bufferOffset?: number;
  len?: number;
  sourceOffset?: number;
  fileSize: number;
  readRange: (offset: number, length: number) => Promise<Uint8Array>;
}) => {
  const normalized = normalizeReadIntoRequest({
    buffer,
    bufferOffset,
    fileOffset: sourceOffset,
    fileSize,
    len,
  });
  if (!normalized.readLength) return 0;
  const bytes = await readRange(normalized.sourceOffset, normalized.readLength);
  normalized.target.set(bytes, normalized.targetOffset);
  return bytes.byteLength;
};

const createByteReader = (bytes: Uint8Array, name = DEFAULT_NAME): BinarySourceReader => ({
  name,
  readInto(buffer, bufferOffset, len, sourceOffset) {
    const normalized = normalizeReadIntoRequest({
      buffer,
      bufferOffset,
      fileOffset: sourceOffset,
      fileSize: bytes.byteLength,
      len,
    });
    if (!normalized.readLength) return 0;
    normalized.target.set(
      bytes.subarray(normalized.sourceOffset, normalized.sourceOffset + normalized.readLength),
      normalized.targetOffset,
    );
    return normalized.readLength;
  },
  readRange(offset, length) {
    const range = normalizeRange(bytes.byteLength, offset, length);
    return Promise.resolve(Uint8Array.from(bytes.subarray(range.offset, range.offset + range.length)));
  },
  size: bytes.byteLength,
});

const createBinaryObjectReader = (source: BinaryObjectLike, name?: string): BinarySourceReader => ({
  lastModified: source.lastModified,
  name: name || source.name || DEFAULT_NAME,
  async readInto(buffer, bufferOffset, len, sourceOffset) {
    return readRangeIntoTarget({
      buffer,
      bufferOffset,
      fileSize: source.size,
      len,
      readRange: (offset, length) => this.readRange(offset, length),
      sourceOffset,
    });
  },
  async readRange(offset, length) {
    return readBinaryObjectRange(source, offset, length);
  },
  size: source.size,
  type: source.type,
});

const createRecordReader = async (record: ByteSourceRecord, name = record.fileName || record.name || DEFAULT_NAME) => {
  if (isBinaryObjectLike(record._file)) return createBinaryObjectReader(record._file, name);
  if (record._u8array instanceof Uint8Array) return createByteReader(record._u8array, name);
  if (typeof record.filePath === "string" && record.filePath)
    throw new Error("Path binary source support is not configured");
  if (typeof record.readIntoAt === "function" && typeof record.fileSize === "number") {
    return {
      name,
      readInto(buffer, bufferOffset, len, sourceOffset) {
        const normalized = normalizeReadIntoRequest({
          buffer,
          bufferOffset,
          fileOffset: sourceOffset,
          fileSize: record.fileSize || 0,
          len,
        });
        if (!normalized.readLength) return 0;
        return (
          record.readIntoAt?.(
            normalized.target,
            normalized.targetOffset,
            normalized.readLength,
            normalized.sourceOffset,
          ) || normalized.readLength
        );
      },
      async readRange(offset?: number, length?: number) {
        const range = normalizeRange(record.fileSize || 0, offset, length);
        const bytes = new Uint8Array(range.length);
        if (range.length) record.readIntoAt?.(bytes, 0, range.length, range.offset);
        return bytes;
      },
      size: record.fileSize,
    } satisfies BinarySourceReader;
  }
  if (typeof record.materialize === "function" && typeof record.fileSize === "number") {
    return {
      name,
      async readInto(buffer, bufferOffset, len, sourceOffset) {
        return readRangeIntoTarget({
          buffer,
          bufferOffset,
          fileSize: record.fileSize || 0,
          len,
          readRange: (offset, length) => this.readRange(offset, length),
          sourceOffset,
        });
      },
      async readRange(offset?: number, length?: number) {
        const range = normalizeRange(record.fileSize || 0, offset, length);
        if (!range.length) return new Uint8Array(0);
        const materialized = record.materialize?.(range.offset, range.length);
        return Uint8Array.from(toByteSourceUint8Array(materialized, "Invalid materialized source"));
      },
      size: record.fileSize,
    } satisfies BinarySourceReader;
  }
  return null;
};

const hasReadableBytes = (source: SourceValue): boolean => {
  const directSource = getNamedSource(source as Parameters<typeof getNamedSource>[0]) as SourceValue;
  if (
    isRecord(directSource) &&
    directSource._browserFileBacked === true &&
    !(directSource._u8array instanceof Uint8Array)
  )
    return false;
  return (
    directSource instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer === "function" && directSource instanceof SharedArrayBuffer) ||
    ArrayBuffer.isView(directSource) ||
    (isRecord(directSource) &&
      (directSource._u8array instanceof Uint8Array ||
        typeof directSource.readIntoAt === "function" ||
        typeof directSource.materialize === "function"))
  );
};

const createBinarySourceReader = async (
  source: SourceValue,
  fallbackName = DEFAULT_NAME,
): Promise<BinarySourceReader> => {
  const directSource = getNamedSource(source as Parameters<typeof getNamedSource>[0]) as SourceValue;
  const fileName = getNamedSourceFileName(source as Parameters<typeof getNamedSource>[0], { fallback: fallbackName });

  const sourcePath = getNamedSourcePath(source as Parameters<typeof getNamedSource>[0]);
  if (sourcePath) throw new Error("Path binary source support is not configured");
  if (directSource instanceof ArrayBuffer) return createByteReader(toArrayBufferViewUint8Array(directSource), fileName);
  if (typeof SharedArrayBuffer === "function" && directSource instanceof SharedArrayBuffer)
    return createByteReader(toArrayBufferViewUint8Array(directSource), fileName);
  if (ArrayBuffer.isView(directSource)) return createByteReader(toArrayBufferViewUint8Array(directSource), fileName);
  for (const factory of objectBinarySourceReaderFactories) {
    const reader = await factory(directSource, fileName, fallbackName);
    if (reader) return reader;
  }
  if (isBinaryObjectLike(directSource)) return createBinaryObjectReader(directSource, fileName);
  if (isRecord(directSource)) {
    const reader = await createRecordReader(directSource as ByteSourceRecord, fileName || fallbackName);
    if (reader) return reader;
  }

  throw new Error("Unsupported binary source");
};

const copySourceToWriter = async (
  source: SourceValue,
  writer: (bytes: Uint8Array, offset: number) => Promise<void> | void,
  options?: { chunkSize?: number; offset?: number; length?: number },
) => {
  const reader = await createBinarySourceReader(source);
  const chunkSize = Math.max(1, Math.floor(options?.chunkSize || 8 * 1024 * 1024));
  const range = normalizeRange(reader.size, options?.offset, options?.length);
  let copied = 0;
  while (copied < range.length) {
    const sourceOffset = range.offset + copied;
    const bytes = await reader.readRange(sourceOffset, Math.min(chunkSize, range.length - copied));
    if (!bytes.byteLength) break;
    await writer(bytes, sourceOffset);
    copied += bytes.byteLength;
  }
  return copied;
};

const materializeSourceBytes = async (
  source: SourceValue,
  options: MaterializeOptions,
  invalidLabel?: string,
): Promise<Uint8Array> => {
  if (!options?.allowFullMaterialization) throw new Error("Full source materialization requires explicit opt-in");
  try {
    return (await createBinarySourceReader(source)).readRange();
  } catch (error) {
    if (invalidLabel) throw new Error(invalidLabel, { cause: error });
    throw error;
  }
};

const materializeSourceArrayBuffer = async (
  source: SourceValue,
  options: MaterializeOptions,
  invalidLabel?: string,
): Promise<ArrayBuffer> => {
  const bytes = await materializeSourceBytes(source, options, invalidLabel);
  return toOwnedArrayBuffer(bytes, options.preserveWholeBuffer);
};

const isDirectlyCloneablePatchFile = (
  source: SourceValue,
): source is SourceValue & PatchFileLike & { _u8array?: Uint8Array; filePath?: string } => {
  if (!(source && typeof source === "object")) return false;
  if ((source as { _u8array?: unknown })._u8array instanceof Uint8Array) return true;
  return (
    typeof (source as { filePath?: unknown }).filePath === "string" && !!(source as { filePath?: string }).filePath
  );
};

const createPatchFileFromSource = async (
  source: SourceValue,
  PatchFileClass: PatchFileConstructorLike,
  options?: Parameters<typeof getNamedSource>[1],
): Promise<PatchFileLike> => {
  const directSource = getNamedSource(source as Parameters<typeof getNamedSource>[0], options) as SourceValue;
  if (directSource instanceof PatchFileClass && isDirectlyCloneablePatchFile(directSource)) {
    const fileName = getNamedSourceFileName(source as Parameters<typeof getNamedSource>[0], options);
    const binFile = new PatchFileClass(directSource);
    binFile.fileName = fileName;
    return binFile;
  }

  const fileName = getNamedSourceFileName(source as Parameters<typeof getNamedSource>[0], options);
  const sourcePath = getNamedSourcePath(source as Parameters<typeof getNamedSource>[0]);
  const binFile = sourcePath
    ? new PatchFileClass(sourcePath)
    : new PatchFileClass(
        await materializeSourceArrayBuffer(source, { allowFullMaterialization: true }, "Unsupported binary source"),
      );
  binFile.fileName = fileName;
  if (isBinaryObjectLike(directSource)) {
    (binFile as { _file?: BinaryObjectLike })._file = directSource;
    (binFile as { fileSize?: number }).fileSize = directSource.size;
    (binFile as { fileType?: string }).fileType = directSource.type || (binFile as { fileType?: string }).fileType;
  }
  if (isFileSystemFileHandleLike(directSource))
    (binFile as { _fileHandle?: FileSystemFileHandle | null })._fileHandle = directSource;
  if (
    directSource instanceof PatchFileClass &&
    typeof (directSource as { littleEndian?: unknown }).littleEndian === "boolean"
  )
    (binFile as { littleEndian?: boolean }).littleEndian = (directSource as { littleEndian: boolean }).littleEndian;
  return binFile;
};

export {
  configureObjectBinarySourceReaderFactories,
  copySourceToWriter,
  createBinaryObjectReader,
  createPatchFileFromSource,
  hasReadableBytes,
  toUint8Array,
};
