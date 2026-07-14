import { useCallback, useRef, useState } from "react";
import type { BundleApplySession } from "../../lib/bundle/bundle-session-model.ts";
import { loadLocalBundleSession } from "../../lib/bundle/local-bundle-session.ts";
import { listDroppedArchiveEntryNames } from "../../lib/input/input-preparation-archive.ts";
import { createLogger } from "../../lib/logging.ts";
import { classifyDroppedFiles, isArchiveFileName, isPatchFileName, isRomFileName } from "./file-classification.ts";

/**
 * Drop orchestration for the Apply tab.
 *
 * Bare ROMs/patches route by extension. An archive is classified by its CONTENTS - a cheap entry
 * listing (no byte extraction), the same authoritative signal Rust uses (`is_rom = has_rom ||
 * !has_patch` over the entries; see `emit_probe_bundle`). A real ROM archive joins the ROM
 * bucket; a patch-only bundle goes straight to the patch bucket. Crucially, a patch-only archive
 * never enters the ROM input list: routing it there would re-stage (re-extract) any already staged
 * ROM and flash a ROM card before Rust's later probe-bundle reclassified it. That probe-bundle
 * reclassify (`reclassifyArchiveToPatch` in the session) remains as a safety net for the rare
 * misroute (e.g. a listing failure defaults to the ROM bucket). Both the in-tab dropzone and the
 * page-wide drop forwarder funnel through one `onDrop`.
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

type PendingDropUpdate = Partial<Pick<PendingDrop, "entryCount" | "kind" | "bundle" | "sheet">>;

type UnifiedDropController = {
  provideRomInputFiles?: (files: File[]) => void;
  providePatchInputFiles?: (files: File[]) => void;
};

const isBundleFileName = (name: string) =>
  /^rom-weaver-bundle\.json(?:\.[^.]+)?$/i.test(name.split(/[\\/]/).pop() || "");

type UnifiedApplyDrop = {
  pendingDrops: PendingDrop[];
  onDrop: (files: File[], isCancelled?: () => boolean) => void;
};

/**
 * Decide a dropped archive's bucket from its entry names, mirroring Rust's probe-bundle verdict
 * (`is_rom = has_rom || !has_patch`). Defaults to the ROM bucket on any listing failure - the safe
 * direction, since Rust's reclassify still moves a misrouted patch bundle afterwards.
 */
const classifyArchiveBucket = (archive: File, names: string[]): "rom" | "patch" => {
  const hasRom = names.some(isRomFileName);
  const hasPatch = names.some(isPatchFileName);
  // A container whose top-level entries are ONLY nested plain archives (no direct rom - rvz/chd/iso
  // are rom names so a nested rom container sets hasRom - and no direct patch) is a nested patch
  // bundle whose patches live a level down (e.g. B_bundle → B_discN.zip → patchBN.ips). Route it to
  // the patch bucket so the patch-leaf enumeration fans the branches into one multi-select, instead
  // of the ROM keep-one prompt that several sibling archives would otherwise trigger. Rust's is_rom
  // reclassify still moves a genuinely-ROM misroute back.
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
): Promise<void> => {
  const { archives, inputs, patches } = classifyDroppedFiles(files);
  const directBundles = files.filter((file) => isBundleFileName(file.name));
  const archiveEntries = await Promise.all(
    archives.map((archive) => listDroppedArchiveEntryNames(archive).catch(() => [] as string[])),
  );
  const bundleArchives = archives.filter((_archive, index) =>
    archiveEntries[index]?.some((name) => normalizeArchivePath(name).toLowerCase() === "rom-weaver-bundle.json"),
  );
  const archiveBuckets = archives.map((archive, index) => classifyArchiveBucket(archive, archiveEntries[index] || []));
  archives.forEach((archive, index) => {
    const names = archiveEntries[index] || [];
    const sheet = names.some((name) => /\.cue$/i.test(name))
      ? "CUE"
      : names.some((name) => /\.gdi$/i.test(name))
        ? "GDI"
        : undefined;
    onPendingUpdate?.(archive, { entryCount: names.length, kind: archiveBuckets[index], sheet });
  });
  // Yield one task so React can paint the newly learned shape before routing
  // replaces the placeholder. This does not wait on a timer interval.
  if (archives.length && onPendingUpdate) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const bundles = [...directBundles, ...bundleArchives.filter((file) => !directBundles.includes(file))];
  if (bundles.length > 1) throw new Error("Drop contains more than one bundle");
  if (bundles[0]) {
    onPendingUpdate?.(bundles[0], { bundle: true });
    const loaded = await loadLocalBundleSession(bundles[0], files);
    if (isCancelled?.()) return;
    onBundleSession?.(loaded.session);
    const companionRoms = inputs.filter((file) => !directBundles.includes(file));
    if (!loaded.romFile && companionRoms.length > 1) {
      throw new Error("A checks-only bundle drop contains more than one possible ROM");
    }
    const romFile = loaded.romFile || companionRoms[0];
    if (romFile) controller.provideRomInputFiles?.([romFile]);
    controller.providePatchInputFiles?.(loaded.patchFiles);
    return;
  }
  if (isCancelled?.()) return;
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
  const onDrop = useCallback(
    (files: File[], isCancelled?: () => boolean) => {
      if (isCancelled?.()) return;
      const { archives } = classifyDroppedFiles(files);
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
        if (!pendingIds.size) return;
        const clear = () => setPendingDrops((current) => current.filter((entry) => !pendingIds.has(entry.id)));
        const remaining = MIN_PENDING_DISPLAY_MS - (performance.now() - pendingStartedAt);
        if (remaining > 0) setTimeout(clear, remaining);
        else clear();
      };
      void routeUnifiedDrop(files, controller, onBundleSession, isCancelled, updatePending)
        .catch((error) => {
          logger.error("bundle drop failed", { error: String(error) });
          onError?.(error instanceof Error ? error : new Error(String(error)));
        })
        .finally(clearPending);
    },
    [controller, onError, onBundleSession],
  );

  return { onDrop, pendingDrops };
};

export { type PendingDrop, useUnifiedApplyDrop };
