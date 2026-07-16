import { createLogger } from "../../lib/logging.ts";
import { classifyDroppedFiles } from "./file-classification.ts";

/**
 * Pure routing for the unified drop surface: turn a dropped `File[]` into a
 * per-bucket assignment a tab can hand to its existing controllers. Kept free of
 * React/controller types so the auto-organize behavior is unit-testable.
 */

const logger = createLogger("unified-drop-routing");

/**
 * ROM-only tabs (Make Patch/Trim) have no patch bucket. Drop patches silently (with
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
 * Make Patch-tab strategy: fill empty slots in drop order; if more ROMs are dropped
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

/** Trim-tab strategy: a single ROM source - take the first dropped ROM, if any. */
const routeSingleRom = (files: File[]): File | null => {
  const roms = collectRomDropFiles(files);
  const first = roms[0];
  if (!first) return null;
  logger.trace("routed unified drop to single source", { name: first.name });
  return first;
};

export { collectRomDropFiles, routeByOrder, routeSingleRom };
