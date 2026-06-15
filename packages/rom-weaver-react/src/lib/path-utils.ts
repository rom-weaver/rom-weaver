type FileNameValue = unknown;

const PATH_PART_SPLIT_REGEX = /[/\\]+/;
const FILE_QUERY_OR_HASH_REGEX = /[?#].*$/;
const LEADING_EXTENSION_DOT_REGEX = /^\./;
const FILE_EXTENSION_REGEX = /\.[^./\\\s?#]+(?:[?#].*)?$/;
const FILE_EXTENSION_CAPTURE_REGEX = /\.([^./\\\s?#]+)(?:[?#].*)?$/;
const FILE_NAME_PARTS_REGEX = /^(.+?)(\.[^./\\]*)?$/;
const CHD_EXTENSION_REGEX = /\.chd$/i;
const COMPRESSION_LEVEL_PROFILE_REGEX = /^(min|very-low|low|medium|high|very-high|max)$/i;

const stripFileNameQuery = (value: FileNameValue): string => String(value || "").replace(FILE_QUERY_OR_HASH_REGEX, "");

const stripLeadingExtensionDot = (value: FileNameValue): string =>
  String(value || "").replace(LEADING_EXTENSION_DOT_REGEX, "");

const getPathBaseName = (value: FileNameValue, fallback = ""): string => {
  const text = String(value || "").trim();
  if (!text) return fallback;
  const parts = text.split(PATH_PART_SPLIT_REGEX).filter((part) => !!part);
  return parts[parts.length - 1] || fallback;
};

const hasFileNameExtension = (fileName: FileNameValue): boolean => FILE_EXTENSION_REGEX.test(String(fileName || ""));

const getFileNameExtension = (
  fileName: FileNameValue,
  options: { includeDot?: boolean; stripQuery?: boolean } = {},
): string => {
  const normalized = options.stripQuery === false ? String(fileName || "") : stripFileNameQuery(fileName);
  const extension = normalized.match(FILE_EXTENSION_CAPTURE_REGEX)?.[1]?.toLowerCase() || "";
  if (!extension) return "";
  return options.includeDot ? `.${extension}` : extension;
};

const getFileNameWithoutExtension = (fileName: FileNameValue): string =>
  String(fileName || "").replace(FILE_EXTENSION_REGEX, "");

const getFileNameParts = (fileName: FileNameValue, fallback = "input.bin"): { extension: string; stem: string } => {
  const baseName = getPathBaseName(String(fileName || ""), fallback);
  const match = baseName.match(FILE_NAME_PARTS_REGEX);
  return {
    extension: match?.[2] || "",
    stem: match?.[1] || baseName,
  };
};

const replaceFileNameExtension = (fileName: string, extension: FileNameValue): string => {
  const normalizedExtension = stripLeadingExtensionDot(extension || "bin");
  if (!normalizedExtension) return fileName;
  if (hasFileNameExtension(fileName)) return fileName.replace(FILE_EXTENSION_REGEX, `.${normalizedExtension}`);
  return `${fileName}.${normalizedExtension}`;
};

const isCompressionLevelProfile = (value: FileNameValue): boolean =>
  COMPRESSION_LEVEL_PROFILE_REGEX.test(String(value || ""));

const joinPath = (directory: string, fileName: string): string => {
  const normalizedDirectory = String(directory || "").trim();
  if (!normalizedDirectory) return fileName;
  const separator = normalizedDirectory.includes("\\") && !normalizedDirectory.includes("/") ? "\\" : "/";
  if (normalizedDirectory.endsWith("/") || normalizedDirectory.endsWith("\\"))
    return `${normalizedDirectory}${fileName}`;
  return `${normalizedDirectory}${separator}${fileName}`;
};

export {
  CHD_EXTENSION_REGEX,
  getFileNameExtension,
  getFileNameParts,
  getFileNameWithoutExtension,
  getPathBaseName,
  hasFileNameExtension,
  isCompressionLevelProfile,
  joinPath,
  replaceFileNameExtension,
  stripFileNameQuery,
  stripLeadingExtensionDot,
};
