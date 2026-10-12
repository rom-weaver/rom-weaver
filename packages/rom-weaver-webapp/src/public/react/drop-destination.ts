import { createLogger } from "../../lib/logging.ts";
import { isArchiveFileName, isPatchFileName, isRomFileName, isWeaveFileName } from "./file-classification.ts";

/**
 * Pure routing for drops that pick a workflow: the landing page sends files to
 * the workflow that fits them, and a workflow that cannot use what was dropped
 * offers the one that can. Name-only and free of React so it is unit-testable;
 * the per-tab drop handlers still own the real staging and classification.
 */

const logger = createLogger("drop-destination");

/** The workflows a drop can be sent to. Ids match `WebappView`. */
type DropDestination = "creator" | "patcher" | "test";

type DropCounts = {
  patches: number;
  /** Files with a known ROM or container name, cue/gdi tracks folded into their sheet. */
  roms: number;
  /** Files no extension matched; the workflows stage them as inputs. */
  unknown: number;
};

/**
 * One dropped name. `archiveBucket` is the verdict of an archive's entry
 * listing when the caller could list it; without one an archive counts as a
 * ROM unless its own name says it wraps a patch (`hack.bps.zip`).
 */
type DropEntry = {
  archiveBucket?: "patch" | "rom";
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

const SHEET_NAME = /\.(?:cue|gdi)$/i;
const TRACK_NAME = /\.(?:bin|raw)$/i;

const baseName = (name: string) => name.split(/[\\/]/).pop() || name;

/** `translation.bps.zip` → true: the archive's own name says what it carries. */
const isPatchArchiveName = (name: string) => isPatchFileName(baseName(name).replace(/\.[^.]+$/, ""));

const classifyDropEntry = (entry: DropEntry): "patch" | "rom" | "unknown" => {
  if (isWeaveFileName(entry.name) || isPatchFileName(entry.name)) return "patch";
  if (isArchiveFileName(entry.name)) {
    if (entry.archiveBucket) return entry.archiveBucket;
    return isPatchArchiveName(entry.name) ? "patch" : "rom";
  }
  return isRomFileName(entry.name) ? "rom" : "unknown";
};

/**
 * Count a drop by kind. A disc dropped as a cue/gdi sheet with its track files
 * is one ROM, so `.bin`/`.raw` tracks stop counting once a sheet is present.
 */
const countDropEntries = (entries: readonly DropEntry[]): DropCounts => {
  const counts: DropCounts = { patches: 0, roms: 0, unknown: 0 };
  const hasSheet = entries.some((entry) => SHEET_NAME.test(entry.name));
  for (const entry of entries) {
    const kind = classifyDropEntry(entry);
    if (kind === "patch") counts.patches += 1;
    else if (kind === "unknown") counts.unknown += 1;
    else if (!(hasSheet && TRACK_NAME.test(entry.name) && !isArchiveFileName(entry.name))) counts.roms += 1;
  }
  logger.trace("counted dropped entries", { ...counts, names: entries.map((entry) => entry.name) });
  return counts;
};

/**
 * Where a drop on the landing page should go. Unknown files count as ROMs here
 * because every candidate workflow stages them as inputs.
 *
 * - patches only, or one ROM with patches → Apply
 * - one ROM → Apply or Test
 * - two or more ROMs → Create
 * - two or more ROMs with patches → Create or Apply, flagged as mixed
 */
const planDropDestinations = ({ patches, roms, unknown }: DropCounts): DropPlan => {
  const inputs = roms + unknown;
  let plan: DropPlan;
  if (inputs === 0) plan = { destinations: patches ? ["patcher"] : [], mixed: false };
  else if (inputs === 1) plan = { destinations: patches ? ["patcher"] : ["patcher", "test"], mixed: false };
  else if (patches === 0) plan = { destinations: ["creator"], mixed: false };
  else plan = { destinations: ["creator", "patcher"], mixed: true };
  logger.trace("planned drop destinations", { inputs, patches, ...plan });
  return plan;
};

/**
 * Whether a drop on `view` belongs in another workflow. Only known ROM names
 * count here, so a save or a stray text file never triggers a redirect, and an
 * archive with no listing never counts as a patch.
 */
const planDropRedirect = (view: string, { patches, roms }: DropCounts): DropRedirect | null => {
  let redirect: DropRedirect | null = null;
  if (view === "test" && patches > 0) redirect = { reason: "applyBeforeTest", to: "patcher" };
  else if ((view === "creator" && roms <= 1) || view === "trim") {
    if (patches > 0) redirect = { reason: "patchesNeedApply", to: "patcher" };
  } else if (view === "patcher" && patches === 0 && roms >= 2) redirect = { reason: "romsMakePatch", to: "creator" };
  if (redirect) logger.debug("drop belongs in another workflow", { from: view, patches, roms, ...redirect });
  return redirect;
};

/** Files a workflow that takes no patches can still use when the visitor keeps the drop there. */
const withoutPatchFiles = <TFile extends { name: string }>(files: readonly TFile[]): TFile[] =>
  files.filter((file) => classifyDropEntry({ name: file.name }) !== "patch");

export {
  countDropEntries,
  isPatchArchiveName,
  planDropDestinations,
  planDropRedirect,
  withoutPatchFiles,
  type DropCounts,
  type DropDestination,
  type DropEntry,
  type DropPlan,
  type DropRedirect,
  type DropRedirectReason,
};
