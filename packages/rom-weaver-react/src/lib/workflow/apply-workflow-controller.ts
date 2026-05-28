import type {
  ApplyWorkflowChecksums,
  ApplyWorkflowInputState,
  ApplyWorkflowParentCompression,
  ApplyWorkflowPatchState,
  ApplyWorkflowResolvedInput,
} from "../../types/apply-workflow.ts";
import type { WorkflowProgress } from "../../types/progress.ts";
import type { ApplyResult } from "../../types/public.ts";
import type { CandidateSelectionRequest, SelectionCandidate, SelectionFileCandidate } from "../../types/selection.ts";
import type { ApplySettings, CompressionFormat } from "../../types/settings.ts";
import type { WorkflowOptions, WorkflowWarning } from "../../types/workflow-controller.ts";
import type { ApplyWorkflowOptions, PatchInput } from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { ParsedPatchLike, PatchFileInstance } from "../../workers/protocol/patch-engine.ts";
import { patchWorkflowDeps, runApplyWorkflow } from "../apply/workflow.ts";
import {
  Z3DS_COMPRESSION_INPUT_EXTENSIONS,
  Z3DS_DECOMPRESSION_INPUT_EXTENSIONS,
} from "../compression/disc-format-support.ts";
import OutputCompressionManager from "../compression/output-compression-manager.ts";
import { RomWeaverError, throwIfAborted, toRomWeaverError, withAbortSignal } from "../errors.ts";
import { getPatchFileCleanup } from "../input/binary-service.ts";
import { getInputPreparationMetrics, type InputAsset, type InputParentCompression } from "../input/input-assets.ts";
import {
  getBinarySourceSize,
  prepareInputAssets,
  prepareInputFile,
  prepareMultipleDirectInputAssets,
} from "../input/input-preparation-service.ts";
import {
  appendFileNameExtension,
  getBaseFileName,
  getFileNameWithoutExtension,
  stripFileNameQuery,
} from "../input/path-utils.ts";
import { selectionToArchiveEntry } from "../input/selection.ts";
import { wrapPublicOutput } from "../output/index.ts";
import {
  cloneCandidate,
  cloneValue,
  cloneWarning,
  createChecksumSource,
  createWorkflowId,
  createWorkflowProgress,
  DEFAULT_CHECKSUMS,
  getPreparationProgressStage,
  getSourceFileName,
  getSourceSize,
  isRecord,
} from "./controller-utils.ts";
import { WorkflowController } from "./workflow-controller.ts";
import { traceWorkflowControllerEvent } from "./workflow-tracing.ts";

type SourceValidator<TSource> = (sources: TSource | TSource[] | undefined) => void;
type SourceRole = "input" | "patch";
type SourceStatus = ApplyWorkflowInputState["status"];
type InternalSourceState = {
  id: string;
  fileName?: string;
  order: number;
  status: SourceStatus;
  candidates: SelectionCandidate[];
  selectedCandidateId?: string;
  targetInputId?: string;
  targetInputFileName?: string;
  size?: number;
  sourceSize?: number;
  decompressionTimeMs?: number;
  wasDecompressed?: boolean;
  warnings: WorkflowWarning[];
  checksums?: ApplyWorkflowChecksums;
  checksumTimeMs?: number;
  role: SourceRole;
};
type InternalCandidate<TSource> = {
  archiveEntry?: string;
  candidate: SelectionCandidate;
  owner?: StagedSource<TSource>;
  request?: CandidateSelectionRequest;
};
type StagedSource<TSource> = {
  source: TSource;
  allowLazyBrowserRomSource?: boolean;
  index: number;
  state: InternalSourceState;
  internalCandidates: Map<string, InternalCandidate<TSource>>;
  preparedInputAssets?: InputAsset[];
  preparedPatchFile?: PatchFileInstance;
  parsedPatch?: ParsedPatchLike;
  selectedArchiveEntry?: string;
  outputLabel?: string;
  parentCompressions: ApplyWorkflowParentCompression[];
};
type InputSession<TSource> = {
  sources: TSource[];
  stages: StagedSource<TSource>[];
  view: StagedSource<TSource>;
  synthetic: boolean;
};
const getPatchFilePrecomputedChecksums = (file: PatchFileInstance | undefined): ApplyWorkflowChecksums | undefined => {
  const checksums = (file as (PatchFileInstance & { checksums?: unknown }) | undefined)?.checksums;
  if (!isRecord(checksums)) return undefined;
  const out: ApplyWorkflowChecksums = {};
  for (const algorithm of DEFAULT_CHECKSUMS) {
    const value = checksums[algorithm];
    if (typeof value !== "string" || !value.trim()) return undefined;
    out[algorithm] = value.trim().toLowerCase();
  }
  return out;
};
const PATCH_OUTPUT_LABEL_PATTERN = /\[([^\]]+)\](?:\.[^.]+)?\d*$/;
const FILE_EXTENSION_REGEX = /\.([^./\\\s]+)$/;
const APPLY_FORMATS = new Set<CompressionFormat>(["7z", "chd", "none", "rvz", "z3ds", "zip"]);
const Z3DS_APPLY_EXTENSIONS = new Set([...Z3DS_COMPRESSION_INPUT_EXTENSIONS, ...Z3DS_DECOMPRESSION_INPUT_EXTENSIONS]);
const PATCH_TARGET_SELECTION_ERROR_CODES = new Set(["AMBIGUOUS_SELECTION", "PATCH_TARGET_MISMATCH"]);

const cloneInputState = (
  state: InternalSourceState | null | undefined,
  parentCompressions: ApplyWorkflowParentCompression[],
  resolvedInputs?: ApplyWorkflowResolvedInput[],
) =>
  state
    ? ({
        candidates: state.candidates.map(cloneCandidate),
        checksums: state.checksums ? cloneValue(state.checksums) : undefined,
        checksumTimeMs: state.checksumTimeMs,
        decompressionTimeMs: state.decompressionTimeMs,
        fileName: (() => {
          if (!(state.status === "needsSelection" && !state.selectedCandidateId)) return state.fileName;
          const selectableGroups = state.candidates.filter(
            (candidate) => candidate.type === "group" && candidate.selectable,
          );
          const selectableGroupIds = new Set(selectableGroups.map((candidate) => candidate.id));
          const romCandidates = state.candidates.filter(
            (candidate): candidate is SelectionFileCandidate =>
              candidate.type === "file" &&
              candidate.kind === "rom" &&
              candidate.selectable &&
              !selectableGroupIds.has(candidate.parentCandidateId || ""),
          );
          return romCandidates.length === 1 ? romCandidates[0]?.fileName || state.fileName : state.fileName;
        })(),
        id: state.id,
        parentCompressions: parentCompressions.map((entry) => ({ ...entry })),
        resolvedInputs: resolvedInputs?.map((entry) => ({
          ...entry,
          checksums: entry.checksums ? cloneValue(entry.checksums) : undefined,
          parentCompressions: entry.parentCompressions.map((parent) => ({
            ...parent,
          })),
        })),
        selectedCandidateId: state.selectedCandidateId,
        size: state.size,
        sourceSize: state.sourceSize,
        status: state.status,
        warnings: state.warnings.map(cloneWarning),
        wasDecompressed: state.wasDecompressed,
      } satisfies ApplyWorkflowInputState)
    : null;

const clonePatchState = (
  state: InternalSourceState,
  parentCompressions: ApplyWorkflowParentCompression[],
): ApplyWorkflowPatchState => ({
  candidates: state.candidates.map(cloneCandidate),
  decompressionTimeMs: state.decompressionTimeMs,
  fileName: state.fileName,
  id: state.id,
  parentCompressions: parentCompressions.map((entry) => ({ ...entry })),
  selectedCandidateId: state.selectedCandidateId,
  size: state.size,
  sourceSize: state.sourceSize,
  status: state.status,
  targetInputFileName: state.targetInputFileName,
  targetInputId: state.targetInputId,
  warnings: state.warnings.map(cloneWarning),
  wasDecompressed: state.wasDecompressed,
});

