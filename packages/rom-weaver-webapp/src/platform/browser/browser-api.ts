import { invokeRomWeaverPpfUndoWorker } from "../../lib/runtime/wasm-command-runtime.ts";
import type {
  CheatDatabaseRecord,
  ClassifiedCheatRecord,
  LocalCheatFileImport,
  RuntimeCheatRecord,
} from "../../lib/cheats/model.ts";
import { ApplyWorkflowController } from "../../lib/workflow/apply-workflow-controller.ts";
import { CreateWorkflowController } from "../../lib/workflow/create-workflow-controller.ts";
import { TrimWorkflowController } from "../../lib/workflow/trim-workflow-controller.ts";
import { aggregateIdentifyStatus } from "../../types/identify.ts";
import type { ParsedIdentifyCandidate, ParsedIdentifyResult } from "../../types/identify.ts";
import type { LogLevel } from "../../types/logging.ts";
import type { BrowserSaveDestination } from "../../types/output.ts";
import type { ApplySettings, CreateSettings, WorkerSettings } from "../../types/settings.ts";
import type { BrowserSourceRef, SourceRef } from "../../types/source.ts";
import type { WorkflowOptions } from "../../types/workflow-public.ts";
import type { RuntimePatchCreateFormatCandidates } from "../../types/workflow-runtime-adapter.ts";
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

type BrowserCheatInput = {
  importedFile?: LocalCheatFileImport;
  records: Array<CheatDatabaseRecord | RuntimeCheatRecord>;
  rom: SourceRef;
  selectedIds?: string[];
  outputName?: string;
  signal?: AbortSignal;
};

const toRuntimeCheatRecord = (record: CheatDatabaseRecord | RuntimeCheatRecord): RuntimeCheatRecord => ({
  id: record.id,
  system: record.system,
  gameId: record.gameId,
  description: record.description,
  rawCode: record.rawCode ?? null,
  ...(record.codeKind ? { codeKind: record.codeKind } : {}),
  rawFields: Array.isArray(record.rawFields)
    ? Object.fromEntries(record.rawFields.map(({ name, value }) => [name, value]))
    : record.rawFields,
  sourceFile: record.sourceFile,
  sourceIndex: record.sourceIndex,
  sourceRevision: record.sourceRevision,
});

const runBrowserCheats = async ({ importedFile, outputName, records, rom, selectedIds, signal }: BrowserCheatInput) => {
  browserRuntime.binary.assertSource(rom, "Cheat classification");
  const cheat = browserRuntime.cheat;
  if (!cheat) throw new Error("The cheat worker is unavailable");
  const result = await cheat.run({
    ...(importedFile ? { importedFile } : {}),
    ...(outputName ? { outputName } : {}),
    records: records.map(toRuntimeCheatRecord),
    ...(selectedIds?.length ? { selectedIds } : {}),
    signal,
    source: rom,
  });
  return { ...result, records: result.records as ClassifiedCheatRecord[] };
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
    const candidates: ParsedIdentifyCandidate[] = result.assets.map((asset) => ({
      checksumVariants: asset.checksumVariants || [],
      checksums: asset.checksums || {},
      ...(asset.platform ? { detectedPlatform: asset.platform } : {}),
      matches: identifyUnavailable ? [] : asset.identification?.matches || [],
      path: asset.memberPath || asset.fileName || fileName,
      status: identifyUnavailable ? "unavailable" : asset.identification?.status || "unknown",
    }));
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
export type { BrowserCheatInput };

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
  getIngestOutputBlob,
  identifyRom,
  ingestRom,
  preloadBrowserRuntime,
  runBrowserCheats,
  TrimWorkflow,
  undoPpf,
};
