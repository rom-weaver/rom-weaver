import type { RomWeaverBrowserSyncAccessMode } from "./browser-opfs-runtime-types.ts";

// OPFS FileSystemSyncAccessHandle surface used by the browser runtime. Mirrors the
// local SyncAccessHandleLike in browser-opfs-io-adapters.ts; duplicated here because
// the shared runtime types module is owned elsewhere.
export type SyncAccessHandleLike = {
  close(): void;
  flush(): void;
  getSize(): number;
  read(buffer: Uint8Array, options?: { at?: number }): number;
  truncate(size: number): void;
  write(buffer: Uint8Array, options?: { at?: number }): number;
};

type SyncAccessCapableFileHandle = {
  createSyncAccessHandle(options?: { mode?: RomWeaverBrowserSyncAccessMode }): Promise<SyncAccessHandleLike>;
};

// OPFS permits only one open access handle (or writable stream) per file at a time. When a previous
// holder is still mid-close - e.g. the staging worker just finished writing a freshly staged source,
// or a sibling operation is tearing down - createSyncAccessHandle briefly rejects with "Access
// Handles cannot be created if there is another open Access Handle or Writable stream associated with
// the same file." The handle frees as soon as the other side closes, so the failure is transient.
// This surfaced when re-uploading the same archive to pick a second entry: the second extract opened
// the staged source while the first operation's handle was still releasing, failing the whole run.
const SYNC_ACCESS_CONTENTION_RETRY_DELAYS_MS = [4, 8, 16, 32, 64, 128];

const isSyncAccessContentionError = (error: unknown): boolean => {
  let source: unknown = error;
  if (typeof error === "object" && error !== null && "message" in error) {
    const candidate = (error as { message?: unknown }).message;
    if (candidate) source = candidate;
  }
  const message = String(source || "").toLowerCase();
  return (
    message.includes("another open access handle") ||
    message.includes("access handles cannot be created") ||
    message.includes("writable stream")
  );
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const createSyncAccessHandleWithRetry = async (
  fileHandle: SyncAccessCapableFileHandle,
  options: { mode?: RomWeaverBrowserSyncAccessMode } | undefined,
): Promise<SyncAccessHandleLike> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return options === undefined
        ? await fileHandle.createSyncAccessHandle()
        : await fileHandle.createSyncAccessHandle(options);
    } catch (error) {
      const delay = SYNC_ACCESS_CONTENTION_RETRY_DELAYS_MS[attempt];
      if (!isSyncAccessContentionError(error) || delay === undefined) throw error;
      await wait(delay);
    }
  }
};

export async function openSyncAccessHandle({
  fileHandle,
  mode,
}: {
  fileHandle: unknown;
  mode?: RomWeaverBrowserSyncAccessMode;
}): Promise<SyncAccessHandleLike> {
  // File handles arrive through FileSystemDirectoryHandleLike.getFileHandle, which
  // surfaces `unknown`; narrow to the sync-access surface actually used at runtime.
  const handle = fileHandle as SyncAccessCapableFileHandle;
  if (mode === undefined) return createSyncAccessHandleWithRetry(handle, undefined);
  try {
    return await createSyncAccessHandleWithRetry(handle, { mode });
  } catch {
    // Some WebKit/iOS builds reject the `mode` option - notably "readwrite-unsafe" - with
    // InvalidStateError, which the proxy would otherwise surface as a fatal EIO and fail the whole
    // run. The default (no-option) handle is plain read-write: always supported, and strictly safer
    // than "unsafe". Fall back to it for any requested mode before giving up.
    return createSyncAccessHandleWithRetry(handle, undefined);
  }
}

export function closeSyncFiles(files: Iterable<unknown>) {
  for (const file of files) {
    try {
      // Best-effort close: entries without a callable close() throw and are ignored,
      // matching the historical behavior for untyped file collections.
      (file as { close(): unknown }).close();
    } catch {
      // ignore best-effort close failures
    }
  }
}

export function writableSyncAccessMode(
  mode: RomWeaverBrowserSyncAccessMode | undefined,
): RomWeaverBrowserSyncAccessMode | undefined {
  return mode === "read-only" ? undefined : mode;
}
