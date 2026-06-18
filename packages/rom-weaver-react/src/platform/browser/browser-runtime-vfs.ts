import { emitTraceLog } from "../../lib/logging.ts";
import { getNamedSource } from "../../storage/shared/binary/source-file-utils.ts";
import { createRuntimeOutputFromVfs } from "../../storage/vfs/runtime-output.ts";
import { isVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type { LargeFileVfs } from "../../storage/vfs/types.ts";
import type { RuntimeWorkerIo, RuntimeWorkerSourceRequest } from "../../types/workflow-runtime-adapter.ts";
import { createBrowserOpfsSourceRef } from "../../workers/protocol/browser-opfs-source-ref.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../workers/shared/worker-storage/storage-layout.ts";

type CreateBrowserRuntimeVfsIoOptions = {
  mountPoint?: string;
  vfs: LargeFileVfs;
};

type StagedBrowserSource = Awaited<ReturnType<typeof createBrowserOpfsSourceRef>>;
type CachedStagedSource = {
  cleanedUp?: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  cleanupWhenIdle?: boolean;
  refCount: number;
  staged: StagedBrowserSource;
};

// How long a staged source survives after its last reference is released. One input load stages the
// same source independently for each pass (drop-routing probe -> descent listings -> extract, then a
// post-extract listing), and each pass otherwise re-copies the whole compressed file into OPFS. A
// short retention lets the next pass reuse the existing copy; a re-stage within the window cancels the
// timer (see stageSource), and an explicit session release (releaseSources) still cleans immediately.
const STAGED_SOURCE_RETENTION_MS = 3000;

const emitBrowserRuntimeVfsTrace = (
  trace: RuntimeWorkerSourceRequest["trace"],
  message: string,
  details: Record<string, unknown> = {},
) =>
  emitTraceLog(
    {
      logLevel: trace?.logLevel,
      namespace: "runtime:browser-runtime-vfs",
      onLog: trace?.onLog,
    },
    message,
    details,
  );

const createBrowserRuntimeVfsIo = ({
  mountPoint = WORKER_OPFS_MOUNTPOINT,
  vfs,
}: CreateBrowserRuntimeVfsIoOptions): RuntimeWorkerIo => {
  const stagedSourceCache = new WeakMap<object, CachedStagedSource>();
  // Sources released while a staging pass was still in flight: releaseSources misses the cache for
  // those (the entry is only cached after staging completes), and the cancelled consumer never
  // calls its wrapped cleanup, stranding the staged OPFS copy. Track the release so the in-flight
  // pass cleans up after itself when it lands; a later re-stage of the same source clears the mark.
  const releasedStagingSources = new WeakSet<object>();
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const getStagedSourceCacheKey = (source: unknown) => {
    const directSource = getNamedSource(source as Parameters<typeof getNamedSource>[0]);
    const candidate = directSource || source;
    if (!(candidate && typeof candidate === "object")) return null;
    if (isVfsFileRef(candidate)) return null;
    return candidate;
  };
  const cleanupCachedStagedSource = async (key: object, cached: CachedStagedSource) => {
    // Releasing twice must not double-release the underlying staged copy: the source-ref cleanup
    // decrements a content-keyed registry, and a second call could hit a NEW same-key entry.
    if (cached.cleanedUp) return;
    cached.cleanedUp = true;
    if (cached.cleanupTimer) {
      clearTimeout(cached.cleanupTimer);
      cached.cleanupTimer = undefined;
    }
    stagedSourceCache.delete(key);
    await cached.staged.cleanup().catch(() => undefined);
  };
  const releaseCachedStagedSource = (key: object, cached: CachedStagedSource) => {
    cached.refCount = Math.max(0, cached.refCount - 1);
    if (cached.refCount > 0 || cached.cleanupTimer) return;
    if (cached.cleanupWhenIdle) {
      void cleanupCachedStagedSource(key, cached);
      return;
    }
    // Defer cleanup so the next pass of the same input reuses this staged copy instead of re-staging
    // the whole compressed file. A re-stage within the window clears this timer and re-references it.
    cached.cleanupTimer = setTimeout(() => {
      cached.cleanupTimer = undefined;
      void cleanupCachedStagedSource(key, cached);
    }, STAGED_SOURCE_RETENTION_MS);
  };
  const releaseSources: RuntimeWorkerIo["releaseSources"] = async (sources) => {
    const cleanups: Array<Promise<void>> = [];
    for (const source of sources) {
      const key = getStagedSourceCacheKey(source);
      if (!key) continue;
      releasedStagingSources.add(key);
      const cached = stagedSourceCache.get(key);
      if (!cached) continue;
      cached.cleanupWhenIdle = true;
      // Release means the session no longer references this source. A holder that never returned
      // its ref (a cancelled in-flight pass) would otherwise pin the staged copy forever, so clean
      // regardless of refCount; per-wrapper released flags keep late cleanup() calls harmless.
      cleanups.push(cleanupCachedStagedSource(key, cached));
    }
    await Promise.all(cleanups);
  };
  const wrapCachedStagedSource = (key: object, cached: CachedStagedSource): StagedBrowserSource => {
    let released = false;
    return {
      ...cached.staged,
      cleanup: async () => {
        if (released) return;
        released = true;
        releaseCachedStagedSource(key, cached);
      },
    };
  };
  const statWithRetries = async (filePath: string) => {
    let stat = await vfs.stat(filePath);
    if (stat) return stat;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await wait(25 * (attempt + 1));
      stat = await vfs.stat(filePath);
      if (stat) return stat;
    }
    return null;
  };
  const assertStagedPath = async (filePath: string) => {
    const stat = await statWithRetries(filePath);
    if (!stat) throw new Error(`Browser worker input path is not available: ${filePath}`);
    return stat;
  };
  const stageSource: RuntimeWorkerIo["stageSource"] = async ({
    fallbackFileName,
    pathBucket,
    pathPrefix,
    scope,
    source,
    trace,
  }) => {
    emitBrowserRuntimeVfsTrace(trace, "stageSource start", {
      fallbackFileName,
      pathBucket,
      pathPrefix,
      scope,
    });
    const directSource = getNamedSource(source as Parameters<typeof getNamedSource>[0]);
    const directVfsSource = isVfsFileRef(directSource) ? directSource : isVfsFileRef(source) ? source : null;
    if (directVfsSource && directVfsSource.vfs === vfs) {
      emitBrowserRuntimeVfsTrace(trace, "stageSource using direct vfs source", {
        fileName: directVfsSource.fileName || fallbackFileName,
        filePath: directVfsSource.path,
        scope,
      });
      const stat = await assertStagedPath(directVfsSource.path);
      return {
        cleanup: async () => undefined,
        fileName: directVfsSource.fileName || fallbackFileName,
        filePath: directVfsSource.path,
        size: stat?.size,
      };
    }
    const stageFromSource = () =>
      createBrowserOpfsSourceRef(source, fallbackFileName, {
        bucket: pathBucket,
        mountPoint,
        pathPrefix: pathPrefix || scope,
        trace,
      });
    emitBrowserRuntimeVfsTrace(trace, "stageSource creating source ref", {
      fallbackFileName,
      pathBucket,
      pathPrefix: pathPrefix || scope,
      scope,
    });
    const cacheKey = getStagedSourceCacheKey(source);
    // A fresh stage of this source supersedes any earlier release marker (e.g. the same File
    // re-added after a cancelled candidate selection).
    if (cacheKey) releasedStagingSources.delete(cacheKey);
    const cached = cacheKey ? stagedSourceCache.get(cacheKey) : undefined;
    if (cached) {
      if (cached.cleanupTimer) {
        clearTimeout(cached.cleanupTimer);
        cached.cleanupTimer = undefined;
      }
      cached.refCount += 1;
      emitBrowserRuntimeVfsTrace(trace, "stageSource reusing cached staged source ref", {
        fileName: cached.staged.fileName,
        filePath: cached.staged.filePath,
        scope,
        size: cached.staged.size,
        virtual: !!cached.staged.virtual,
      });
      return wrapCachedStagedSource(cacheKey, cached);
    }
    // Cache every staged source (in-memory virtual *and* real OPFS-staged path copies) keyed on the
    // underlying File/handle, so the list/probe/extract passes of a single input reuse one staged copy
    // instead of re-copying the whole compressed file into OPFS for each pass.
    const cacheStagedSource = (resolved: StagedBrowserSource): StagedBrowserSource => {
      if (!cacheKey) return resolved;
      const entry: CachedStagedSource = {
        refCount: 1,
        staged: resolved,
      };
      if (releasedStagingSources.has(cacheKey)) {
        // The source was released while this stage was in flight; its consumer belongs to a
        // cancelled flow and will never call cleanup, so drop the staged copy now.
        releasedStagingSources.delete(cacheKey);
        void cleanupCachedStagedSource(cacheKey, entry);
        return wrapCachedStagedSource(cacheKey, entry);
      }
      stagedSourceCache.set(cacheKey, entry);
      emitBrowserRuntimeVfsTrace(trace, "stageSource cached staged source ref", {
        fileName: resolved.fileName,
        filePath: resolved.filePath,
        scope,
        size: resolved.size,
        virtual: !!resolved.virtual,
      });
      return wrapCachedStagedSource(cacheKey, entry);
    };
    let staged = await stageFromSource();
    emitBrowserRuntimeVfsTrace(trace, "stageSource source ref created", {
      fileName: staged.fileName,
      filePath: staged.filePath,
      size: staged.size,
      virtual: !!staged.virtual,
    });
    if (staged.virtual) {
      return cacheStagedSource(staged);
    }
    try {
      const stat = await assertStagedPath(staged.filePath);
      emitBrowserRuntimeVfsTrace(trace, "stageSource path verified", {
        filePath: staged.filePath,
        size: staged.size ?? stat.size,
      });
      return cacheStagedSource({
        ...staged,
        size: staged.size ?? stat.size,
      });
    } catch (error) {
      emitBrowserRuntimeVfsTrace(trace, "stageSource path verify failed, retrying", {
        filePath: staged.filePath,
        message: error instanceof Error ? error.message : String(error),
      });
      await staged.cleanup().catch(() => undefined);
      staged = await stageFromSource();
      try {
        const stat = await assertStagedPath(staged.filePath);
        emitBrowserRuntimeVfsTrace(trace, "stageSource retry path verified", {
          filePath: staged.filePath,
          size: staged.size ?? stat.size,
        });
        return cacheStagedSource({
          ...staged,
          size: staged.size ?? stat.size,
        });
      } catch (retryError) {
        emitBrowserRuntimeVfsTrace(trace, "stageSource retry failed", {
          filePath: staged.filePath,
          message: retryError instanceof Error ? retryError.message : String(retryError),
        });
        await staged.cleanup().catch(() => undefined);
        throw retryError instanceof Error ? retryError : error;
      }
    }
  };

  const workerIo: RuntimeWorkerIo = {
    createWorkerOutput: async (result, fallbackFileName, failureMessage) => {
      const fileName = result.fileName || result.outputRef?.fileName || result.patchFileName || fallbackFileName;
      const filePath = result.outputRef?.filePath || result.filePath || result.patchFilePath;
      if (filePath) {
        const cleanup = async () => {
          await Promise.resolve(result.cleanup?.()).catch(() => undefined);
          await vfs.remove(filePath).catch(() => undefined);
        };
        const output = await createRuntimeOutputFromVfs(vfs, filePath, fileName, {
          checksums: result.checksums,
          cleanup,
          size: result.outputRef?.size || result.size,
          timing: result.timing,
        });
        if (result.checksumVariants?.length) output.checksumVariants = result.checksumVariants;
        if (result.romType) output.romType = result.romType;
        if (result.cueText) output.cueText = result.cueText;
        if (result.gdiText) output.gdiText = result.gdiText;
        if (result.discGroupId) output.discGroupId = result.discGroupId;
        if (typeof result.trackNumber === "number") output.trackNumber = result.trackNumber;
        return output;
      }
      throw new Error(failureMessage || "Worker did not return browser output");
    },
    releaseSources,
    runPathWorkerToOutput: async ({
      failureMessage,
      fallbackFileName,
      outputName,
      pathPrefix,
      run,
      scope,
      source,
      trace,
    }) => {
      const workerSource = await stageSource({ fallbackFileName, pathPrefix, scope, source, trace });
      try {
        return await workerIo.createWorkerOutput(await run(workerSource), outputName, failureMessage);
      } finally {
        await workerSource.cleanup().catch(() => undefined);
      }
    },
    stageSource,
    stageSources: (requests) => Promise.all(requests.map((request) => stageSource(request))),
  };
  return workerIo;
};

export { createBrowserRuntimeVfsIo };
