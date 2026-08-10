import { createLogger } from "../../lib/logging.ts";
import type { Localizer } from "../../presentation/localization/index.ts";
import { classifyDroppedFiles } from "./file-classification.ts";

/**
 * Pure routing for the unified drop surface: turn a dropped `File[]` into a
 * per-bucket assignment a tab can hand to its existing controllers. Kept free of
 * React/controller types so the auto-organize behavior is unit-testable.
 */

const logger = createLogger("unified-drop-routing");

/**
 * ROM-only tabs (Make Patch/Trim) have no patch bucket. Keep ROMs + archives in
 * their original drop order and return patches separately so the caller can
 * explain where those inputs belong.
 */
type RomDropCollection = {
  ignoredPatches: File[];
  roms: File[];
};

const collectRomDropFiles = (files: File[]): RomDropCollection => {
  const { patches } = classifyDroppedFiles(files);
  if (patches.length) {
    logger.info("ignored patch files dropped on a ROM-only tab", {
      count: patches.length,
      names: patches.map((file) => file.name),
    });
  }
  const patchSet = new Set(patches);
  const roms = files.filter((file) => !patchSet.has(file));
  logger.trace("collected ROM-only drop inputs", {
    ignoredPatchCount: patches.length,
    romCount: roms.length,
    names: roms.map((file) => file.name),
  });
  // The classifier remains the source of truth for what is rejected. The
  // returned list deliberately follows `files`, not bucket order.
  return { ignoredPatches: patches, roms };
};

type RomDropRouting = {
  assignment: (File | null)[];
  ignoredPatches: File[];
  unused: File[];
};

type SingleRomDropRouting = {
  ignoredPatches: File[];
  source: File | null;
  unused: File[];
};

type RomDropNoticeLevel = "warn" | "error";

const DROP_NOTICE_NAME_LIMIT = 3;
const DROP_NOTICE_NAME_LENGTH = 80;

const formatDropNoticeName = (file: File) =>
  file.name.length <= DROP_NOTICE_NAME_LENGTH ? file.name : `${file.name.slice(0, DROP_NOTICE_NAME_LENGTH - 1)}…`;

/**
 * Make Patch-tab strategy: fill empty slots in drop order. If more ROMs are
 * dropped than there are empty slots, the remainder is reported as unused.
 *
 * Returns one entry per slot: a `File` to place, or `null` to leave unchanged.
 * Files that do not fit stay in `unused`; they are never substituted into a
 * filled slot.
 */
const routeByOrder = (files: File[], slotFilled: boolean[]): RomDropRouting => {
  const assignment: (File | null)[] = slotFilled.map(() => null);
  const { ignoredPatches, roms } = collectRomDropFiles(files);
  if (roms.length === 0 || slotFilled.length === 0) {
    return { assignment, ignoredPatches, unused: roms };
  }
  const emptySlots = slotFilled.map((filled, index) => (filled ? -1 : index)).filter((index) => index >= 0);
  let fileIndex = 0;
  for (const slot of emptySlots) {
    const file = roms[fileIndex];
    if (!file) break;
    assignment[slot] = file;
    fileIndex += 1;
  }
  const unused = roms.slice(fileIndex);
  logger.trace("routed unified drop by order", {
    assignedSlots: assignment.map((file) => file?.name ?? null),
    slotFilled,
    unused: unused.map((file) => file.name),
  });
  return { assignment, ignoredPatches, unused };
};

/** Trim-tab strategy: take the first dropped ROM and report every other input. */
const routeSingleRom = (files: File[]): SingleRomDropRouting => {
  const { ignoredPatches, roms } = collectRomDropFiles(files);
  const [source, ...unused] = roms;
  logger.trace("routed unified drop to single source", {
    name: source?.name,
    unused: unused.map((file) => file.name),
  });
  return { ignoredPatches, source: source || null, unused };
};

const getRomDropNotice = (
  { ignoredPatches, unused }: Pick<RomDropRouting, "ignoredPatches" | "unused">,
  localizer: Pick<Localizer, "message" | "messageCount">,
) => {
  const notices: string[] = [];
  if (ignoredPatches.length) notices.push(localizer.message("ui.drop.patchesIgnored"));
  if (unused.length) {
    const shown = unused.slice(0, DROP_NOTICE_NAME_LIMIT).map(formatDropNoticeName);
    const remaining = unused.length - shown.length;
    notices.push(localizer.messageCount("ui.drop.unusedInputs", remaining, { names: shown.join(", ") }));
  }
  return notices.join(" ");
};

const getRomDropNoticeLevel = (routing: RomDropRouting | SingleRomDropRouting): RomDropNoticeLevel => {
  const used = "assignment" in routing ? routing.assignment.some(Boolean) : !!routing.source;
  return routing.unused.length > 0 && !used ? "error" : "warn";
};

export { collectRomDropFiles, getRomDropNotice, getRomDropNoticeLevel, routeByOrder, routeSingleRom };
