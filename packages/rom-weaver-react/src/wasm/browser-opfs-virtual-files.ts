import * as wasiShim from "@bjorn3/browser_wasi_shim";
import {
  isGuestPathWithinMount,
  joinGuestPath,
  normalizeKnownInputPaths,
  normalizeRelativePathParts,
} from "./browser-opfs-guest-paths.ts";
import { BrowserVirtualRandomAccessFile, isBlobLike, isVirtualFileProxy } from "./browser-opfs-io-adapters.ts";
import type { BrowserOpfsMount } from "./browser-opfs-mount.ts";
import { BrowserProxyRandomAccessFile } from "./browser-opfs-proxy-file.ts";
import type {
  FileReaderSyncLike,
  FileSystemDirectoryHandleLike,
  RomWeaverRunInput,
  TraceLine,
} from "./browser-opfs-runtime-types.ts";
import { basenameForTrace } from "./browser-opfs-stdio-events.ts";
import { WasiRandomAccessFileInode } from "./browser-opfs-wasi-file-inode.ts";
import type { WasiDirectoryContents } from "./browser-opfs-wasi-paths.ts";
import {
  inodeMapContents,
  lastPathPart,
  normalizeWasiRelativePathParts,
  pathExistsInDirectory,
} from "./browser-opfs-wasi-paths.ts";
import { collectRomWeaverRunInputPaths } from "./rom-weaver-command.ts";
import { normalizeGuestPath } from "./rom-weaver-runtime-utils.ts";

declare const FileReaderSync: {
  new (): FileReaderSyncLike;
};

/** Shape produced by normalizeVirtualFiles and consumed by mount startRun. */
export interface NormalizedVirtualFile {
  path: string;
  source: unknown;
}

/** Bookkeeping needed to undo a virtual-file mount after a run finishes. */
export type VirtualFileRestore =
  | { entries: WasiDirectoryContents; hadExisting: true; name: string; value: wasiShim.Inode }
  | { entries: WasiDirectoryContents; hadExisting: false; name: string; value: null };

interface AddVirtualFilesToMountOptions {
  contents: WasiDirectoryContents;
  mountPath: string;
  trace?: TraceLine;
  virtualFiles?: NormalizedVirtualFile[];
}

export function addVirtualFilesToMount({ contents, mountPath, trace, virtualFiles }: AddVirtualFilesToMountOptions) {
  const restores: VirtualFileRestore[] = [];
  for (const entry of virtualFiles ?? []) {
    if (!isGuestPathWithinMount(entry.path, mountPath)) {
      trace?.(
        `[browser-opfs] virtual file skipped outside mount path=${basenameForTrace(entry.path)} mount=${mountPath}`,
      );
      continue;
    }
    const relativePath = entry.path === mountPath ? "" : entry.path.slice(mountPath.length + 1);
    addVirtualFileEntry(contents, relativePath, entry.source, restores, trace);
  }
  return restores;
}

function addVirtualFileEntry(
  contents: WasiDirectoryContents,
  relativePath: string,
  source: unknown,
  restores: VirtualFileRestore[],
  trace: TraceLine | undefined,
) {
  const parts = normalizeWasiRelativePathParts(relativePath);
  if (parts === null || parts.length === 0) {
    throw new TypeError(`virtual file path must be inside a mounted directory: ${relativePath}`);
  }
  let entries: WasiDirectoryContents = contents;
  for (const part of parts.slice(0, -1)) {
    const existing = entries.get(part) ?? null;
    if (!existing) {
      const directory = new wasiShim.Directory(new Map());
      entries.set(part, directory);
      entries = directory.contents;
      continue;
    }
    const existingContents = inodeMapContents(existing);
    if (!existingContents) {
      throw new Error(`virtual file parent path is not a directory: ${relativePath}`);
    }
    entries = existingContents;
  }
  const file = new BrowserVirtualRandomAccessFile(source, { trace });
  const name = lastPathPart(parts);
  trace?.(`[browser-opfs] virtual file mounted name=${name} proxy=${Boolean(file.proxy)} size=${file.size()}`);
  const existingValue = entries.get(name);
  restores.push(
    existingValue === undefined
      ? { entries, hadExisting: false, name, value: null }
      : { entries, hadExisting: true, name, value: existingValue },
  );
  entries.set(name, new WasiRandomAccessFileInode(file, { closeOnLastFdClose: true, readonly: true }));
}

