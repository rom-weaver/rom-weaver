import {
  createArchiveSourceBlob,
  type NamedArchiveBlob,
  normalizeArchiveBytes,
} from "../shared/archive-source-utils.ts";

const normalizeArchiveSourceBytes = (
  data: ArrayBufferLike | Uint8Array | ArrayBufferView | null | undefined,
): Uint8Array => normalizeArchiveBytes(data);

export { createArchiveSourceBlob, type NamedArchiveBlob, normalizeArchiveSourceBytes };
