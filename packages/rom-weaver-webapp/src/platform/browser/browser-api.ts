import {
  invokeRomWeaverPpfUndoWorker,
  invokeRomWeaverSaveExportSchemaWorker,
  invokeRomWeaverSaveGetWorker,
  invokeRomWeaverSaveIdentifyWorker,
  invokeRomWeaverSaveInspectWorker,
  invokeRomWeaverSaveSetWorker,
} from "../../lib/runtime/wasm-command-runtime.ts";
import type { SaveEditorResult } from "../../lib/runtime/save-editor-result.ts";
import { ApplyWorkflowController } from "../../lib/workflow/apply-workflow-controller.ts";
import { CreateWorkflowController } from "../../lib/workflow/create-workflow-controller.ts";
import { TrimWorkflowController } from "../../lib/workflow/trim-workflow-controller.ts";
import { aggregateIdentifyStatus } from "../../types/identify.ts";
import type { ParsedIdentifyCandidate, ParsedIdentifyResult } from "../../types/identify.ts";
import type { LogLevel } from "../../types/logging.ts";
import type { BrowserSaveDestination } from "../../types/output.ts";
import type { ApplySettings, CreateSettings, WorkerSettings } from "../../types/settings.ts";
import type { BrowserSourceRef } from "../../types/source.ts";
import type { PublicOutput } from "../../types/workflow-runtime-types.ts";
import type { WorkflowOptions } from "../../types/workflow-public.ts";
import type { RuntimePatchCreateFormatCandidates } from "../../types/workflow-runtime-adapter.ts";
import type { CompressionProbeInput } from "../../types/workflow-runtime-types.ts";
import { getDefaultBrowserThreadCount } from "../shared/compression-options.ts";
import { createPublicSourcesValidator, createPublicSourceValidator } from "../shared/public-source-validation.ts";
import { configureBrowserAssetBaseUrl } from "./browser-asset-base.ts";
import { scheduleBrowserRuntimeWarmupExtraction } from "./browser-runtime-warmup.ts";
// The public browser API is itself lazy-loaded by workflow routes. Keep the
// heavy workflow runtime behind that boundary so importing the API types and
// route shell does not make the runner part of the shared initial graph.
const { browserRuntime } = await import("./workflow-runtime.ts");

const assertPublicSources = createPublicSourcesValidator<BrowserSourceRef>(
  createPublicSourceValidator({ environmentLabel: "browser" }),
);
type BrowserRuntimePreloadOptions = {
  threads?: WorkerSettings["threads"] | null;
};
type BrowserCreatePatchFormatCandidatesInput = {
  assetBaseUrl?: string;
  original: BrowserSourceRef;
  modified: BrowserSourceRef;
  threads?: WorkerSettings["threads"] | null;
  settings?: Partial<CreateSettings>;
};
type BrowserPpfUndoInput = {
  logLevel?: LogLevel;
  outputName: string;
  patch: BrowserSourceRef;
  rom: BrowserSourceRef;
  signal?: AbortSignal;
};

type BrowserIngestRomOptions = {
  checksumAlgorithms?: string[];
  identify?: boolean;
  identifyAllRomEntries?: boolean;
  onProgress?: Parameters<NonNullable<NonNullable<typeof browserRuntime.ingest>["run"]>>[0]["onProgress"];
  signal?: AbortSignal;
};

type BrowserIdentifyRomOptions = BrowserIngestRomOptions;

const ingestRom = async (source: Blob, fileName: string, options: BrowserIngestRomOptions = {}) => {
  const ingest = browserRuntime.ingest;
  if (!ingest?.run) throw new Error("The rom-weaver checksum runtime is unavailable.");
  return ingest.run({
    checksumAlgorithms: options.checksumAlgorithms || ["sha1"],
    fileName,
    identify: options.identify,
    identifyAllRomEntries: options.identifyAllRomEntries,
    onProgress: options.onProgress,
    signal: options.signal,
    source,
  });
};

