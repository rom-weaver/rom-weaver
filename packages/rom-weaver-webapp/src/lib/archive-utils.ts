import {
  createArchiveSourceBlob as createSharedArchiveSourceBlob,
  type NamedArchiveBlob,
} from "../storage/shared/archive-source-utils.ts";

const createArchiveSourceBlob = (
  data: ArrayBufferLike | Uint8Array | ArrayBufferView | null | undefined,
  fileName?: string | null,
  fileType = "application/octet-stream",
): NamedArchiveBlob => createSharedArchiveSourceBlob(data, fileName, fileType, "Archive entry data is not available");

export { createArchiveSourceBlob };