const cloneResolvedInputState = (
  state: InternalSourceState,
  parentCompressions: ApplyWorkflowParentCompression[],
  selected: boolean,
): ApplyWorkflowResolvedInput => ({
  checksums: state.checksums ? cloneValue(state.checksums) : undefined,
  checksumTimeMs: state.checksumTimeMs,
  decompressionTimeMs: state.decompressionTimeMs,
  fileName: state.fileName,
  groupId: (() => {
    const selectedCandidate = state.candidates.find(
      (candidate) => candidate.id === state.selectedCandidateId && "parentCandidateId" in candidate,
    );
    return selectedCandidate && "parentCandidateId" in selectedCandidate
      ? selectedCandidate.parentCandidateId || undefined
      : undefined;
  })(),
  id: state.id,
  order: state.order,
  parentCompressions: parentCompressions.map((entry) => ({ ...entry })),
  selected,
  selectedCandidateId: state.selectedCandidateId,
  size: state.size,
  sourceSize: state.sourceSize,
  wasDecompressed: state.wasDecompressed,
});

const createPatchOutputLabel = (fileName: string | undefined) => {
  const label = String(fileName || "")
    .match(PATCH_OUTPUT_LABEL_PATTERN)?.[1]
    ?.trim();
  return label || undefined;
};

const getCompressionExtension = (
  format: CompressionFormat,
  inputFileName: string | undefined,
  settings: Partial<ApplySettings>,
) => {
  if (format === "none") {
    const extension = stripFileNameQuery(inputFileName || "").match(FILE_EXTENSION_REGEX)?.[1];
    return extension || "";
  }
  if (format === "7z") return "7z";
  if (format === "zip")
    return OutputCompressionManager.getArchiveOutputExtension("zip", {
      zipCodec: settings.output?.container?.zipCodec,
    });
  if (format === "chd") return "chd";
  if (format === "rvz") return "rvz";
  if (format === "z3ds") {
    const extension = stripFileNameQuery(inputFileName || "")
      .match(FILE_EXTENSION_REGEX)?.[1]
      ?.toLowerCase();
    if (extension === "cia" || extension === "zcia") return "zcia";
    if (extension === "3ds" || extension === "z3ds") return "z3ds";
    if (extension === "cci" || extension === "zcci") return "zcci";
    if (extension === "cxi" || extension === "app" || extension === "zcxi") return "zcxi";
    if (extension === "3dsx" || extension === "z3dsx") return "z3dsx";
    return "z3ds";
  }
  return format;
};

const resolveAutomaticFormat = (
  input: InputSession<unknown> | undefined,
  _settings: Partial<ApplySettings>,
): CompressionFormat => {
  const parentKind = input?.view?.parentCompressions?.[0]?.kind;
  if (parentKind === "zip") return "zip";
  if (parentKind === "7z") return "7z";
  if (parentKind === "chd") return "chd";
  if (parentKind === "rvz") return "rvz";
  if (parentKind === "z3ds") return "z3ds";
  const sourceName = input?.sources[0] ? getSourceFileName(input.sources[0], "input") : "";
  const extension = stripFileNameQuery(sourceName).match(FILE_EXTENSION_REGEX)?.[1]?.toLowerCase();
  if (extension === "zip" || extension === "zipx") return "zip";
  if (extension === "7z") return "7z";
  if (extension === "chd") return "chd";
  if (extension === "rvz") return "rvz";
  if (Z3DS_APPLY_EXTENSIONS.has(extension || "")) return "z3ds";
  return "7z";
};

const releasePreparedFile = (file?: PatchFileInstance) => {
  const cleanup = file ? getPatchFileCleanup(file) : undefined;
  if (cleanup) void Promise.resolve(cleanup()).catch(() => undefined);
};

const releasePreparedSource = (source?: StagedSource<unknown>) => {
  if (!source) return;
  for (const asset of source.preparedInputAssets || []) releasePreparedFile(asset.file);
  releasePreparedFile(source.preparedPatchFile);
  source.preparedInputAssets = undefined;
  source.preparedPatchFile = undefined;
  source.parsedPatch = undefined;
};

const getSelectableCandidateCount = (request: CandidateSelectionRequest) => {
  const selectableGroups = request.candidates.filter((candidate) => candidate.type === "group" && candidate.selectable);
  const selectableGroupIds = new Set(selectableGroups.map((candidate) => candidate.id));
  const selectableFiles = request.candidates.filter(
    (candidate) =>
      candidate.type === "file" && candidate.selectable && !selectableGroupIds.has(candidate.parentCandidateId || ""),
  );
  return selectableGroups.length + selectableFiles.length;
};

const getPreparedAssetFileName = (asset: InputAsset | undefined, fallback?: string) =>
  getBaseFileName(asset?.file.fileName || asset?.fileName || fallback || "input.bin");

const canRecoverWithCandidateSelection = (error: unknown, requests: CandidateSelectionRequest[]) => {
  if (!requests.length) return false;
  const normalized = toRomWeaverError(error);
  if (normalized.code === "AMBIGUOUS_SELECTION") return true;
  return requests.some((request) => getSelectableCandidateCount(request) !== 1);
};

class ApplyWorkflowController<TSource, TDestination> extends WorkflowController<{ progress: WorkflowProgress }> {
  readonly id: string;
  protected readonly runtime: WorkflowRuntime;
  protected readonly validateSources?: SourceValidator<TSource>;
  private readonly abortController = new AbortController();
  private readonly constructorSignal?: AbortSignal;
  private readonly selectFile?: WorkflowOptions<ApplySettings>["selectFile"];
  private disposed = false;
  private progressSequence = 0;
  private nextCandidateSequence = 0;
  private nextInputSequence = 0;
  private nextPatchSequence = 0;
  private manualOutputName = false;
  private manualOutputFormat = false;
  private outputName = "";
  private outputFormat: CompressionFormat = "7z";
  private settings: Partial<ApplySettings>;
  private inputSession?: InputSession<TSource>;
  private mutationQueue: Promise<void> | null = null;
  private patches: Array<StagedSource<TSource>> = [];
  private inputs: TSource[] = [];

  constructor(
    runtime: WorkflowRuntime,
    options: WorkflowOptions<ApplySettings> = {},
    validateSources?: SourceValidator<TSource>,
  ) {
    super();
    this.runtime = runtime;
    this.validateSources = validateSources;
    this.id = options.id || createWorkflowId();
    this.settings = cloneValue(options.settings || {});
    this.constructorSignal = options.signal;
    this.selectFile = options.selectFile;
    const initialCompression = this.settings.output?.compression;
    if (initialCompression && initialCompression !== "auto" && APPLY_FORMATS.has(initialCompression)) {
      this.manualOutputFormat = true;
      this.outputFormat = initialCompression;
    }
    if (typeof this.settings.output?.outputName === "string") {
      this.manualOutputName = true;
      this.outputName = this.settings.output.outputName;
    }
    if (!this.manualOutputFormat) this.outputFormat = resolveAutomaticFormat(undefined, this.settings);
    if (options.signal?.aborted) this.abortController.abort(options.signal.reason);
    else options.signal?.addEventListener("abort", () => this.abort(options.signal?.reason), { once: true });
  }

  getInput(): ApplyWorkflowInputState | null {
    const session = this.inputSession;
    if (!session) return null;
    const selectedOwner = this.getSelectedInputOwner();
    const resolvedInputs = session.synthetic
      ? session.stages
          .filter((stage) => stage.state.status === "ready")
          .map((stage) => cloneResolvedInputState(stage.state, stage.parentCompressions, stage === selectedOwner))
      : [cloneResolvedInputState(session.view.state, session.view.parentCompressions, true)];
    return cloneInputState(session.view.state, session.view.parentCompressions || [], resolvedInputs);
  }