type BrowserProbeRomOptions = Partial<Pick<NonNullable<CompressionProbeInput["options"]>, "onProgress" | "signal">>;

/**
 * Metadata-only look at one input: its entries, the platform decoded from its
 * bytes, and a CHD's header digests. Nothing is extracted.
 */
const probeRom = async (source: Blob, fileName: string, options: BrowserProbeRomOptions = {}) => {
  const probe = browserRuntime.compression.probe;
  if (!probe) throw new Error("The rom-weaver probe runtime is unavailable.");
  return probe({
    options: { ...options, romFilter: true },
    source: { fileName, source },
  });
};

/**
 * Identify every ROM candidate in one input. An archive contributes one result
 * per selectable member rather than one arbitrary winner, and a database that
 * never loaded reports `unavailable` instead of a false "no match".
 */
const identifyRom = async (
  source: Blob,
  fileName: string,
  options: BrowserIdentifyRomOptions = {},
): Promise<ParsedIdentifyResult> => {
  const { identifyUnavailable, outputs, patchOutputs, result } = await ingestRom(source, fileName, {
    ...options,
    checksumAlgorithms: ["crc32", "md5", "sha1"],
    identify: true,
    identifyAllRomEntries: true,
  });
  try {
    const candidates: ParsedIdentifyCandidate[] = result.assets.map((asset) => {
      const identification = identifyUnavailable ? undefined : asset.identification;
      return {
        checksumVariants: asset.checksumVariants || [],
        checksums: asset.checksums || {},
        ...(asset.platform ? { detectedPlatform: asset.platform } : {}),
        matches: identification?.matches || [],
        path: asset.memberPath || asset.fileName || fileName,
        ...(Number.isFinite(asset.sizeBytes) ? { sizeBytes: asset.sizeBytes } : {}),
        status: identifyUnavailable ? "unavailable" : identification?.status || "unknown",
        ...(identification?.quality ? { quality: identification.quality } : {}),
        ...(identification?.platformCandidates ? { platformCandidates: identification.platformCandidates } : {}),
        ...(identification?.evidence ? { evidence: identification.evidence } : {}),
        ...(identification?.database ? { database: identification.database } : {}),
        ...(identification?.condition
          ? { condition: identification.condition, ...(identification.hint ? { hint: identification.hint } : {}) }
          : {}),
      };
    });
    // An archive that yielded extracted leaves names itself so the UI can show
    // "Archive: x.zip / ROM: Games/y.gba" rather than implying the zip matched.
    const archiveName = result.assets.some((asset) => !asset.copiedInPlace) ? fileName : undefined;
    return {
      ...(archiveName ? { archiveName } : {}),
      candidates,
      input: fileName,
      status: identifyUnavailable ? "unavailable" : aggregateIdentifyStatus(candidates.map((entry) => entry.status)),
      ...(identifyUnavailable ? { unavailableReason: identifyUnavailable } : {}),
    };
  } finally {
    await Promise.all([...outputs, ...patchOutputs].map((output) => output.dispose().catch(() => undefined)));
  }
};

type BrowserIdentifyHashOptions = {
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void;
  signal?: AbortSignal;
};

/** The checks to identify from: one or more digests plus an optional exact size. */
type BrowserIdentifyCheck = { checksums: Readonly<Record<string, string>>; size?: number };

const identifyCheckHashes = (check: BrowserIdentifyCheck): string[] =>
  Object.values(check.checksums)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

/**
 * Identify from checks alone - a bare crc32/md5/sha1 digest, or the whole rom
 * check a bundle entry or a patch's source requirement carries - through the
 * `identify --hash` command. The checksum router picks the packs a digest can
 * be in, so only those load; a router that names none is a definitive
 * `unknown`. An unloadable database reports `unavailable`, never a false
 * "no match".
 */
