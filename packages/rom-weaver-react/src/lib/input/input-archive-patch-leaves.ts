import { DEFAULT_VFS_ROOT } from "../../storage/vfs/path.ts";
import type { ParsedPatchDescriptor } from "../../types/ingest.ts";
import type { CandidateSelectionRequest, SelectionFileCandidate } from "../../types/selection.ts";
import type { PublicOutput } from "../../types/workflow-runtime-types.ts";
import { attachIngestPatchRequirements, patchProbeRequirementsFromDescriptor } from "../apply/patch-apply-service.ts";
import { RomWeaverError } from "../errors.ts";
import { createPatchFileFromPublicOutput } from "../runtime/public-output-bin-file.ts";
import { stripOperationScopeChain } from "../runtime/run-output-paths.ts";
import { getPatchFileCleanup, type PatchFileInstance } from "./binary-service.ts";
import {
  ensureValidatedPatchArchiveEntryCleanup,
  getValidatedPatchArchiveEntryCache,
} from "./input-archive-patch-validity.ts";
import { type InputParentCompression, makeInputId } from "./input-assets.ts";
import {
  describeArchiveFileForTrace,
  getCompressionFormat,
  getCompressionRuntimeSource,
  type InputPreparationOptions,
  type InputPreparationRuntimeLike,
  isCompressionFile,
  traceArchivePreparation,
} from "./input-preparation-archive.ts";
import { resolveInputPreparationRuntime } from "./input-preparation-compression.ts";
import { getBaseFileName, normalizeArchiveEntryName } from "./path-utils.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type PatchArchiveLeaf = {
  candidate: SelectionFileCandidate;
  file: PatchFileInstance;
  parentCompressions: InputParentCompression[];
  // Libretro sidecar apply order when ingest name-matched this patch to the source's ROM; absent for
  // an unmatched patch. Drives the non-interactive (headless) auto-apply of name-matched sidecars.
  sidecarOrder?: number;
};

// Each ambiguous patch selection extracts every branch ONCE; the resulting (materialized) leaf files
// are stashed against the emitted selection request so the controller can reuse the exact extracted
// file for whichever candidate(s) the user picks - no re-extraction (which would collide on OPFS
// paths) and correct addressing even for two sibling patches in one branch. Keyed by request, so the
// stash is GC'd once the controller drops the request (e.g. on re-stage or source removal).
type RegisteredPatchLeaf = { file: PatchFileInstance; parentCompressions: InputParentCompression[] };
const patchLeafFilesByRequest = new WeakMap<CandidateSelectionRequest, Map<string, RegisteredPatchLeaf>>();

const PATCH_LEAF_ROOT_SEGMENTS = DEFAULT_VFS_ROOT.split("/").filter(Boolean);

/** Compute a leaf's archive-nesting breadcrumbs by stripping the extraction root (`/work`): a direct
 * patch yields `[]`, a nested patch yields its chain of containing nested-archive directories (named
 * after each archive, e.g. `["B_disc1"]`, `["C_set", "C_sub"]`). Stripping the fixed root (rather
 * than the prefix shared across leaves) keeps the nesting visible even when every patch sits under
 * the same nested archive. The per-operation output scratch dir (`operations/<uuid>`) ingest extracts
 * into is an internal path, not a real archive folder, so its two leading segments are stripped too -
 * otherwise every ingested leaf would surface a meaningless `operations › <uuid>` breadcrumb. */
const derivePatchLeafBreadcrumbs = (path: string): string[] => {
  const dirSegments = String(path || "")
    .split("/")
    .filter(Boolean)
    .slice(0, -1);
  let start = 0;
  while (start < PATCH_LEAF_ROOT_SEGMENTS.length && dirSegments[start] === PATCH_LEAF_ROOT_SEGMENTS[start]) {
    start += 1;
  }
  return stripOperationScopeChain(dirSegments.slice(start), (segment) => segment);
};

/** Discover EVERY patch across all (nested) branches of a patch archive in one recursive `ingest`
 * call: ingest classifies + extracts all patch-filtered leaves (the facade adopts them as
 * `patchOutputs`) and describes each (`result.patches`), so the leaf's embedded source/target
 * requirements ride along the extraction and are stashed for the apply parse (no second probe). Each
 * valid leaf is cached by its unique extracted path so the re-entrant selection (and the multi-select
 * fan-out) reuses it without re-extracting. Every patch ingest identifies is surfaced (only an archive
 * leaf is excluded); the apply-time validate guards a genuinely bad one. */
