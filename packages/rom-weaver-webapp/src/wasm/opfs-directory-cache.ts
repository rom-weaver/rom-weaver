// Remembers OPFS directory handles by path, so repeated opens walk only the folders not seen yet.

interface DirectoryHandleSource {
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<unknown>;
}

interface ResolveOptions {
  /** Creates missing folders. */
  create: boolean;
  /** Namespaces the keys, so one cache can serve several roots. */
  keyPrefix?: string;
  /** Called once per folder served from the cache. */
  onCachedDirectory?: () => void;
  /** Called with the key of each folder looked up in OPFS. */
  onUncachedDirectory?: (key: string) => void;
}

const STALE_HANDLE_ERROR_NAMES = new Set(["NotFoundError", "InvalidStateError", "UnknownError"]);

/** Whether a call on a cached directory handle failed because the folder was removed. WebKit reports UnknownError when a file is created in one. */
export const isStaleDirectoryHandleError = (error: unknown): boolean =>
  STALE_HANDLE_ERROR_NAMES.has((error as { name?: string } | null)?.name ?? "");

export class OpfsDirectoryCache<Directory extends DirectoryHandleSource> {
  // Promises, so concurrent walks of one path share a single lookup.
  private readonly handles = new Map<string, Promise<Directory>>();
  private readonly maxEntries: number;

  constructor(maxEntries = Number.POSITIVE_INFINITY) {
    this.maxEntries = maxEntries;
  }

  async resolve(
    root: Directory,
    parts: readonly string[],
    { create, keyPrefix = "", onCachedDirectory, onUncachedDirectory }: ResolveOptions,
  ): Promise<Directory> {
    let current = root;
    let key = keyPrefix;
    for (const part of parts) {
      key = `${key}/${part}`;
      const cached = this.handles.get(key);
      if (cached) {
        onCachedDirectory?.();
        current = await cached;
        continue;
      }
      onUncachedDirectory?.(key);
      const pending = current.getDirectoryHandle(part, { create }) as Promise<Directory>;
      this.remember(key, pending);
      try {
        current = await pending;
      } catch (error) {
        this.handles.delete(key);
        throw error;
      }
    }
    return current;
  }

  /** Drops the folder at `parts` and everything under it; no parts and no prefix drops all. */
  forget(parts: readonly string[], keyPrefix = ""): void {
    const key = parts.reduce((path, part) => `${path}/${part}`, keyPrefix);
    if (!key) {
      this.handles.clear();
      return;
    }
    for (const cachedKey of this.handles.keys()) {
      if (cachedKey === key || cachedKey.startsWith(`${key}/`)) this.handles.delete(cachedKey);
    }
  }

  clear(): void {
    this.handles.clear();
  }

  private remember(key: string, pending: Promise<Directory>): void {
    if (this.handles.size >= this.maxEntries) {
      const oldest = this.handles.keys().next().value;
      if (oldest !== undefined) this.handles.delete(oldest);
    }
    this.handles.set(key, pending);
  }
}
