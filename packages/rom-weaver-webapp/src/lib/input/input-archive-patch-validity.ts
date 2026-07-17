import { attachPatchFileCleanup, getPatchFileCleanup, type PatchFileInstance } from "./binary-service.ts";

// The per-archive cache of extracted patch leaves, split out of the input-archive orchestrator. A
// dropped/ROM-bearing archive's patch leaves are extracted once (by the ingest harvest) and the
// surviving leaf files are cached (keyed by extracted path) on a WeakMap so re-entrant selection and
// the multi-select fan-out reuse them without re-extracting. Validity itself is Rust's verdict
// (`PatchDescriptor.is_valid_patch` on the ingest result), so there is no TS re-read of the magic.

type ValidatedPatchArchiveEntryCache = Map<string, PatchFileInstance>;

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

export { ensureValidatedPatchArchiveEntryCleanup, getValidatedPatchArchiveEntryCache };