const enumeratePatchLeaves = async (
  archiveFile: PatchFileInstance,
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike,
  sourceIndex: number,
): Promise<PatchArchiveLeaf[]> => {
  const resolvedRuntime = await resolveInputPreparationRuntime(runtime);
  if (!resolvedRuntime.ingest?.run) throw new Error("Ingest runtime is unavailable");
  const compressionFormat = getCompressionFormat(archiveFile);
  traceArchivePreparation(options, "input.archive.patch.enumerate.start", {
    compressionFormat,
    file: describeArchiveFileForTrace(archiveFile),
  });
  // Ingest reports one extract elapsed per descended level (not per leaf); sum them for the breadcrumb
  // root, matching the single-elapsed value the old extract path attached there.
  let extractElapsedMs: number | undefined;
  const { result, patchOutputs } = await resolvedRuntime.ingest.run({
    fileName: archiveFile.fileName,
    // Unpack EVERY patch leaf without Rust prompting for a subset: the flat multi-select below is the
    // single place the user chooses patches. Without this, an ambiguous patch archive prompts twice -
    // once in ingest's extract selection, then again here.
    interactiveSelectionEnabled: false,
    logLevel: options?.logging?.level,
    onLog: options?.onLog,
    onProgress: (progress) => {
      const details = isRecord(progress) ? (progress as { details?: unknown }).details : undefined;
      const step = isRecord(details) ? (details as { extract_step?: unknown }).extract_step : undefined;
      if (isRecord(step) && step.status === "succeeded") {
        const elapsed = Number((step as { extract_time_ms?: unknown }).extract_time_ms);
        if (Number.isFinite(elapsed)) extractElapsedMs = (extractElapsedMs ?? 0) + elapsed;
      }
      options?.onProgress?.(progress as never);
    },
    source: getCompressionRuntimeSource(archiveFile),
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  return buildPatchArchiveLeaves(archiveFile, result.patches, patchOutputs, extractElapsedMs, options, sourceIndex);
};

/** Turn an `ingest` result's patch descriptors + adopted `patchOutputs` into materialized leaf files
 * with selection candidates. Shared by {@link enumeratePatchLeaves} (which runs its own ingest for a
 * dropped patch archive) and the ROM-staging descent (which harvests the sidecar patches its single
 * ingest already extracted, so no second pass is needed). Every patch ingest identified is surfaced
 * (only an archive leaf is excluded); the apply-time validate guards a genuinely bad one. */
const buildPatchArchiveLeaves = async (
  archiveFile: PatchFileInstance,
  patches: ParsedPatchDescriptor[],
  patchOutputs: PublicOutput[],
  extractElapsedMs: number | undefined,
  options: InputPreparationOptions,
  sourceIndex: number,
): Promise<PatchArchiveLeaf[]> => {
  const cache = getValidatedPatchArchiveEntryCache(archiveFile);
  const leaves: PatchArchiveLeaf[] = [];
  for (let index = 0; index < patches.length; index += 1) {
    const descriptor = patches[index];
    if (!descriptor) continue;
    const displayPath = descriptor.leafPath;
    // Archive leaves are adopted 1:1 into patchOutputs (a bare patch - never an archive - yields none).
    const output = patchOutputs.find((candidate) => candidate.path === displayPath);
    if (!output) continue;
    const fileName = getBaseFileName(descriptor.fileName || `patch-${index + 1}.bin`);
    let file = cache.get(displayPath);
    if (!file) {
      file = await createPatchFileFromPublicOutput(output, fileName, { materializeBlob: true });
      file.fileName = fileName;
    }
    // Trust ingest's name-based patch identification (the Rust set) and surface ALL of its leaves -
    // only an archive leaf is excluded. The TS magic-byte re-check used to drop name-valid patches the
    // header probe mis-read, hiding real choices; ingest already classified these as patches and the
    // apply-time validate still guards a genuinely bad one.
    if (isCompressionFile(file)) {
      if (!cache.has(displayPath)) await Promise.resolve(getPatchFileCleanup(file)?.()).catch(() => undefined);
      continue;
    }
    // Stash the descriptor's embedded source/target requirements so the apply parse reuses them
    // instead of re-ingesting the leaf.
    attachIngestPatchRequirements(file, patchProbeRequirementsFromDescriptor(descriptor));
    ensureValidatedPatchArchiveEntryCleanup(archiveFile);
    cache.set(displayPath, file);
    // Full archive-nesting path: the source archive, then each nested archive/folder it descends
    // through (the leaf file name is shown separately as the candidate's primary label).
    const breadcrumbs = [archiveFile.fileName || "archive", ...derivePatchLeafBreadcrumbs(displayPath)];
    // Surface the same chain as parentCompressions so a fanned-out patch keeps its "extract section"
    // (the archive › nested-archive path) in the patch stack row. Attach the elapsed time to the root
    // entry but leave parent sizes unset - synthesizing the whole-archive size as a single leaf's
    // parent would compute a nonsensical compression ratio (archive ÷ leaf).
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
        size: descriptor.sizeBytes,
        type: "file",
      },
      file,
      parentCompressions,
      ...(typeof descriptor.sidecarOrder === "number" ? { sidecarOrder: descriptor.sidecarOrder } : {}),
    });
  }
  traceArchivePreparation(options, "input.archive.patch.enumerate.finish", {
    file: describeArchiveFileForTrace(archiveFile),
    leafCandidateIds: leaves.map((leaf) => leaf.candidate.id),
    leafCount: leaves.length,
    leafPaths: leaves.map((leaf) => leaf.candidate.path),
    outputCount: patchOutputs.length,
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

export {
  buildPatchArchiveLeaves,
  getPatchLeafFileForSelection,
  getPatchLeafParentCompressionsForSelection,
  resolvePatchArchiveLeaf,
};
