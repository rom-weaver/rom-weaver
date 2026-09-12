import type { RomWeaverBrowserSyncAccessMode } from "./browser-opfs-runtime-types.ts";

// Structural OPFS handle type shared by the runtime and its test doubles.
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

// OPFS rejects a second handle while the previous holder is still closing. Retry this transient
// contention so immediate reuse of a staged source does not fail.
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
    // Retry without options for browsers that reject the requested access mode.
    // If the default read-write handle also fails, its error reaches the caller.
    return createSyncAccessHandleWithRetry(handle, undefined);
  }
}

export function closeSyncFiles(files: Iterable<unknown>) {
  for (const file of files) {
    try {
      // Untyped collection: entries without a callable close() throw and are ignored below.
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
