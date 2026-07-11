import { emitTraceLog } from "../../lib/logging.ts";
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
  // Set when a consumer picks this entry up while it had no live refs (idle under the retention timer):
  // that is a cross-drop re-stage, so a stale releaseSources from the earlier drop must defer to this
  // live reader instead of force-cleaning the copy out from under its in-flight command.
  reusedWhileIdle?: boolean;
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

// Staging dedup state is process-global, not per-runtime-instance. The app builds several
// WorkflowRuntime instances (the module singleton in workflow-runtime.ts plus the lazily-created
// input-preparation and output-verification runtimes), and one dropped input is staged by passes that
// land on *different* instances. The virtual-file path allocator (browser-opfs-source-ref) is already a
// module global, so two instances staging the same input concurrently collide there and the loser is
// handed a phantom `name-2.ext` - which the codec/disc extractors then bake into `-2` outputs. Keeping
// the dedup cache global (keyed by content identity, namespaced by mount) makes every pass on any
// instance reuse one staged copy and one bare visible name. String-keyed (not a WeakMap), so entries are
// pruned explicitly in cleanupCachedStagedSource - which already runs for every staged source.
const stagedSourceCache = new Map<string, CachedStagedSource>();
// In-flight stages keyed by the same content identity, so a second pass that starts before the first
// finishes staging coalesces onto it instead of running a duplicate stage (the resolved-entry cache only
// dedupes *after* the first pass caches). Each carries a per-stage token so a release can be tied to the
// exact in-flight stage it targets. Cleared in stageSource's finally once the entry caches.
const pendingStages = new Map<string, { promise: Promise<void>; token: number }>();
let nextStageToken = 0;
// Sources released while a staging pass was still in flight: releaseSources misses the cache for those
// (the entry is only cached after staging completes), and the cancelled consumer never calls its wrapped
// cleanup, stranding the staged OPFS copy. Track the release so the in-flight pass cleans up after itself
// when it lands. The value is the token of the in-flight stage the release targets, so a re-stage that
// starts later (a different token) is never destroyed by this stale release; a later re-stage of the same
// source also clears the mark.
const releasedStagingSources = new Map<string, number>();
// Per-object identity key for sources that carry no derivable content identity (file handles, nameless
// Blobs). Those are reused by reference across passes, so object identity is the right key.
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
    // A File carries a stable content identity (name + size + lastModified) that survives the per-pass
    // re-wrapping of one dropped input into fresh File objects, so every pass resolves to one key.
    if (typeof File !== "undefined" && candidate instanceof File) {
      return `${mountPrefix}file:${candidate.name}:${candidate.size}:${candidate.lastModified}`;
    }
    return `${mountPrefix}${getObjectIdentityKey(candidate)}`;
  };
  const releaseSources: RuntimeWorkerIo["releaseSources"] = async (sources) => {
    const cleanups: Array<Promise<void>> = [];
    for (const source of sources) {
      const key = getStagedSourceCacheKey(source);
      if (!key) continue;
      const cached = stagedSourceCache.get(key);
      if (!cached) {
        // Not yet cached: only mark the release when a stage is actually in flight, tied to that stage's
        // token (consumed in cacheStagedSource). Without the in-flight guard a release could re-add a
        // mark that a concurrent re-stage just cleared, and without the token a re-stage that starts
        // later would be destroyed by this stale release. No in-flight stage means nothing to release.
        const pending = pendingStages.get(key);
        if (pending) releasedStagingSources.set(key, pending.token);
        continue;
      }
      cached.cleanupWhenIdle = true;
      // Release means the session no longer references this source. A live cross-drop reader (an idle
      // entry a re-stage just picked up) still needs the copy: defer to its wrapper cleanup via
      // cleanupWhenIdle instead of yanking it out from under the in-flight command. Only force-clean a
      // truly-dead holder - a leaked ref from a cancelled pass that never returned it (never reused while
      // idle), which cleanupWhenIdle alone would pin forever; per-wrapper released flags keep late
      // cleanup() calls harmless.
      if (cached.refCount > 0 && cached.reusedWhileIdle) continue;
      cleanups.push(cleanupCachedStagedSource(key, cached));
    }
    await Promise.all(cleanups);
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
      // A consumer picking up an entry with no live refs (kept alive only by the retention timer) is a
      // cross-drop re-stage; flag it so a stale releaseSources from the prior drop defers to this reader.
      if (entry.refCount === 0) entry.reusedWhileIdle = true;
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
    // Coalesce concurrent stages of the SAME source onto one in-flight stage. The resolved-entry cache
    // above only dedupes once the first pass has finished staging *and* cached its entry; a second pass
    // that starts inside that window would otherwise run its own stageFromSource, copy the input into
    // OPFS a second time, and - because the first copy still holds the bare visible name - be handed a
    // phantom `name-2.ext`. Codec/disc extractors derive output names from the staged stem, so the stray
    // copy surfaced as a `-2` extraction with no base file (e.g. during ingest). Awaiting the in-flight
    // stage lets this pass reuse the single bare-named copy instead.
    if (cacheKey) {
      // Loop rather than a single check: several passes can wake from the SAME failed in-flight stage at
      // once. The first to resume starts a fresh stage and republishes it in pendingStages below, so the
      // rest must re-check and coalesce onto that one instead of each starting a duplicate (the `-2`
      // phantom this coalescing exists to prevent).
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
      // A release landed while this stage was in flight and targets THIS stage (token match): the
      // releasing session no longer wants the copy, but the live consumer of this fresh stage still holds
      // its ref. Mark cleanupWhenIdle so the copy drops when that consumer releases (refCount -> 0)
      // instead of being cleaned out from under its in-flight command; consumers release in a finally
      // (workflow-runtime-core cleanupWorkerSources / runPathWorkerToOutput), so this cannot pin forever.
      // A stale mark from an earlier stage carries a different token and is ignored here.
      if (releasedStagingSources.get(cacheKey) === stageToken) {
        releasedStagingSources.delete(cacheKey);
        entry.cleanupWhenIdle = true;
      }
      // A concurrent same-key stage may have cached a live entry while this one was in flight; don't
      // clobber it (identity guard, like the delete above) - overwriting would strand its staged copy and
      // let our later cleanup evict the wrong entry. Keep ours untracked; its wrapper cleanup still
      // releases the duplicate staged copy.
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