const identifyChecks = async (
  check: BrowserIdentifyCheck,
  options: BrowserIdentifyHashOptions = {},
): Promise<ParsedIdentifyResult> => {
  const hashes = identifyCheckHashes(check);
  const normalized = hashes[0] || "";
  if (!normalized) throw new Error("Identify needs at least one checksum.");
  const workerIo = browserRuntime.workerIo;
  if (!workerIo) throw new Error("The rom-weaver identify runtime is unavailable.");
  const { IdentifyDataUnavailableError, loadIdentifyPacks } = await import("./identify-packs.ts");
  let packs: Awaited<ReturnType<typeof loadIdentifyPacks>>;
  try {
    packs = await loadIdentifyPacks({ checksums: check.checksums }, (platforms) => {
      options.onProgress?.({ message: `Loading identification data for ${platforms.length} systems…` });
    });
  } catch (error) {
    if (!(error instanceof IdentifyDataUnavailableError)) throw error;
    return {
      candidates: [{ checksumVariants: [], checksums: {}, matches: [], path: normalized, status: "unavailable" }],
      input: normalized,
      status: "unavailable",
      unavailableReason: error.message,
    };
  }
  if (!packs.length) {
    return {
      candidates: [{ checksumVariants: [], checksums: {}, matches: [], path: normalized, status: "unknown" }],
      input: normalized,
      status: "unknown",
    };
  }
  const { invokeRomWeaverIdentifyHashWorker } = await import("../../lib/runtime/wasm-command-runtime.ts");
  const staged = await workerIo.stageSources(
    packs.map((pack, index) => ({
      fallbackFileName: pack.fileName,
      pathPrefix: `identify-pack-${index + 1}`,
      pathPrefixInPath: true as const,
      scope: "checksum" as const,
      source: pack.blob,
    })),
  );
  try {
    const result = await invokeRomWeaverIdentifyHashWorker(
      {
        databasePaths: staged.map((entry) => entry.filePath),
        hash: hashes,
        knownInputPaths: staged.map((entry) => entry.filePath),
        signal: options.signal,
        ...(typeof check.size === "number" && Number.isFinite(check.size) ? { size: check.size } : {}),
      },
      options.onProgress,
    );
    return {
      candidates: [
        {
          checksumVariants: result.checksumVariants,
          checksums: result.checksums,
          matches: result.matches,
          path: result.input || normalized,
          status: result.status,
        },
      ],
      input: result.input || normalized,
      status: result.status,
    };
  } finally {
    await Promise.all(staged.map((entry) => entry.cleanup().catch(() => undefined)));
  }
};

/** Options for a name search; `limit` caps how many titles come back. */
type BrowserIdentifyNameOptions = BrowserIdentifyHashOptions & { limit?: number };

/**
 * Search the identify data by game name inside ONE platform. A name carries no
 * checksum, so the router cannot narrow it and a bare query would pull tens of
 * megabytes of packs; the caller MUST name the platform, and exactly the pack
 * that platform owns is loaded. An unloadable database reports `unavailable`,
 * never a false "no match".
 */
