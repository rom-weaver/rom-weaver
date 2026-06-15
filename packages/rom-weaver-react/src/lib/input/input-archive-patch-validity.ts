import { attachPatchFileCleanup, getPatchFileCleanup, type PatchFileInstance } from "./binary-service.ts";
import {
  type ArchiveEntryLike,
  extractArchiveEntry,
  filterNestedContainerEntries,
  type InputPreparationOptions,
  type InputPreparationRuntimeLike,
  isCompressionFile,
  listCompressionEntries,
} from "./input-preparation-archive.ts";
import { DEFAULT_INPUT_PREPARATION_RUNTIME } from "./input-preparation-compression.ts";

// Patch-validity detection + the per-archive cache of validated patch leaves, split out of the
// input-archive orchestrator. A dropped archive is scanned for sidecar patches; each candidate entry
// is extracted once and checked for a real patch magic, and the surviving leaf files are cached
// (keyed by entry name) on a WeakMap so re-entrant selection can reuse them without re-extracting.

type ValidatedPatchArchiveEntryCache = Map<string, PatchFileInstance>;

const PATCH_MAGIC_BY_EXTENSION = {
  bps: "BPS1",
  ips: "PATCH",
  ups: "UPS1",
} as const;

const validatedPatchArchiveEntriesByFile = new WeakMap<PatchFileInstance, ValidatedPatchArchiveEntryCache>();
const patchArchiveValidationCleanupAttached = new WeakSet<PatchFileInstance>();

const getValidatedPatchArchiveEntryCache = (archiveFile: PatchFileInstance): ValidatedPatchArchiveEntryCache => {
  const existing = validatedPatchArchiveEntriesByFile.get(archiveFile);
  if (existing) return existing;
  const created = new Map<string, PatchFileInstance>();
  validatedPatchArchiveEntriesByFile.set(archiveFile, created);
  return created;
};

const releaseValidatedPatchArchiveEntries = async (archiveFile: PatchFileInstance) => {
  const cache = validatedPatchArchiveEntriesByFile.get(archiveFile);
  if (!cache?.size) {
    validatedPatchArchiveEntriesByFile.delete(archiveFile);
    return;
  }
  validatedPatchArchiveEntriesByFile.delete(archiveFile);
  await Promise.all(
    [...cache.values()].map((file) => Promise.resolve(getPatchFileCleanup(file)?.()).catch(() => undefined)),
  );
};

const ensureValidatedPatchArchiveEntryCleanup = (archiveFile: PatchFileInstance) => {
  if (patchArchiveValidationCleanupAttached.has(archiveFile)) return;
  patchArchiveValidationCleanupAttached.add(archiveFile);
  attachPatchFileCleanup(archiveFile, async () => {
    patchArchiveValidationCleanupAttached.delete(archiveFile);
    await releaseValidatedPatchArchiveEntries(archiveFile);
  });
};

const isValidPatchPatchFile = async (patchFile: PatchFileInstance): Promise<boolean> => {
  try {
    patchFile.littleEndian = false;
    patchFile.seek(0);
    const header = patchFile.readString(8);
    patchFile.seek(0);
    const extension = String(patchFile.fileName || "")
      .match(/\.([^.]+?)(?:\d+)?$/)?.[1]
      ?.toLowerCase();
    if (!extension) return false;
    const expectedMagic = PATCH_MAGIC_BY_EXTENSION[extension as keyof typeof PATCH_MAGIC_BY_EXTENSION];
    return expectedMagic ? header.startsWith(expectedMagic) : true;
  } catch (_error) {
    return false;
  }
};

const filterValidPatchArchiveEntriesForSource = async (
  archiveFile: PatchFileInstance,
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
) => {
  const listedPatchEntries = await listCompressionEntries(archiveFile, options, runtime, { patchFilter: true }).catch(
    () => [],
  );
  // Skip nested-container entries up front: extracting them only to discard them (they fail the
  // `isCompressionFile` check below) is a wasteful re-extraction of every nested archive level, and
  // patches inside nested archives are not auto-discovered anyway.
  const nestedContainerNames = new Set(filterNestedContainerEntries(listedPatchEntries).map((entry) => entry.filename));
  const patchEntries = listedPatchEntries.filter((entry) => !nestedContainerNames.has(entry.filename));
  const cache = getValidatedPatchArchiveEntryCache(archiveFile);
  const validEntries: ArchiveEntryLike[] = [];
  for (const entry of patchEntries) {
    if (cache.has(entry.filename)) {
      validEntries.push(entry);
      continue;
    }
    const patchFile = await extractArchiveEntry(archiveFile, entry.filename, undefined, options, runtime, [], {
      patchFilter: true,
    }).catch(() => null);
    if (!patchFile) continue;
    try {
      if (isCompressionFile(patchFile)) continue;
      if (!(await isValidPatchPatchFile(patchFile))) continue;
      ensureValidatedPatchArchiveEntryCleanup(archiveFile);
      cache.set(entry.filename, patchFile);
      validEntries.push(entry);
    } finally {
      if (!cache.has(entry.filename)) await Promise.resolve(getPatchFileCleanup(patchFile)?.()).catch(() => undefined);
    }
  }
  return validEntries;
};

export {
  ensureValidatedPatchArchiveEntryCleanup,
  filterValidPatchArchiveEntriesForSource,
  getValidatedPatchArchiveEntryCache,
  isValidPatchPatchFile,
};