  getPatches(): ApplyWorkflowPatchState[] {
    return this.patches.map((patch) => clonePatchState(patch.state, patch.parentCompressions));
  }

  async setInput(input: TSource | TSource[]): Promise<void> {
    return this.mutate("setInput", async () => {
      this.trace("input.set.start", {
        inputCount: Array.isArray(input) ? input.length : input ? 1 : 0,
      });
      try {
        this.releaseInputSession();
        this.inputs = [];
        this.validateSources?.(input);
        this.inputs = Array.isArray(input) ? [...input] : [input];
        if (!this.inputs.length) throw new RomWeaverError("INVALID_INPUT", "Input source is required");
        const initial = this.createInitialInputView(this.inputs);
        this.inputSession = {
          sources: this.inputs,
          stages: [],
          synthetic: false,
          view: initial,
        };
        this.trace("input.set.initialized", {
          fileName: initial.state.fileName,
          inputCount: this.inputs.length,
        });
        this.inputSession = await this.stageInputSession(this.inputs);
        this.trace("input.set.staged", {
          selectedCandidateId: this.inputSession.view.state.selectedCandidateId,
          stageCount: this.inputSession.stages.length,
          status: this.inputSession.view.state.status,
          synthetic: this.inputSession.synthetic,
        });
        await this.maybeResolveBlockingInputSelection();
        this.trace("input.set.selection-resolved", {
          selectedCandidateId: this.inputSession.view.state.selectedCandidateId,
          status: this.inputSession.view.state.status,
        });
        await this.finalizeInputStableState();
        this.trace("input.set.finalized", {
          hasChecksums: !!this.inputSession.view.state.checksums,
          status: this.inputSession.view.state.status,
        });
        await this.refreshPatchReadiness();
        this.recomputeOutputState();
        this.trace("input.set.finish", {
          status: this.inputSession.view.state.status,
        });
      } catch (error) {
        this.trace("input.set.fail", {
          error,
        });
        throw error;
      }
    });
  }

  async clearInput(): Promise<void> {
    return this.mutate("clearInput", async () => {
      this.releaseInputSession();
      this.inputs = [];
      this.inputSession = undefined;
      await this.refreshPatchReadiness();
      this.recomputeOutputState();
    });
  }

  async addPatch(patch: TSource): Promise<void> {
    this.assertCanStartOperation();
    try {
      this.validateSources?.(patch);
    } catch (error) {
      throw toRomWeaverError(error);
    }
    const patchIndex = this.patches.length;
    const stage = this.createInitialSource("patch", patch, patchIndex);
    stage.outputLabel = createPatchOutputLabel(stage.state.fileName);
    this.patches.push(stage);
    const stagedPromise = this.stageSource(stage).catch((error) => {
      throw toRomWeaverError(error);
    });
    void stagedPromise.catch(() => undefined);
    return this.mutate("addPatch", async () => {
      try {
        const staged = await stagedPromise;
        await this.maybeResolveBlockingPatchSelection(staged);
        await this.evaluatePatchReadiness(staged);
        this.recomputeOutputState();
      } catch (error) {
        const index = this.patches.indexOf(stage);
        if (index !== -1) this.patches.splice(index, 1);
        releasePreparedSource(stage);
        this.recomputeOutputState();
        throw error;
      }
    });
  }

  async clearPatches(): Promise<void> {
    return this.mutate("clearPatches", async () => {
      this.trace("patches.clear.start", {
        patchCount: this.patches.length,
      });
      for (const patch of this.patches) releasePreparedSource(patch);
      this.patches = [];
      this.recomputeOutputState();
      this.trace("patches.clear.finish");
    });
  }

  async setSettings(settings: Partial<ApplySettings>): Promise<void> {
    return this.mutate("setSettings", async () => {
      this.trace("settings.set.start", {
        hasInputSession: !!this.inputSession,
      });
      this.settings = cloneValue(settings || {});
      const output = this.settings.output || {};
      const initialCompression = output.compression;
      this.manualOutputFormat = !!(
        initialCompression &&
        initialCompression !== "auto" &&
        APPLY_FORMATS.has(initialCompression)
      );
      if (this.manualOutputFormat) {
        this.outputFormat = initialCompression as CompressionFormat;
      } else {
        this.outputFormat = resolveAutomaticFormat(
          this.inputSession as InputSession<unknown> | undefined,
          this.settings,
        );
      }
      this.manualOutputName = typeof output.outputName === "string" && !!output.outputName.trim();
      this.outputName = this.manualOutputName ? output.outputName || "" : "";
      this.preloadRuntimeCapability("compression");
      await this.refreshPatchReadiness();
      this.recomputeOutputState();
      this.trace("settings.set.finish", {
        outputFormat: this.outputFormat,
      });
    });
  }

  async setOutputName(name: string): Promise<void> {
    return this.mutate("setOutputName", async () => {
      const normalizedName = name.trim();
      this.manualOutputName = !!normalizedName;
      if (this.manualOutputName) {
        this.outputName = name;
        this.settings.output = {
          ...(this.settings.output || {}),
          outputName: name,
        };
      } else {
        if (this.settings.output) delete this.settings.output.outputName;
        this.recomputeOutputState();
      }
    });
  }

  async setOutputFormat(format: CompressionFormat): Promise<void> {
    return this.mutate("setOutputFormat", async () => {
      if (!APPLY_FORMATS.has(format))
        throw new RomWeaverError("INVALID_SETTINGS", `Unsupported output format: ${format}`);
      this.manualOutputFormat = true;
      this.outputFormat = format;
      this.settings.output = {
        ...(this.settings.output || {}),
        compression: format,
      };
      this.recomputeOutputState();
    });
  }

  async run(): Promise<ApplyResult<TDestination>> {
    return this.mutate("run", async () => {
      const input = this.inputSession;
      if (!input) throw new RomWeaverError("INVALID_INPUT", "Input source is required");
      await this.finalizeInputStableState();
      await this.refreshPatchReadiness();
      this.recomputeOutputState();
      if (input.view.state.status !== "ready" || !input.view.state.selectedCandidateId)
        throw new RomWeaverError("AMBIGUOUS_SELECTION", "Input selection is required");
      const pendingPatch = this.patches.find((patch) => patch.state.status !== "ready");
      if (pendingPatch) {
        if (!pendingPatch.state.selectedCandidateId)
          throw new RomWeaverError(
            "AMBIGUOUS_SELECTION",
            `${pendingPatch.state.fileName || "Patch"} requires selection`,
          );
        throw new RomWeaverError(
          "AMBIGUOUS_SELECTION",
          pendingPatch.state.warnings.at(-1)?.message || `${pendingPatch.state.fileName || "Patch"} is not ready`,
        );
      }
      const outputName = this.outputName;
      if (!outputName) throw new RomWeaverError("INVALID_SETTINGS", "Output name is required");
      const result = await withAbortSignal(
        runApplyWorkflow(
          this.createPatchInput((progress) => {
            const stage = progress.stage === "output" ? "compress" : "apply";
            const role = progress.stage === "output" ? "output" : "worker";
            this.emitProgress({
              details: {
                ...(isRecord(progress.details) ? progress.details : {}),
              },
              hasProgress: progress.hasProgress,
              id: `${this.id}:${role}:${stage}`,
              label: progress.label || (stage === "compress" ? "Compressing output..." : "Applying patch..."),
              percent:
                typeof progress.percent === "number" && Number.isFinite(progress.percent) ? progress.percent : null,
              role,
              stage,
              workflow: "apply",
            });
          }),
          this.runtime,
          patchWorkflowDeps as never,
        ),
        this.abortController.signal,
      );
      const outputs = result.outputs.map((output, index) =>
        wrapPublicOutput<TDestination>(output, this.runtime, index),
      );
      const publicResult: ApplyResult<TDestination> = {
        inputs: result.inputs,
        output: outputs[0] as ApplyResult<TDestination>["output"],
        outputs,
        patches: result.patches,
        sizeSummary: result.sizeSummary,
      };
      return publicResult;
    });
  }

