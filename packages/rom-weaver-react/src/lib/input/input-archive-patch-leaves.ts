import { DEFAULT_VFS_ROOT } from "../../storage/vfs/path.ts";
import type { CandidateSelectionRequest, SelectionFileCandidate } from "../../types/selection.ts";
import type { PublicOutput } from "../../types/workflow-runtime-types.ts";
import { RomWeaverError } from "../errors.ts";
import { createPatchFileFromPublicOutput } from "../runtime/public-output-bin-file.ts";
import { getPatchFileCleanup, type PatchFileInstance } from "./binary-service.ts";
import { preflightArchiveLimitsForDescent } from "./input-archive-limits.ts";
import {
  ensureValidatedPatchArchiveEntryCleanup,
  getValidatedPatchArchiveEntryCache,
  isValidPatchPatchFile,
} from "./input-archive-patch-validity.ts";
import { type InputParentCompression, makeInputId } from "./input-assets.ts";
import {
  describeArchiveFileForTrace,
  getCompressionFormat,
  getCompressionRuntimeOptions,
  getCompressionRuntimeSource,
  type InputPreparationOptions,
  type InputPreparationRuntimeLike,
  isCompressionFile,
  traceArchivePreparation,
} from "./input-preparation-archive.ts";
import { resolveInputPreparationRuntime } from "./input-preparation-compression.ts";
import { getBaseFileName, normalizeArchiveEntryName } from "./path-utils.ts";

type PatchArchiveLeaf = {
  candidate: SelectionFileCandidate;
  file: PatchFileInstance;
  parentCompressions: InputParentCompression[];
};

// Each ambiguous patch selection extracts every branch ONCE; the resulting (materialized) leaf files
// are stashed against the emitted selection request so the controller can reuse the exact extracted
// file for whichever candidate(s) the user picks — no re-extraction (which would collide on OPFS
// paths) and correct addressing even for two sibling patches in one branch. Keyed by request, so the
// stash is GC'd once the controller drops the request (e.g. on re-stage or source removal).
type RegisteredPatchLeaf = { file: PatchFileInstance; parentCompressions: InputParentCompression[] };
const patchLeafFilesByRequest = new WeakMap<CandidateSelectionRequest, Map<string, RegisteredPatchLeaf>>();

const PATCH_LEAF_ROOT_SEGMENTS = DEFAULT_VFS_ROOT.split("/").filter(Boolean);

/** Compute a leaf's archive-nesting breadcrumbs by stripping the extraction root (`/work`): a direct
 * patch yields `[]`, a nested patch yields its chain of containing nested-archive directories (named
 * after each archive, e.g. `["B_disc1"]`, `["C_set", "C_sub"]`). Stripping the fixed root (rather
 * than the prefix shared across leaves) keeps the nesting visible even when every patch sits under
 * the same nested archive. */
const derivePatchLeafBreadcrumbs = (path: string): string[] => {
  const dirSegments = String(path || "")
    .split("/")
    .filter(Boolean)
    .slice(0, -1);
  let start = 0;
  while (start < PATCH_LEAF_ROOT_SEGMENTS.length && dirSegments[start] === PATCH_LEAF_ROOT_SEGMENTS[start]) {
    start += 1;
  }
  return dirSegments.slice(start);
};

/** Extract EVERY patch across all (nested) branches of a patch archive in one recursive descent with
 * interactive selection OFF, so an ambiguous multi-branch container fully unpacks instead of
 * prompting for a single branch. Each valid leaf patch is cached by its unique extracted path so the
 * re-entrant selection (and the multi-select fan-out) can reuse it without re-extracting — essential
 * because two sibling patches in one branch cannot be addressed by a primary-container `--select`. */
