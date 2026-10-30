import { useCallback, useEffect, useRef, useState } from "react";
import type { WeaveApplySession } from "../../lib/weave/weave-session-model.ts";
import { loadLocalWeaveSession } from "../../lib/weave/local-weave-session.ts";
import {
  isCueEntryFileName,
  isGdiEntryFileName,
  parseCueFileReferences,
  parseGdiFileReferences,
} from "../../lib/input/archive.ts";
import { listDroppedArchiveEntryNames, probeDroppedInputKind } from "../../lib/input/input-preparation-archive.ts";
import { groupNfsFiles, isNfsPartName } from "../../lib/input/nfs-inputs.ts";
import { createLogger } from "../../lib/logging.ts";
import type { SelectFile, SelectionCandidate } from "../../types/selection.ts";
import {
  classifyArchiveBucket,
  classifyDroppedFiles,
  isArchiveFileName,
  isPatchFileName,
  isRomFileName,
  isWeaveFileName,
} from "./file-classification.ts";
import { ROM_WEAVER_WEAVE_FILE_NAMES } from "../../wasm/generated/rom-weaver-format-metadata.ts";
import {
  type DropRejection,
  screenRomCandidates,
  separateIngestPatches,
  separateSplitWbfs,
} from "./apply-drop-screening.ts";

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

/** UI-only row shown while an archive or weave is being identified and routed. */
type PendingDrop = {
  /** A practice file still downloading, before it reaches the drop path. */
  downloading?: boolean;
  entryCount?: number;
  extracting: boolean;
  id: string;
  kind: "patch" | "rom";
  weave?: boolean;
  name: string;
  sheet?: "CUE" | "GDI";
};

type PendingDropUpdate = Partial<Pick<PendingDrop, "entryCount" | "kind" | "weave" | "name" | "sheet">>;

type UnifiedDropController = {
  discardCompletedOutput?: () => void;
  provideRomInputFiles?: (files: File[]) => void;
  providePatchInputFiles?: (files: File[]) => void;
};

// Any other uncompressed `*.json` is a content-probe CANDIDATE: it is only
// treated as a weave if its bytes parse+validate (mirrors the Rust loader), so
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
  onDrop: (files: File[], isCancelled?: () => boolean, signal?: AbortSignal, onSettled?: () => void) => void;
};
type ActiveDropKind = "weave" | "patch" | "rom" | "unknown";
type DropRouteLifecycle = {
  /** Files held back from routing, with the reason; delivery of the remaining files continues. */
  onRejected?: (rejection: DropRejection) => void;
  beforeNonWeaveDelivery?: () => Promise<void>;
  onWeaveDetected?: () => void;
  rememberWeaveSourceCleanup?: (cleanup: () => Promise<void>) => void;
};

const getDropKind = (files: File[], classification: ReturnType<typeof classifyDroppedFiles>): ActiveDropKind => {
  const hasWeave = files.some((file) => isWeaveFileName(file.name));
  const hasRom = classification.inputs.length > 0 || files.some((file) => isRomFileName(file.name));
  return hasWeave ? "weave" : hasRom ? "rom" : classification.archives.length ? "unknown" : "patch";
};

