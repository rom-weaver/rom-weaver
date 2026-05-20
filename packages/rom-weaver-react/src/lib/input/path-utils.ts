import {
  type FileNameValue,
  getBaseName,
  normalizePathSeparators,
  stripFileNameQuery,
  stripLeadingDot,
} from "../../storage/shared/path-utils.ts";

const LEADING_SLASHES_REGEX = /^\/+/;

const FILE_EXTENSION_PATTERN = /\.[^./\\\s]+$/;

const normalizeArchiveEntryPath = (fileName: FileNameValue): string =>
  normalizePathSeparators(fileName).replace(LEADING_SLASHES_REGEX, "");

const normalizeArchiveEntryName = (fileName: FileNameValue): string =>
  stripFileNameQuery(normalizeArchiveEntryPath(fileName));

const getDirectoryPath = (fileName: FileNameValue): string => {
  const normalized = normalizePathSeparators(fileName);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index + 1);
};

const escapeRegExp = (value: FileNameValue): string => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const hasFileNameExtension = (fileName: FileNameValue): boolean => FILE_EXTENSION_PATTERN.test(String(fileName || ""));

const replaceFileNameExtension = (fileName: string, extension: FileNameValue): string => {
  const normalizedExtension = stripLeadingDot(extension || "bin");
  if (FILE_EXTENSION_PATTERN.test(fileName)) return fileName.replace(FILE_EXTENSION_PATTERN, `.${normalizedExtension}`);
  return `${fileName}.${normalizedExtension}`;
};

const appendFileNameExtension = (fileName: string, extension: FileNameValue): string => {
  const normalizedExtension = stripLeadingDot(extension);
  if (!normalizedExtension) return fileName;
  return `${fileName}.${normalizedExtension}`;
};

const getFileNameWithoutExtension = (fileName: FileNameValue): string =>
  String(fileName || "disc").replace(FILE_EXTENSION_PATTERN, "");

const getBaseFileName = (fileName: FileNameValue): string => getBaseName(fileName);

export {
  appendFileNameExtension,
  escapeRegExp,
  getBaseFileName,
  getDirectoryPath,
  getFileNameWithoutExtension,
  hasFileNameExtension,
  normalizeArchiveEntryName,
  normalizeArchiveEntryPath,
  replaceFileNameExtension,
  stripFileNameQuery,
};