export function restoreVirtualFiles(restores: VirtualFileRestore[]) {
  for (let index = restores.length - 1; index >= 0; index -= 1) {
    const restore = restores[index];
    if (!restore) continue;
    const current = restore.entries.get(restore.name) ?? null;
    if (current instanceof WasiRandomAccessFileInode && typeof current.file?.close === "function") {
      try {
        current.file.close();
      } catch {
        // ignore best-effort virtual-file cleanup failures
      }
    }
    if (restore.hadExisting) {
      restore.entries.set(restore.name, restore.value);
      continue;
    }
    restore.entries.delete(restore.name);
  }
}

interface SyncMountedInputPathsFromOpfsOptions {
  cwdMountPath?: string;
  knownInputPaths?: unknown;
  mountHandles: Record<string, FileSystemDirectoryHandleLike>;
  mounts: BrowserOpfsMount[];
  request: RomWeaverRunInput | undefined;
  runtimeMounts: string[];
  trace?: TraceLine;
}

export async function syncMountedInputPathsFromOpfs({
  cwdMountPath,
  knownInputPaths,
  mounts,
  mountHandles,
  request,
  runtimeMounts,
  trace,
}: SyncMountedInputPathsFromOpfsOptions) {
  const inputPaths = collectMountedInputPaths(request, knownInputPaths);
  const summary = { hydrated: 0, missing: 0, paths: inputPaths.length };
  if (inputPaths.length === 0) return summary;
  const mountsByPath = new Map<string, BrowserOpfsMount>(mounts.map((mount) => [mount.mountPath, mount]));
  for (const path of inputPaths) {
    const resolved = resolveMountedGuestPath(path, mountHandles, runtimeMounts, { cwdMountPath });
    if (!resolved) continue;
    const mount = mountsByPath.get(resolved.mountPath);
    if (!mount) continue;
    const relativePath = resolved.relativeParts.join("/");
    if (relativePath.length === 0 || pathExistsInDirectory(mount.contents, relativePath)) continue;
    const hydrated = await hydrateMountedInputPathFromOpfs({
      mount,
      relativeParts: resolved.relativeParts,
      rootHandle: resolved.handle,
    });
    if (hydrated) {
      summary.hydrated += 1;
    } else {
      summary.missing += 1;
      trace?.(`[browser-opfs] sync mounted input path missing path=${basenameForTrace(path)}`);
    }
  }
  return summary;
}

function collectMountedInputPaths(request: RomWeaverRunInput | undefined, knownInputPaths: unknown) {
  // request is always provided on real runs; preserve the original behavior (a TypeError from
  // collectRomWeaverRunInputPaths) instead of silently skipping when it is missing.
  return collectRomWeaverRunInputPaths(request as RomWeaverRunInput, {
    knownInputPaths: normalizeKnownInputPaths(knownInputPaths),
  });
}

