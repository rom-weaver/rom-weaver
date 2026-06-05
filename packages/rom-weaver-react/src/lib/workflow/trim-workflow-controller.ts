import type { ChecksumRomProbe } from "../../types/checksum.ts";
import type { WorkflowProgress } from "../../types/progress.ts";
import type { SelectedInputInfo, TrimResult } from "../../types/public.ts";
import type { SelectionCandidate } from "../../types/selection.ts";
import type { CompressionFormat, CreateSettings } from "../../types/settings.ts";
import type {
  TrimWorkflowChecksums,
  TrimWorkflowParentCompression,
  TrimWorkflowSourceState,
} from "../../types/trim-workflow.ts";
import type { WorkflowOptions, WorkflowWarning } from "../../types/workflow-controller.ts";
import type { CreateWorkflowOptions, TrimInput } from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { getCompressionOutputExtension, isCompressionFormat } from "../compression/container-format-registry.ts";
import { RomWeaverError, throwIfAborted, withAbortSignal } from "../errors.ts";
import { getFileNameWithoutExtension } from "../input/path-utils.ts";
import { wrapPublicOutput } from "../output/index.ts";
import { runTrimWorkflow, trimWorkflowDeps } from "../trim/workflow.ts";
import {
  cloneCandidate,
  cloneValue,
  cloneWarning,
  createWorkflowId,
  createWorkflowProgress,
  getPreparationProgressStage,
  isRecord,
} from "./controller-utils.ts";
import { type SharedRomStagedSource, StagedRomSourceController } from "./staged-rom-source.ts";
import { WorkflowController } from "./workflow-controller.ts";
import { traceWorkflowControllerEvent } from "./workflow-tracing.ts";

type SourceValidator<TSource> = (sources: TSource | TSource[] | undefined) => void;
type SourceStatus = TrimWorkflowSourceState["status"];
type SourceRole = "input";
type InternalSourceState = {
  id: string;
  fileName?: string;
  status: SourceStatus;
  candidates: SelectionCandidate[];
  selectedCandidateId?: string;
  size?: number;
  sourceSize?: number;
  checksums?: TrimWorkflowChecksums;
  checksumTimeMs?: number;
  decompressionTimeMs?: number;
  parentCompressions: TrimWorkflowParentCompression[];
  romProbe?: ChecksumRomProbe;
  wasDecompressed?: boolean;
  warnings: WorkflowWarning[];
  role: SourceRole;
};
type StagedSource<TSource> = SharedRomStagedSource<TSource, InternalSourceState>;

const TRIM_INPUT_ROLE: SourceRole = "input";
const FILE_EXTENSION_REGEX = /\.[^./\\]+$/;

const cloneSourceState = (state: InternalSourceState | null | undefined) =>
  state
    ? ({
        candidates: state.candidates.map(cloneCandidate),
        checksums: state.checksums ? cloneValue(state.checksums) : undefined,
        checksumTimeMs: state.checksumTimeMs,
        decompressionTimeMs: state.decompressionTimeMs,
        fileName: state.fileName,
        id: state.id,
        parentCompressions: state.parentCompressions.map((entry) => ({ ...entry })),
        romProbe: state.romProbe
          ? {
              ...state.romProbe,
              trim: state.romProbe.trim ? { ...state.romProbe.trim } : state.romProbe.trim,
            }
          : undefined,
        selectedCandidateId: state.selectedCandidateId,
        size: state.size,
        sourceSize: state.sourceSize,
        status: state.status,
        warnings: state.warnings.map(cloneWarning),
        wasDecompressed: state.wasDecompressed,
      } satisfies TrimWorkflowSourceState)
    : null;

const appendTrimmedMarker = (baseName: string) =>
  /\(trimmed\)$/i.test(baseName.trim()) ? baseName.trim() : `${baseName.trim() || "trimmed"} (trimmed)`;

const getFileNameExtension = (fileName: string) => {
  const match = fileName.match(FILE_EXTENSION_REGEX);
  return match ? match[0].slice(1) : "";
};

