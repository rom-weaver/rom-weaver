import type { BrowserOpfsMountAcquireOptions } from "./browser-opfs-mount.ts";
import { BrowserOpfsMount } from "./browser-opfs-mount.ts";
import type { FileSystemDirectoryHandleLike } from "./browser-opfs-runtime-types.ts";

export { buildBrowserOpfsWasiFds } from "./browser-opfs-fd-builder.ts";
export {
  normalizeKnownInputPaths,
  normalizeMountHandleMap,
  normalizeWritableRoots,
} from "./browser-opfs-guest-paths.ts";
export type { BrowserOpfsMountAcquireOptions } from "./browser-opfs-mount.ts";
export { cleanupBrowserOpfsMounts } from "./browser-opfs-mount.ts";

export { normalizeVirtualFiles } from "./browser-opfs-virtual-files.ts";

/** FileSystemDirectoryHandleLike does not declare isSameEntry; real OPFS handles may have it. */
type DirectoryHandleWithSameEntry = FileSystemDirectoryHandleLike & {
  isSameEntry?: (other: FileSystemDirectoryHandleLike) => boolean | Promise<boolean>;
};

export type BrowserOpfsMountCache = ReturnType<typeof createBrowserOpfsMountCache>;

export function createBrowserOpfsMountCache() {
  let disposed = false;
  const mountsByPath = new Map<string, BrowserOpfsMount>();

  return {
    async acquire({
      directoryHandle,
      mountPath,
      proxyClient,
      syncAccessMode,
      virtualOnly,
      writableRoots,
    }: BrowserOpfsMountAcquireOptions) {
      if (disposed) throw new Error("browser OPFS mount cache is disposed");
      const writableRootsKey = writableRoots.join("\0");
      const resolvedProxyClient = proxyClient ?? null;
      const current = mountsByPath.get(mountPath) ?? null;
      if (
        current &&
        current.syncAccessMode === syncAccessMode &&
        current.virtualOnly === Boolean(virtualOnly) &&
        current.writableRootsKey === writableRootsKey &&
        current.proxyClient === resolvedProxyClient &&
        (await directoryHandlesMatch(current.directoryHandle, directoryHandle))
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
        proxyClient: resolvedProxyClient,
        syncAccessMode,
        virtualOnly,
        writableRoots,
      });
      mountsByPath.set(mountPath, mount);
      return mount;
    },

    async dispose() {
      disposed = true;
      const mounts = [...mountsByPath.values()];
      mountsByPath.clear();
      for (const mount of mounts) {
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

    async invalidateMounts(mounts: Iterable<BrowserOpfsMount> | null | undefined) {
      const seen = new Set(mounts ?? []);
      for (const mount of seen) {
        if (!mount || typeof mount !== "object") continue;
        const current = mountsByPath.get(mount.mountPath);
        if (current !== mount) continue;
        mountsByPath.delete(mount.mountPath);
        await mount.dispose();
      }
    },
  };
}

async function directoryHandlesMatch(left: DirectoryHandleWithSameEntry, right: DirectoryHandleWithSameEntry) {
  if (left === right) return true;
  if (typeof left?.isSameEntry === "function") {
    try {
      return await left.isSameEntry(right);
    } catch {
      // ignored
    }
  }
  if (typeof right?.isSameEntry === "function") {
    try {
      return await right.isSameEntry(left);
    } catch {
      // ignored
    }
  }
  return false;
}