const routeUnifiedDrop = async (
  files: File[],
  controller: UnifiedDropController,
  onWeaveSession?: (session: WeaveApplySession) => void,
  isCancelled?: () => boolean,
  onPendingUpdate?: (file: File, update: PendingDropUpdate) => void,
  signal?: AbortSignal,
  lifecycle?: DropRouteLifecycle,
  selectFile?: SelectFile,
): Promise<void> => {
  if (signal?.aborted || isCancelled?.()) return;
  const { archives, inputs, patches } = classifyDroppedFiles(files);
  const directWeaves = files.filter((file) => isWeaveFileName(file.name));
  const archiveEntries = await Promise.all(
    archives.map(async (archive) =>
      isNfsPartName(archive.name) ? [] : listDroppedArchiveEntryNames(archive).catch(() => [] as string[]),
    ),
  );
  if (signal?.aborted || isCancelled?.()) return;
  const weaveArchives = archives.filter((_archive, index) =>
    archiveEntries[index]?.some(
      (name) => normalizeArchivePath(name).toLowerCase() === ROM_WEAVER_WEAVE_FILE_NAMES.weave,
    ),
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
  // Deliver a loaded weave into the form: seed the session, then hand its ROM
  // (bundled, or a companion dropped alongside a checks-only weave) and its
  // patches to the input pipeline.
  const applyLoadedWeave = async (
    loaded: NonNullable<Awaited<ReturnType<typeof loadLocalWeaveSession>>>,
    weaveFile: File,
  ) => {
    // Companion ROMs route like a second drop: bare files plus ROM-bucket archives, with a
    // directly dropped disc sheet kept together with its tracks.
    const companionRoms = loaded.romFile
      ? []
      : [...inputs, ...archives.filter((_archive, index) => archiveBuckets[index] === "rom")].filter(
          (file) => file !== weaveFile,
        );
    let companionRom: File[] | undefined;
    try {
      companionRom = await chooseSingleRom(companionRoms, selectFile);
    } catch (error) {
      await loaded.cleanup();
      throw error;
    }
    if (signal?.aborted || isCancelled?.()) {
      await loaded.cleanup();
      return;
    }
    try {
      onWeaveSession?.(loaded.session);
      const romFiles = loaded.romFile ? [loaded.romFile] : companionRom;
      if (romFiles?.length) controller.provideRomInputFiles?.(romFiles);
      controller.providePatchInputFiles?.(loaded.patchFiles);
      lifecycle?.rememberWeaveSourceCleanup?.(loaded.cleanup);
      logger.debug("weave source cleanup registered with form owner", {
        hasRom: !!romFiles?.length,
        patchCount: loaded.patchFiles.length,
      });
    } catch (error) {
      await loaded.cleanup();
      throw error;
    }
  };

  // 1) Canonical `rom-weaver-weave.json` (by name, direct or an archive root):
  // authoritative, so its parse errors surface.
  const canonicalWeaves = [...directWeaves, ...weaveArchives.filter((file) => !directWeaves.includes(file))];
  if (canonicalWeaves.length > 1) throw new Error("Drop contains more than one weave");
  if (canonicalWeaves[0]) {
    lifecycle?.onWeaveDetected?.();
    onPendingUpdate?.(canonicalWeaves[0], { weave: true });
    const loaded = await loadLocalWeaveSession(canonicalWeaves[0], files, { signal });
    if (signal?.aborted || isCancelled?.()) {
      await loaded.cleanup();
      return;
    }
    await applyLoadedWeave(loaded, canonicalWeaves[0]);
    return;
  }

  // 2) No canonical name: content-probe other `*.json` candidates - a bare
  // `rw.json`, or an archive whose index is not the canonical name. The first
  // whose bytes parse+validate as a weave wins; anything that fails to parse
  // falls through to normal routing (so a stray `config.json` is harmless).
  const probeCandidates = [
    ...files.filter((file) => isJsonCandidateName(file.name) && !directWeaves.includes(file)),
    ...archives.filter(
      (archive, index) =>
        !weaveArchives.includes(archive) && (archiveEntries[index] || []).some(isRootJsonArchiveEntry),
    ),
  ];
  for (const candidate of probeCandidates) {
    const loaded = await loadLocalWeaveSession(candidate, files, { probe: true, signal });
    if (signal?.aborted || isCancelled?.()) {
      await loaded?.cleanup();
      return;
    }
    if (!loaded) continue;
    logger.debug("content-probed a weave from a non-canonical json candidate", { name: candidate.name });
    lifecycle?.onWeaveDetected?.();
    onPendingUpdate?.(candidate, { weave: true });
    await applyLoadedWeave(loaded, candidate);
    return;
  }
  if (signal?.aborted || isCancelled?.()) return;
  await lifecycle?.beforeNonWeaveDelivery?.();
  if (signal?.aborted || isCancelled?.()) return;
  const patchArchives = archives.filter((_archive, index) => archiveBuckets[index] === "patch");
  const romBucketArchives = new Map(
    archives.flatMap((archive, index) =>
      archiveBuckets[index] === "rom" ? [[archive, archiveEntries[index] || []] as const] : [],
    ),
  );
  const screened = screenRomCandidates({
    archives: romBucketArchives,
    inputs,
    sheetReferenced: new Set(
      (await groupDirectDiscInputs(inputs)).filter((group) => group.files.length > 1).flatMap((group) => group.files),
    ),
  });
  if (screened.rejection) lifecycle?.onRejected?.(screened.rejection);
  const ingestRouted = await separateIngestPatches(
    {
      archives: new Map(screened.archives.map((archive) => [archive, romBucketArchives.get(archive) ?? []] as const)),
      inputs: screened.inputs,
    },
    (file) => probeDroppedInputKind(file, signal),
    () => !!signal?.aborted || !!isCancelled?.(),
  );
  if (signal?.aborted || isCancelled?.()) return;
  const romArchives = ingestRouted.archives;
  const romInputs = [...ingestRouted.inputs, ...romArchives];
  const patchInputs = [...patches, ...patchArchives, ...ingestRouted.patches];
  logger.trace("unified apply drop routed files", {
    archiveCount: archives.length,
    fileCount: files.length,
    patchArchiveCount: patchArchives.length,
    patchInputCount: patchInputs.length,
    romArchiveCount: romArchives.length,
    romInputCount: romInputs.length,
  });
  const chosenRom = await chooseSingleRom(romInputs, selectFile);
  // The chooser stays open while newer drops arrive; a later ROM drop aborts this route.
  if (signal?.aborted || isCancelled?.()) return;
  if (chosenRom) controller.provideRomInputFiles?.(chosenRom);
  if (patchInputs.length) controller.providePatchInputFiles?.(patchInputs);
};

type RomDropGroup = { files: File[]; label: string; size: number };

const leafName = (name: string) => name.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() || "";

/** Disc sheets and their supplied tracks MUST stay together as one logical ROM. */
const groupDirectDiscInputs = async (romInputs: readonly File[]): Promise<RomDropGroup[]> => {
  const unassigned = new Set(romInputs);
  const groups: RomDropGroup[] = [];
  const nfsFiles = groupNfsFiles(romInputs);
  if (nfsFiles) {
    for (const file of nfsFiles) unassigned.delete(file);
    groups.push({
      files: nfsFiles,
      label: nfsFiles[0].name,
      size: nfsFiles.reduce((total, file) => total + file.size, 0),
    });
  }
  const sheets = [
    ...romInputs.filter((file) => isCueEntryFileName(file.name)),
    ...romInputs.filter((file) => isGdiEntryFileName(file.name)),
  ];
  for (const sheet of sheets) {
    if (!unassigned.has(sheet)) continue;
    try {
      const isCue = isCueEntryFileName(sheet.name);
      const text = await sheet.text();
      const references = new Set(
        (isCue
          ? parseCueFileReferences(text).map((reference) => reference.fileName)
          : parseGdiFileReferences(text)
        ).map(leafName),
      );
      const files = [sheet];
      for (const file of unassigned) {
        if (file === sheet) continue;
        const isReferencedTrack = references.has(leafName(file.name));
        const gdiReferences = isCue && isGdiEntryFileName(file.name) ? parseGdiFileReferences(await file.text()) : [];
        const isMatchingGdi =
          gdiReferences.length > 0 && gdiReferences.every((reference) => references.has(leafName(reference)));
        if (isReferencedTrack || isMatchingGdi) files.push(file);
      }
      // Claim the files only after every read succeeded, so a failed read leaves them selectable.
      for (const file of files) unassigned.delete(file);
      groups.push({ files, label: sheet.name, size: files.reduce((total, file) => total + file.size, 0) });
    } catch (error) {
      logger.debug("direct disc grouping failed", { error: String(error), fileName: sheet.name });
    }
  }
  for (const file of unassigned) groups.push({ files: [file], label: file.name, size: file.size });
  return groups;
};

/**
 * A run patches exactly one logical ROM. A directly dropped disc can contain a
 * CUE or GDI plus several track files, which MUST stay together as one candidate.
 */
const chooseSingleRom = async (romInputs: readonly File[], selectFile?: SelectFile): Promise<File[] | undefined> => {
  const groups = await groupDirectDiscInputs(romInputs);
  if (groups.length <= 1) return groups[0]?.files;
  if (!selectFile) return groups[0]?.files;
  const candidates: SelectionCandidate[] = groups.map((group, index) => ({
    fileName: group.label,
    id: `dropped-rom-${index}`,
    kind: "rom",
    selectable: true,
    size: group.size,
    type: "file",
  }));
  try {
    const choice = await selectFile({
      candidates,
      role: "input",
      // Empty so the dialog uses its own "More than one ROM was dropped" heading
      // rather than naming one of the files the user has not chosen yet.
      sourceName: "",
      warnings: [],
    });
    const index = candidates.findIndex((candidate) => candidate.id === choice?.id);
    return index >= 0 ? groups[index]?.files : undefined;
  } catch (error) {
    logger.debug("multi-ROM drop prompt was cancelled", { error: String(error) });
    return undefined;
  }
};

const normalizeArchivePath = (name: string) => name.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\//, "");

const useUnifiedApplyDrop = (
  controller: UnifiedDropController,
  onWeaveSession?: (session: WeaveApplySession) => void,
  onError?: (error: Error) => void,
  selectFile?: SelectFile,
  onRejected?: (rejection: DropRejection) => void,
): UnifiedApplyDrop => {
  const [pendingDrops, setPendingDrops] = useState<PendingDrop[]>([]);
  const nextIdRef = useRef(0);
  const activeDropsRef = useRef(new Map<AbortController, ActiveDropKind>());
  const weaveSourceCleanupsRef = useRef(new Set<() => Promise<void>>());
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
    const weaveSourceCleanups = weaveSourceCleanupsRef.current;
    const pendingTimers = pendingTimersRef.current;
    return () => {
      mountedRef.current = false;
      for (const controller of activeDrops.keys()) controller.abort();
      activeDrops.clear();
      const cleanups = [...weaveSourceCleanups];
      weaveSourceCleanups.clear();
      void Promise.all(
        cleanups.map((cleanup) =>
          cleanup().catch((error: unknown) => {
            logger.warn("weave source cleanup failed", { error: String(error) });
          }),
        ),
      );
      // The minimum-display timers below outlive the drop that scheduled them, so an unmount
      // between scheduling and firing would otherwise setState on a dead root.
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
    };
  }, []);
  const rememberWeaveSourceCleanup = useCallback((cleanup: () => Promise<void>) => {
    weaveSourceCleanupsRef.current.add(cleanup);
  }, []);
  const onDrop = useCallback(
    (droppedFiles: File[], isCancelled?: () => boolean, outerSignal?: AbortSignal, onSettled?: () => void) => {
      const { rejection: splitWbfsRejection, remaining: files } = separateSplitWbfs(droppedFiles);
      if (splitWbfsRejection) onRejected?.(splitWbfsRejection);
      if (!files.length) {
        onSettled?.();
        return;
      }
      const classification = classifyDroppedFiles(files);
      // The classifier deliberately treats unknown bare extensions as ROM/input fallbacks. Use its
      // bucket here too so replacement/cancellation policy cannot disagree with the eventual route;
      // keep the name predicate for ROM/container overlaps such as RVZ and CHD that probe as archives.
      const dropKind = getDropKind(files, classification);
      // Dynamic weave promotion must mirror a direct canonical weave submitted at this moment:
      // it supersedes only routes that already existed, never newer user actions added while probing.
      const precedingDropControllers = new Set(activeDropsRef.current.keys());
      if (dropKind === "weave") {
        for (const activeController of activeDropsRef.current.keys()) activeController.abort();
        activeDropsRef.current.clear();
        dropQueueRef.current = Promise.resolve();
      } else if (dropKind === "rom") {
        // A later explicit ROM replaces an earlier explicit ROM/weave, but patch routes are additive.
        // An archive of unknown contents stays ordered ahead of the ROM: it may itself be a patch weave.
        for (const [activeController, activeKind] of activeDropsRef.current) {
          if (activeKind !== "rom" && activeKind !== "weave") continue;
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
        onSettled?.();
        return;
      }
      // This drop supersedes whatever the last run produced. Retire it now rather than when routing
      // finally resolves: classification is async, and until it lands the completed run's "Download"
      // button is still enabled and would hand back output built from the PREVIOUS inputs.
      if (files.length) controller.discardCompletedOutput?.();
      const { archives } = classification;
      const identifiedFiles = files.filter((file) => archives.includes(file) || isWeaveFileName(file.name));
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
      const mayContainWeave =
        classification.archives.length > 0 || files.some((file) => isJsonCandidateName(file.name));
      const promoteToWeave = () => {
        for (const activeController of precedingDropControllers) {
          if (!activeDropsRef.current.has(activeController)) continue;
          activeController.abort();
          activeDropsRef.current.delete(activeController);
        }
        activeDropsRef.current.set(dropController, "weave");
      };
      const runRoute = () =>
        routeUnifiedDrop(
          files,
          controller,
          onWeaveSession,
          isCancelled,
          updatePending,
          dropController.signal,
          {
            ...(mayContainWeave ? { beforeNonWeaveDelivery: () => previousRoute } : {}),
            rememberWeaveSourceCleanup,
            onRejected,
            onWeaveDetected: promoteToWeave,
          },
          selectFile,
        );
      // Input callbacks mutate ordered ROM/patch stacks. Serialize delivery so a small later patch cannot
      // overtake an earlier archive/weave that is still being identified or downloaded. Potential
      // weaves identify concurrently; a real weave supersedes prior routes, while an ordinary
      // archive/JSON waits on the captured tail before delivering and preserves drop order.
      const route = mayContainWeave ? runRoute() : previousRoute.then(runRoute);
      dropQueueRef.current = route.then(
        () => undefined,
        () => undefined,
      );
      void route
        .catch((error) => {
          if (dropController.signal.aborted || isCancelled?.()) return;
          logger.error("weave drop failed", { error: String(error) });
          onError?.(error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          outerSignal?.removeEventListener("abort", abortDrop);
          activeDropsRef.current.delete(dropController);
          clearPending();
          onSettled?.();
        });
    },
    [controller, onError, onRejected, onWeaveSession, rememberWeaveSourceCleanup, selectFile],
  );

  return { onDrop, pendingDrops };
};

export { type PendingDrop, useUnifiedApplyDrop };
