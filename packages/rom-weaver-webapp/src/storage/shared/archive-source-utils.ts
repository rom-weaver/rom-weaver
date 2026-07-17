import { toUint8Array } from "./binary/binary-source-utils.ts";

type ArchiveSourceBytes = ArrayBufferLike | ArrayBufferView | Uint8Array | null | undefined;
type NamedArchiveBlob = Blob & {
  name?: string;
  type?: string;
};

const normalizeArchiveBytes = (
  data: ArchiveSourceBytes,
  invalidLabel = "Archive source data is not available",
): Uint8Array => {
  if (!data) throw new Error(invalidLabel);
  return toUint8Array(data, invalidLabel);
};

const createArchiveSourceBlob = (
  data: ArchiveSourceBytes,
  fileName?: string | null,
  fileType = "application/octet-stream",
  invalidLabel?: string,
): NamedArchiveBlob => {
  const archiveBytes = normalizeArchiveBytes(data, invalidLabel);
  const resolvedFileName = String(fileName || "archive.bin");
  const FileConstructor = typeof File === "function" ? File : null;
  if (FileConstructor) {
    return new FileConstructor([archiveBytes as BlobPart], resolvedFileName, {
      type: fileType,
    }) as NamedArchiveBlob;
  }
  return Object.assign(new Blob([archiveBytes as BlobPart], { type: fileType }), {
    name: resolvedFileName,
  });
};

export { createArchiveSourceBlob, type NamedArchiveBlob };