class TrimWorkflowController<TSource, TDestination> extends WorkflowController<{ progress: WorkflowProgress }> {
  readonly id: string;
  protected readonly runtime: WorkflowRuntime;
  protected readonly validateSources?: SourceValidator<TSource>;
  private readonly abortController = new AbortController();
  private readonly constructorSignal?: AbortSignal;
  private readonly selectFile?: WorkflowOptions<CreateSettings>["selectFile"];
  private readonly inputStages: StagedRomSourceController<TSource, InternalSourceState>;
  private disposed = false;
  private activeMutation: string | null = null;
  private progressSequence = 0;
  private settings: Partial<CreateSettings>;
  private outputFormat: CompressionFormat = "none";
  private outputExtension = "";
  private outputName = "";
  private manualOutputName = false;
  private inputStage?: StagedSource<TSource>;

  constructor(
    runtime: WorkflowRuntime,
    options: WorkflowOptions<CreateSettings> = {},
    validateSources?: SourceValidator<TSource>,
  ) {
    super();
    this.runtime = runtime;
    this.validateSources = validateSources;
    this.id = options.id || createWorkflowId();
    this.settings = cloneValue(options.settings || {});
    this.constructorSignal = options.signal;
    this.selectFile = options.selectFile;
    this.inputStages = new StagedRomSourceController<TSource, InternalSourceState>({
      clearRequestsWhenSinglePatchableAsset: true,
      emitProgress: (event) => this.emitProgress(event),
      getExecutionOptions: () => this.createExecutionOptions(),
      getPreparedFileName: (asset, fallback) => asset?.fileName || fallback,
      getSourceId: (_role, index) => `${TRIM_INPUT_ROLE}-${index + 1}`,
      id: this.id,
      releasePreparedOnSelection: "always",
      runtime: this.runtime,
      selectFile: this.selectFile,
      trace: (message, details = {}) =>
        traceWorkflowControllerEvent(
          {
            logLevel: this.settings.logging?.level,
            onLog: this.settings.logging?.sink,
            workflow: "trim",
            workflowId: this.id,
          },
          message,
          details,
        ),
      workflow: "trim",
    });
    const configuredCompression = this.settings.output?.compression;
    if (isCompressionFormat(configuredCompression)) {
      this.outputFormat = configuredCompression;
    }
    if (typeof this.settings.output?.outputName === "string" && this.settings.output.outputName.trim()) {
      this.manualOutputName = true;
      this.outputName = this.settings.output.outputName;
    } else {
      this.outputName = this.buildAutomaticOutputName();
    }
    if (options.signal?.aborted) this.abortController.abort(options.signal.reason);
    else options.signal?.addEventListener("abort", () => this.abort(options.signal?.reason), { once: true });
  }

  getInput(): TrimWorkflowSourceState | null {
    return cloneSourceState(this.inputStage?.state);
  }

  async setInput(source: TSource | TSource[]): Promise<void> {
    return this.mutate("setInput", async () => {
      this.validateSources?.(source);
      const sources = Array.isArray(source) ? [...source] : [source];
      const first = sources[0];
      if (first === undefined) throw new RomWeaverError("INVALID_INPUT", "No trim source was provided");
      try {
        await this.releaseInputStage();
        await this.runtime.preload?.preloadCapability?.("compression", () => undefined, {
          workerThreads: this.settings.workers?.threads,
        });
        const stage = (await this.inputStages.stageSource(
          this.inputStages.createInitialSource(TRIM_INPUT_ROLE, first, 0, {
            allowLazyBrowserRomSource: true,
          }),
        )) as StagedSource<TSource>;
        this.inputStage = stage;
        await this.inputStages.maybeResolveBlockingStageSelection(stage);
        if (!this.manualOutputName) this.outputName = this.buildAutomaticOutputName();
      } catch (error) {
        await this.releaseInputStage();
        await this.inputStages.releaseRuntimeSources(sources);
        throw error;
      }
    });
  }

