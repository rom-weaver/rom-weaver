import { useCallback, useEffect, useRef, useState } from "react";
import type { BundleApplySession } from "../../lib/bundle/bundle-session-model.ts";
import { loadLocalBundleSession } from "../../lib/bundle/local-bundle-session.ts";
import { listDroppedArchiveEntryNames } from "../../lib/input/input-preparation-archive.ts";
import { createLogger } from "../../lib/logging.ts";
import { classifyDroppedFiles, isArchiveFileName, isPatchFileName, isRomFileName } from "./file-classification.ts";

/**
 * Drop orchestration for the Apply tab.
 *
 * Bare files route by extension; archives route from a metadata-only entry
 * listing using Rust's `is_rom = has_rom || !has_patch` rule. Keeping patch-only
 * archives out of the ROM bucket avoids restaging the current ROM. Rust's later
 * reclassification remains the fallback for listing failures.
 */

const logger = createLogger("unified-apply-drop");
const MIN_PENDING_DISPLAY_MS = 180;

/** UI-only row shown while an archive or bundle is being identified and routed. */
type PendingDrop = {
  entryCount?: number;
  extracting: boolean;
  id: string;
  kind: "patch" | "rom";
  bundle?: boolean;
  name: string;
  sheet?: "CUE" | "GDI";
};

type PendingDropUpdate = Partial<Pick<PendingDrop, "entryCount" | "kind" | "bundle" | "name" | "sheet">>;

type UnifiedDropController = {
  discardCompletedOutput?: () => void;
  provideRomInputFiles?: (files: File[]) => void;
  providePatchInputFiles?: (files: File[]) => void;
};

// The canonical name is the trusted fast-path: it marks a bundle by name
// alone, and its parse errors surface. `rom-weaver-bundle.json[.codec]`.
const isBundleFileName = (name: string) =>
  /^rom-weaver-bundle\.json(?:\.[^.]+)?$/i.test(name.split(/[\\/]/).pop() || "");

// Any other uncompressed `*.json` is a content-probe CANDIDATE: it is only
// treated as a bundle if its bytes parse+validate (mirrors the Rust loader), so
// a stray `config.json` costs one parse attempt and is then ignored.
const isJsonCandidateName = (name: string) => /\.json$/i.test(name.split(/[\\/]/).pop() || "");

// A root-level (non-nested) `*.json` archive member - the only place a bundled
// index can live, canonical or not.
const isRootJsonArchiveEntry = (name: string) => {
  const path = normalizeArchivePath(name);
  return !path.includes("/") && /\.json$/i.test(path);
};

type UnifiedApplyDrop = {
  pendingDrops: PendingDrop[];
  onDrop: (files: File[], isCancelled?: () => boolean, signal?: AbortSignal) => void;
};
type ActiveDropKind = "bundle" | "patch" | "rom" | "unknown";
type DropRouteLifecycle = {
  beforeNonBundleDelivery?: () => Promise<void>;
  onBundleDetected?: () => void;
};

const getDropKind = (files: File[], classification: ReturnType<typeof classifyDroppedFiles>): ActiveDropKind => {
  const hasBundle = files.some((file) => isBundleFileName(file.name));
  const hasRom = classification.inputs.length > 0 || files.some((file) => isRomFileName(file.name));
  return hasBundle ? "bundle" : hasRom ? "rom" : classification.archives.length ? "unknown" : "patch";
};

/**
 * Decide a dropped archive's bucket from its entry names, mirroring Rust's probe-bundle verdict
 * (`is_rom = has_rom || !has_patch`). Defaults to the ROM bucket on any listing failure - the safe
 * direction, since Rust's reclassify still moves a misrouted patch bundle afterwards.
 */
const classifyArchiveBucket = (archive: File, names: string[]): "rom" | "patch" => {
  const hasRom = names.some(isRomFileName);
  const hasPatch = names.some(isPatchFileName);
  // Archive-only roots usually wrap nested patch bundles; route them to patch
  // enumeration instead of the ROM keep-one prompt. Rust corrects real ROMs.
  const hasNestedArchive = names.some(isArchiveFileName);
  const bucket = hasRom ? "rom" : hasPatch || hasNestedArchive ? "patch" : "rom";
  logger.trace("archive content classified", {
    bucket,
    entryCount: names.length,
    hasNestedArchive,
    hasPatch,
    hasRom,
    name: archive.name,
  });
  return bucket;
};

