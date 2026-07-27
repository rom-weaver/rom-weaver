// Bounded cache of idle (zero-fd) OPFS-backed file adapters.
//
// A many-entry extract creates one adapter per archive entry. Holding every one of them open makes
// live SyncAccessHandles and their multi-MiB coalescing buffers scale with the entry count - the
// iOS tab-kill shape. Closing every one the instant its fd drops swings too far the other way:
// `createSyncAccessHandle` is an async OPFS round-trip, and per-entry checksum/stat passes reopen the
// same file many times over.
//
// This keeps a small LRU of idle adapters open so repeat access is free, while guaranteeing the live
// handle count stays bounded by (concurrent fds + capacity) rather than by entry count.

import type { TraceLine } from "./browser-opfs-runtime-types.ts";

/** Idle adapters kept open. Small enough that WebKit's handle budget is never the constraint. */
const DEFAULT_IDLE_FILE_POOL_CAPACITY = 8;

export interface IdleFilePoolEntry {
  /** Close the underlying file/handle now. Must be idempotent. */
  closeIdleFile(): void;
}

export class IdleFilePool {
  private readonly capacity: number;
  private readonly trace: TraceLine | null;
  // Insertion order is LRU order: re-retaining an entry deletes and re-inserts it at the tail.
  private readonly idle = new Set<IdleFilePoolEntry>();
  private evictions = 0;

  constructor(options: { capacity?: number; trace?: TraceLine | null } = {}) {
    this.capacity = Math.max(0, options.capacity ?? DEFAULT_IDLE_FILE_POOL_CAPACITY);
    this.trace = options.trace ?? null;
  }

  get size(): number {
    return this.idle.size;
  }

  /** Park a now-idle entry, evicting least-recently-idle entries past the capacity. */
  retain(entry: IdleFilePoolEntry): void {
    this.idle.delete(entry);
    this.idle.add(entry);
    while (this.idle.size > this.capacity) {
      const oldest = this.idle.values().next().value;
      if (!oldest) break;
      this.idle.delete(oldest);
      this.evictions += 1;
      this.closeQuietly(oldest);
    }
  }

  /** Take an entry back out of the idle set because it is being opened again. */
  remove(entry: IdleFilePoolEntry): void {
    this.idle.delete(entry);
  }

  /** Close every parked entry (run teardown). Safe to call repeatedly. */
  closeAll(): void {
    const parked = [...this.idle];
    this.idle.clear();
    for (const entry of parked) this.closeQuietly(entry);
    if (parked.length > 0 || this.evictions > 0) {
      this.trace?.(`[browser-opfs] idle file pool drained closed=${parked.length} evictions=${this.evictions}`);
    }
    this.evictions = 0;
  }

  /** Eviction runs inside an unrelated caller's fd_close; a failing close must not become its error. */
  private closeQuietly(entry: IdleFilePoolEntry): void {
    try {
      entry.closeIdleFile();
    } catch (error) {
      this.trace?.(`[browser-opfs] idle file pool close failed ${String(error)}`);
    }
  }
}