  async setOutputFormat(format: CompressionFormat | string): Promise<void> {
    return this.mutate("setOutputFormat", async () => {
      const normalized = String(format || "").trim();
      if (isCompressionFormat(normalized)) {
        this.outputFormat = normalized;
        this.outputExtension = "";
      } else {
        // A raw output extension (for example `nds`) keeps the trimmed bytes uncompressed.
        this.outputFormat = "none";
        this.outputExtension = normalized.replace(/^\./, "");
      }
      if (!this.manualOutputName) this.outputName = this.buildAutomaticOutputName();
    });
  }

  async setOutputName(name: string): Promise<void> {
    return this.mutate("setOutputName", async () => {
      const normalizedName = name.trim();
      this.manualOutputName = !!normalizedName;
      this.outputName = this.manualOutputName ? this.normalizeOutputName(name) : this.buildAutomaticOutputName();
    });
  }

  async run(): Promise<TrimResult<TDestination>> {
    return this.mutate("run", async () => {
      const stage = this.inputStage;
      if (!stage) throw new RomWeaverError("INVALID_INPUT", "A trim source is required");
      if (stage.state.status !== "ready" || !stage.state.selectedCandidateId)
        throw new RomWeaverError("AMBIGUOUS_SELECTION", "Trim source requires candidate selection");
      this.getOutputCompression();
      const outputName = this.outputName.trim();
      if (!outputName) throw new RomWeaverError("INVALID_SETTINGS", "Output name is required");
      const result = await withAbortSignal(
        runTrimWorkflow(this.createTrimInput(stage), this.runtime, trimWorkflowDeps),
        this.abortController.signal,
      );
      const output = wrapPublicOutput<TDestination>(result.output, this.runtime, 0);
      return {
        input: this.toSelectedInputInfo(stage),
        output,
        sizeSummary: { ...(result.sizeSummary || {}), outputSize: output.size },
      };
    });
  }

  abort(reason?: unknown): void {
    if (!this.abortController.signal.aborted) this.abortController.abort(reason);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.abort();
    await this.releaseInputStage();
    this.clearListeners();
    this.disposed = true;
  }

