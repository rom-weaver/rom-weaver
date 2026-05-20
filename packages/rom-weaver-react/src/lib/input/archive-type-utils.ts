import { ARCHIVE_TYPES, getArchiveType, isArchiveFile, SUPPORTED_ARCHIVE_EXTENSION_VALUES } from "./archive-utils.ts";

const getArchiveTypeLabel = (archiveType: string | null | undefined) => {
  if (archiveType === ARCHIVE_TYPES.ZIP) return "ZIP";
  if (archiveType === ARCHIVE_TYPES.SEVEN_ZIP) return "7z";
  if (archiveType === ARCHIVE_TYPES.RAR) return "RAR";
  if (archiveType === ARCHIVE_TYPES.TAR_GZIP) return "TAR.GZ";
  if (archiveType === ARCHIVE_TYPES.TAR_BZIP2) return "TAR.BZ2";
  if (archiveType === ARCHIVE_TYPES.TAR_XZ) return "TAR.XZ";
  if (archiveType === ARCHIVE_TYPES.TAR_LZMA) return "TAR.LZMA";
  if (archiveType === ARCHIVE_TYPES.TAR_ZSTD) return "TAR.ZST";
  if (archiveType === ARCHIVE_TYPES.TAR) return "TAR";
  return archiveType ? archiveType.toUpperCase() : "archive";
};

const getArchiveSourceLabel = (source: Parameters<typeof getArchiveType>[0]) =>
  getArchiveTypeLabel(getArchiveType(source));

export {
  ARCHIVE_TYPES,
  getArchiveSourceLabel,
  getArchiveType,
  getArchiveTypeLabel,
  isArchiveFile,
  SUPPORTED_ARCHIVE_EXTENSION_VALUES,
};
