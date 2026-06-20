import { useCallback } from "react";
import { listDroppedArchiveEntryNames } from "../../lib/input/input-preparation-archive.ts";
import { createLogger } from "../../lib/logging.ts";
import { classifyDroppedFiles, isPatchFileName, isRomFileName } from "./file-classification.ts";

/**
 * Drop orchestration for the Apply tab.
 *
 * Bare ROMs/patches route by extension. An archive is classified by its CONTENTS — a cheap entry
 * listing (no byte extraction), the same authoritative signal Rust uses (`is_rom = has_rom ||
 * !has_patch` over the entries; see `emit_probe_manifest`). A real ROM archive joins the ROM
 * bucket; a patch-only bundle goes straight to the patch bucket. Crucially, a patch-only archive
 * never enters the ROM input list: routing it there would re-stage (re-extract) any already staged
 * ROM and flash a ROM card before Rust's later probe-manifest reclassified it. That probe-manifest
 * reclassify (`reclassifyArchiveToPatch` in the session) remains as a safety net for the rare
 * misroute (e.g. a listing failure defaults to the ROM bucket). Both the in-tab dropzone and the
 * page-wide drop forwarder funnel through one `onDrop`.
 */

const logger = createLogger("unified-apply-drop");

/** Retained for API compatibility — bare files and classified archives stage into their resolved
 * bucket directly, so no placeholder cards are needed. */
type PendingDrop = {
  id: string;
  name: string;
};

type UnifiedDropController = {
  provideRomInputFiles?: (files: File[]) => void;
  providePatchInputFiles?: (files: File[]) => void;
};

type UnifiedApplyDrop = {
  pendingDrops: PendingDrop[];
  onDrop: (files: File[], isCancelled?: () => boolean) => void;
};

const NO_PENDING_DROPS: PendingDrop[] = [];

/**
 * Decide a dropped archive's bucket from its entry names, mirroring Rust's probe-manifest verdict
 * (`is_rom = has_rom || !has_patch`). Defaults to the ROM bucket on any listing failure — the safe
 * direction, since Rust's reclassify still moves a misrouted patch bundle afterwards.
 */
const classifyArchiveBucket = async (archive: File): Promise<"rom" | "patch"> => {
  try {
    const names = await listDroppedArchiveEntryNames(archive);
    const hasRom = names.some(isRomFileName);
    const hasPatch = names.some(isPatchFileName);
    const bucket = hasRom || !hasPatch ? "rom" : "patch";
    logger.trace("archive content classified", {
      bucket,
      entryCount: names.length,
      hasPatch,
      hasRom,
      name: archive.name,
    });
    return bucket;
  } catch (error) {
    logger.trace("archive content classify failed; defaulting to ROM bucket", {
      error: String(error),
      name: archive.name,
    });
    return "rom";
  }
};

const routeUnifiedDrop = async (
  files: File[],
  controller: UnifiedDropController,
  isCancelled?: () => boolean,
): Promise<void> => {
  const { archives, inputs, patches } = classifyDroppedFiles(files);
  const archiveBuckets = await Promise.all(archives.map(classifyArchiveBucket));
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

const useUnifiedApplyDrop = (controller: UnifiedDropController): UnifiedApplyDrop => {
  const onDrop = useCallback(
    (files: File[], isCancelled?: () => boolean) => {
      if (isCancelled?.()) return;
      void routeUnifiedDrop(files, controller, isCancelled);
    },
    [controller],
  );

  return { onDrop, pendingDrops: NO_PENDING_DROPS };
};

export { type PendingDrop, useUnifiedApplyDrop };
