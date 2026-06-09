import { createLogger } from "../../lib/logging.ts";
import { classifyDroppedFiles } from "./file-classification.ts";

/**
 * Pure routing for the unified drop surface: turn a dropped `File[]` into a
 * per-bucket assignment a tab can hand to its existing controllers. Kept free of
 * React/controller types so the auto-organize behavior is unit-testable.
 */

const logger = createLogger("unified-drop-routing");

type ByTypeRouting = {
  /** Files destined for a tab's ROM/input bucket. */
  inputs: File[];
  /** Files destined for a tab's patch bucket. */
  patches: File[];
};

/**
 * Apply-tab strategy: ROMs/unknown → inputs, patches → patches. An archive is a
 * patch container when a ROM is already loaded (its contents are most likely the
 * patch), otherwise it is the ROM source to extract.
 */
const routeByType = (files: File[], options: { romPresent: boolean }): ByTypeRouting => {
  const { archives, inputs, patches } = classifyDroppedFiles(files);
  const routed: ByTypeRouting = { inputs: [...inputs], patches: [...patches] };
  for (const archive of archives) {
    if (options.romPresent) routed.patches.push(archive);
    else routed.inputs.push(archive);
  }
  logger.trace("routed unified drop by type", {
    inputCount: routed.inputs.length,
    patchCount: routed.patches.length,
    romPresent: options.romPresent,
  });
  return routed;
};

/**
 * ROM-only tabs (Create/Trim) have no patch bucket. Drop patches silently (with
 * a log) and keep ROMs + archives, which the workflow extracts into ROMs.
 */
const collectRomDropFiles = (files: File[]): File[] => {
  const { archives, inputs, patches } = classifyDroppedFiles(files);
  if (patches.length) {
    logger.info("ignored patch files dropped on a ROM-only tab", {
      count: patches.length,
      names: patches.map((file) => file.name),
    });
  }
  return [...inputs, ...archives];
};

/**
 * Create-tab strategy: fill empty slots in drop order; if more ROMs are dropped
 * than there are empty slots, the last dropped ROM overflows into the final slot
 * (matching the legacy "default to modified" page-drop behavior).
 *
 * Returns one entry per slot: a `File` to place, or `null` to leave unchanged.
 */
const routeByOrder = (files: File[], slotFilled: boolean[]): (File | null)[] => {
  const assignment: (File | null)[] = slotFilled.map(() => null);
  const roms = collectRomDropFiles(files);
  if (roms.length === 0 || slotFilled.length === 0) return assignment;
  const emptySlots = slotFilled.map((filled, index) => (filled ? -1 : index)).filter((index) => index >= 0);
  let fileIndex = 0;
  for (const slot of emptySlots) {
    const file = roms[fileIndex];
    if (!file) break;
    assignment[slot] = file;
    fileIndex += 1;
  }
  if (fileIndex < roms.length) {
    const lastRom = roms[roms.length - 1];
    if (lastRom) assignment[assignment.length - 1] = lastRom;
  }
  logger.trace("routed unified drop by order", {
    assignedSlots: assignment.map((file) => file?.name ?? null),
    slotFilled,
  });
  return assignment;
};

/** Trim-tab strategy: a single ROM source — take the first dropped ROM, if any. */
const routeSingleRom = (files: File[]): File | null => {
  const roms = collectRomDropFiles(files);
  const first = roms[0];
  if (!first) return null;
  logger.trace("routed unified drop to single source", { name: first.name });
  return first;
};

export type { ByTypeRouting };
export { collectRomDropFiles, routeByOrder, routeByType, routeSingleRom };
