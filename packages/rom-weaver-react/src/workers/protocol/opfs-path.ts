import { emitTraceLog } from "../../lib/logging.ts";
import type { LogRecord } from "../../types/logging.ts";

// Per-call trace gating: a caller with an active run's log level / onLog sink threads it through so the
// rare not-found-retry trace emits via the shared logger (gated by the actual log level setting) instead
// of an unconditional console line. Shared low-level callers without a context simply emit nothing.
type OpfsPathTraceContext = {
  logLevel?: string;
  onLog?: (record: Pick<LogRecord, "details" | "level" | "message" | "namespace" | "timestamp">) => void;
};

const LEADING_SLASHES_REGEX = /^\/+/;
const NOT_FOUND_ERROR_REGEX = /not\s+found|object\s+can\s+not\s+be\s+found/i;
const PATH_SEPARATOR_REGEX = /[\\/]+/;

// OPFS handle resolution used to re-fetch navigator.storage.getDirectory() and re-walk the full
// bucket hierarchy on every stage/write/truncate/cleanup. The OPFS root is a per-origin singleton
// and intermediate directories are long-lived, so we memoize both. Leaf FILE handles are never
// cached (files are created/removed under per-op nonces). Invalidation: removeManagedOpfsPath drops
// the removed subtree, and a NotFoundError from a cached handle triggers one retry from a fresh root.
const STORAGE_ROOT_CACHE = new WeakMap<object, Promise<FileSystemDirectoryHandle>>();
const DIRECTORY_HANDLE_CACHE = new Map<string, Promise<FileSystemDirectoryHandle>>();

const emitOpfsPathTrace = (
  trace: OpfsPathTraceContext | undefined,
  message: string,
  details?: Record<string, unknown>,
) =>
  emitTraceLog(
    { logLevel: trace?.logLevel, namespace: "runtime:opfs-path", onLog: trace?.onLog },
    message,
    details || {},
  );

const normalizeOpfsPathParts = (filePath: string): string[] => {
  const raw = String(filePath || "");
  const parts = raw
    .replace(LEADING_SLASHES_REGEX, "")
    .split(PATH_SEPARATOR_REGEX)
    .filter((part) => part && part !== "." && part !== "..");
  // Absolute guest paths are mounted under a single leading root segment (the guest mount root,
  // e.g. the VFS root); strip it so the remainder maps to an OPFS-relative storage path. Never
  // strip the only segment — that would leave the file without a name.
  if (LEADING_SLASHES_REGEX.test(raw) && parts.length > 1) parts.shift();
  return parts;
};

const getStorage = (navigatorObject?: Pick<Navigator, "storage"> | null) =>
  navigatorObject?.storage || globalThis.navigator?.storage;

const getManagedOpfsDirectory = async (
  navigatorObject?: Pick<Navigator, "storage"> | null,
): Promise<FileSystemDirectoryHandle | null> => {
  const storage = getStorage(navigatorObject);
  if (!storage || typeof storage.getDirectory !== "function") return null;
  const cached = STORAGE_ROOT_CACHE.get(storage);
  if (cached) return cached;
  // Cache the in-flight promise so concurrent callers share one getDirectory() call; on failure
  // drop it so a later call can retry instead of inheriting a permanently rejected promise.
  const pending = storage.getDirectory().catch((error) => {
    STORAGE_ROOT_CACHE.delete(storage);
    throw error;
  });
  STORAGE_ROOT_CACHE.set(storage, pending);
  return pending;
};

const resetOpfsHandleCaches = (navigatorObject?: Pick<Navigator, "storage"> | null) => {
  DIRECTORY_HANDLE_CACHE.clear();
  const storage = getStorage(navigatorObject);
  if (storage) STORAGE_ROOT_CACHE.delete(storage);
};

const invalidateDirectoryCacheSubtree = (filePath: string) => {
  const key = normalizeOpfsPathParts(filePath).join("/");
  if (!key) {
    DIRECTORY_HANDLE_CACHE.clear();
    return;
  }
  const childPrefix = `${key}/`;
  for (const cachedKey of DIRECTORY_HANDLE_CACHE.keys()) {
    if (cachedKey === key || cachedKey.startsWith(childPrefix)) DIRECTORY_HANDLE_CACHE.delete(cachedKey);
  }
};

const resolveParentDirectory = async (
  root: FileSystemDirectoryHandle,
  parts: string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle> => {
  let current = root;
  let prefix = "";
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    const cached = DIRECTORY_HANDLE_CACHE.get(prefix);
    if (cached) {
      current = await cached;
      continue;
    }
    const pending = current.getDirectoryHandle(part, { create });
    DIRECTORY_HANDLE_CACHE.set(prefix, pending);
    try {
      current = await pending;
    } catch (error) {
      DIRECTORY_HANDLE_CACHE.delete(prefix);
      throw error;
    }
  }
  return current;
};

const isNotFoundError = (error: unknown) =>
  typeof DOMException !== "undefined" && error instanceof DOMException
    ? error.name === "NotFoundError"
    : error instanceof Error && NOT_FOUND_ERROR_REGEX.test(error.message);

const getManagedOpfsFileHandle = async (
  filePath: string,
  options: {
    create?: boolean;
    navigatorObject?: Pick<Navigator, "storage"> | null;
    trace?: OpfsPathTraceContext;
  } = {},
): Promise<FileSystemFileHandle | null> => {
  const create = options.create === true;
  const parts = normalizeOpfsPathParts(filePath);
  const fileName = parts.pop();
  if (!fileName) return null;

  const locate = async (): Promise<FileSystemFileHandle | null> => {
    const directory = await getManagedOpfsDirectory(options.navigatorObject);
    if (!directory) return null;
    const parent = await resolveParentDirectory(directory, parts, create);
    return parent.getFileHandle(fileName, { create });
  };

  try {
    return await locate();
  } catch (error) {
    if (isNotFoundError(error)) {
      // A cached directory handle may point at a tree that was removed and recreated. Drop the
      // caches and retry once from a fresh root before treating this as a genuine miss.
      emitOpfsPathTrace(options.trace, "not-found, retrying from fresh root", { create, filePath });
      resetOpfsHandleCaches(options.navigatorObject);
      try {
        return await locate();
      } catch (retryError) {
        if (!create && isNotFoundError(retryError)) return null;
        throw retryError;
      }
    }
    throw error;
  }
};

const removeManagedOpfsPath = async (
  filePath: string,
  navigatorObject?: Pick<Navigator, "storage"> | null,
): Promise<void> => {
  const directory = await getManagedOpfsDirectory(navigatorObject);
  if (!directory) return;
  const parts = normalizeOpfsPathParts(filePath);
  const fileName = parts.pop();
  if (!fileName) return;
  // Drop any cached directory handles under the path being removed before deleting it, so a later
  // create of the same path resolves fresh handles instead of a detached, stale subtree.
  invalidateDirectoryCacheSubtree(filePath);
  let parentDirectory = directory;
  try {
    for (const part of parts) parentDirectory = await parentDirectory.getDirectoryHandle(part, { create: false });
    await parentDirectory.removeEntry(fileName, { recursive: true });
  } catch (_error) {
    /* ignore cleanup errors */
  }
};

export { getManagedOpfsDirectory, getManagedOpfsFileHandle, removeManagedOpfsPath };