  abort(reason?: unknown): void {
    if (!this.abortController.signal.aborted) this.abortController.abort(reason);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.abort();
    this.releaseInputSession();
    for (const patch of this.patches) releasePreparedSource(patch);
    this.patches = [];
    this.clearListeners();
    this.disposed = true;
  }

  protected traceTriggerEvent(event: "progress", payload: WorkflowProgress, listenerCount: number): void {
    traceWorkflowControllerEvent(
      {
        logLevel: this.settings.logging?.level,
        onLog: this.settings.logging?.sink,
        workflow: "apply",
        workflowId: this.id,
      },
      "trigger",
      {
        event,
        listenerCount,
        payload,
      },
    );
  }

  private trace(message: string, details: Record<string, unknown> = {}): void {
    traceWorkflowControllerEvent(
      {
        logLevel: this.settings.logging?.level,
        onLog: this.settings.logging?.sink,
        workflow: "apply",
        workflowId: this.id,
      },
      message,
      details,
    );
  }

  private preloadRuntimeCapability(capability: "checksum" | "compression" | "patch"): void {
    const preload = this.runtime.preload?.preloadCapability;
    if (!preload) return;
    this.trace("runtime.preload.start", {
      capability,
      workerThreads: this.settings.workers?.threads,
    });
    void preload(capability, () => undefined, {
      workerThreads: this.settings.workers?.threads,
    })
      .then(() => {
        this.trace("runtime.preload.finish", {
          capability,
        });
      })
      .catch((error) => {
        this.trace("runtime.preload.fail", {
          capability,
          error,
        });
      });
  }

  private emitProgress(event: {
    current?: number;
    details?: Record<string, unknown>;
    hasProgress?: boolean;
    id: string;
    label: string;
    percent?: number | null;
    role: WorkflowProgress["role"];
    stage: WorkflowProgress["stage"];
    total?: number;
    workflow: WorkflowProgress["workflow"];
  }) {
    this.trigger("progress", createWorkflowProgress(++this.progressSequence, event));
  }

  private async mutate<TValue>(_operation: string, callback: () => Promise<TValue>): Promise<TValue> {
    const execute = async () => {
      this.assertCanStartOperation();
      try {
        return await callback();
      } catch (error) {
        throw toRomWeaverError(error);
      }
    };
    const previousMutation = this.mutationQueue;
    const run = previousMutation ? previousMutation.catch(() => undefined).then(execute) : execute();
    const queued = run.then(
      () => undefined,
      () => undefined,
    );
    this.mutationQueue = queued;
    queued.finally(() => {
      if (this.mutationQueue === queued) this.mutationQueue = null;
    });
    return run;
  }

  private assertCanStartOperation(): void {
    if (this.disposed) throw new RomWeaverError("WORKFLOW_DISPOSED", "Workflow has been disposed");
    throwIfAborted(this.abortController.signal);
    throwIfAborted(this.constructorSignal);
  }

  private createInitialSource(
    role: SourceRole,
    source: TSource,
    index: number,
    options: { allowLazyBrowserRomSource?: boolean } = {},
  ): StagedSource<TSource> {
    const fileName = getSourceFileName(source, `${role}-${index + 1}`);
    const sourceSize = getSourceSize(source);
    return {
      allowLazyBrowserRomSource: options.allowLazyBrowserRomSource,
      index,
      internalCandidates: new Map(),
      outputLabel: role === "patch" ? createPatchOutputLabel(fileName) : undefined,
      parentCompressions: [],
      source,
      state: {
        candidates: [],
        fileName,
        id: role === "input" ? `input-${++this.nextInputSequence}` : `patch-${++this.nextPatchSequence}`,
        order: index,
        role,
        size: sourceSize,
        sourceSize,
        status: "loading",
        warnings: [],
      },
    };
  }

  private createInitialInputView(sources: TSource[]): StagedSource<TSource> {
    return this.createInitialSource("input", sources[0] as TSource, 0);
  }

  private async stageInputSession(sources: TSource[]): Promise<InputSession<TSource>> {
    this.trace("input.session.stage.start", {
      sourceCount: sources.length,
    });
    if (sources.length === 1) {
      this.trace("input.session.stage.single.start", {
        fileName: getSourceFileName(sources[0] as never, "Input 1"),
        size: getSourceSize(sources[0] as never),
      });
      const view = await this.stageSource(
        this.createInitialSource("input", sources[0] as TSource, 0, {
          allowLazyBrowserRomSource: true,
        }),
      );
      this.trace("input.session.stage.single.finish", {
        candidateCount: view.state.candidates.length,
        fileName: view.state.fileName,
        status: view.state.status,
      });
      return {
        sources,
        stages: [view],
        synthetic: false,
        view,
      };
    }
    const requests: CandidateSelectionRequest[] = [];
    const directAssets = await prepareMultipleDirectInputAssets(
      sources as never,
      {
        ...this.createExecutionOptions(),
        onCandidatesFound: (request: CandidateSelectionRequest) => requests.push(request),
      } as never,
    );
    this.trace("input.session.stage.multi.direct-assets", {
      found: !!directAssets,
      requestCount: requests.length,
      sourceCount: sources.length,
    });
    if (directAssets) {
      const view = this.createInitialSource("input", sources[0] as TSource, 0);
      view.preparedInputAssets = directAssets;
      view.state.status = "ready";
      view.state.id = "input-session";
      view.state.fileName = directAssets[0]?.fileName || view.state.fileName;
      view.state.size = directAssets.reduce((total, asset) => total + asset.size, 0);
      view.state.sourceSize = sources.reduce((total, source) => total + (getBinarySourceSize(source as never) || 0), 0);
      const metrics = getInputPreparationMetrics(directAssets);
      view.parentCompressions = this.normalizeParentCompressions(metrics?.parentCompressions);
      for (const request of requests) this.addCandidateRequest(view, request);
      if (!view.state.candidates.length) this.addDirectCandidate(view, "input", 0, view.state.id);
      const selectable = view.state.candidates.filter((candidate) => candidate.selectable);
      if (selectable.length === 1) view.state.selectedCandidateId = selectable[0]?.id;
      else view.state.status = "needsSelection";
      if (view.state.status === "ready") this.applyPreparedInputMetadata(view);
      this.trace("input.session.stage.multi.direct-finish", {
        assetCount: directAssets.length,
        candidateCount: view.state.candidates.length,
        status: view.state.status,
      });
      return { sources, stages: [view], synthetic: false, view };
    }
    const stages: Array<StagedSource<TSource>> = [];
    for (let index = 0; index < sources.length; index += 1) {
      this.trace("input.session.stage.multi.source", {
        index,
        sourceCount: sources.length,
      });
      stages.push(await this.stageSource(this.createInitialSource("input", sources[index] as TSource, index)));
    }
    this.trace("input.session.stage.multi.synthetic-finish", {
      stageCount: stages.length,
    });
    return this.buildSyntheticInputSession(sources, stages);
  }

  private buildSyntheticInputSession(sources: TSource[], stages: Array<StagedSource<TSource>>): InputSession<TSource> {
    const view = this.createInitialSource("input", sources[0] as TSource, 0);
    view.state.id = "input-session";
    view.state.candidates = stages.flatMap((stage) => stage.state.candidates.map(cloneCandidate));
    view.internalCandidates = new Map();
    for (const stage of stages) {
      for (const [id, candidate] of stage.internalCandidates) {
        view.internalCandidates.set(id, {
          ...candidate,
          owner: stage,
        });
      }
    }
    view.preparedInputAssets = stages.flatMap((stage) => stage.preparedInputAssets || []);
    view.state.sourceSize = stages.reduce((total, stage) => total + (stage.state.sourceSize || 0), 0) || undefined;
    const selectable = view.state.candidates.filter((candidate) => candidate.selectable);
    if (selectable.length === 1) {
      view.state.selectedCandidateId = selectable[0]?.id;
      view.state.status = "ready";
    } else {
      view.state.status = "needsSelection";
    }
    const session = { sources, stages, synthetic: true, view };
    this.inputSession = session;
    this.syncInputSessionView();
    return session;
  }

