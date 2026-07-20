type FileNameValue = unknown;

const PATH_PART_SPLIT_REGEX = /[/\\]+/;
const LEADING_EXTENSION_DOT_REGEX = /^\./;
const EXTENSION_CHARS_ONLY_REGEX = /^[^./\\\s?#]+$/;
const FILE_NAME_PARTS_REGEX = /^(.+?)(\.[^./\\]*)?$/;
const CHD_EXTENSION_REGEX = /\.chd$/i;
const COMPRESSION_LEVEL_PROFILE_REGEX = /^(min|very-low|low|medium|high|very-high|max)$/i;

const findQueryOrHashIndex = (value: string): number => {
  const query = value.indexOf("?");
  const hash = value.indexOf("#");
  if (query < 0) return hash;
  if (hash < 0) return query;
  return Math.min(query, hash);
};

// Index of the dot that opens the file extension, or -1. Replaces the former
// `/\.[^./\\\s?#]+(?:[?#].*)?$/` scan, whose leading `\.` retried at every dot
// and made long dotted names quadratic (CodeQL js/polynomial-redos).
//
// The regex matched leftmost-first, so a dot before a `?`/`#` wins over one after it
// (`a.b?c.d` -> `b`, not `d`). The pre-query stem is therefore checked first.
const findExtensionDotIndex = (value: string): number => {
  const queryIndex = findQueryOrHashIndex(value);
  if (queryIndex >= 0) {
    const stem = value.slice(0, queryIndex);
    const stemDot = stem.lastIndexOf(".");
    if (stemDot >= 0 && EXTENSION_CHARS_ONLY_REGEX.test(stem.slice(stemDot + 1))) return stemDot;
  }
  const trailingDot = value.lastIndexOf(".");
  if (trailingDot >= 0 && EXTENSION_CHARS_ONLY_REGEX.test(value.slice(trailingDot + 1))) return trailingDot;
  return -1;
};

const stripFileNameQuery = (value: FileNameValue): string => {
  const text = String(value || "");
  const queryIndex = findQueryOrHashIndex(text);
  return queryIndex < 0 ? text : text.slice(0, queryIndex);
};

const stripLeadingExtensionDot = (value: FileNameValue): string =>
  String(value || "").replace(LEADING_EXTENSION_DOT_REGEX, "");

const getPathBaseName = (value: FileNameValue, fallback = ""): string => {
  const text = String(value || "").trim();
  if (!text) return fallback;
  const parts = text.split(PATH_PART_SPLIT_REGEX).filter((part) => !!part);
  return parts.at(-1) || fallback;
};

const hasFileNameExtension = (fileName: FileNameValue): boolean => findExtensionDotIndex(String(fileName || "")) >= 0;

const getFileNameExtension = (
  fileName: FileNameValue,
  options: { includeDot?: boolean; stripQuery?: boolean } = {},
): string => {
  const normalized = options.stripQuery === false ? String(fileName || "") : stripFileNameQuery(fileName);
  const dotIndex = findExtensionDotIndex(normalized);
  if (dotIndex < 0) return "";
  const tail = normalized.slice(dotIndex + 1);
  const queryIndex = findQueryOrHashIndex(tail);
  const extension = (queryIndex < 0 ? tail : tail.slice(0, queryIndex)).toLowerCase();
  if (!extension) return "";
  return options.includeDot ? `.${extension}` : extension;
};

const getFileNameWithoutExtension = (fileName: FileNameValue): string => {
  const text = String(fileName || "");
  const dotIndex = findExtensionDotIndex(text);
  return dotIndex < 0 ? text : text.slice(0, dotIndex);
};

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
  const dotIndex = findExtensionDotIndex(fileName);
  if (dotIndex >= 0) return `${fileName.slice(0, dotIndex)}.${normalizedExtension}`;
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
