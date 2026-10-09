import { getWeaveRuntime } from "../runtime/bundle-runtime.ts";
import { createCleanupOnce } from "../../storage/shared/disposal.ts";
import type {
  ParsedWeave,
  ParsedWeavePatchEntry,
  ParsedWeavePatchSource,
  ParsedWeaveSourceRef,
} from "../../types/weave.ts";
import { attachIngestPatchRequirements, patchProbeRequirementsFromDescriptor } from "../apply/patch-apply-service.ts";
import { setWeaveRomProvenance } from "../input/weave-rom-provenance.ts";
import { inheritSourceIdentificationPolicy } from "../input/input-identification-policy.ts";
import type { InputParentCompression } from "../input/input-assets.ts";
import { fetchRemoteFiles } from "../remote/remote-file-fetch.ts";
import type { WeaveApplySession, WeaveApplySessionEntry } from "./weave-session-model.ts";
import { weaveChainEndpointChecks, weaveRomExpectation, weaveSessionDisplayName } from "./weave-session-model.ts";
import { resolveWeaveChecks } from "./weave-targets.ts";

// The archive-nesting chain a fanned-out leaf patch carries on its File so a re-stage still renders
// the "extract section"; a weave-extracted patch rides the same channel (see apply-prepared-metadata).
type NestedPatchSourceMetadata = { __nestedParentCompressions?: InputParentCompression[] };

const normalizePath = (value: string) =>
  value
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");

const baseName = (value: string) => normalizePath(value).split("/").pop() || value;

const createWeaveAbortError = () => {
  const error = new Error("Weave loading was aborted");
  error.name = "AbortError";
  return error;
};

const resolveDroppedPath = (files: File[], requested: string, label: string): File => {
  const normalized = normalizePath(requested);
  const exact = files.filter((file) => normalizePath(file.webkitRelativePath || file.name) === normalized);
  if (exact.length === 1) return exact[0] as File;
  if (exact.length > 1) throw new Error(`Weave ${label} path is ambiguous: ${requested}`);
  const basenameMatches = files.filter((file) => baseName(file.name) === baseName(normalized));
  if (basenameMatches.length === 1) return basenameMatches[0] as File;
  if (basenameMatches.length > 1) throw new Error(`Weave ${label} basename is ambiguous: ${requested}`);
  throw new Error(`Weave ${label} file is missing from this drop: ${requested}`);
};

const loadSource = async (
  source: ParsedWeaveSourceRef,
  files: File[],
  extractedFiles: Map<string, File>,
  label: string,
  signal?: AbortSignal,
): Promise<{ cleanup?: () => Promise<void>; file: File }> => {
  if (signal?.aborted) throw createWeaveAbortError();
  if (source.kind === "extracted") {
    const file = extractedFiles.get(source.extractedPath);
    if (!file) throw new Error(`Weave ${label} was not extracted: ${source.extractedPath}`);
    return { file };
  }
  if (source.kind === "path") return { file: resolveDroppedPath(files, source.path, label) };
  try {
    const url = new URL(source.url);
    const [fetched] = await fetchRemoteFiles([{ url: url.toString() }], signal);
    if (!fetched) throw new Error(`Weave ${label} download returned no file`);
    return { cleanup: fetched.cleanup, file: fetched.file };
  } catch (error) {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(source.url)) {
      return { file: resolveDroppedPath(files, source.url, label) };
    }
    throw error;
  }
};

type LoadLocalWeaveOptions = {
  /**
   * Content-probe mode: the caller only suspects `weaveFile` is a weave (a
   * non-canonically-named `*.json`, or an archive whose index is not
   * `rom-weaver-weave.json`). A PARSE failure then means "not a weave" and
   * resolves to `null` so the caller falls back to normal routing. Acquisition
   * failures still throw - once the JSON parses+validates it IS a weave, and a
   * missing member is a real, surfaceable error.
   */
  probe?: boolean;
  signal?: AbortSignal;
};

type LoadedLocalWeave = {
  cleanup: () => Promise<void>;
  patchFiles: File[];
  romFile: File | undefined;
  session: WeaveApplySession;
};

