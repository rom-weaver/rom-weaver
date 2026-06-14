import { getFileNameParts, getPathBaseName } from "../path-utils.ts";

const WORK_ROOT_PATH = "/work";

const joinPath = (directory: string, fileName: string): string => {
  const normalizedDirectory = String(directory || "").trim();
  if (!normalizedDirectory) return fileName;
  const separator = normalizedDirectory.includes("\\") && !normalizedDirectory.includes("/") ? "\\" : "/";
  if (normalizedDirectory.endsWith("/") || normalizedDirectory.endsWith("\\"))
    return `${normalizedDirectory}${fileName}`;
  return `${normalizedDirectory}${separator}${fileName}`;
};

const normalizeAbsolutePosixPath = (pathValue: string): string => {
  const normalized = String(pathValue || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
  if (!normalized.startsWith("/")) return "";
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
};

const selectRomWeaverOutputPath = (
  sourcePath: string,
  outputFileName: string,
  // `modifiedFilePath` is optional now that patch-create accepts cheat codes
  // instead of a modified ROM; undefined entries are coerced/filtered below.
  blockedPaths: Array<string | undefined> = [],
) => {
  const outputBaseName = getPathBaseName(outputFileName, "output.bin");
  const preferredPath = joinPath(WORK_ROOT_PATH, outputBaseName);
  const normalizedPreferredPath = normalizeAbsolutePosixPath(preferredPath);
  const normalizedBlocked = new Set(
    [sourcePath, ...blockedPaths]
      .map((pathValue) => normalizeAbsolutePosixPath(pathValue ?? ""))
      .filter((pathValue) => !!pathValue),
  );
  if (normalizedBlocked.has(normalizedPreferredPath)) {
    throw new Error(`Browser output path conflicts with an active input or patch: ${preferredPath}`);
  }
  return preferredPath;
};

const appendTrimmedOutputMarker = (fileName: string) => {
  const { extension, stem } = getFileNameParts(fileName || "trimmed.bin");
  const normalizedStem = stem.trim() || "trimmed";
  const trimmedStem = /\(trimmed\)$/i.test(normalizedStem) ? normalizedStem : `${normalizedStem} (trimmed)`;
  return `${trimmedStem}${extension || ".bin"}`;
};

const getTrimOutputFileName = (sourceFilePath: string, requestedOutputName: string | undefined) => {
  const sourceBaseName = getPathBaseName(sourceFilePath, "trimmed.bin");
  const requestedBaseName = getPathBaseName(requestedOutputName || sourceBaseName, sourceBaseName);
  const sourceParts = getFileNameParts(sourceBaseName);
  const requestedParts = getFileNameParts(requestedBaseName);
  if (requestedParts.stem.trim().toLowerCase() === sourceParts.stem.trim().toLowerCase()) {
    return appendTrimmedOutputMarker(requestedBaseName);
  }
  return requestedBaseName;
};

export { getTrimOutputFileName, selectRomWeaverOutputPath };
