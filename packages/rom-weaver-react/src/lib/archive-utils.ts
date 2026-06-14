import {
  createArchiveSourceBlob as createSharedArchiveSourceBlob,
  type NamedArchiveBlob,
  normalizeArchiveBytes,
} from "../storage/shared/archive-source-utils.ts";

const normalizeArchiveEntryBytes = (
  data: ArrayBufferLike | Uint8Array | ArrayBufferView | null | undefined,
): Uint8Array => normalizeArchiveBytes(data, "Archive entry data is not available");

const createArchiveSourceBlob = (
  data: ArrayBufferLike | Uint8Array | ArrayBufferView | null | undefined,
  fileName?: string | null,
  fileType = "application/octet-stream",
): NamedArchiveBlob => createSharedArchiveSourceBlob(data, fileName, fileType, "Archive entry data is not available");

export { createArchiveSourceBlob, normalizeArchiveEntryBytes };