/**
 * Runs the weave's source acquisitions as one unit: the first failure aborts the
 * rest, but every settled result is still reported so their cleanups can be
 * registered before the error is rethrown.
 */
function createAcquisitionGroup(signal: AbortSignal | undefined) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let failed = false;
  let firstError: unknown;
  return {
    acquire: <T>(promise: Promise<T>) =>
      promise.catch((error: unknown) => {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        abort();
        throw error;
      }),
    assertSucceeded: () => {
      if (failed) throw firstError;
      if (signal?.aborted) throw createWeaveAbortError();
    },
    detach: () => signal?.removeEventListener("abort", abort),
    signal: controller.signal,
  };
}

/**
 * A ROM extracted from the weave archive keeps that provenance: register a
 * weave -> rom breadcrumb (keyed by the extracted ROM's File) so its ROM card
 * renders the same "Extract" section a plainly-dropped archive would, instead of
 * appearing as a bare, chainless input.
 */
function markExtractedRomProvenance(romFile: File, weaveFile: File, parseElapsedMs: number) {
  setWeaveRomProvenance(romFile, [
    {
      decompressionTimeMs: parseElapsedMs,
      depth: 0,
      fileName: weaveFile.name,
      kind: "archive",
      outputSize: romFile.size,
      sourceSize: weaveFile.size,
    },
  ]);
  inheritSourceIdentificationPolicy(weaveFile, romFile);
}

/** Only the fields the manifest declared reach the session; the rest stay absent. */
function buildWeaveApplySession(
  result: { weave: ParsedWeave; warnings: WeaveApplySession["warnings"] },
  weaveFile: File,
  patchFiles: File[],
  romFile: File | undefined,
): WeaveApplySession {
  const output = result.weave.output;
  const name = weaveSessionDisplayName(result.weave);
  const romExpectation = romFile ? undefined : weaveRomExpectation(result.weave);
  return {
    chainEndpointChecks: weaveChainEndpointChecks(result.weave),
    ...(result.weave.rom?.member ? { romMember: result.weave.rom.member } : {}),
    entries: result.weave.patches.map((patch, index) =>
      toWeaveSessionEntry(
        {
          ...patch,
          inputChecks: resolveWeaveChecks(result.weave, patch.inputChecks, patch.inputChecksRef),
          outputChecks: resolveWeaveChecks(result.weave, patch.outputChecks, patch.outputChecksRef),
        },
        patchFiles[index],
        index,
      ),
    ),
    key: `local:${weaveFile.name}:${weaveFile.size}:${weaveFile.lastModified}`,
    patchBasis: result.weave.version >= 2 ? result.weave.patchBasis || "auto" : "auto",
    ...(name ? { name } : {}),
    outputDefaults: {
      ...(output?.name ? { name: output.name } : {}),
      ...(output?.header ? { header: output.header } : {}),
    },
    ...(romFile ? { romFileName: romFile.name } : {}),
    ...(romExpectation ? { romExpectation } : {}),
    warnings: result.warnings,
  };
}

// Authoritative load (canonical name): parse errors surface.
/**
 * A patch extracted from the weave archive keeps that provenance: carry a
 * weave -> patch breadcrumb on the leaf File (the same `__nestedParentCompressions`
 * side-channel a fanned-out archive patch uses) so its patch-stack row renders the
 * "Extract" section instead of a bare leaf. Sizes stay unset - the
 * weave-archive-over-one-tiny-patch ratio would be nonsensical - matching the
 * archive-patch-leaf treatment; only the root extract time rides along.
 */
function markExtractedPatchProvenance(
  patchFiles: File[],
  patchSources: ParsedWeavePatchSource[],
  weaveFileName: string,
  parseElapsedMs: number,
) {
  patchFiles.forEach((file, index) => {
    attachIngestPatchRequirements(file, patchProbeRequirementsFromDescriptor(patchSources[index]?.descriptor));
    if (patchSources[index]?.source.kind !== "extracted") return;
    (file as File & NestedPatchSourceMetadata).__nestedParentCompressions = [
      { decompressionTimeMs: parseElapsedMs, depth: 0, fileName: weaveFileName, kind: "archive" },
    ];
  });
}

