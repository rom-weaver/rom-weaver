import type { EmscriptenFsLike } from "./types.ts";

const TRAILING_POSIX_SLASHES_REGEX = /\/+$/;
const FILE_QUERY_OR_HASH_REGEX = /[?#].*$/;
const TRAILING_PATH_SEPARATORS_REGEX = /[/\\]+$/;
const PATH_DIRECTORY_PREFIX_REGEX = /^.*[/\\]/;
const TRAILING_PATH_SEPARATOR_REGEX = /[/\\]$/;
const WINDOWS_DRIVE_PREFIX_REGEX = /^[a-z]:/i;
const FILE_TYPE_MODE_MASK = 0o170000;
const DIRECTORY_MODE = 0o040000;

export const TEXT_ENCODER = new TextEncoder();

export const joinFsPath = (...parts: string[]) => {
  const joined = parts
    .filter((part) => part !== "")
    .join("/")
    .replace(/\/+/g, "/");
  return joined.startsWith("/") ? joined : `/${joined}`;
};

export const parentDir = (filePath: string) => {
  const normalized = filePath.replace(TRAILING_POSIX_SLASHES_REGEX, "");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
};

export const baseName = (filePath: string | null | undefined) =>
  String(filePath || "")
    .replace(FILE_QUERY_OR_HASH_REGEX, "")
    .replace(TRAILING_PATH_SEPARATORS_REGEX, "")
    .replace(PATH_DIRECTORY_PREFIX_REGEX, "");

export const mkdirTree = (FS: EmscriptenFsLike, dirPath: string) => {
  if (!dirPath || dirPath === "/") return;
  if (typeof FS.mkdirTree === "function") {
    FS.mkdirTree(dirPath);
    return;
  }
  let current = "";
  for (const part of dirPath.split("/")) {
    if (!part) continue;
    current += `/${part}`;
    try {
      FS.mkdir(current);
    } catch (_err) {
      /* ignore cleanup errors */
    }
  }
};

export const pathExists = (FS: EmscriptenFsLike, filePath: string) => {
  try {
    FS.stat(filePath);
    return true;
  } catch (_err) {
    return false;
  }
};

export const isDirectoryMode = (FS: EmscriptenFsLike, mode: number) =>
  typeof FS.isDir === "function" ? FS.isDir(mode) : (mode & FILE_TYPE_MODE_MASK) === DIRECTORY_MODE;

export const removeTree = (FS: EmscriptenFsLike, filePath: string) => {
  let stat: { mode: number } | null = null;
  try {
    stat = FS.stat(filePath);
  } catch (_err) {
    return;
  }
  if (stat && isDirectoryMode(FS, stat.mode)) {
    for (const entry of FS.readdir(filePath)) {
      if (entry === "." || entry === "..") continue;
      removeTree(FS, joinFsPath(filePath, entry));
    }
    FS.rmdir(filePath);
    return;
  }
  FS.unlink(filePath);
};

export const collectFilePaths = (FS: EmscriptenFsLike, dirPath: string): string[] => {
  const stat = FS.stat(dirPath);
  if (!isDirectoryMode(FS, stat.mode)) return [dirPath];
  const results: string[] = [];
  for (const entry of FS.readdir(dirPath)) {
    if (entry === "." || entry === "..") continue;
    results.push(...collectFilePaths(FS, joinFsPath(dirPath, entry)));
  }
  return results;
};

export const normalizeEntryPath = (filePath: string) => {
  const hadTrailingSlash = TRAILING_PATH_SEPARATOR_REGEX.test(filePath);
  const normalized = String(filePath || "")
    .replace(WINDOWS_DRIVE_PREFIX_REGEX, "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  if (!normalized) throw new Error(`Invalid archive entry name: ${filePath}`);
  return hadTrailingSlash && !normalized.endsWith("/") ? `${normalized}/` : normalized;
};

export const sanitizeWorkFileName = (fileName: string) => baseName(fileName) || "archive.bin";
