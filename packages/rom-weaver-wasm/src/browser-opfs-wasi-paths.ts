import * as wasiShim from "@bjorn3/browser_wasi_shim";

/** Directory contents map used by the in-memory WASI inode tree. */
export type WasiDirectoryContents = Map<string, wasiShim.Inode>;

export function requestsWriteRights(fsRightsBase: bigint, oflags: number) {
  return (
    (BigInt(fsRightsBase) & BigInt(wasiShim.wasi.RIGHTS_FD_WRITE)) === BigInt(wasiShim.wasi.RIGHTS_FD_WRITE) ||
    (oflags & wasiShim.wasi.OFLAGS_TRUNC) === wasiShim.wasi.OFLAGS_TRUNC ||
    (oflags & wasiShim.wasi.OFLAGS_CREAT) === wasiShim.wasi.OFLAGS_CREAT
  );
}

export function pathExistsInDirectory(contents: WasiDirectoryContents, pathStr: string) {
  return Boolean(findEntryInDirectory(contents, pathStr));
}

export function pathIsDirectoryInDirectory(contents: WasiDirectoryContents, pathStr: string) {
  const entry = findEntryInDirectory(contents, pathStr);
  return Boolean(entry && entry instanceof wasiShim.Directory);
}

export function findEntryInDirectory(contents: WasiDirectoryContents, pathStr: string): wasiShim.Inode | null {
  if (!(contents instanceof Map)) return null;
  const parts = normalizeWasiRelativePathParts(pathStr);
  if (parts === null) return null;
  if (parts.length === 0) return new wasiShim.Directory(contents);

  let currentEntries = contents;
  for (const [index, part] of parts.entries()) {
    const entry = currentEntries.get(part) ?? null;
    if (!entry) return null;
    if (index === parts.length - 1) return entry;
    const entryContents = inodeMapContents(entry);
    if (!entryContents) return null;
    currentEntries = entryContents;
  }
  return null;
}

// Inode subclasses store directory children on `contents`; duck-typed rather than
// `instanceof Directory` so wrapped/subclassed directory inodes still match.
export function inodeMapContents(entry: wasiShim.Inode): WasiDirectoryContents | null {
  const contents = (entry as { contents?: unknown }).contents;
  return contents instanceof Map ? (contents as WasiDirectoryContents) : null;
}

// Callers verify parts is non-empty before indexing; this re-asserts that for
// noUncheckedIndexedAccess without resorting to non-null assertions.
export function lastPathPart(parts: string[]): string {
  const name = parts.at(-1);
  if (name === undefined) throw new Error("path has no segments");
  return name;
}

export function unlinkEntryFromDirectory(contents: WasiDirectoryContents, pathStr: string) {
  const parts = normalizeWasiRelativePathParts(pathStr);
  if (parts === null) return { inode_obj: null, ret: wasiShim.wasi.ERRNO_NOTCAPABLE };
  if (parts.length === 0) return { inode_obj: null, ret: wasiShim.wasi.ERRNO_INVAL };
  const parent = resolveParentDirectory(contents, parts);
  if (parent.ret !== wasiShim.wasi.ERRNO_SUCCESS || parent.entries === null) {
    return { inode_obj: null, ret: parent.ret };
  }
  const entry = parent.entries.get(parent.name) ?? null;
  if (!entry) return { inode_obj: null, ret: wasiShim.wasi.ERRNO_NOENT };
  parent.entries.delete(parent.name);
  return { inode_obj: entry, ret: wasiShim.wasi.ERRNO_SUCCESS };
}

type ParentDirectoryResolution =
  | { ret: number; entries: WasiDirectoryContents; name: string }
  | { ret: number; entries: null; name: null };

export function resolveParentDirectory(contents: WasiDirectoryContents, parts: string[]): ParentDirectoryResolution {
  let entries = contents;
  for (const part of parts.slice(0, -1)) {
    const entry = entries.get(part) ?? null;
    if (!entry) return { entries: null, name: null, ret: wasiShim.wasi.ERRNO_NOENT };
    const entryContents = inodeMapContents(entry);
    if (!entryContents) {
      return { entries: null, name: null, ret: wasiShim.wasi.ERRNO_NOTDIR };
    }
    entries = entryContents;
  }
  return { entries, name: lastPathPart(parts), ret: wasiShim.wasi.ERRNO_SUCCESS };
}

export function normalizeWasiRelativePathParts(pathStr: string) {
  const value = String(pathStr);
  if (value.startsWith("/") || value.includes("\0")) return null;
  const parts: string[] = [];
  for (const token of value.split("/")) {
    if (token === "" || token === ".") continue;
    if (token === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(token);
  }
  return parts;
}

export function validateWasiRelativePath(pathStr: string) {
  const value = String(pathStr);
  if (value.startsWith("/")) return wasiShim.wasi.ERRNO_NOTCAPABLE;
  if (value.includes("\0")) return wasiShim.wasi.ERRNO_INVAL;

  const parts: string[] = [];
  for (const token of value.split("/")) {
    if (token === "" || token === ".") continue;
    if (token === "..") {
      if (parts.length === 0) return wasiShim.wasi.ERRNO_NOTCAPABLE;
      parts.pop();
      continue;
    }
    parts.push(token);
  }

  return wasiShim.wasi.ERRNO_SUCCESS;
}

export function pathRequiresDirectory(pathStr: string, oflags: number) {
  return (oflags & wasiShim.wasi.OFLAGS_DIRECTORY) === wasiShim.wasi.OFLAGS_DIRECTORY || String(pathStr).endsWith("/");
}