/** Only the fields the manifest actually declared reach the session entry. */
function toWeaveSessionEntry(
  patch: ParsedWeavePatchEntry,
  file: File | undefined,
  index: number,
): WeaveApplySessionEntry {
  if (!file) throw new Error(`Weave patch ${index + 1} was not acquired`);
  return {
    acquisition: { extractedPath: file.name, kind: "extracted" },
    fileName: file.name,
    optional: patch.optional === true,
    ...(patch.name ? { name: patch.name } : {}),
    ...(patch.description ? { description: patch.description } : {}),
    ...(patch.version ? { version: patch.version } : {}),
    ...(patch.author ? { author: patch.author } : {}),
    ...(patch.label ? { label: patch.label } : {}),
    ...(patch.header ? { header: patch.header } : {}),
    ...(patch.basis ? { basis: patch.basis } : {}),
    ...(patch.input ? { input: patch.input } : {}),
    ...(patch.target ? { target: patch.target } : {}),
    ...(patch.inputChecks ? { inputChecks: patch.inputChecks } : {}),
    ...(patch.outputChecks ? { outputChecks: patch.outputChecks } : {}),
  };
}

async function loadLocalWeaveSession(
  weaveFile: File,
  droppedFiles: File[],
  options?: { probe?: false; signal?: AbortSignal },
): Promise<LoadedLocalWeave>;
// Probe load: a parse failure resolves to null so the caller can fall back.
async function loadLocalWeaveSession(
  weaveFile: File,
  droppedFiles: File[],
  options: { probe: true; signal?: AbortSignal },
): Promise<LoadedLocalWeave | null>;
async function loadLocalWeaveSession(
  weaveFile: File,
  droppedFiles: File[],
  { probe = false, signal }: LoadLocalWeaveOptions = {},
): Promise<LoadedLocalWeave | null> {
  const { browserRuntime } = await import("../../platform/browser/workflow-runtime.ts");
  const parse = getWeaveRuntime(browserRuntime)?.parse;
  if (!parse) throw new Error("Weave parsing is not available in this runtime");
  let parsed: Awaited<ReturnType<typeof parse>>;
  const parseStartedAt = performance.now();
  try {
    parsed = await parse({ fileName: weaveFile.name, signal, source: weaveFile });
  } catch (error) {
    if (probe && !signal?.aborted) return null;
    throw error;
  }
  const parseElapsedMs = Math.max(0, performance.now() - parseStartedAt);
  const { result, extractedFiles } = parsed;
  const acquiredCleanups: Array<() => Promise<void>> = [parsed.cleanup];
  const cleanup = createCleanupOnce(async () => {
    await Promise.all(acquiredCleanups.map((release) => release()));
  });
  const group = createAcquisitionGroup(signal);
  try {
    const [settledRom, ...settledPatches] = await Promise.allSettled([
      result.romSource
        ? group.acquire(loadSource(result.romSource, droppedFiles, extractedFiles, "ROM", group.signal))
        : Promise.resolve(undefined),
      ...result.patchSources.map((patch, index) =>
        group.acquire(loadSource(patch.source, droppedFiles, extractedFiles, `patch ${index + 1}`, group.signal)),
      ),
    ]);
    for (const entry of [settledRom, ...settledPatches]) {
      if (entry.status === "fulfilled" && entry.value?.cleanup) acquiredCleanups.push(entry.value.cleanup);
    }
    group.assertSucceeded();
    const romSource = settledRom.status === "fulfilled" ? settledRom.value : undefined;
    const acquiredPatches = settledPatches.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
    const romFile = romSource?.file;
    if (romFile && result.romSource?.kind === "extracted") {
      markExtractedRomProvenance(romFile, weaveFile, parseElapsedMs);
    }
    const patchFiles = acquiredPatches.map((entry) => entry.file);
    markExtractedPatchProvenance(patchFiles, result.patchSources, weaveFile.name, parseElapsedMs);
    const session = buildWeaveApplySession(result, weaveFile, patchFiles, romFile);
    return { cleanup, patchFiles, romFile, session };
  } catch (error) {
    await cleanup();
    throw error;
  } finally {
    group.detach();
  }
}

export { loadLocalWeaveSession };