const routeUnifiedDrop = async (
  files: File[],
  controller: UnifiedDropController,
  onBundleSession?: (session: BundleApplySession) => void,
  isCancelled?: () => boolean,
  onPendingUpdate?: (file: File, update: PendingDropUpdate) => void,
  signal?: AbortSignal,
  lifecycle?: DropRouteLifecycle,
): Promise<void> => {
  if (signal?.aborted || isCancelled?.()) return;
  const { archives, inputs, patches } = classifyDroppedFiles(files);
  const directBundles = files.filter((file) => isBundleFileName(file.name));
  const archiveEntries = await Promise.all(
    archives.map((archive) => listDroppedArchiveEntryNames(archive).catch(() => [] as string[])),
  );
  if (signal?.aborted || isCancelled?.()) return;
  const bundleArchives = archives.filter((_archive, index) =>
    archiveEntries[index]?.some((name) => normalizeArchivePath(name).toLowerCase() === "rom-weaver-bundle.json"),
  );
  const archiveBuckets = archives.map((archive, index) => classifyArchiveBucket(archive, archiveEntries[index] || []));
  archives.forEach((archive, index) => {
    const names = archiveEntries[index] || [];
    const patchNames = names.filter(isPatchFileName);
    const patchName =
      archiveBuckets[index] === "patch" && patchNames.length === 1
        ? normalizeArchivePath(patchNames[0] || "")
            .split("/")
            .pop()
        : undefined;
    const sheet = names.some((name) => /\.cue$/i.test(name))
      ? "CUE"
      : names.some((name) => /\.gdi$/i.test(name))
        ? "GDI"
        : undefined;
    onPendingUpdate?.(archive, {
      entryCount: names.length,
      kind: archiveBuckets[index],
      ...(patchName ? { name: patchName } : {}),
      sheet,
    });
  });
  // Yield one task so React can paint the newly learned shape before routing
  // replaces the placeholder. This does not wait on a timer interval.
  if (archives.length && onPendingUpdate) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (signal?.aborted || isCancelled?.()) return;
  // Deliver a loaded bundle into the form: seed the session, then hand its ROM
  // (bundled, or a companion dropped alongside a checks-only bundle) and its
  // patches to the input pipeline.
  const applyLoadedBundle = async (
    loaded: NonNullable<Awaited<ReturnType<typeof loadLocalBundleSession>>>,
    bundleFile: File,
  ) => {
    const companionRoms = inputs.filter((file) => file !== bundleFile);
    if (!loaded.romFile && companionRoms.length > 1) {
      await loaded.cleanup();
      throw new Error("A checks-only bundle drop contains more than one possible ROM");
    }
    try {
      onBundleSession?.(loaded.session);
      const romFile = loaded.romFile || companionRoms[0];
      if (romFile) controller.provideRomInputFiles?.([romFile]);
      controller.providePatchInputFiles?.(loaded.patchFiles);
    } catch (error) {
      await loaded.cleanup();
      throw error;
    }
  };

  // 1) Canonical `rom-weaver-bundle.json` (by name, direct or an archive root):
  // authoritative, so its parse errors surface.
  const canonicalBundles = [...directBundles, ...bundleArchives.filter((file) => !directBundles.includes(file))];
  if (canonicalBundles.length > 1) throw new Error("Drop contains more than one bundle");
  if (canonicalBundles[0]) {
    lifecycle?.onBundleDetected?.();
    onPendingUpdate?.(canonicalBundles[0], { bundle: true });
    const loaded = await loadLocalBundleSession(canonicalBundles[0], files, { signal });
    if (signal?.aborted || isCancelled?.()) {
      await loaded.cleanup();
      return;
    }
    await applyLoadedBundle(loaded, canonicalBundles[0]);
    return;
  }

  // 2) No canonical name: content-probe other `*.json` candidates - a bare
  // `rw.json`, or an archive whose index is not the canonical name. The first
  // whose bytes parse+validate as a bundle wins; anything that fails to parse
  // falls through to normal routing (so a stray `config.json` is harmless).
  const probeCandidates = [
    ...files.filter((file) => isJsonCandidateName(file.name) && !directBundles.includes(file)),
    ...archives.filter(
      (archive, index) =>
        !bundleArchives.includes(archive) && (archiveEntries[index] || []).some(isRootJsonArchiveEntry),
    ),
  ];
  for (const candidate of probeCandidates) {
    const loaded = await loadLocalBundleSession(candidate, files, { probe: true, signal });
    if (signal?.aborted || isCancelled?.()) {
      await loaded?.cleanup();
      return;
    }
    if (!loaded) continue;
    logger.debug("content-probed a bundle from a non-canonical json candidate", { name: candidate.name });
    lifecycle?.onBundleDetected?.();
    onPendingUpdate?.(candidate, { bundle: true });
    await applyLoadedBundle(loaded, candidate);
    return;
  }
  if (signal?.aborted || isCancelled?.()) return;
  await lifecycle?.beforeNonBundleDelivery?.();
  if (signal?.aborted || isCancelled?.()) return;
  const romArchives = archives.filter((_archive, index) => archiveBuckets[index] === "rom");
  const patchArchives = archives.filter((_archive, index) => archiveBuckets[index] === "patch");
  const romInputs = [...inputs, ...romArchives];
  const patchInputs = [...patches, ...patchArchives];
  logger.trace("unified apply drop routed files", {
    archiveCount: archives.length,
    fileCount: files.length,
    patchArchiveCount: patchArchives.length,
    patchInputCount: patchInputs.length,
    romArchiveCount: romArchives.length,
    romInputCount: romInputs.length,
  });
  if (romInputs.length) controller.provideRomInputFiles?.(romInputs);
  if (patchInputs.length) controller.providePatchInputFiles?.(patchInputs);
};