  private async stageSource(stage: StagedSource<TSource>): Promise<StagedSource<TSource>> {
    this.trace("source.stage.start", {
      allowLazyBrowserRomSource: !!stage.allowLazyBrowserRomSource,
      fileName: stage.state.fileName,
      order: stage.state.order,
      role: stage.state.role,
      sourceSize: stage.state.sourceSize,
    });
    const requests: CandidateSelectionRequest[] = [];
    const options = {
      ...this.createExecutionOptions(),
      onCandidatesFound: (request: CandidateSelectionRequest) => requests.push(request),
      onProgress: (progress: {
        current?: number;
        details?: unknown;
        hasProgress?: boolean;
        label?: string;
        message?: string;
        percent?: number | null;
        total?: number;
      }) => {
        const progressStage = getPreparationProgressStage(progress, stage.state.role);
        this.emitProgress({
          current: progress.current,
          details: {
            ...(isRecord(progress.details) ? progress.details : {}),
            fileName: stage.state.fileName,
            order: stage.state.order,
            sourceId: stage.state.id,
          },
          hasProgress: progress.hasProgress,
          id: `${this.id}:${stage.state.id}:${progressStage}`,
          label: progress.label || progress.message || "Preparing input...",
          percent: typeof progress.percent === "number" && Number.isFinite(progress.percent) ? progress.percent : null,
          role: stage.state.role,
          stage: progressStage,
          total: progress.total,
          workflow: "apply",
        });
      },
    } satisfies Partial<ApplyWorkflowOptions>;
    try {
      if (stage.state.role === "input") {
        this.trace("source.stage.prepare-input-assets.start", {
          fileName: stage.state.fileName,
          order: stage.state.order,
        });
        stage.preparedInputAssets = await prepareInputAssets(
          stage.source as never,
          options as never,
          stage.index,
          this.runtime,
          undefined,
          { allowLazyBrowserRomSource: !!stage.allowLazyBrowserRomSource },
        );
        this.trace("source.stage.prepare-input-assets.finish", {
          assetCount: stage.preparedInputAssets.length,
          fileName: stage.state.fileName,
          order: stage.state.order,
        });
      } else {
        this.trace("source.stage.prepare-patch.start", {
          fileName: stage.state.fileName,
          order: stage.state.order,
        });
        const prepared = await prepareInputFile(
          stage.source as never,
          "patch",
          options as never,
          this.runtime,
          undefined,
          stage.index,
        );
        stage.preparedPatchFile = prepared.file;
        this.applyPreparedPatchMetadata(stage, prepared);
        this.trace("source.stage.prepare-patch.finish", {
          fileName: stage.state.fileName,
          order: stage.state.order,
          preparedFileName: prepared.file.fileName,
        });
      }
    } catch (error) {
      this.trace("source.stage.prepare.fail", {
        error,
        fileName: stage.state.fileName,
        order: stage.state.order,
        requestCount: requests.length,
        role: stage.state.role,
      });
      if (requests.length && !canRecoverWithCandidateSelection(error, requests)) throw error;
      if (!requests.length) this.pushWarning(stage, toRomWeaverError(error));
    }
    if (stage.state.role === "input" && stage.preparedInputAssets?.filter((asset) => asset.patchable).length === 1)
      requests.length = 0;
    for (const request of requests) this.addCandidateRequest(stage, request);
    if (!stage.state.candidates.length)
      this.addDirectCandidate(
        stage,
        stage.state.role,
        stage.index,
        stage.state.role === "patch" ? stage.state.id : stage.state.id,
      );
    const selectable = stage.state.candidates.filter((candidate) => candidate.selectable);
    if (selectable.length === 1) {
      stage.state.selectedCandidateId = selectable[0]?.id;
      stage.selectedArchiveEntry = stage.internalCandidates.get(selectable[0]?.id || "")?.archiveEntry;
      this.trace("source.stage.prepare-selected.start", {
        fileName: stage.state.fileName,
        order: stage.state.order,
        selectedCandidateId: stage.state.selectedCandidateId,
      });
      await this.prepareSelectedSource(stage);
      this.trace("source.stage.prepare-selected.finish", {
        fileName: stage.state.fileName,
        order: stage.state.order,
        status: stage.state.status,
      });
      if (stage.state.role === "patch") await this.parsePatch(stage);
    } else {
      stage.state.status = "needsSelection";
      if (stage.state.role === "input") await this.maybeResolveBlockingInputSelection();
      else await this.maybeResolveBlockingPatchSelection(stage);
    }
    this.trace("source.stage.finish", {
      candidateCount: stage.state.candidates.length,
      fileName: stage.state.fileName,
      order: stage.state.order,
      role: stage.state.role,
      status: stage.state.status,
      warningCount: stage.state.warnings.length,
    });
    return stage;
  }

  private async prepareSelectedSource(stage: StagedSource<TSource>): Promise<void> {
    this.trace("source.prepare-selected.enter", {
      candidateId: stage.state.selectedCandidateId,
      fileName: stage.state.fileName,
      order: stage.state.order,
      role: stage.state.role,
    });
    const requests: CandidateSelectionRequest[] = [];
    const options = {
      ...this.createExecutionOptions(),
      onCandidatesFound: (request: CandidateSelectionRequest) => requests.push(request),
      onProgress: (progress: {
        current?: number;
        details?: unknown;
        hasProgress?: boolean;
        label?: string;
        message?: string;
        percent?: number | null;
        total?: number;
      }) => {
        const progressStage = getPreparationProgressStage(progress, stage.state.role);
        this.emitProgress({
          current: progress.current,
          details: {
            ...(isRecord(progress.details) ? progress.details : {}),
            fileName: stage.state.fileName,
            order: stage.state.order,
            sourceId: stage.state.id,
          },
          hasProgress: progress.hasProgress,
          id: `${this.id}:${stage.state.id}:${progressStage}`,
          label: progress.label || progress.message || "Preparing input...",
          percent: typeof progress.percent === "number" && Number.isFinite(progress.percent) ? progress.percent : null,
          role: stage.state.role,
          stage: progressStage,
          total: progress.total,
          workflow: "apply",
        });
      },
    } satisfies Partial<ApplyWorkflowOptions>;
    try {
      if (stage.state.role === "input") {
        const cachedFile = stage.preparedInputAssets?.[0]?.file;
        this.trace("source.prepare-selected.input.start", {
          cachedFile: !!cachedFile,
          fileName: stage.state.fileName,
          order: stage.state.order,
          selectedArchiveEntry: stage.selectedArchiveEntry,
        });
        const file =
          cachedFile ||
          (await (async () => {
            stage.preparedInputAssets = await prepareInputAssets(
              stage.source as never,
              options as never,
              stage.index,
              this.runtime,
              stage.selectedArchiveEntry,
              { allowLazyBrowserRomSource: !!stage.allowLazyBrowserRomSource },
            );
            return stage.preparedInputAssets[0]?.file;
          })());
        if (!file && requests.length) return this.handleSourceSelectionRequests(stage, requests);
        this.applyPreparedInputMetadata(stage);
        stage.state.status = "ready";
        this.trace("source.prepare-selected.input.finish", {
          fileName: stage.state.fileName,
          order: stage.state.order,
          preparedFileName: file?.fileName,
          status: stage.state.status,
        });
        return;
      }
      const prepared = stage.preparedPatchFile
        ? {
            decompressionTimeMs: stage.state.decompressionTimeMs || 0,
            file: stage.preparedPatchFile,
            parentCompressions: stage.parentCompressions,
            sourceSize: stage.state.sourceSize || stage.preparedPatchFile.fileSize,
            wasDecompressed: stage.state.wasDecompressed === true,
          }
        : await prepareInputFile(
            stage.source as never,
            "patch",
            options as never,
            this.runtime,
            stage.selectedArchiveEntry,
            stage.index,
          );
      stage.preparedPatchFile = prepared.file;
      this.applyPreparedPatchMetadata(stage, prepared);
      stage.outputLabel = stage.outputLabel || createPatchOutputLabel(prepared.file.fileName);
      if (stage.outputLabel)
        (
          stage.preparedPatchFile as PatchFileInstance & {
            _generatedPatchName?: string;
          }
        )._generatedPatchName = stage.outputLabel;
      stage.state.status = "ready";
    } catch (error) {
      if (requests.length && !canRecoverWithCandidateSelection(error, requests)) throw error;
      if (requests.length) {
        this.handleSourceSelectionRequests(stage, requests);
        if (stage.state.role === "input") await this.maybeResolveBlockingInputSelection();
        else await this.maybeResolveBlockingPatchSelection(stage);
        return;
      }
      throw error;
    }
  }