async function hydrateMountedInputPathFromOpfs({
  mount,
  relativeParts,
  rootHandle,
}: {
  mount: BrowserOpfsMount;
  relativeParts: string[];
  rootHandle: FileSystemDirectoryHandleLike;
}) {
  if (!Array.isArray(relativeParts) || relativeParts.length === 0) return false;
  let entries = mount.contents;
  let directoryHandle = rootHandle;
  for (const part of relativeParts.slice(0, -1)) {
    let entry: wasiShim.Inode | null = entries.get(part) ?? null;
    if (entry) {
      try {
        directoryHandle = (await directoryHandle.getDirectoryHandle(part, {
          create: false,
        })) as FileSystemDirectoryHandleLike;
      } catch {
        return false;
      }
    } else {
      try {
        directoryHandle = (await directoryHandle.getDirectoryHandle(part, {
          create: false,
        })) as FileSystemDirectoryHandleLike;
      } catch {
        return false;
      }
      entry = new wasiShim.Directory(new Map());
      entries.set(part, entry);
    }
    if (!(entry instanceof wasiShim.Directory)) return false;
    entries = entry.contents;
  }

  const name = lastPathPart(relativeParts);
  if (entries.has(name)) return true;

  const guestPath = joinGuestPath(mount.mountPath, relativeParts.join("/"));
  const writable = mount.isWritablePath(guestPath);
  try {
    // Confirm the file exists in OPFS before mounting it (the proxy opens it lazily by path).
    await directoryHandle.getFileHandle(name, { create: false });
    const proxyFile = new BrowserProxyRandomAccessFile(mount.proxyClient, guestPath, { writable });
    mount.trackOwnedFile(proxyFile);
    entries.set(name, new WasiRandomAccessFileInode(proxyFile, { readonly: !writable }));
    return true;
  } catch {
    // ignored
  }

  try {
    await directoryHandle.getDirectoryHandle(name, { create: false });
    entries.set(name, new wasiShim.Directory(new Map()));
    return true;
  } catch {
    // ignored
  }
  return false;
}

function resolveMountedGuestPath(
  path: string,
  mountHandles: Record<string, FileSystemDirectoryHandleLike>,
  runtimeMounts: string[],
  { cwdMountPath }: { cwdMountPath?: string } = {},
) {
  const rawPath = String(path ?? "").trim();
  const candidatePaths = [normalizeGuestPath(rawPath, { label: "prepared request path" })];
  if (rawPath && !rawPath.startsWith("/") && cwdMountPath) {
    candidatePaths.push(joinGuestPath(cwdMountPath, rawPath));
  }
  const sortedMounts = [...runtimeMounts].sort((a, b) => b.length - a.length);
  for (const normalizedPath of candidatePaths) {
    for (const mountPath of sortedMounts) {
      if (normalizedPath !== mountPath && !normalizedPath.startsWith(`${mountPath}/`)) continue;
      const handle = mountHandles[mountPath];
      if (!handle) return null;
      const relative = normalizedPath === mountPath ? "" : normalizedPath.slice(mountPath.length + 1);
      return {
        handle,
        mountPath,
        relativeParts: relative ? normalizeRelativePathParts(relative, { label: normalizedPath }) : [],
      };
    }
  }
  return null;
}

export function normalizeVirtualFiles(value: unknown): NormalizedVirtualFile[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError("virtualFiles must be an array");
  return value.map((entry, index) => normalizeVirtualFile(entry, index));
}

function normalizeVirtualFile(entry: unknown, index: number): NormalizedVirtualFile {
  if (!entry || typeof entry !== "object") {
    throw new TypeError(`virtualFiles[${index}] must be an object`);
  }
  const record = entry as Record<string, unknown>;
  const path = normalizeGuestPath(record.path, { label: `virtualFiles[${index}].path` });
  const source = record.source ?? record.file ?? record.blob ?? record.bytes ?? record.data;
  const proxy = record.proxy;
  if (isVirtualFileProxy(proxy)) return { path, source: proxy };
  if (isVirtualFileProxy(source)) return { path, source };
  if (isBlobLike(source)) {
    if (typeof FileReaderSync !== "function") {
      throw new Error("Blob virtual files require FileReaderSync in a dedicated worker");
    }
    return { path, source };
  }
  if (source instanceof Uint8Array || source instanceof ArrayBuffer) return { path, source };
  throw new TypeError(`virtualFiles[${index}].source must be a Blob, File, Uint8Array, or ArrayBuffer`);
}
