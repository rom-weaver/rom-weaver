import { createLogger } from "../../lib/logging.ts";
import { listDroppedArchiveEntryNames } from "../../lib/input/input-preparation-archive.ts";
import {
  classifyArchiveBucket,
  isArchiveFileName,
  isPatchFileName,
  isRomFileName,
  isWeaveFileName,
} from "./file-classification.ts";

/**
 * Pure routing for drops that pick a workflow: the landing page sends files to
 * the workflow that fits them, and a workflow that cannot use what was dropped
 * offers the one that can. Name-only and free of React so it is unit-testable;
 * the per-tab drop handlers still own the real staging and classification.
 */

const logger = createLogger("drop-destination");

/** The workflows a drop can be sent to. Ids match `WebappView`. */
type DropDestination = "creator" | "patcher" | "test" | "weave";

type DropFileKind = "patch" | "rom" | "save" | "unknown";

type DropCounts = {
  patches: number;
  weaves: number;
  /** Files with a known ROM or container name, cue/gdi tracks folded into their sheet. */
  roms: number;
  /** Raw battery saves (`.sav`, `.srm`…), which Test loads alongside their ROM. */
  saves: number;
  /** Files no extension matched; the workflows stage them as inputs. */
  unknown: number;
  /** ROM-counted archives whose entries were never listed, so they may still wrap a patch. */
  unlistedArchives: number;
};

/**
 * One dropped name. `archiveBucket` is the verdict of an archive's entry
 * listing when the caller could list it; without one an archive counts as a
 * ROM unless its own name says it wraps a patch (`hack.bps.zip`).
 */
type DropEntry = {
  archiveBucket?: "patch" | "rom";
  weave?: boolean;
  hasPatches?: boolean;
  name: string;
};

type DropPlan = {
  /** Candidate workflows, best fit first. One entry routes directly; several ask. */
  destinations: DropDestination[];
  /** Several ROMs arrived with patches, so whichever workflow is picked leaves some files unused. */
  mixed: boolean;
};

type DropRedirectReason = "applyBeforeTest" | "patchesNeedApply" | "romsMakePatch";

type DropRedirect = {
  reason: DropRedirectReason;
  to: DropDestination;
};

/** Matches the raw saves the Save editor reads; wrapped formats need its conversion first. */
const SAVE_NAME = /\.(?:sav|srm|sra|eep|fla|mpk|mcr|mcd)$/i;
const SHEET_NAME = /\.(?:cue|gdi)$/i;
const TRACK_NAME = /\.(?:bin|raw)$/i;

const baseName = (name: string) => name.split(/[\\/]/).pop() || name;

/** `translation.bps.zip` → true: the archive's own name says what it carries. */
const isPatchArchiveName = (name: string) => isPatchFileName(baseName(name).replace(/\.[^.]+$/, ""));

const isSaveFileName = (name: string) => SAVE_NAME.test(name);

const classifyDropEntry = (entry: DropEntry): DropFileKind => {
  if (entry.weave || isWeaveFileName(entry.name) || isPatchFileName(entry.name)) return "patch";
  if (isArchiveFileName(entry.name)) {
    if (entry.archiveBucket) return entry.archiveBucket;
    return isPatchArchiveName(entry.name) ? "patch" : "rom";
  }
  if (isRomFileName(entry.name)) return "rom";
  return isSaveFileName(entry.name) ? "save" : "unknown";
};

/**
 * Count a drop by kind. A disc dropped as a cue/gdi sheet with its track files
 * is one ROM, so `.bin`/`.raw` tracks stop counting once a sheet is present.
 */
const countDropEntries = (entries: readonly DropEntry[]): DropCounts => {
  const counts: DropCounts = { patches: 0, weaves: 0, roms: 0, saves: 0, unknown: 0, unlistedArchives: 0 };
  const hasSheet = entries.some((entry) => SHEET_NAME.test(entry.name));
  for (const entry of entries) {
    if (entry.weave || isWeaveFileName(entry.name)) counts.weaves += 1;
    const kind = classifyDropEntry(entry);
    if (kind === "patch") counts.patches += 1;
    else if (kind === "save") counts.saves += 1;
    else if (kind === "unknown") counts.unknown += 1;
    else if (!(hasSheet && TRACK_NAME.test(entry.name) && !isArchiveFileName(entry.name))) counts.roms += 1;
    if (kind === "rom" && !entry.archiveBucket && isArchiveFileName(entry.name)) counts.unlistedArchives += 1;
  }
  logger.trace("counted dropped entries", { ...counts, names: entries.map((entry) => entry.name) });
  return counts;
};

