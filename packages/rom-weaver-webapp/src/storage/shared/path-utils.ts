import { stripFileNameQuery } from "../../lib/path-utils.ts";

type FileNameValue = unknown;

const LEADING_RELATIVE_SLASHES_REGEX = /^\/+/;
const EDGE_SLASHES_REGEX = /^[/\\]+|[/\\]+$/g;
const PATH_BASENAME_PATTERN = /^.*\//;
const UNSAFE_RELATIVE_PATH_SEGMENTS = new Set(["", ".", ".."]);

const normalizePathSeparators = (value: FileNameValue): string => String(value || "").replace(/\\/g, "/");

const getBaseName = (value: FileNameValue, fallback = "") => {
  const normalized = normalizePathSeparators(value);
  return normalized.replace(PATH_BASENAME_PATTERN, "") || fallback;
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
export { getBaseName, normalizePathSeparators, normalizeRelativeFilePath, stripFileNameQuery };
