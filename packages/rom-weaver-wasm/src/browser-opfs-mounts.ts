import { BrowserOpfsMount } from './browser-opfs-mount.ts';
import type { BrowserOpfsMountAcquireOptions } from './browser-opfs-mount.ts';
import type {
  FileSystemDirectoryHandleLike,
  RomWeaverBrowserSyncAccessMode,
} from './browser-opfs-runtime-types.ts';

export { cleanupBrowserOpfsMounts } from './browser-opfs-mount.ts';
export type { BrowserOpfsMountAcquireOptions } from './browser-opfs-mount.ts';
export { buildBrowserOpfsWasiFds } from './browser-opfs-fd-builder.ts';
export type { BuildBrowserOpfsWasiFdsOptions } from './browser-opfs-fd-builder.ts';
export { normalizeVirtualFiles } from './browser-opfs-virtual-files.ts';
export type { NormalizedVirtualFile } from './browser-opfs-virtual-files.ts';
export { normalizeScratchFilePoolSize } from './browser-opfs-scratch-pool.ts';
export { __createWasiRandomAccessFileInodeForTest } from './browser-opfs-wasi-file-inode.ts';
export type { RandomAccessFileLike } from './browser-opfs-wasi-file-inode.ts';
export {
  isGuestPathWithinMount,
  isGuestPathWithinRoots,
  joinGuestPath,
  normalizeKnownInputPaths,
  normalizeMountHandleMap,
  normalizePreopenOutputPaths,
  normalizeRelativePathParts,
  normalizeStdin,
  normalizeWritableRoots,
} from './browser-opfs-guest-paths.ts';

/** FileSystemDirectoryHandleLike does not declare isSameEntry; real OPFS handles may have it. */
type DirectoryHandleWithSameEntry = FileSystemDirectoryHandleLike & {
  isSameEntry?: (other: FileSystemDirectoryHandleLike) => boolean | Promise<boolean>;
};

export type BrowserOpfsMountCache = ReturnType<typeof createBrowserOpfsMountCache>;

export interface SeedBrowserOpfsScratchPoolsOptions {
  mountCache: BrowserOpfsMountCache;
  mountHandles?: Record<string, FileSystemDirectoryHandleLike> | null;
  runtimeMounts?: string[] | null;
  scratchFilePoolSize?: unknown;
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  virtualOnlyMounts?: boolean;
  writableRoots: string[];
}

export function createBrowserOpfsMountCache() {
  let disposed = false;
  const mountsByPath = new Map<string, BrowserOpfsMount>();

  return {
    async acquire({
      directoryHandle,
      mountPath,
      syncAccessMode,
      virtualOnly,
      writableRoots,
    }: BrowserOpfsMountAcquireOptions) {
      if (disposed) throw new Error('browser OPFS mount cache is disposed');
      const writableRootsKey = writableRoots.join('\0');
      const current = mountsByPath.get(mountPath) ?? null;
      if (
        current
        && current.syncAccessMode === syncAccessMode
        && current.virtualOnly === Boolean(virtualOnly)
        && current.writableRootsKey === writableRootsKey
        && await directoryHandlesMatch(current.directoryHandle, directoryHandle)
      ) {
        return current;
      }
      if (current) {
        mountsByPath.delete(mountPath);
        await current.dispose();
      }
      const mount = await BrowserOpfsMount.create({
        directoryHandle,
        mountPath,
        syncAccessMode,
        virtualOnly,
        writableRoots,
      });
      mountsByPath.set(mountPath, mount);
      return mount;
    },

    async invalidateMounts(mounts: Iterable<BrowserOpfsMount> | null | undefined) {
      const seen = new Set(mounts ?? []);
      for (const mount of seen) {
        if (!mount || typeof mount !== 'object') continue;
        const current = mountsByPath.get(mount.mountPath);
        if (current !== mount) continue;
        mountsByPath.delete(mount.mountPath);
        await mount.dispose();
      }
    },

    async invalidateMountPaths(mountPaths: Iterable<string> | null | undefined) {
      const lookup = new Set(mountPaths ?? []);
      for (const [mountPath, mount] of mountsByPath) {
        if (!lookup.has(mountPath)) continue;
        mountsByPath.delete(mountPath);
        await mount.dispose();
      }
    },

    async dispose() {
      disposed = true;
      const mounts = [...mountsByPath.values()];
      mountsByPath.clear();
      for (const mount of mounts) {
        await mount.dispose();
      }
    },
  };
}

export async function seedBrowserOpfsScratchPools({
  mountCache,
  mountHandles,
  runtimeMounts,
  scratchFilePoolSize,
  syncAccessMode,
  virtualOnlyMounts,
  writableRoots,
}: SeedBrowserOpfsScratchPoolsOptions) {
  for (const mountPath of runtimeMounts ?? []) {
    const handle = mountHandles?.[mountPath];
    if (!handle) continue;
    const mount = await mountCache.acquire({
      directoryHandle: handle,
      mountPath,
      syncAccessMode,
      virtualOnly: virtualOnlyMounts,
      writableRoots,
    });
    await mount.ensureScratchPool({ scratchFilePoolSize });
  }
}

async function directoryHandlesMatch(
  left: DirectoryHandleWithSameEntry,
  right: DirectoryHandleWithSameEntry,
) {
  if (left === right) return true;
  if (typeof left?.isSameEntry === 'function') {
    try {
      return await left.isSameEntry(right);
    } catch {
      // ignored
    }
  }
  if (typeof right?.isSameEntry === 'function') {
    try {
      return await right.isSameEntry(left);
    } catch {
      // ignored
    }
  }
  return false;
}
