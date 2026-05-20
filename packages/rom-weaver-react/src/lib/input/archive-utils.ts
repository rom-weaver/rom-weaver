import {
  createBinarySourceReader,
  hasReadableBytes,
  materializeSourceArrayBuffer,
  toArrayBuffer,
  toUint8Array,
} from "../../storage/shared/binary/binary-source-utils.ts";
import { getBlobSource } from "../../workers/protocol/archive-shared-utils.ts";

type BlobLike = {
  arrayBuffer: () => Promise<ArrayBuffer>;
  size: number;
  slice?: (start?: number, end?: number) => BlobLike;
};

const toInt8Array = (source: RuntimeValue) => {
  const u8array = toUint8Array(source);
  return new Int8Array(u8array.buffer, u8array.byteOffset, u8array.byteLength);
};

const readBlobSlice = (blob: BlobLike, start: number, end: number) => {
  return createBinarySourceReader(blob)
    .then((reader) => reader.readRange(start, end - start))
    .then((bytes) => bytes.buffer);
};

const sourceToArrayBuffer = (source: RuntimeValue) => {
  return materializeSourceArrayBuffer(source, { allowFullMaterialization: true }).catch((error) =>
    Promise.reject(new Error("Invalid archive source", { cause: error })),
  );
};

const getSourceSize = (source: RuntimeValue) => {
  const blob = getBlobSource(source);
  if (blob) return blob.size;
  return toUint8Array(source).byteLength;
};

export {
  ARCHIVE_TYPES,
  FILTER_NON_ROMS,
  FILTER_PATCHES,
  getArchiveMagicType,
  getArchiveType,
  getBlobSource,
  getExtension,
  getFileNameLower,
  getSupportedArchiveExtension,
  isArchiveFile,
  isMetadataEntry,
  isWrappedArchiveType,
  MAGIC_SIGNATURES,
  matchesMagic,
  SUPPORTED_ARCHIVE_EXTENSION_VALUES,
  sortFileEntries,
} from "../../workers/protocol/archive-shared-utils.ts";

export {
  getSourceSize,
  hasReadableBytes,
  readBlobSlice,
  sourceToArrayBuffer,
  toArrayBuffer,
  toInt8Array,
  toUint8Array,
};