const identifyName = async (
  /** A catalog pack slug, or any platform name the catalog aliases. */
  platform: string,
  query: string,
  options: BrowserIdentifyNameOptions = {},
): Promise<ParsedIdentifyResult> => {
  const normalized = query.trim();
  if (!normalized) throw new Error("Identify needs a name to search for.");
  const workerIo = browserRuntime.workerIo;
  if (!workerIo) throw new Error("The rom-weaver identify runtime is unavailable.");
  const { IdentifyDataUnavailableError, loadIdentifyPackForPlatform } = await import("./identify-packs.ts");
  let pack: Awaited<ReturnType<typeof loadIdentifyPackForPlatform>>;
  try {
    pack = await loadIdentifyPackForPlatform(platform, (platforms) => {
      options.onProgress?.({ message: `Loading identification data for ${platforms.join(", ")}…` });
    });
  } catch (error) {
    if (!(error instanceof IdentifyDataUnavailableError)) throw error;
    return {
      candidates: [{ checksumVariants: [], checksums: {}, matches: [], path: normalized, status: "unavailable" }],
      input: normalized,
      status: "unavailable",
      unavailableReason: error.message,
    };
  }
  const { invokeRomWeaverIdentifyNameWorker } = await import("../../lib/runtime/wasm-command-runtime.ts");
  const staged = await workerIo.stageSources([
    {
      fallbackFileName: pack.fileName,
      pathPrefix: "identify-pack-1",
      pathPrefixInPath: true as const,
      scope: "checksum" as const,
      source: pack.blob,
    },
  ]);
  try {
    const result = await invokeRomWeaverIdentifyNameWorker(
      {
        databasePaths: staged.map((entry) => entry.filePath),
        knownInputPaths: staged.map((entry) => entry.filePath),
        name: normalized,
        signal: options.signal,
        ...(typeof options.limit === "number" && Number.isFinite(options.limit) ? { limit: options.limit } : {}),
      },
      options.onProgress,
    );
    return {
      candidates: [
        {
          checksumVariants: result.checksumVariants,
          checksums: result.checksums,
          matches: result.matches,
          path: result.input || normalized,
          status: result.status,
        },
      ],
      input: result.input || normalized,
      status: result.status,
    };
  } finally {
    await Promise.all(staged.map((entry) => entry.cleanup().catch(() => undefined)));
  }
};

/** The single-digest entry point the identify page pastes into. */
const identifyHash = (hash: string, options: BrowserIdentifyHashOptions = {}): Promise<ParsedIdentifyResult> =>
  identifyChecks({ checksums: { hash } }, options);

const getIngestOutputBlob = async (
  output: Parameters<NonNullable<typeof browserRuntime.publicOutput>["getBlob"]>[0],
) => {
  const adapter = browserRuntime.publicOutput;
  if (!adapter) throw new Error("The rom-weaver output adapter is unavailable.");
  return adapter.getBlob(output);
};

let runtimePreloadKey = "";
let runtimePreloadPromise = Promise.resolve();
const resolveRuntimePreloadThreads = (threads: BrowserRuntimePreloadOptions["threads"]) => {
  const normalized = String(threads ?? "")
    .trim()
    .toLowerCase();
  return !normalized || normalized === "auto" ? getDefaultBrowserThreadCount() : threads;
};

const preloadBrowserRuntime = (options: BrowserRuntimePreloadOptions = {}) => {
  const threads = resolveRuntimePreloadThreads(options.threads);
  const preloadKey = String(threads);
  if (runtimePreloadKey === preloadKey) return runtimePreloadPromise;
  runtimePreloadKey = preloadKey;
  runtimePreloadPromise = Promise.resolve(
    browserRuntime.preload?.preloadCapability?.("compression", () => undefined, { threads }),
  )
    .then(() => {
      // Runner init (above) warms the WASM module, worker pool, and scratch pool. Schedule one silent
      // dummy extraction at idle so the decode-path JIT and first OPFS input/output handle opens are
      // warm too, so the user's first real extraction starts at steady state.
      scheduleBrowserRuntimeWarmupExtraction();
    })
    .catch(() => {
      if (runtimePreloadKey === preloadKey) runtimePreloadKey = "";
    })
    .then(() => undefined);
  return runtimePreloadPromise;
};

const getCreatePatchFormatCandidates = async ({
  assetBaseUrl,
  modified,
  original,
  settings,
  threads,
}: BrowserCreatePatchFormatCandidatesInput): Promise<RuntimePatchCreateFormatCandidates> => {
  configureBrowserAssetBaseUrl(assetBaseUrl);
  assertPublicSources([original, modified]);
  const candidates = await browserRuntime.patch.createPatchCandidates?.({
    logLevel: settings?.logging?.level,
    modified,
    onLog: settings?.logging?.sink,
    original,
    threads: threads ?? settings?.workers?.threads,
  });
  if (!candidates) throw new Error("Create patch candidate selection is unavailable");
  return candidates;
};