  private handleSourceSelectionRequests(stage: StagedSource<TSource>, requests: CandidateSelectionRequest[]) {
    stage.internalCandidates.clear();
    stage.state.candidates = [];
    for (const request of requests) this.addCandidateRequest(stage, request);
    stage.state.checksums = undefined;
    stage.state.checksumTimeMs = undefined;
    stage.state.decompressionTimeMs = undefined;
    stage.state.selectedCandidateId = undefined;
    stage.state.targetInputId = undefined;
    stage.state.targetInputFileName = undefined;
    stage.state.status = "needsSelection";
    stage.state.wasDecompressed = undefined;
    stage.parentCompressions = [];
    releasePreparedSource(stage);
  }

  private createSelectionRequest(state: InternalSourceState): CandidateSelectionRequest {
    return {
      candidates: state.candidates.map(cloneCandidate),
      role: state.role,
      sourceName: state.fileName || state.id,
      warnings: state.warnings.map((warning) => warning.message),
    };
  }

  private async maybeResolveBlockingInputSelection(): Promise<boolean> {
    const session = this.inputSession;
    if (!(session && session.view.state.status === "needsSelection" && !session.view.state.selectedCandidateId))
      return false;
    const selection = await this.resolveSelectionRequest(
      this.createSelectionRequest(session.view.state),
      this.selectFile,
    );
    if (!selection) return false;
    const owner = session.view.internalCandidates.get(selection.id)?.owner || session.view;
    if (!owner.internalCandidates.has(selection.id))
      throw new RomWeaverError("SELECTION_NOT_FOUND", `Selection candidate was not found: ${selection.id}`);
    releasePreparedSource(owner);
    owner.state.selectedCandidateId = selection.id;
    owner.selectedArchiveEntry = owner.internalCandidates.get(selection.id)?.archiveEntry;
    owner.state.checksums = undefined;
    owner.state.checksumTimeMs = undefined;
    await this.prepareSelectedSource(owner);
    this.syncInputSessionView();
    if (session.view.state.status === "needsSelection" && !session.view.state.selectedCandidateId)
      return this.maybeResolveBlockingInputSelection();
    return true;
  }

  private async maybeResolveBlockingPatchSelection(stage: StagedSource<TSource>): Promise<boolean> {
    if (!(stage.state.status === "needsSelection" && !stage.state.selectedCandidateId && stage.state.candidates.length))
      return false;
    const selection = await this.resolveSelectionRequest(this.createSelectionRequest(stage.state), this.selectFile);
    if (!selection) return false;
    if (!stage.internalCandidates.has(selection.id))
      throw new RomWeaverError("SELECTION_NOT_FOUND", `Selection candidate was not found: ${selection.id}`);
    releasePreparedSource(stage);
    stage.state.selectedCandidateId = selection.id;
    stage.selectedArchiveEntry = stage.internalCandidates.get(selection.id)?.archiveEntry;
    await this.prepareSelectedSource(stage);
    return true;
  }

  private applyPreparedInputMetadata(stage: StagedSource<TSource>) {
    const assets = stage.preparedInputAssets || [];
    const preparation = getInputPreparationMetrics(assets);
    stage.parentCompressions = this.normalizeParentCompressions(preparation?.parentCompressions);
    stage.state.fileName = getPreparedAssetFileName(assets[0], stage.state.fileName || stage.state.id);
    stage.state.size = assets.reduce((total, asset) => total + asset.size, 0) || stage.state.size;
    stage.state.sourceSize =
      (typeof preparation?.sourceSize === "number" && Number.isFinite(preparation.sourceSize)
        ? preparation.sourceSize
        : stage.state.sourceSize) || stage.state.size;
    stage.state.decompressionTimeMs =
      typeof preparation?.decompressionTimeMs === "number" && Number.isFinite(preparation.decompressionTimeMs)
        ? preparation.decompressionTimeMs
        : undefined;
    stage.state.wasDecompressed = preparation?.wasDecompressed === true;
    if (assets.length === 1 && !stage.state.checksums) {
      const precomputed = getPatchFilePrecomputedChecksums(assets[0]?.file);
      if (precomputed) {
        stage.state.checksums = precomputed;
        stage.state.checksumTimeMs = 0;
      }
    }
  }

  private applyPreparedPatchMetadata(
    stage: StagedSource<TSource>,
    prepared: Awaited<ReturnType<typeof prepareInputFile>>,
  ) {
    stage.parentCompressions = this.normalizeParentCompressions(prepared.parentCompressions);
    stage.state.fileName = getBaseFileName(prepared.file.fileName || stage.state.fileName || stage.state.id);
    stage.state.size = prepared.file.fileSize;
    stage.state.sourceSize = prepared.sourceSize || prepared.file.fileSize;
    stage.state.decompressionTimeMs = prepared.wasDecompressed ? prepared.decompressionTimeMs : undefined;
    stage.state.wasDecompressed = prepared.wasDecompressed;
  }

  private normalizeParentCompressions(
    parentCompressions: InputParentCompression[] | undefined,
  ): ApplyWorkflowParentCompression[] {
    return (parentCompressions || []).map((entry) => ({
      decompressionTimeMs: entry.decompressionTimeMs,
      depth: entry.depth,
      fileName: entry.fileName,
      kind: entry.kind,
      outputSize: entry.outputSize,
      sourceSize: entry.sourceSize,
    }));
  }

  private async parsePatch(stage: StagedSource<TSource>): Promise<void> {
    const patchFile = stage.preparedPatchFile;
    if (!patchFile) {
      stage.state.status = "needsSelection";
      return;
    }
    const parsed = await patchWorkflowDeps.parsePatchForApply(patchFile, this.runtime);
    if (!parsed)
      throw new RomWeaverError("INVALID_INPUT", `Invalid patch file: ${patchFile.fileName || stage.state.fileName}`);
    stage.parsedPatch = parsed;
  }

  private addCandidateRequest(stage: StagedSource<TSource>, request: CandidateSelectionRequest) {
    const publicIdByCandidateId = new Map(
      request.candidates.map((candidate) => [
        candidate.id,
        `${this.id}:${stage.state.role}:${++this.nextCandidateSequence}`,
      ]),
    );
    const candidates = request.candidates.map((candidate) => {
      const publicId = publicIdByCandidateId.get(candidate.id) as string;
      const publicCandidate = cloneCandidate(candidate);
      const internal = {
        archiveEntry: candidate.selectable ? selectionToArchiveEntry(request, { id: candidate.id }) : undefined,
        candidate,
        owner: stage,
        request,
      } satisfies InternalCandidate<TSource>;
      stage.internalCandidates.set(publicId, internal);
      return {
        ...publicCandidate,
        id: publicId,
        ...(publicCandidate.type === "group"
          ? {
              candidateIds: (publicCandidate.candidateIds || []).map(
                (candidateId) => publicIdByCandidateId.get(candidateId) || candidateId,
              ),
            }
          : {
              ...(publicCandidate.parentCandidateId
                ? {
                    parentCandidateId: publicIdByCandidateId.get(publicCandidate.parentCandidateId),
                  }
                : {}),
            }),
      } as SelectionCandidate;
    });
    stage.state.candidates = candidates;
  }

