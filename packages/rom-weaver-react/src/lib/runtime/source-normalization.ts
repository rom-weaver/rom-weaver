import { toBinarySourceArrayBuffer } from "../../storage/shared/binary/binary-source-utils.ts";
import { getNamedSource, getNamedSourceFileName } from "../../storage/shared/binary/source-file-utils.ts";
import {
  isFileSystemFileHandleLike,
  toArrayBufferViewUint8Array,
  toOwnedArrayBuffer,
} from "../../storage/shared/binary/source-shared.ts";
import { isVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type { JsonObject, JsonValue } from "../../types/runtime.ts";
import type { SourceRef } from "../../types/source.ts";
import type { CompressionCreateInput } from "../../types/workflow-runtime.ts";

type SevenZipZstdCreateInput = Extract<CompressionCreateInput, { entries: unknown }>;

const getDirectSource = (source: SourceRef) => getNamedSource(source);

const assertBrowserBinarySource = (source: SourceRef, context: string) => {
  const directSource = getDirectSource(source);
  if (typeof Blob !== "undefined" && directSource instanceof Blob) return;
  if (isFileSystemFileHandleLike(directSource)) return;
  if (isVfsFileRef(directSource)) return;
  if (typeof directSource === "string" && directSource.trim())
    throw new Error(`${context} does not accept filesystem paths in browser workflows`);
  throw new Error(`${context} requires a Blob, FileSystemFileHandle, or VFS path in browser workflows`);
};

const assertNodeBinarySource = (source: SourceRef, context: string) => {
  const directSource = getDirectSource(source);
  if (typeof directSource === "string" && directSource.trim()) return;
  if (typeof Blob !== "undefined" && directSource instanceof Blob) return;
  if (isVfsFileRef(directSource)) return;
  if (isFileSystemFileHandleLike(directSource))
    throw new Error(`${context} does not accept FileSystemFileHandle values in Node workflows`);
  throw new Error(`${context} requires a filesystem path, Blob, or VFS path in Node workflows`);
};

const getArchiveEntryArrayBuffer = (
  data: SevenZipZstdCreateInput["entries"][number]["data"],
): ArrayBufferLike | Uint8Array | undefined => {
  if (ArrayBuffer.isView(data)) return toOwnedArrayBuffer(toArrayBufferViewUint8Array(data));
  if (data instanceof ArrayBuffer) return data;
  return undefined;
};

const getArchiveEntryUint8Array = (
  data: SevenZipZstdCreateInput["entries"][number]["data"],
): Uint8Array | undefined => {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return toArrayBufferViewUint8Array(data);
  return undefined;
};

const toWorkerMetadata = (metadata: JsonObject): Record<string, JsonValue> => {
  const normalizedMetadata: Record<string, JsonValue> = {};
  for (const key of Object.keys(metadata || {})) {
    const value = metadata[key];
    if (value !== undefined) normalizedMetadata[key] = value;
  }
  return normalizedMetadata;
};

export {
  assertBrowserBinarySource,
  assertNodeBinarySource,
  getArchiveEntryArrayBuffer,
  getArchiveEntryUint8Array,
  getNamedSource,
  getNamedSourceFileName,
  toBinarySourceArrayBuffer,
  toWorkerMetadata,
};