const normalizeArchivePath = (name: string) => name.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\//, "");

const useUnifiedApplyDrop = (
  controller: UnifiedDropController,
  onBundleSession?: (session: BundleApplySession) => void,
  onError?: (error: Error) => void,
): UnifiedApplyDrop => {
  const [pendingDrops, setPendingDrops] = useState<PendingDrop[]>([]);
  const nextIdRef = useRef(0);
  const activeDropsRef = useRef(new Map<AbortController, ActiveDropKind>());
  const dropQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const mountedRef = useRef(true);
  useEffect(() => {
    // Re-armed on every setup, not just initialised at declaration: StrictMode runs
    // setup -> cleanup -> setup against the same fiber and the same refs, so a ref only
    // ever cleared would stay false after the double-invoke and disable clear() forever.
    mountedRef.current = true;
    // Captured at setup so the cleanup does not read `.current` later; both refs hold a
    // collection that is only ever mutated, never reassigned, so these are the same objects.
    const activeDrops = activeDropsRef.current;
    const pendingTimers = pendingTimersRef.current;
    return () => {
      mountedRef.current = false;
      for (const controller of activeDrops.keys()) controller.abort();
      activeDrops.clear();
      // The minimum-display timers below outlive the drop that scheduled them, so an unmount
      // between scheduling and firing would otherwise setState on a dead root.
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
    };
  }, []);
  const onDrop = useCallback(
    (files: File[], isCancelled?: () => boolean, outerSignal?: AbortSignal) => {
      const classification = classifyDroppedFiles(files);
      // The classifier deliberately treats unknown bare extensions as ROM/input fallbacks. Use its
      // bucket here too so replacement/cancellation policy cannot disagree with the eventual route;
      // keep the name predicate for ROM/container overlaps such as RVZ and CHD that probe as archives.
      const dropKind = getDropKind(files, classification);
      // Dynamic bundle promotion must mirror a direct canonical bundle submitted at this moment:
      // it supersedes only routes that already existed, never newer user actions added while probing.
      const precedingDropControllers = new Set(activeDropsRef.current.keys());
      if (dropKind === "bundle") {
        for (const activeController of activeDropsRef.current.keys()) activeController.abort();
        activeDropsRef.current.clear();
        dropQueueRef.current = Promise.resolve();
      } else if (dropKind === "rom") {
        // A later explicit ROM replaces an earlier explicit ROM/bundle, but patch routes are additive.
        // An archive of unknown contents stays ordered ahead of the ROM: it may itself be a patch bundle.
        for (const [activeController, activeKind] of activeDropsRef.current) {
          if (activeKind !== "rom" && activeKind !== "bundle") continue;
          activeController.abort();
          activeDropsRef.current.delete(activeController);
        }
        if (!activeDropsRef.current.size) dropQueueRef.current = Promise.resolve();
      }
      const dropController = new AbortController();
      activeDropsRef.current.set(dropController, dropKind);
      const abortDrop = () => dropController.abort();
      if (outerSignal?.aborted || isCancelled?.()) abortDrop();
      else outerSignal?.addEventListener("abort", abortDrop, { once: true });
      if (dropController.signal.aborted) {
        activeDropsRef.current.delete(dropController);
        outerSignal?.removeEventListener("abort", abortDrop);
        return;
      }
      // This drop supersedes whatever the last run produced. Retire it now rather than when routing
      // finally resolves: classification is async, and until it lands the completed run's "Download"
      // button is still enabled and would hand back output built from the PREVIOUS inputs.
      if (files.length) controller.discardCompletedOutput?.();
      const { archives } = classification;
      const identifiedFiles = files.filter((file) => archives.includes(file) || isBundleFileName(file.name));
      const pending: PendingDrop[] = identifiedFiles.map((file) => {
        nextIdRef.current += 1;
        return {
          extracting: isArchiveFileName(file.name),
          id: `pending-${nextIdRef.current}`,
          kind: isRomFileName(file.name) ? "rom" : "patch",
          name: file.name,
        };
      });
      if (pending.length) setPendingDrops((current) => [...current, ...pending]);
      const pendingIdsByFile = new Map(identifiedFiles.map((file, index) => [file, pending[index]?.id]));
      const updatePending = (file: File, update: PendingDropUpdate) => {
        const id = pendingIdsByFile.get(file);
        if (id)
          setPendingDrops((current) => current.map((entry) => (entry.id === id ? { ...entry, ...update } : entry)));
      };
      const pendingIds = new Set(pending.map((entry) => entry.id));
      const pendingStartedAt = performance.now();
      const clearPending = () => {
        // An aborted route's .finally() runs as a microtask after unmount cleanup has already
        // emptied pendingTimersRef, so a timer scheduled here would never be cancelled.
        if (!(pendingIds.size && mountedRef.current)) return;
        const clear = () => {
          if (!mountedRef.current) return;
          setPendingDrops((current) => current.filter((entry) => !pendingIds.has(entry.id)));
        };
        const remaining = MIN_PENDING_DISPLAY_MS - (performance.now() - pendingStartedAt);
        if (remaining <= 0) {
          clear();
          return;
        }
        const timer = setTimeout(() => {
          pendingTimersRef.current.delete(timer);
          clear();
        }, remaining);
        pendingTimersRef.current.add(timer);
      };
      const previousRoute = dropQueueRef.current.catch(() => undefined);
      const mayContainBundle =
        classification.archives.length > 0 || files.some((file) => isJsonCandidateName(file.name));
      const promoteToBundle = () => {
        for (const activeController of precedingDropControllers) {
          if (!activeDropsRef.current.has(activeController)) continue;
          activeController.abort();
          activeDropsRef.current.delete(activeController);
        }
        activeDropsRef.current.set(dropController, "bundle");
      };
      const runRoute = () =>
        routeUnifiedDrop(files, controller, onBundleSession, isCancelled, updatePending, dropController.signal, {
          ...(mayContainBundle ? { beforeNonBundleDelivery: () => previousRoute } : {}),
          onBundleDetected: promoteToBundle,
        });
      // Input callbacks mutate ordered ROM/patch stacks. Serialize delivery so a small later patch cannot
      // overtake an earlier archive/bundle that is still being identified or downloaded. Potential
      // bundles identify concurrently; a real bundle supersedes prior routes, while an ordinary
      // archive/JSON waits on the captured tail before delivering and preserves drop order.
      const route = mayContainBundle ? runRoute() : previousRoute.then(runRoute);
      dropQueueRef.current = route.then(
        () => undefined,
        () => undefined,
      );
      void route
        .catch((error) => {
          if (dropController.signal.aborted || isCancelled?.()) return;
          logger.error("bundle drop failed", { error: String(error) });
          onError?.(error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          outerSignal?.removeEventListener("abort", abortDrop);
          activeDropsRef.current.delete(dropController);
          clearPending();
        });
    },
    [controller, onError, onBundleSession],
  );

  return { onDrop, pendingDrops };
};

export { type PendingDrop, useUnifiedApplyDrop };