  private addDirectCandidate(stage: StagedSource<TSource>, role: SourceRole, index: number, internalId: string) {
    const publicId = `${this.id}:${role}:${++this.nextCandidateSequence}`;
    const candidate: SelectionCandidate = {
      fileName: stage.state.fileName || `${role}-${index + 1}`,
      id: publicId,
      kind: role === "patch" ? "patch" : "rom",
      patchable: role === "input",
      selectable: true,
      size: stage.state.size,
      type: "file",
    };
    stage.state.candidates = [candidate];
    stage.internalCandidates.set(publicId, {
      candidate: { ...candidate, id: internalId },
      owner: stage,
    });
  }

  private syncInputSessionView() {
    const session = this.inputSession;
    if (!session?.synthetic) return;
    const view = session.view;
    const selectedOwner = this.getSelectedInputOwner();
    view.preparedInputAssets = session.stages.flatMap((stage) => stage.preparedInputAssets || []);
    view.state.selectedCandidateId =
      selectedOwner?.state.selectedCandidateId ||
      (view.state.candidates.filter((candidate) => candidate.selectable).length === 1
        ? view.state.candidates.find((candidate) => candidate.selectable)?.id
        : undefined);
    view.state.status = view.state.selectedCandidateId ? "ready" : "needsSelection";
    view.state.fileName = selectedOwner?.state.fileName || session.stages[0]?.state.fileName;
    view.state.checksums = selectedOwner?.state.checksums;
    view.state.checksumTimeMs = selectedOwner?.state.checksumTimeMs;
    view.state.size =
      selectedOwner?.state.size ||
      view.preparedInputAssets?.reduce((total, asset) => total + asset.size, 0) ||
      undefined;
    view.state.sourceSize =
      selectedOwner?.state.sourceSize ||
      session.stages.reduce((total, stage) => total + (stage.state.sourceSize || 0), 0) ||
      undefined;
    view.state.decompressionTimeMs = selectedOwner?.state.decompressionTimeMs;
    view.state.wasDecompressed = selectedOwner?.state.wasDecompressed;
    view.parentCompressions = selectedOwner?.parentCompressions || [];
  }

  private getSelectedInputOwner(): StagedSource<TSource> | undefined {
    const session = this.inputSession;
    if (!session) return undefined;
    if (!session.synthetic) return session.view;
    const selectedId = session.view.state.selectedCandidateId;
    if (!selectedId) return undefined;
    return session.view.internalCandidates.get(selectedId)?.owner;
  }

  private async finalizeInputStableState(): Promise<boolean> {
    const session = this.inputSession;
    const selected = this.getSelectedInputOwner();
    if (!session) return false;
    const checksumStages = session.synthetic ? session.stages : [selected];
    for (let index = 0; index < checksumStages.length; index += 1) {
      const stage = checksumStages[index];
      if (!(stage && stage.state.status === "ready" && stage.preparedInputAssets?.[0]?.file)) continue;
      if (!stage.state.checksums) {
        const precomputed = getPatchFilePrecomputedChecksums(stage.preparedInputAssets[0].file);
        if (precomputed) {
          stage.state.checksums = precomputed;
          stage.state.checksumTimeMs = 0;
          continue;
        }
        const checksumFileName = getPreparedAssetFileName(stage.preparedInputAssets[0], stage.state.fileName);
        const checksumStartedAt = Date.now();
        stage.state.checksums = await this.calculateChecksumsForFile(
          stage.preparedInputAssets[0].file,
          {
            ...stage.state,
            fileName: checksumFileName,
            parentCompressions: stage.parentCompressions,
          },
          "input",
          session.synthetic ? `${stage.state.id}:${index}` : stage.state.id,
        );
        stage.state.checksumTimeMs = Date.now() - checksumStartedAt;
      }
    }
    if (session.synthetic) this.syncInputSessionView();
    return !!(selected && session.view.state.status === "ready" && selected.preparedInputAssets?.[0]?.file);
  }

  private async calculateChecksumsForFile(
    file: PatchFileInstance,
    state: Pick<InternalSourceState, "fileName" | "id"> & {
      decompressionTimeMs?: number;
      order?: number;
      parentCompressions?: ApplyWorkflowParentCompression[];
      size?: number;
      sourceSize?: number;
      wasDecompressed?: boolean;
    },
    role: WorkflowProgress["role"],
    progressId = state.id,
  ): Promise<ApplyWorkflowChecksums> {
    if (!this.runtime.checksum.calculate) return {};
    const progressDetails = {
      decompressionTimeMs: state.decompressionTimeMs,
      fileName: state.fileName,
      order: state.order,
      parentCompressions: state.parentCompressions?.map((entry) => ({
        ...entry,
      })),
      size: state.size,
      sourceId: state.id,
      sourceSize: state.sourceSize,
      wasDecompressed: state.wasDecompressed,
    };
    this.emitProgress({
      details: progressDetails,
      id: `${this.id}:${progressId}:checksum`,
      label: "Calculating checksums...",
      percent: null,
      role,
      stage: "checksum",
      workflow: "apply",
    });
    const result = await this.runtime.checksum.calculate({
      algorithms: [...DEFAULT_CHECKSUMS],
      logLevel: this.settings.logging?.level,
      onLog: this.settings.logging?.sink,
      onProgress: (progress) =>
        this.emitProgress({
          details: progressDetails,
          id: `${this.id}:${progressId}:checksum`,
          label: String(progress.label || progress.message || "Calculating checksums..."),
          percent: typeof progress.percent === "number" && Number.isFinite(progress.percent) ? progress.percent : null,
          role,
          stage: "checksum",
          workflow: "apply",
        }),
      source: createChecksumSource(file, state.fileName) as never,
    });
    return {
      crc32: Number(result.crc32 || 0)
        .toString(16)
        .padStart(8, "0"),
      md5: result.md5 || "",
      sha1: result.sha1 || "",
    };
  }

  private getPreparedInputAssets(): InputAsset[] {
    return this.inputSession?.view.preparedInputAssets ? [...this.inputSession.view.preparedInputAssets] : [];
  }

  private getPatchableInputAssets(): InputAsset[] {
    return this.getPreparedInputAssets().filter((asset) => asset.patchable);
  }

  private clearPatchTarget(stage: StagedSource<TSource>) {
    stage.state.targetInputId = undefined;
    stage.state.targetInputFileName = undefined;
  }

  private assignPatchTarget(stage: StagedSource<TSource>, target: InputAsset) {
    stage.state.targetInputId = target.id;
    stage.state.targetInputFileName = target.fileName;
  }

  private createPatchTargetSelectionRequest(stage: StagedSource<TSource>, assets: InputAsset[]) {
    const inputByCandidateId = new Map<string, InputAsset>();
    const candidates = assets.map((asset) => {
      const id = `${this.id}:patch-target:${++this.nextCandidateSequence}`;
      inputByCandidateId.set(id, asset);
      return {
        fileName: asset.fileName,
        id,
        kind: asset.kind,
        patchable: true,
        selectable: true,
        size: asset.size,
        type: "file",
      } satisfies SelectionCandidate;
    });
    const request: CandidateSelectionRequest = {
      candidates,
      role: "patch",
      sourceIndex: stage.index,
      sourceName: stage.state.fileName || stage.state.id,
      warnings: stage.state.warnings.map((warning) => warning.message),
    };
    return { inputByCandidateId, request };
  }

