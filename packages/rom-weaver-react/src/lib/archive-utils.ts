import {
  createArchiveSourceBlob as createSharedArchiveSourceBlob,
  type NamedArchiveBlob,
  normalizeArchiveBytes,
} from "../storage/shared/archive-source-utils.ts";
import { encodeText } from "../storage/shared/binary/text-encoding.ts";
import type { ArchiveEntryInput, MaterializedArchiveEntry } from "../types/runtime.ts";

const encodeArchiveEntryText = (text: string | number): Uint8Array => encodeText(text);

const normalizeArchiveEntryBytes = (
  data: ArrayBufferLike | Uint8Array | ArrayBufferView | null | undefined,
): Uint8Array => normalizeArchiveBytes(data, "Archive entry data is not available");

const createArchiveSourceBlob = (
  data: ArrayBufferLike | Uint8Array | ArrayBufferView | null | undefined,
  fileName?: string | null,
  fileType = "application/octet-stream",
): NamedArchiveBlob => createSharedArchiveSourceBlob(data, fileName, fileType, "Archive entry data is not available");

const resolveArchiveEntryFileName = (entry: ArchiveEntryInput): string => {
  const fileName = entry.fileName || entry.filename || entry.name || entry.file?.name;
  if (!fileName) throw new Error("Archive entry file name is not available");
  return String(fileName);
};

const materializeArchiveEntry = async (entry: ArchiveEntryInput): Promise<MaterializedArchiveEntry> => {
  if (entry.text !== undefined)
    return {
      data: encodeArchiveEntryText(entry.text),
      filename: resolveArchiveEntryFileName(entry),
      mtime: entry.lastModified || Date.now(),
    };
  if (typeof entry.filePath === "string" && entry.filePath)
    return {
      data: new Uint8Array(0),
      filename: resolveArchiveEntryFileName(entry),
      filePath: entry.filePath,
      mtime: entry.lastModified || Date.now(),
    };
  if (entry.u8array || entry.arrayBuffer || entry.data)
    return {
      data: normalizeArchiveEntryBytes(entry.u8array || entry.arrayBuffer || entry.data),
      filename: resolveArchiveEntryFileName(entry),
      mtime: entry.lastModified || Date.now(),
    };
  if (entry.file && typeof entry.file.arrayBuffer === "function")
    return {
      data: entry.file,
      filename: resolveArchiveEntryFileName(entry),
      mtime: entry.lastModified || entry.file.lastModified || Date.now(),
    };
  throw new Error("Archive entry data is not available");
};

export {
  type ArchiveEntryInput,
  createArchiveSourceBlob,
  encodeArchiveEntryText,
  type MaterializedArchiveEntry,
  materializeArchiveEntry,
  type NamedArchiveBlob,
  normalizeArchiveEntryBytes,
  resolveArchiveEntryFileName,
};
