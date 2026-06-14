type ByteSourceMetadata = {
  fileName?: string;
  filePath?: string;
  fileSize: number;
  fileType?: string;
};

type SyncByteSource = ByteSourceMetadata & {
  readIntoAt: (
    buffer: ArrayBuffer | ArrayBufferView,
    bufferOffset?: number,
    len?: number,
    fileOffset?: number,
  ) => number;
  readBytesAt: (offset: number, len: number) => Uint8Array;
  slice: (offset?: number, len?: number, doNotClone?: boolean) => SyncByteSource;
};

type WritableSyncByteSource = SyncByteSource & {
  close?: () => void;
  flush?: () => void;
  truncate?: (size: number) => void;
  writeBytesAt: (offset: number, bytes: ArrayBuffer | ArrayBufferView | ArrayLike<number>) => void;
};

const DEFAULT_FILE_NAME = "file.bin";
const DEFAULT_FILE_TYPE = "application/octet-stream";

const toUint8Array = (source: ArrayBuffer | ArrayBufferView | ArrayLike<number>): Uint8Array => {
  if (source instanceof Uint8Array) return source;
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return Uint8Array.from(source);
};

const normalizeRange = (
  fileSize: number,
  offset?: number,
  len?: number,
  allowEmpty = true,
): { end: number; len: number; offset: number } => {
  const normalizedSize = Math.max(0, Math.floor(fileSize || 0));
  const normalizedOffset = typeof offset === "number" && offset > 0 ? Math.floor(offset) : 0;
  if (normalizedOffset > normalizedSize || (!allowEmpty && normalizedOffset >= normalizedSize))
    throw new Error("out of bounds slicing");
  const normalizedLen =
    typeof len === "number" && len >= 0 && normalizedOffset + len <= normalizedSize
      ? Math.floor(len)
      : normalizedSize - normalizedOffset;
  if (!allowEmpty && normalizedLen === 0) throw new Error("zero length provided for slicing");
  return {
    end: normalizedOffset + Math.max(0, normalizedLen),
    len: Math.max(0, normalizedLen),
    offset: normalizedOffset,
  };
};

