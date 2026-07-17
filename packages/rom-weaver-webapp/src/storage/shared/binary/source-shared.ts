import { getBaseName } from "../path-utils.ts";

const DEFAULT_SOURCE_FILE_NAME = "file.bin";

type BinaryObjectLike = {
  arrayBuffer: () => Promise<ArrayBuffer>;
  lastModified?: number;
  name?: string;
  size: number;
  slice?: (start?: number, end?: number) => BinaryObjectLike;
  type?: string;
};

type ByteSourceRecordLike = {
  _u8array?: Uint8Array;
  fileSize?: number;
  materialize?: (offset: number, len: number) => unknown;
  readIntoAt?: (buffer: Uint8Array, bufferOffset?: number, len?: number, fileOffset?: number) => number | undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && (typeof value === "object" || typeof value === "function");

const isBinaryObjectLike = (value: unknown): value is BinaryObjectLike =>
  !!value &&
  typeof value === "object" &&
  "size" in value &&
  typeof (value as { size?: unknown }).size === "number" &&
  "arrayBuffer" in value &&
  typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function";

const isFileSystemFileHandleLike = (value: unknown): value is FileSystemFileHandle =>
  isRecord(value) &&
  "kind" in value &&
  value.kind === "file" &&
  "getFile" in value &&
  typeof value.getFile === "function";

const normalizeRange = (size: number, offset?: number, length?: number) => {
  const rangeOffset = Math.max(0, Math.min(size, Math.floor(offset || 0)));
  const requestedLength = typeof length === "number" ? Math.max(0, Math.floor(length)) : size - rangeOffset;
  return {
    length: Math.max(0, Math.min(requestedLength, size - rangeOffset)),
    offset: rangeOffset,
  };
};

const toArrayBufferViewUint8Array = (source: ArrayBuffer | SharedArrayBuffer | ArrayBufferView): Uint8Array => {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (typeof SharedArrayBuffer === "function" && source instanceof SharedArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  throw new Error("Invalid byte source");
};

const toOwnedArrayBuffer = (bytes: Uint8Array, preserveWholeBuffer?: boolean): ArrayBuffer => {
  if (
    preserveWholeBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
  )
    return bytes.buffer;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const isArrayLikeByteSource = (value: unknown): value is ArrayLike<number> =>
  !!value &&
  typeof value === "object" &&
  "length" in value &&
  typeof (value as { length?: unknown }).length === "number";

const toByteSourceUint8Array = (source: unknown, invalidLabel = "Invalid byte source"): Uint8Array => {
  if (source instanceof Uint8Array) return source;
  if (
    source instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer === "function" && source instanceof SharedArrayBuffer) ||
    ArrayBuffer.isView(source)
  )
    return toArrayBufferViewUint8Array(source);
  if (isRecord(source) && source._u8array instanceof Uint8Array) return source._u8array;
  if (isArrayLikeByteSource(source)) return Uint8Array.from(source);
  throw new Error(invalidLabel);
};

const materializeByteSourceRecord = (
  record: ByteSourceRecordLike,
  invalidLabel = "Invalid byte source",
): Uint8Array | null => {
  if (record._u8array instanceof Uint8Array) return record._u8array;
  if (typeof record.materialize === "function" && typeof record.fileSize === "number") {
    return toByteSourceUint8Array(record.materialize(0, record.fileSize), invalidLabel);
  }
  if (typeof record.readIntoAt === "function" && typeof record.fileSize === "number") {
    const bytes = new Uint8Array(record.fileSize);
    record.readIntoAt(bytes, 0, record.fileSize, 0);
    return bytes;
  }
  return null;
};

const readBinaryObjectRange = async (
  source: BinaryObjectLike,
  offset?: number,
  length?: number,
): Promise<Uint8Array> => {
  const range = normalizeRange(source.size, offset, length);
  if (!range.length) return new Uint8Array(0);
  const rangedSource =
    typeof source.slice === "function" ? source.slice(range.offset, range.offset + range.length) : source;
  const buffer = await rangedSource.arrayBuffer();
  if (typeof source.slice === "function") return new Uint8Array(buffer);
  return new Uint8Array(buffer).subarray(range.offset, range.offset + range.length);
};

export type { BinaryObjectLike, ByteSourceRecordLike };
export {
  DEFAULT_SOURCE_FILE_NAME,
  getBaseName,
  isBinaryObjectLike,
  isFileSystemFileHandleLike,
  isRecord,
  materializeByteSourceRecord,
  normalizeRange,
  readBinaryObjectRange,
  toArrayBufferViewUint8Array,
  toByteSourceUint8Array,
  toOwnedArrayBuffer,
};