const undoPpf = async ({ logLevel, outputName, patch, rom, signal }: BrowserPpfUndoInput) => {
  assertPublicSources([rom, patch]);
  const staged = await browserRuntime.workerIo.stageSources([
    {
      fallbackFileName: "patched-rom.bin",
      pathPrefix: "ppf-undo-rom",
      scope: "apply",
      source: rom,
      trace: { logLevel },
    },
    {
      fallbackFileName: "undo.ppf",
      pathBucket: "patches",
      pathPrefix: "ppf-undo-patch",
      scope: "apply",
      source: patch,
      trace: { logLevel },
    },
  ]);
  const [stagedRom, stagedPatch] = staged;
  if (!(stagedRom && stagedPatch)) throw new Error("PPF undo inputs could not be staged");
  try {
    const result = await invokeRomWeaverPpfUndoWorker({
      knownInputPaths: [stagedRom.filePath, stagedPatch.filePath],
      logLevel,
      outputName,
      patchFilePath: stagedPatch.filePath,
      romFilePath: stagedRom.filePath,
      signal,
    });
    return browserRuntime.workerIo.createWorkerOutput(result, outputName, "PPF undo did not return a restored ROM");
  } finally {
    await Promise.all(staged.map((source) => source.cleanup().catch(() => undefined)));
  }
};

type BrowserSaveInput = {
  game?: string;
  romSha1?: string;
  signal?: AbortSignal;
  source: BrowserSourceRef | Uint8Array;
  fileName?: string;
};
type BrowserSaveSetInput = BrowserSaveInput & { assignments: string[]; outputName: string };
const MAX_SAVE_INPUT_SIZE = 128 * 1024 * 1024;

const saveSourceSize = (source: BrowserSourceRef | Uint8Array): number | undefined => {
  if (source instanceof Uint8Array) return source.byteLength;
  if (typeof Blob !== "undefined" && source instanceof Blob) return source.size;
  if (typeof source === "object" && "size" in source && typeof source.size === "number") return source.size;
  if (typeof source === "object" && "source" in source && source.source instanceof Blob) return source.source.size;
  return undefined;
};

const stageSaveInput = (input: BrowserSaveInput) => {
  const size = saveSourceSize(input.source);
  if (size !== undefined && size > MAX_SAVE_INPUT_SIZE) {
    throw new Error("The save file is larger than 128 MiB.");
  }
  return browserRuntime.workerIo.stageSource({
    fallbackFileName: input.fileName || "save.sav",
    pathPrefix: "save-editor-input",
    scope: "checksum",
    source: input.source,
  });
};

const runBrowserSaveRead = async (
  input: BrowserSaveInput,
  run: (filePath: string) => Promise<{ parsed: SaveEditorResult }>,
) => {
  const staged = await stageSaveInput(input);
  try {
    return (await run(staged.filePath)).parsed;
  } finally {
    await staged.cleanup().catch(() => undefined);
  }
};

const identifySave = (input: BrowserSaveInput) =>
  runBrowserSaveRead(input, (inputPath) =>
    invokeRomWeaverSaveIdentifyWorker({ inputPath, game: input.game, romSha1: input.romSha1, signal: input.signal }),
  );
const inspectSave = (input: BrowserSaveInput) =>
  runBrowserSaveRead(input, (inputPath) =>
    invokeRomWeaverSaveInspectWorker({ inputPath, game: input.game, romSha1: input.romSha1, signal: input.signal }),
  );
const getSaveField = (input: BrowserSaveInput & { field: string }) =>
  runBrowserSaveRead(input, (inputPath) =>
    invokeRomWeaverSaveGetWorker({
      inputPath,
      field: input.field,
      game: input.game,
      romSha1: input.romSha1,
      signal: input.signal,
    }),
  );
