import { emitTraceLog } from "../../lib/logging.ts";
import { releaseBrowserSource, retainBrowserSource } from "../../storage/browser/browser-source-primitives.ts";
import { getNamedSource } from "../../storage/shared/binary/source-file-utils.ts";
import { createRuntimeOutputFromVfs } from "../../storage/vfs/runtime-output.ts";
import { isVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type { LargeFileVfs } from "../../storage/vfs/types.ts";
import type {
  RuntimeWorkerIo,
  RuntimeWorkerPathSource,
  RuntimeWorkerSourceRequest,
} from "../../types/workflow-runtime-adapter.ts";
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

// Retain staged input briefly between probe/list/extract passes to avoid
// re-copying it into OPFS. Explicit session release still cleans immediately.
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

// Global cache deduplicates staging across several WorkflowRuntime instances.
// Without it, concurrent instances allocate phantom `name-2.ext` paths that
// leak into codec outputs. String keys are pruned during staged-source cleanup.
const stagedSourceCache = new Map<string, CachedStagedSource>();
// Coalesce concurrent stages before the resolved cache exists. Tokens bind a
// release to the exact in-flight stage it targets.
const pendingStages = new Map<string, { promise: Promise<void>; token: number }>();
let nextStageToken = 0;
// Remember releases that beat cache insertion so the completed stage cleans
// itself up. Tokens prevent a stale release from destroying a later re-stage.
const releasedStagingSources = new Map<string, number>();
// Per-object identity key for staged sources. File metadata is not content identity: two distinct files
// can have the same name, size, and lastModified. Callers that intentionally derive a new File view keep
// that view stable across passes instead (see normalizeZipLikeArchiveSource).
let nextObjectIdentityKey = 0;
const objectIdentityKeys = new WeakMap<object, string>();
const getObjectIdentityKey = (candidate: object): string => {
  const existing = objectIdentityKeys.get(candidate);
  if (existing) return existing;
  nextObjectIdentityKey += 1;
  const created = `obj:${nextObjectIdentityKey}`;
  objectIdentityKeys.set(candidate, created);
  return created;
};
const cleanupCachedStagedSource = async (key: string, cached: CachedStagedSource) => {
  // Releasing twice must not double-release the underlying staged copy: the source-ref cleanup
  // decrements a content-keyed registry, and a second call could hit a NEW same-key entry.
  if (cached.cleanedUp) return;
  cached.cleanedUp = true;
  if (cached.cleanupTimer) {
    clearTimeout(cached.cleanupTimer);
    cached.cleanupTimer = undefined;
  }
  // Only evict our own slot: a re-stage may have replaced this key with a different live entry, and
  // deleting that would strand the new staged copy (identity guard, mirrors browser-virtual-files.ts).
  if (stagedSourceCache.get(key) === cached) stagedSourceCache.delete(key);
  // Prune any lingering in-flight-release mark so the process-global set stays bounded.
  releasedStagingSources.delete(key);
  await cached.staged.cleanup().catch(() => undefined);
};
const releaseCachedStagedSource = (key: string, cached: CachedStagedSource) => {
  cached.refCount = Math.max(0, cached.refCount - 1);
  if (cached.refCount > 0 || cached.cleanupTimer) return;
  if (cached.cleanupWhenIdle) {
    void cleanupCachedStagedSource(key, cached);
    return;
  }
  // Defer cleanup so the next pass of the same input reuses this staged copy instead of re-staging the
  // whole compressed file. A re-stage within the window clears this timer and re-references it.
  cached.cleanupTimer = setTimeout(() => {
    cached.cleanupTimer = undefined;
    void cleanupCachedStagedSource(key, cached);
  }, STAGED_SOURCE_RETENTION_MS);
};
const wrapCachedStagedSource = (key: string, cached: CachedStagedSource): StagedBrowserSource => {
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

const createBrowserRuntimeVfsIo = ({
  mountPoint = WORKER_OPFS_MOUNTPOINT,
  vfs,
}: CreateBrowserRuntimeVfsIoOptions): RuntimeWorkerIo => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const getStagedSourceCacheKey = (source: unknown): string | null => {
    const directSource = getNamedSource(source as Parameters<typeof getNamedSource>[0]);
    const candidate = directSource || source;
    if (!(candidate && typeof candidate === "object")) return null;
    if (isVfsFileRef(candidate)) return null;
    // Namespace the (process-global) cache key by mount so it never serves a path staged under a
    // different mount point. All current runtimes share WORKER_OPFS_MOUNTPOINT; this stays correct if
    // that ever changes.
    const mountPrefix = `${mountPoint}|`;
    return `${mountPrefix}${getObjectIdentityKey(candidate)}`;
  };
  const releaseStagedSource = (source: unknown): Promise<void> | undefined => {
    const key = getStagedSourceCacheKey(source);
    if (!key) return undefined;
    const cached = stagedSourceCache.get(key);
    if (!cached) {
      const pending = pendingStages.get(key);
      if (pending) releasedStagingSources.set(key, pending.token);
      return undefined;
    }
    cached.cleanupWhenIdle = true;
    // A workflow can release an old source while a queued validation or apply still owns a live
    // staged reader. Cleaning here would delete the OPFS path under that reader. Let the last reader
    // cleanup perform the release; this also covers re-stages that began before the old release ran.
    if (cached.refCount > 0) return undefined;
    return cleanupCachedStagedSource(key, cached);
  };
  const releaseSources: RuntimeWorkerIo["releaseSources"] = async (sources) => {
    await Promise.all(sources.map((source) => Promise.resolve(releaseStagedSource(source))));
  };
  const retainOwnedSources: RuntimeWorkerIo["retainOwnedSources"] = (sources) => {
    for (const source of sources) {
      const directSource = getNamedSource(source as Parameters<typeof getNamedSource>[0]);
      retainBrowserSource(directSource || source);
    }
  };
  const releaseOwnedSources: RuntimeWorkerIo["releaseOwnedSources"] = async (sources) => {
    await Promise.all(
      sources.map((source) => {
        const directSource = getNamedSource(source as Parameters<typeof getNamedSource>[0]);
        return releaseBrowserSource(directSource || source);
      }),
    );
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
    pathPrefixInPath,
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
        pathPrefixInPath,
        trace,
      });
    emitBrowserRuntimeVfsTrace(trace, "stageSource creating source ref", {
      fallbackFileName,
      pathBucket,
      pathPrefix: pathPrefix || scope,
      scope,
    });
    const cacheKey = getStagedSourceCacheKey(source);
    // Unique per stageSource call. Ties an in-flight-release mark (releasedStagingSources) to the exact
    // stage it targets so a later re-stage under the same key is never cleaned by a stale release.
    nextStageToken += 1;
    const stageToken = nextStageToken;
    // A fresh stage of this source supersedes any earlier release marker (e.g. the same File
    // re-added after a cancelled candidate selection).
    if (cacheKey) releasedStagingSources.delete(cacheKey);
    // Reuse an already-staged copy: cancel any pending cleanup and hand back another ref-counted wrapper.
    const reuseCachedEntry = (key: string, entry: CachedStagedSource): StagedBrowserSource => {
      if (entry.cleanupTimer) {
        clearTimeout(entry.cleanupTimer);
        entry.cleanupTimer = undefined;
      }
      entry.refCount += 1;
      emitBrowserRuntimeVfsTrace(trace, "stageSource reusing cached staged source ref", {
        fileName: entry.staged.fileName,
        filePath: entry.staged.filePath,
        scope,
        size: entry.staged.size,
        virtual: !!entry.staged.virtual,
      });
      return wrapCachedStagedSource(key, entry);
    };
    const cached = cacheKey ? stagedSourceCache.get(cacheKey) : undefined;
    if (cacheKey && cached) return reuseCachedEntry(cacheKey, cached);
    // Coalesce in-flight stages so one source cannot acquire a duplicate `name-2.ext` OPFS path.
    if (cacheKey) {
      // Recheck after failures because another waiter may already have published a replacement stage.
      let inFlight = pendingStages.get(cacheKey);
      while (inFlight) {
        emitBrowserRuntimeVfsTrace(trace, "stageSource awaiting in-flight stage of same source", { scope });
        await inFlight.promise.catch(() => undefined);
        const settled = stagedSourceCache.get(cacheKey);
        if (settled) return reuseCachedEntry(cacheKey, settled);
        inFlight = pendingStages.get(cacheKey);
      }
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
      // Defer a matching in-flight release until the live consumer drops its reference.
      if (releasedStagingSources.get(cacheKey) === stageToken) {
        releasedStagingSources.delete(cacheKey);
        entry.cleanupWhenIdle = true;
      }
      // Do not replace a concurrently cached entry; this stage's wrapper will clean up its duplicate.
      if (stagedSourceCache.get(cacheKey)) {
        emitBrowserRuntimeVfsTrace(trace, "stageSource skipped caching (key already live)", {
          fileName: resolved.fileName,
          filePath: resolved.filePath,
          scope,
        });
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
    const runStaging = async (): Promise<StagedBrowserSource> => {
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
    // No stable cache key (e.g. a non-object source): nothing to coalesce against, stage directly.
    if (!cacheKey) return runStaging();
    // Publish this stage as in-flight so a concurrent same-source pass coalesces onto it (above) rather
    // than starting a duplicate stage. Resolved in `finally` after the entry is cached, so the waiter
    // then finds it in the resolved-entry cache.
    let settleInFlight: () => void = () => undefined;
    pendingStages.set(cacheKey, {
      promise: new Promise<void>((resolve) => {
        settleInFlight = resolve;
      }),
      token: stageToken,
    });
    try {
      return await runStaging();
    } finally {
      pendingStages.delete(cacheKey);
      settleInFlight();
    }
  };

  const workerIo: RuntimeWorkerIo = {
    createWorkerOutput: async (result, fallbackFileName, failureMessage) => {
      const fileName = result.fileName || result.outputRef?.fileName || result.patchFileName || fallbackFileName;
      const filePath = result.outputRef?.filePath || result.filePath || result.patchFilePath;
      if (filePath) {
        const resultCleanup = result.cleanup;
        const cleanup = async () => {
          if (resultCleanup) await Promise.resolve(resultCleanup()).catch(() => undefined);
          else await vfs.remove(filePath).catch(() => undefined);
        };
        try {
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
        } catch (error) {
          await cleanup();
          throw error;
        }
      }
      throw new Error(failureMessage || "Worker did not return browser output");
    },
    retainOwnedSources,
    releaseOwnedSources,
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
    stageSources: async (requests) => {
      // allSettled, not Promise.all: if one stage rejects, the siblings that already staged must be
      // cleaned up before rethrowing. Promise.all would drop those fulfilled wrappers on the floor, so
      // their cleanup never runs - the staged OPFS copies and their bare visible names stay pinned (a
      // later same-named stage then climbs to a phantom `-2`).
      const settled = await Promise.allSettled(requests.map((request) => stageSource(request)));
      const staged: RuntimeWorkerPathSource[] = [];
      let firstRejection: PromiseRejectedResult | undefined;
      for (const result of settled) {
        if (result.status === "fulfilled") {
          staged.push(result.value);
          continue;
        }
        if (!firstRejection) firstRejection = result;
      }
      if (firstRejection) {
        await Promise.all(staged.map((source) => source.cleanup().catch(() => undefined)));
        throw firstRejection.reason;
      }
      return staged;
    },
  };
  return workerIo;
};

export { createBrowserRuntimeVfsIo };