  protected traceTriggerEvent(event: "progress", payload: WorkflowProgress, listenerCount: number): void {
    traceWorkflowControllerEvent(
      {
        logLevel: this.settings.logging?.level,
        onLog: this.settings.logging?.sink,
        workflow: "trim",
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
  }) {
    this.trigger("progress", createWorkflowProgress(++this.progressSequence, { ...event, workflow: "trim" }));
  }

  private async mutate<TValue>(operation: string, callback: () => Promise<TValue>): Promise<TValue> {
    if (this.disposed) throw new RomWeaverError("WORKFLOW_DISPOSED", "Workflow has been disposed");
    throwIfAborted(this.abortController.signal);
    throwIfAborted(this.constructorSignal);
    if (this.activeMutation) {
      throw new RomWeaverError("WORKFLOW_BUSY", "Workflow is already running another operation", {
        details: { activeOperation: this.activeMutation, operation },
      });
    }
    this.activeMutation = operation;
    try {
      return await callback();
    } finally {
      this.activeMutation = null;
    }
  }

  private async releaseInputStage() {
    const stage = this.inputStage;
    this.inputStage = undefined;
    if (!stage) return;
    await this.inputStages.releaseSession({
      role: TRIM_INPUT_ROLE,
      sources: [stage.source],
      stages: [stage],
      synthetic: false,
      view: stage,
    });
  }

  private getPreparedTrimSource(stage: StagedSource<TSource>): unknown | undefined {
    return (
      (stage.preparedInputAssets || []).find((asset) => asset.patchable)?.file || stage.preparedInputAssets?.[0]?.file
    );
  }

  private getOutputCompression() {
    const compression = this.outputFormat || "none";
    return compression;
  }

  private buildAutomaticOutputName() {
    const input = this.getInput();
    if (!input?.fileName) return this.outputName;
    const baseName = appendTrimmedMarker(getFileNameWithoutExtension(input.fileName) || "trimmed");
    if (this.outputExtension) {
      return `${baseName}.${this.outputExtension}`;
    }
    if (isCompressionFormat(this.outputFormat)) {
      return `${baseName}.${getCompressionOutputExtension(this.outputFormat, {
        inputFileName: input.fileName,
        settings: this.settings,
      })}`;
    }
    return `${baseName}.${getFileNameExtension(input.fileName) || "bin"}`;
  }

  private normalizeOutputName(name: string) {
    const normalizedName = name.trim();
    const input = this.getInput();
    if (!(normalizedName && input?.fileName)) return normalizedName;
    const outputBaseName = getFileNameWithoutExtension(normalizedName).trim().toLowerCase();
    const inputBaseName = getFileNameWithoutExtension(input.fileName).trim().toLowerCase();
    if (!outputBaseName || outputBaseName !== inputBaseName) return normalizedName;
    const baseName = appendTrimmedMarker(getFileNameWithoutExtension(input.fileName) || "trimmed");
    return `${baseName}.${getFileNameExtension(normalizedName) || getFileNameExtension(input.fileName) || "bin"}`;
  }

  private createExecutionOptions(): CreateWorkflowOptions {
    return {
      input: cloneValue(this.settings.input || {}),
      limits: cloneValue(this.settings.limits || {}),
      logging: cloneValue(this.settings.logging || {}),
      onLog: this.settings.logging?.sink,
      output: {
        ...cloneValue(this.settings.output || {}),
        compression: this.getOutputCompression(),
        outputName: this.normalizeOutputName(this.outputName || this.settings.output?.outputName || ""),
      },
      workers: cloneValue(this.settings.workers || {}),
    };
  }

  private createTrimInput(stage: StagedSource<TSource>): TrimInput {
    const preparedSource = this.getPreparedTrimSource(stage);
    return {
      options: {
        ...this.createExecutionOptions(),
        onProgress: (progress) => {
          let stageName = getPreparationProgressStage(progress);
          if (progress.stage === "output") stageName = "compress";
          else if (progress.stage === "apply") stageName = "trim";
          let fallbackLabel = "Preparing input...";
          if (stageName === "compress") fallbackLabel = "Compressing output...";
          else if (stageName === "trim") fallbackLabel = "Trimming...";
          this.emitProgress({
            details: isRecord(progress.details) ? progress.details : undefined,
            hasProgress: progress.hasProgress,
            id: `${this.id}:worker:${stageName}`,
            label: progress.label || fallbackLabel,
            percent:
              typeof progress.percent === "number" && Number.isFinite(progress.percent) ? progress.percent : null,
            role: progress.stage === "output" ? "output" : "worker",
            stage: stageName,
          });
        },
      },
      selectedSourceEntryName: preparedSource ? undefined : stage.selectedArchiveEntry,
      source: (preparedSource || stage.source) as never,
    };
  }

  private toSelectedInputInfo(source: StagedSource<TSource>): SelectedInputInfo {
    const selected = source.state.selectedCandidateId
      ? source.state.candidates.find((candidate) => candidate.id === source.state.selectedCandidateId)
      : undefined;
    return {
      fileName: source.state.fileName || "input",
      id: source.state.id,
      kind: selected?.type === "file" ? selected.kind : "rom",
      selectedCandidateId: source.state.selectedCandidateId,
      selectedCandidateType: selected?.type,
      size: source.state.size,
    };
  }

  private pushWarning(
    stage: StagedSource<TSource>,
    error: Error & { code?: string; details?: Record<string, unknown> },
  ) {
    stage.state.warnings.push({
      code: error.code,
      details: error.details,
      message: error.message,
      role: stage.state.role,
    });
  }
}

export type { TrimWorkflowSourceState };
export { TrimWorkflowController };