const exportSaveSchema = (input: BrowserSaveInput) =>
  runBrowserSaveRead(input, (inputPath) =>
    invokeRomWeaverSaveExportSchemaWorker({
      game: input.game,
      inputPath,
      romSha1: input.romSha1,
      signal: input.signal,
    }),
  );
const setSaveFields = async (input: BrowserSaveSetInput) => {
  const staged = await stageSaveInput(input);
  try {
    const result = await invokeRomWeaverSaveSetWorker({
      assignments: input.assignments,
      game: input.game,
      inputPath: staged.filePath,
      outputName: input.outputName,
      romSha1: input.romSha1,
      signal: input.signal,
    });
    const workerResult = result as SaveEditorResult & {
      parsed: SaveEditorResult;
      filePath?: string;
      fileName?: string;
      size?: number;
      timing?: PublicOutput["timing"];
    };
    const output = await browserRuntime.workerIo.createWorkerOutput(
      workerResult,
      input.outputName,
      "Save editor did not return an edited save",
    );
    return { ...workerResult.parsed, output };
  } finally {
    await staged.cleanup().catch(() => undefined);
  }
};
const previewSaveFields = async (input: BrowserSaveSetInput) => {
  const staged = await stageSaveInput(input);
  try {
    return await invokeRomWeaverSaveSetWorker({
      assignments: input.assignments,
      dryRun: true,
      game: input.game,
      inputPath: staged.filePath,
      outputName: input.outputName,
      romSha1: input.romSha1,
      signal: input.signal,
    });
  } finally {
    await staged.cleanup().catch(() => undefined);
  }
};

// The public browser workflows ARE their UI-agnostic controllers - a thin subclass adds only the
// browser binding (asset-base config + runtime pre-warm + browserRuntime/source-validation wiring).
// All staging/run/progress/`subscribe`/`getSnapshot` methods are inherited directly from the
// controller, so there is no forwarding layer between the webapp and the controller.
class CreateWorkflow extends CreateWorkflowController<BrowserSourceRef, BrowserSaveDestination> {
  constructor(options: WorkflowOptions<CreateSettings> = {}) {
    super(browserRuntime, options, assertPublicSources);
    configureBrowserAssetBaseUrl(options.assetBaseUrl);
  }
}

export type { BrowserSaveDestination } from "../../types/output.ts";
export type { WorkflowProgress } from "../../types/progress.ts";
export type { BrowserApplyResult, BrowserCreateResult, BrowserTrimResult } from "../../types/public.ts";
export type { CandidateSelectionRequest } from "../../types/selection.ts";
export type { ApplySettings, CreateSettings } from "../../types/settings.ts";

export type { BrowserCreatePatchFormatCandidatesInput, RuntimePatchCreateFormatCandidates };

class ApplyWorkflow extends ApplyWorkflowController<BrowserSourceRef, BrowserSaveDestination> {
  constructor(options: WorkflowOptions<ApplySettings> = {}) {
    super(browserRuntime, options, assertPublicSources);
    configureBrowserAssetBaseUrl(options.assetBaseUrl);
  }
}

class TrimWorkflow extends TrimWorkflowController<BrowserSourceRef, BrowserSaveDestination> {
  constructor(options: WorkflowOptions<CreateSettings> = {}) {
    super(browserRuntime, options, assertPublicSources);
    configureBrowserAssetBaseUrl(options.assetBaseUrl);
  }
}

export {
  ApplyWorkflow,
  CreateWorkflow,
  getCreatePatchFormatCandidates,
  exportSaveSchema,
  getSaveField,
  identifySave,
  inspectSave,
  setSaveFields,
  previewSaveFields,
  getIngestOutputBlob,
  identifyChecks,
  identifyHash,
  identifyName,
  identifyRom,
  ingestRom,
  preloadBrowserRuntime,
  probeRom,
  TrimWorkflow,
  undoPpf,
};
