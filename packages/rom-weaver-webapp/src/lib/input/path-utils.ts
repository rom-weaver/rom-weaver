import {
  type FileNameValue,
  getBaseName,
  normalizePathSeparators,
  stripFileNameQuery,
} from "../../storage/shared/path-utils.ts";
import {
  getFileNameWithoutExtension as getSharedFileNameWithoutExtension,
  hasFileNameExtension as hasSharedFileNameExtension,
  replaceFileNameExtension as replaceSharedFileNameExtension,
  stripLeadingExtensionDot,
} from "../path-utils.ts";

const LEADING_SLASHES_REGEX = /^\/+/;

const normalizeArchiveEntryPath = (fileName: FileNameValue): string =>
  normalizePathSeparators(fileName).replace(LEADING_SLASHES_REGEX, "");

const normalizeArchiveEntryName = (fileName: FileNameValue): string =>
  stripFileNameQuery(normalizeArchiveEntryPath(fileName));

const hasFileNameExtension = (fileName: FileNameValue): boolean => hasSharedFileNameExtension(fileName);

const replaceFileNameExtension = (fileName: string, extension: FileNameValue): string => {
  return replaceSharedFileNameExtension(fileName, extension || "bin");
};

const appendFileNameExtension = (fileName: string, extension: FileNameValue): string => {
  const normalizedExtension = stripLeadingExtensionDot(extension);
  if (!normalizedExtension) return fileName;
  return `${fileName}.${normalizedExtension}`;
};

const getFileNameWithoutExtension = (fileName: FileNameValue): string =>
  getSharedFileNameWithoutExtension(fileName || "disc");

const getBaseFileName = (fileName: FileNameValue): string => getBaseName(fileName);

export {
  appendFileNameExtension,
  getBaseFileName,
  getFileNameWithoutExtension,
  hasFileNameExtension,
  normalizeArchiveEntryName,
  normalizeArchiveEntryPath,
  replaceFileNameExtension,
  stripFileNameQuery,
};