  private async resolvePatchTargetForStage(
    stage: StagedSource<TSource>,
    assets: InputAsset[],
  ): Promise<InputAsset | null> {
    if (!assets.length) {
      this.clearPatchTarget(stage);
      return null;
    }
    if (assets.length === 1) {
      const [target] = assets;
      if (!target) return null;
      this.assignPatchTarget(stage, target);
      return target;
    }
    if (stage.state.targetInputId) {
      const existing = assets.find(
        (asset) => asset.id === stage.state.targetInputId || asset.fileName === stage.state.targetInputId,
      );
      if (existing) {
        this.assignPatchTarget(stage, existing);
        return existing;
      }
    }
    const { inputByCandidateId, request } = this.createPatchTargetSelectionRequest(stage, assets);
    const selection = await this.resolveSelectionRequest(request, this.selectFile);
    if (!selection) {
      this.clearPatchTarget(stage);
      return null;
    }
    const target = inputByCandidateId.get(selection.id);
    if (!target)
      throw new RomWeaverError("SELECTION_NOT_FOUND", `Patch target candidate was not found: ${selection.id}`);
    this.assignPatchTarget(stage, target);
    return target;
  }

  private async evaluatePatchReadiness(stage: StagedSource<TSource>): Promise<boolean> {
    const previousStatus = stage.state.status;
    stage.state.warnings = stage.state.warnings.filter(
      (warning) => !PATCH_TARGET_SELECTION_ERROR_CODES.has(String(warning.code || "")),
    );
    if (stage.state.status === "loading" && !stage.preparedPatchFile && !stage.state.candidates.length) return false;
    if (!stage.state.selectedCandidateId) {
      this.clearPatchTarget(stage);
      stage.state.status = "needsSelection";
      return previousStatus !== stage.state.status;
    }
    if (!stage.preparedPatchFile) await this.prepareSelectedSource(stage);
    if (!stage.parsedPatch) await this.parsePatch(stage);
    const assets = this.getPatchableInputAssets();
    if (!(assets.length && stage.parsedPatch)) {
      this.clearPatchTarget(stage);
      stage.state.status = "needsSelection";
      return previousStatus !== stage.state.status;
    }
    try {
      const target = await this.resolvePatchTargetForStage(stage, assets);
      stage.state.status = target ? "ready" : "needsSelection";
      if (!target) {
        this.pushWarning(
          stage,
          new RomWeaverError("AMBIGUOUS_SELECTION", `${stage.state.fileName || "Patch"} target selection is required`),
        );
      }
    } catch (error) {
      const normalized = toRomWeaverError(error);
      if (normalized.code === "AMBIGUOUS_SELECTION" || normalized.code === "PATCH_TARGET_MISMATCH") {
        this.clearPatchTarget(stage);
        stage.state.status = "needsSelection";
        this.pushWarning(stage, normalized);
      } else {
        throw normalized;
      }
    }
    return previousStatus !== stage.state.status;
  }

  private async refreshPatchReadiness() {
    for (const patch of this.patches) await this.evaluatePatchReadiness(patch);
  }

  private recomputeOutputState() {
    if (!this.manualOutputFormat)
      this.outputFormat = resolveAutomaticFormat(this.inputSession as InputSession<unknown> | undefined, this.settings);
    if (!this.manualOutputName) this.outputName = this.buildAutomaticOutputName();
  }

  private buildAutomaticOutputName() {
    const input = this.getInput();
    if (!input?.fileName) return this.outputName;
    const inputName = input.fileName;
    const inputBase = getFileNameWithoutExtension(inputName) || "patched";
    const patchNames = this.patches
      .map((patch, index) => getFileNameWithoutExtension(this.resolvePatchOutputName(patch, index)))
      .filter(Boolean);
    const outputBase = patchNames.length ? `${inputBase} - ${patchNames.join(" + ")}` : inputBase;
    return outputBase;
  }

  private resolvePatchOutputName(patch: StagedSource<TSource>, index: number): string {
    if (patch.outputLabel) return patch.outputLabel;
    if (patch.state.selectedCandidateId) {
      const selectedCandidate = patch.state.candidates.find(
        (candidate) => candidate.id === patch.state.selectedCandidateId,
      );
      if (selectedCandidate?.type === "file" && selectedCandidate.fileName) return selectedCandidate.fileName;
    }
    if (patch.state.status === "needsSelection" && !patch.state.selectedCandidateId) {
      const selectableGroups = patch.state.candidates.filter(
        (candidate) => candidate.type === "group" && candidate.selectable,
      );
      const selectableGroupIds = new Set(selectableGroups.map((candidate) => candidate.id));
      const selectablePatches = patch.state.candidates.filter(
        (candidate): candidate is SelectionFileCandidate =>
          candidate.type === "file" &&
          candidate.kind === "patch" &&
          candidate.selectable &&
          !selectableGroupIds.has(candidate.parentCandidateId || ""),
      );
      if (selectablePatches.length === 1 && selectablePatches[0]?.fileName) return selectablePatches[0].fileName;
    }
    return patch.state.fileName || `patch ${index + 1}`;
  }

  private getExecutionOutputName() {
    const outputName = this.outputName || this.settings.output?.outputName || "";
    if (this.manualOutputName || !outputName) return outputName;
    if (this.outputFormat === "none") {
      const extension = getCompressionExtension(this.outputFormat, this.getInput()?.fileName, this.settings);
      return extension ? appendFileNameExtension(outputName, extension) : outputName;
    }
    const outputExtension = stripFileNameQuery(outputName).match(FILE_EXTENSION_REGEX)?.[1]?.toLowerCase();
    const compressionExtension = getCompressionExtension(
      this.outputFormat,
      this.getInput()?.fileName,
      this.settings,
    ).toLowerCase();
    if (outputExtension && compressionExtension && outputExtension === compressionExtension) {
      return getFileNameWithoutExtension(outputName) || outputName;
    }
    return outputName;
  }

  private createExecutionOptions(onProgress?: ApplyWorkflowOptions["onProgress"]): ApplyWorkflowOptions {
    const output = this.settings.output || {};
    return {
      compatibility: cloneValue(this.settings.compatibility || {}),
      input: cloneValue(this.settings.input || {}),
      limits: cloneValue(this.settings.limits || {}),
      logging: cloneValue(this.settings.logging || {}),
      onLog: this.settings.logging?.sink,
      onProgress,
      output: {
        ...cloneValue(output),
        compression: this.outputFormat,
        outputName: this.getExecutionOutputName() || output.outputName,
      },
      validation: cloneValue(this.settings.validation || {}),
      workers: cloneValue(this.settings.workers || {}),
    };
  }

  private createPatchInput(onProgress?: ApplyWorkflowOptions["onProgress"]): PatchInput {
    return {
      inputs: this.inputs as never,
      options: this.createExecutionOptions(onProgress),
      parsedPatches: this.patches.map((patch) => patch.parsedPatch).filter(Boolean) as ParsedPatchLike[],
      patches: this.patches.map((patch) => patch.source) as never,
      patchTargets: this.patches.map((patch) => patch.state.targetInputId || "auto"),
      preparedInputAssets: this.getPreparedInputAssets(),
      preparedPatchFiles: this.patches.map((patch) => patch.preparedPatchFile).filter(Boolean) as PatchFileInstance[],
    };
  }

  private pushWarning(
    stage: StagedSource<TSource>,
    error: Error & { code?: string; details?: Record<string, unknown> },
  ) {
    const warning: WorkflowWarning = {
      code: error.code,
      details: error.details,
      message: error.message,
      role: stage.state.role,
    };
    stage.state.warnings.push(warning);
  }

  private releaseInputSession() {
    if (!this.inputSession) return;
    for (const stage of this.inputSession.stages) releasePreparedSource(stage);
    if (!this.inputSession.stages.includes(this.inputSession.view)) releasePreparedSource(this.inputSession.view);
    this.inputSession = undefined;
  }
}

export type { ApplyWorkflowInputState, ApplyWorkflowPatchState };
export { ApplyWorkflowController };