const normalizeReadInto = (
  fileSize: number,
  buffer: ArrayBuffer | ArrayBufferView,
  bufferOffset?: number,
  len?: number,
  fileOffset?: number,
) => {
  const target = toUint8Array(buffer);
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

const readSourceBytesIntoTarget = (
  fileSize: number,
  buffer: ArrayBuffer | ArrayBufferView,
  bufferOffset: number | undefined,
  len: number | undefined,
  fileOffset: number | undefined,
  readBytes: (offset: number, len: number) => Uint8Array,
) => {
  const normalized = normalizeReadInto(fileSize, buffer, bufferOffset, len, fileOffset);
  if (!normalized.readLength) return 0;
  const bytes = readBytes(normalized.sourceOffset, normalized.readLength);
  normalized.target.set(bytes, normalized.targetOffset);
  return bytes.byteLength;
};

const readBytesViaReadInto = (source: SyncByteSource, offset: number, len: number) => {
  const range = normalizeRange(source.fileSize, offset, len);
  const bytes = new Uint8Array(range.len);
  if (range.len) source.readIntoAt(bytes, 0, range.len, range.offset);
  return bytes;
};

const sliceByteSourceView = (
  source: SyncByteSource,
  offset?: number,
  len?: number,
  doNotClone?: boolean,
): SyncByteSource => {
  const range = normalizeRange(source.fileSize, offset, len, false);
  if (range.offset === 0 && range.len === source.fileSize && doNotClone) return source;
  return new ReadViewByteSource(source, range.offset, range.len);
};

class MemoryByteSource implements WritableSyncByteSource {
  fileName: string;
  fileSize: number;
  fileType: string;
  _u8array: Uint8Array;

  constructor(
    source: number | ArrayBuffer | ArrayBufferView | ArrayLike<number>,
    metadata?: Partial<ByteSourceMetadata>,
  ) {
    if (typeof source === "number") this._u8array = new Uint8Array(Math.max(0, Math.floor(source || 0)));
    else this._u8array = toUint8Array(source);
    this.fileName = metadata?.fileName || DEFAULT_FILE_NAME;
    this.fileType = metadata?.fileType || DEFAULT_FILE_TYPE;
    this.fileSize = this._u8array.byteLength;
  }

  readIntoAt(buffer: ArrayBuffer | ArrayBufferView, bufferOffset?: number, len?: number, fileOffset?: number) {
    return readSourceBytesIntoTarget(this.fileSize, buffer, bufferOffset, len, fileOffset, (offset, readLength) =>
      this._u8array.subarray(offset, offset + readLength),
    );
  }

  readBytesAt(offset: number, len: number) {
    const range = normalizeRange(this.fileSize, offset, len);
    return this._u8array.subarray(range.offset, range.end);
  }

  slice(offset?: number, len?: number, doNotClone?: boolean) {
    return sliceByteSourceView(this, offset, len, doNotClone);
  }

  truncate(size: number) {
    const normalizedSize = Math.max(0, Math.floor(size || 0));
    if (normalizedSize === this._u8array.byteLength) return;
    const resized = new Uint8Array(normalizedSize);
    resized.set(this._u8array.subarray(0, Math.min(this._u8array.byteLength, normalizedSize)));
    this._u8array = resized;
    this.fileSize = normalizedSize;
  }

  writeBytesAt(offset: number, bytes: ArrayBuffer | ArrayBufferView | ArrayLike<number>) {
    const u8array = toUint8Array(bytes);
    if (!u8array.byteLength) return;
    const startOffset = Math.max(0, Math.floor(offset || 0));
    const endOffset = startOffset + u8array.byteLength;
    if (endOffset > this._u8array.byteLength) this.truncate(endOffset);
    this._u8array.set(u8array, startOffset);
  }
}

class ReadViewByteSource implements SyncByteSource {
  fileName: string;
  filePath?: string;
  fileSize: number;
  fileType: string;
  source: SyncByteSource;
  sourceOffset: number;

  constructor(source: SyncByteSource, offset?: number, len?: number) {
    const baseSource = source instanceof ReadViewByteSource ? source.source : source;
    const baseOffset = source instanceof ReadViewByteSource ? source.sourceOffset : 0;
    const range = normalizeRange(source.fileSize, offset, len, true);
    this.fileName = source.fileName || DEFAULT_FILE_NAME;
    this.filePath = source.filePath;
    this.fileSize = range.len;
    this.fileType = source.fileType || DEFAULT_FILE_TYPE;
    this.source = baseSource;
    this.sourceOffset = baseOffset + range.offset;
  }

  readIntoAt(buffer: ArrayBuffer | ArrayBufferView, bufferOffset?: number, len?: number, fileOffset?: number) {
    const normalized = normalizeReadInto(this.fileSize, buffer, bufferOffset, len, fileOffset);
    if (!normalized.readLength) return 0;
    return this.source.readIntoAt(
      normalized.target,
      normalized.targetOffset,
      normalized.readLength,
      this.sourceOffset + normalized.sourceOffset,
    );
  }

  readBytesAt(offset: number, len: number) {
    return readBytesViaReadInto(this, offset, len);
  }

  slice(offset?: number, len?: number, doNotClone?: boolean) {
    return sliceByteSourceView(this, offset, len, doNotClone);
  }
}

const isSyncByteSource = (value: unknown): value is SyncByteSource =>
  !!(
    value &&
    typeof value === "object" &&
    typeof (value as SyncByteSource).fileSize === "number" &&
    typeof (value as SyncByteSource).readIntoAt === "function" &&
    typeof (value as SyncByteSource).readBytesAt === "function" &&
    typeof (value as SyncByteSource).slice === "function"
  );

const isWritableSyncByteSource = (value: unknown): value is WritableSyncByteSource =>
  isSyncByteSource(value) && typeof (value as WritableSyncByteSource).writeBytesAt === "function";

export type { SyncByteSource };
export {
  DEFAULT_FILE_NAME,
  DEFAULT_FILE_TYPE,
  isSyncByteSource,
  isWritableSyncByteSource,
  MemoryByteSource,
  normalizeRange,
  normalizeReadInto,
  ReadViewByteSource,
  toUint8Array,
};
