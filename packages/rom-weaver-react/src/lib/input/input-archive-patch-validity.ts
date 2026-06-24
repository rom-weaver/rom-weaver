import {
  attachPatchFileCleanup,
  getPatchFileCleanup,
  getPatchFileExternalSource,
  type PatchFileInstance,
} from "./binary-service.ts";
import {
  type ArchiveEntryLike,
  describeArchiveFileForTrace,
  extractArchiveEntry,
  filterNestedContainerEntries,
  type InputPreparationOptions,
  type InputPreparationRuntimeLike,
  isCompressionFile,
  listCompressionEntries,
  traceArchivePreparation,
} from "./input-preparation-archive.ts";
import { DEFAULT_INPUT_PREPARATION_RUNTIME, resolveInputPreparationRuntime } from "./input-preparation-compression.ts";

// Patch-validity detection + the per-archive cache of validated patch leaves, split out of the
// input-archive orchestrator. A dropped archive is scanned for sidecar patches; each candidate entry
// is extracted once and the surviving leaf files are cached (keyed by entry name) on a WeakMap so
// re-entrant selection can reuse them without re-extracting. Validity is Rust's verdict
// (`PatchDescriptor.is_valid_patch`), obtained by ingesting the already-extracted leaf's own bytes —
// the same classify-and-parse the apply path runs on a bare patch — not a TS re-read of the magic.

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

/** Rust's verdict on an already-extracted patch leaf: ingest the leaf's own bytes (the consolidated
 * classify + parse the apply path already runs over a bare patch — no archive re-extraction) and read
 * `PatchDescriptor.is_valid_patch`. `true` means a registered patch handler recognized + parsed the
 * magic; `false` covers an unsupported extension or a recognized-but-unparseable file. Replaces the
 * former TS magic re-read so the host trusts Rust's single source of truth. */
const isValidPatchLeaf = async (
  patchFile: PatchFileInstance,
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike,
): Promise<boolean> => {
  const resolvedRuntime = await resolveInputPreparationRuntime(runtime);
  const ingestRun = resolvedRuntime.ingest?.run;
  if (!ingestRun) throw new Error("Ingest runtime is unavailable");
  const fileName = patchFile.fileName || "patch.bin";
  const externalSource = getPatchFileExternalSource(patchFile, fileName);
  if (!externalSource) return false;
  try {
    const { result } = await ingestRun({
      fileName,
      ...(options?.logging?.level ? { logLevel: options.logging.level } : {}),
      ...(options?.onLog ? { onLog: options.onLog } : {}),
      source: externalSource.source,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    return result.patches[0]?.isValidPatch === true;
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
      if (!(await isValidPatchLeaf(patchFile, options, runtime))) continue;
      ensureValidatedPatchArchiveEntryCleanup(archiveFile);
      cache.set(entry.filename, patchFile);
      validEntries.push(entry);
    } finally {
      if (!cache.has(entry.filename)) await Promise.resolve(getPatchFileCleanup(patchFile)?.()).catch(() => undefined);
    }
  }
  traceArchivePreparation(options, "input.archive.patch.validity.finish", {
    candidateCount: patchEntries.length,
    file: describeArchiveFileForTrace(archiveFile),
    validEntryNames: validEntries.map((entry) => entry.filename),
  });
  return validEntries;
};

export {
  ensureValidatedPatchArchiveEntryCleanup,
  filterValidPatchArchiveEntriesForSource,
  getValidatedPatchArchiveEntryCache,
};