/**
 * Where a drop on the landing page should go. Unknown files count as ROMs here
 * because every candidate workflow stages them as inputs.
 *
 * - a weave, with or without companion files → Apply or Weave
 * - patches only, or one ROM with patches → Apply
 * - one ROM with a save → Test, which loads the save with it
 * - one ROM → Apply or Test
 * - two or more ROMs → Create
 * - two or more ROMs with patches → Create or Apply, flagged as mixed
 */
const planDropDestinations = ({ patches, weaves, roms, saves, unknown }: DropCounts): DropPlan => {
  const inputs = roms + unknown;
  let plan: DropPlan;
  if (weaves > 0) plan = { destinations: ["patcher", "weave"], mixed: false };
  else if (inputs === 0) plan = { destinations: patches ? ["patcher"] : [], mixed: false };
  else if (inputs === 1 && patches === 0 && saves > 0) plan = { destinations: ["test"], mixed: false };
  else if (inputs === 1) plan = { destinations: patches ? ["patcher"] : ["patcher", "test"], mixed: false };
  else if (patches === 0) plan = { destinations: ["creator"], mixed: false };
  else plan = { destinations: ["creator", "patcher"], mixed: true };
  logger.trace("planned drop destinations", { inputs, patches, saves, ...plan });
  return plan;
};

/**
 * Whether a drop on `view` belongs in another workflow. Only known ROM names
 * count here, so a save or a stray text file never triggers a redirect, and an
 * archive with no listing counts as neither a patch nor a second ROM.
 */
const planDropRedirect = (view: string, { patches, roms, unlistedArchives }: DropCounts): DropRedirect | null => {
  let redirect: DropRedirect | null = null;
  if (view === "test" && patches > 0) redirect = { reason: "applyBeforeTest", to: "patcher" };
  else if (view === "trim") {
    if (patches > 0) redirect = { reason: "patchesNeedApply", to: "patcher" };
  } else if (view === "patcher" && patches === 0 && roms - unlistedArchives >= 2)
    redirect = { reason: "romsMakePatch", to: "creator" };
  if (redirect) logger.debug("drop belongs in another workflow", { from: view, patches, roms, ...redirect });
  return redirect;
};

const USABLE_KINDS: Record<string, readonly DropFileKind[]> = {
  creator: ["patch", "rom", "unknown"],
  patcher: ["patch", "rom", "unknown"],
  test: ["rom", "save", "unknown"],
  trim: ["rom", "unknown"],
};

/**
 * Whether `view` can use a dropped file. A workflow that cannot is still handed
 * the file when the visitor asks for it; this only decides what starts checked.
 */
const isUsableDropFile = (view: string, name: string, archiveBucket?: DropEntry["archiveBucket"]) =>
  (USABLE_KINDS[view] ?? USABLE_KINDS.patcher)?.includes(classifyDropEntry({ archiveBucket, name })) ?? true;

type ListArchiveNames = (archive: File) => Promise<string[]>;

/**
 * Archive contents MUST take precedence over a patch-like outer filename so
 * a packaged weave still offers both workflows. Failed listings keep the name verdict.
 */
const readDropEntries = (
  files: readonly File[],
  listNames: ListArchiveNames = listDroppedArchiveEntryNames,
): Promise<DropEntry[]> =>
  Promise.all(
    files.map(async (file): Promise<DropEntry> => {
      const entry = { name: file.name };
      if (!isArchiveFileName(file.name) || isWeaveFileName(file.name)) return entry;
      const names = await listNames(file).catch((error: unknown) => {
        logger.debug("dropped archive listing failed", { error, name: file.name });
        return [] as string[];
      });
      if (!names.length) return entry;
      const weave = names.some((name) =>
        /^(?:\.\/|\/)?rom-weaver-(?:weave|bundle)\.json$/i.test(name.replaceAll("\\", "/")),
      );
      return {
        archiveBucket: weave ? "patch" : classifyArchiveBucket(file, names),
        hasPatches: names.some(isPatchFileName),
        name: file.name,
        weave,
      };
    }),
  );

export {
  classifyDropEntry,
  countDropEntries,
  isSaveFileName,
  isUsableDropFile,
  planDropDestinations,
  planDropRedirect,
  readDropEntries,
  type DropEntry,
};
