type FileNameValue = unknown;

const FILE_QUERY_OR_HASH_REGEX = /[?#].*$/;
const LEADING_DOT_REGEX = /^\./;
const LEADING_RELATIVE_SLASHES_REGEX = /^\/+/;
const EDGE_SLASHES_REGEX = /^[/\\]+|[/\\]+$/g;
const PATH_BASENAME_PATTERN = /^.*\//;
const UNSAFE_RELATIVE_PATH_SEGMENTS = new Set(["", ".", ".."]);

const normalizePathSeparators = (value: FileNameValue): string => String(value || "").replace(/\\/g, "/");

const stripFileNameQuery = (value: FileNameValue): string => String(value || "").replace(FILE_QUERY_OR_HASH_REGEX, "");

const stripLeadingDot = (value: FileNameValue): string => String(value || "").replace(LEADING_DOT_REGEX, "");

const getBaseName = (value: FileNameValue, fallback = "") => {
  const normalized = normalizePathSeparators(value);
  return normalized.replace(PATH_BASENAME_PATTERN, "") || fallback;
};

const getParentPath = (value: FileNameValue, fallback = "/") => {
  const normalized = normalizePathSeparators(value);
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : fallback;
};

const normalizeSafeFileName = (value: FileNameValue, fallback: FileNameValue = "file.bin") =>
  String(value || fallback || "file.bin")
    .replace(EDGE_SLASHES_REGEX, "")
    .replace(/[/\\]/g, "_");

const normalizeRelativeFilePath = (value: FileNameValue, fallback: FileNameValue = "file.bin") => {
  const normalized = normalizePathSeparators(value || fallback || "file.bin").replace(
    LEADING_RELATIVE_SLASHES_REGEX,
    "",
  );
  if (!normalized || normalized.split("/").some((part) => UNSAFE_RELATIVE_PATH_SEGMENTS.has(part)))
    return normalizeSafeFileName(value, fallback);
  return normalized;
};

export type { FileNameValue };
export {
  getBaseName,
  getParentPath,
  normalizePathSeparators,
  normalizeRelativeFilePath,
  normalizeSafeFileName,
  stripFileNameQuery,
  stripLeadingDot,
};