const enumeratePatchLeaves = async (
  archiveFile: PatchFileInstance,
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike,
  sourceIndex: number,
): Promise<PatchArchiveLeaf[]> => {
  const resolvedRuntime = await resolveInputPreparationRuntime(runtime);
  if (!resolvedRuntime.compression.extract) throw new Error("Compression extraction is unavailable");
  const compressionFormat = getCompressionFormat(archiveFile);
  await preflightArchiveLimitsForDescent(archiveFile, options, runtime, { patchFilter: true }, []);
  traceArchivePreparation(options, "input.archive.patch.enumerate.start", {
    compressionFormat,
    file: describeArchiveFileForTrace(archiveFile),
  });
  const result = await resolvedRuntime.compression.extract({
    descendSinglePayload: true,
    entries: [],
    format: compressionFormat,
    options: getCompressionRuntimeOptions(options, { interactiveSelectionEnabled: false }, { patchFilter: true }),
    source: getCompressionRuntimeSource(archiveFile),
  });
  const outputs: PublicOutput[] = Array.isArray(result.outputs) ? result.outputs : result.output ? [result.output] : [];
  const cache = getValidatedPatchArchiveEntryCache(archiveFile);
  const leaves: PatchArchiveLeaf[] = [];
  for (let index = 0; index < outputs.length; index += 1) {
    const output = outputs[index];
    if (!output) continue;
    const displayPath = String(output.path || "");
    const fileName = getBaseFileName(output.fileName || `patch-${index + 1}.bin`);
    let file = displayPath ? cache.get(displayPath) : undefined;
    if (!file) {
      file = await createPatchFileFromPublicOutput(output, fileName, { materializeBlob: true });
      file.fileName = fileName;
    }
    if (isCompressionFile(file) || !(await isValidPatchPatchFile(file))) {
      if (!(displayPath && cache.has(displayPath)))
        await Promise.resolve(getPatchFileCleanup(file)?.()).catch(() => undefined);
      continue;
    }
    if (displayPath) {
      ensureValidatedPatchArchiveEntryCleanup(archiveFile);
      cache.set(displayPath, file);
    }
    // Full archive-nesting path: the source archive, then each nested archive/folder it descends
    // through (the leaf file name is shown separately as the candidate's primary label).
    const breadcrumbs = [archiveFile.fileName || "archive", ...derivePatchLeafBreadcrumbs(displayPath)];
    // Surface the same chain as parentCompressions so a fanned-out patch keeps its "extract section"
    // (the archive › nested-archive path) in the patch stack row. The runtime only reports a single
    // extract elapsed time and the leaf size (not per-intermediate-archive sizes), so attach the
    // elapsed time to the root entry but leave parent sizes unset — synthesizing the whole-archive
    // size as a single leaf's parent would compute a nonsensical compression ratio (archive ÷ leaf).
    const extractElapsedMs =
      typeof output.timing?.elapsedMs === "number" && Number.isFinite(output.timing.elapsedMs)
        ? output.timing.elapsedMs
        : undefined;
    const parentCompressions: InputParentCompression[] = breadcrumbs.map((entryName, depth) => ({
      depth,
      fileName: entryName,
      kind: "archive",
      ...(depth === 0 && extractElapsedMs !== undefined ? { decompressionTimeMs: extractElapsedMs } : {}),
    }));
    leaves.push({
      candidate: {
        ...(breadcrumbs.length ? { breadcrumbs } : {}),
        fileName,
        id: makeInputId(sourceIndex, displayPath || fileName, normalizeArchiveEntryName),
        kind: "patch",
        path: displayPath || fileName,
        selectable: true,
        size: output.size,
        type: "file",
      },
      file,
      parentCompressions,
    });
  }
  traceArchivePreparation(options, "input.archive.patch.enumerate.finish", {
    compressionFormat,
    file: describeArchiveFileForTrace(archiveFile),
    leafCandidateIds: leaves.map((leaf) => leaf.candidate.id),
    leafCount: leaves.length,
    leafPaths: leaves.map((leaf) => leaf.candidate.path),
    outputCount: outputs.length,
  });
  return leaves;
};

/** Resolve one patch leaf from a (possibly nested) patch archive. Returns the cached/extracted leaf
 * for an explicit selection, auto-picks a lone leaf, prompts (flat multi-select across all branches)
 * when several exist, and returns `null` when no valid patch is discovered so the caller can fall
 * back to the generic single-payload descent. */
const resolvePatchArchiveLeaf = async (
  archiveFile: PatchFileInstance,
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike,
  selectedArchiveEntry: string | undefined,
  sourceIndex: number,
): Promise<PatchFileInstance | null> => {
  const cache = getValidatedPatchArchiveEntryCache(archiveFile);
  if (selectedArchiveEntry) {
    const cached = cache.get(selectedArchiveEntry);
    if (cached) return cached;
  }
  const leaves = await enumeratePatchLeaves(archiveFile, options, runtime, sourceIndex);
  if (selectedArchiveEntry) {
    const leaf = leaves.find((entry) => entry.candidate.path === selectedArchiveEntry);
    if (leaf) return leaf.file;
    throw new RomWeaverError(
      "SELECTION_NOT_FOUND",
      `${archiveFile.fileName || "Patch archive"} has no patch entry "${selectedArchiveEntry}"`,
    );
  }
  if (leaves.length === 0) return null;
  if (leaves.length === 1) return leaves[0]?.file ?? null;
  if (typeof options?.onCandidatesFound !== "function") return leaves[0]?.file ?? null;
  const request: CandidateSelectionRequest = {
    candidates: leaves.map((entry) => entry.candidate),
    multiSelect: true,
    role: "patch",
    sourceIndex,
    sourceName: archiveFile.fileName || "Patch archive",
    warnings: [],
  };
  patchLeafFilesByRequest.set(
    request,
    new Map(
      leaves.map((entry) => [entry.candidate.id, { file: entry.file, parentCompressions: entry.parentCompressions }]),
    ),
  );
  traceArchivePreparation(options, "input.archive.patch.register", {
    candidateIds: leaves.map((entry) => entry.candidate.id),
    count: leaves.length,
    sourceName: request.sourceName,
  });
  options.onCandidatesFound(request);
  throw new RomWeaverError("AMBIGUOUS_SELECTION", `${request.sourceName} requires patch selection`, {
    details: { request },
  });
};

/** Retrieve the already-extracted leaf patch file for a candidate of an emitted patch-selection
 * request, so the controller can stage the user's pick(s) without re-extracting. */
const getPatchLeafFileForSelection = (
  request: CandidateSelectionRequest,
  candidateId: string,
): PatchFileInstance | undefined => patchLeafFilesByRequest.get(request)?.get(candidateId)?.file;

/** Retrieve the archive-nesting chain (source archive › nested archives) for a registered patch
 * leaf so a fanned-out patch entry keeps its "extract section" in the patch stack row. */
const getPatchLeafParentCompressionsForSelection = (
  request: CandidateSelectionRequest,
  candidateId: string,
): InputParentCompression[] | undefined => patchLeafFilesByRequest.get(request)?.get(candidateId)?.parentCompressions;

export { getPatchLeafFileForSelection, getPatchLeafParentCompressionsForSelection, resolvePatchArchiveLeaf };
