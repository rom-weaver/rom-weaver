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

const stripExtension = (name: string): string => name.replace(/\.[^.]+$/, "");

/** Pick the leaf that best matches `preferredName` (a "replace from archive"
 * default): an exact base-name match wins; failing that, a name that matches
 * once the extension is stripped (so `hack.ips` still resolves `hack.bps`).
 * Case-insensitive. Returns undefined when nothing matches. Structural in its
 * leaf shape so it stays a pure, unit-testable helper. */
const matchPreferredPatchLeaf = <TLeaf extends { candidate: { fileName: string } }>(
  leaves: readonly TLeaf[],
  preferredName: string | undefined,
): TLeaf | undefined => {
  const wanted = getBaseFileName(preferredName || "").toLowerCase();
  if (!wanted) return undefined;
  const exact = leaves.find((leaf) => getBaseFileName(leaf.candidate.fileName).toLowerCase() === wanted);
  if (exact) return exact;
  const wantedStem = stripExtension(wanted);
  return leaves.find((leaf) => stripExtension(getBaseFileName(leaf.candidate.fileName).toLowerCase()) === wantedStem);
};

/** Derive archive breadcrumbs by removing `/work` and internal
 * `operations/<uuid>` segments while preserving shared nested folders. */
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

/** Discover and describe every nested patch in one recursive ingest. Cache
 * materialized leaves by path so selection reuses them without extraction or
 * probing again; apply-time validation rejects bad leaves. */
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
    identify: false,
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
const buildPatchArchiveLeaf = async (
  archiveFile: PatchFileInstance,
  descriptor: ParsedPatchDescriptor,
  index: number,
  patchOutputs: PublicOutput[],
  extractElapsedMs: number | undefined,
  cache: Map<string, PatchFileInstance>,
  sourceIndex: number,
): Promise<PatchArchiveLeaf | null> => {
  const displayPath = descriptor.leafPath;
  const output = patchOutputs.find((candidate) => candidate.path === displayPath);
  if (!output) return null;
  const fileName = getBaseFileName(descriptor.fileName || `patch-${index + 1}.bin`);
  let file = cache.get(displayPath);
  if (!file) {
    file = await createPatchFileFromPublicOutput(output, fileName, { materializeBlob: true });
    file.fileName = fileName;
  }
  if (isCompressionFile(file)) {
    if (!cache.has(displayPath)) await Promise.resolve(getPatchFileCleanup(file)?.()).catch(() => undefined);
    return null;
  }
  attachIngestPatchRequirements(file, patchProbeRequirementsFromDescriptor(descriptor));
  const breadcrumbs = [archiveFile.fileName || "archive", ...derivePatchLeafBreadcrumbs(displayPath)];
  const parentCompressions: InputParentCompression[] = breadcrumbs.map((entryName, depth) => ({
    depth,
    fileName: entryName,
    kind: "archive",
    ...(depth === 0 && extractElapsedMs !== undefined ? { decompressionTimeMs: extractElapsedMs } : {}),
  }));
  ensureValidatedPatchArchiveEntryCleanup(archiveFile);
  cache.set(displayPath, file);
  return {
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
  };
};

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
    const leaf = await buildPatchArchiveLeaf(
      archiveFile,
      descriptor,
      index,
      patchOutputs,
      extractElapsedMs,
      cache,
      sourceIndex,
    );
    if (leaf) leaves.push(leaf);
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
const requestPatchArchiveLeafSelection = (
  archiveFile: PatchFileInstance,
  leaves: PatchArchiveLeaf[],
  options: InputPreparationOptions,
  sourceIndex: number,
): never => {
  const replacement = options?.patchLeafPreference;
  const preferred = replacement ? matchPreferredPatchLeaf(leaves, replacement.preferredName) : undefined;
  const orderedLeaves = preferred ? [preferred, ...leaves.filter((entry) => entry !== preferred)] : leaves;
  if (preferred) {
    traceArchivePreparation(options, "input.archive.patch.replace.preselect", {
      file: describeArchiveFileForTrace(archiveFile),
      leafPath: preferred.candidate.path,
      preferredName: replacement?.preferredName || "",
    });
  }
  const request: CandidateSelectionRequest = {
    candidates: orderedLeaves.map((entry) =>
      entry === preferred ? { ...entry.candidate, defaultSelected: true } : entry.candidate,
    ),
    multiSelect: true,
    role: "patch",
    sourceIndex,
    sourceName: archiveFile.fileName || "Patch archive",
    warnings: [],
  };
  patchLeafFilesByRequest.set(
    request,
    new Map(
      orderedLeaves.map((entry) => [
        entry.candidate.id,
        { file: entry.file, parentCompressions: entry.parentCompressions },
      ]),
    ),
  );
  traceArchivePreparation(options, "input.archive.patch.register", {
    candidateIds: orderedLeaves.map((entry) => entry.candidate.id),
    count: orderedLeaves.length,
    preselected: preferred?.candidate.id,
    sourceName: request.sourceName,
  });
  options?.onCandidatesFound?.(request);
  throw new RomWeaverError("AMBIGUOUS_SELECTION", `${request.sourceName} requires patch selection`, {
    details: { request },
  });
};

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
  return requestPatchArchiveLeafSelection(archiveFile, leaves, options, sourceIndex);
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
  matchPreferredPatchLeaf,
  resolvePatchArchiveLeaf,
};
