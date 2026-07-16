import type { ChecksumRomProbe } from "../../types/checksum.ts";
import type { TrimResult } from "../../types/public.ts";
import type { SelectionCandidate } from "../../types/selection.ts";
import type { CompressionFormat, CreateSettings } from "../../types/settings.ts";
import type {
  TrimWorkflowChecksums,
  TrimWorkflowParentCompression,
  TrimWorkflowSourceState,
} from "../../types/trim-workflow.ts";
import type { WorkflowOptions, WorkflowWarning } from "../../types/workflow-controller.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { CreateWorkflowOptions, TrimInput } from "../../types/workflow-runtime-types.ts";
import { getCompressionOutputExtension, isCompressionFormat } from "../compression/container-format-registry.ts";
import { RomWeaverError, withAbortSignal } from "../errors.ts";
import { getFileNameWithoutExtension } from "../input/path-utils.ts";
import { wrapPublicOutput } from "../output/index.ts";
import { runTrimWorkflow, trimWorkflowDeps } from "../trim/workflow.ts";
import { BaseWorkflowController, type BaseWorkflowSnapshot, type SourceValidator } from "./base-workflow-controller.ts";
import { cloneCandidate, cloneValue, cloneWarning, getPreparationProgressStage, isRecord } from "./controller-utils.ts";
import type { SharedRomStagedSource, StagedRomSourceController } from "./staged-rom-source.ts";

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
  chdMode?: string;
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
        chdMode: state.chdMode,
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

/** Reactive snapshot of the trim workflow's staged state (see {@link BaseWorkflowController.getSnapshot}). */
type TrimWorkflowSnapshot = BaseWorkflowSnapshot & {
  input: TrimWorkflowSourceState | null;
  outputName: string;
  outputFormat: CompressionFormat;
  manualOutputName: boolean;
};

class TrimWorkflowController<TSource, TDestination> extends BaseWorkflowController<
  TSource,
  CreateSettings,
  TrimWorkflowSnapshot
> {
  private readonly inputStages: StagedRomSourceController<TSource, InternalSourceState>;
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
    super("trim", runtime, options, validateSources);
    this.inputStages = this.createStagedController<InternalSourceState>({
      getExecutionOptions: () => this.createExecutionOptions(),
      getSourceId: (_role, index) => `${TRIM_INPUT_ROLE}-${index + 1}`,
      releasePreparedOnSelection: "always",
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
          this.inputStages.createInitialSource(TRIM_INPUT_ROLE, first, 0),
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
        sizeSummary: { ...result.sizeSummary, outputSize: output.size },
      };
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.abort();
    await this.releaseInputStage();
    this.clearListeners();
    this.disposed = true;
  }

  private mutate<TValue>(operation: string, callback: () => Promise<TValue>): Promise<TValue> {
    return this.runExclusiveMutation(operation, callback);
  }

  protected computeSnapshot(): TrimWorkflowSnapshot {
    return {
      busy: this.isBusy(),
      id: this.id,
      input: this.getInput(),
      manualOutputName: this.manualOutputName,
      outputFormat: this.outputFormat,
      outputName: this.outputName,
      ready: this.computeReady(),
    };
  }

  /** Mirror the preconditions enforced by {@link run}: input ready+selected and an output name resolved. */
  private computeReady(): boolean {
    const stage = this.inputStage;
    if (!stage) return false;
    if (stage.state.status !== "ready" || !stage.state.selectedCandidateId) return false;
    return !!this.outputName.trim();
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
      logging: cloneValue(this.settings.logging || {}),
      onLog: this.settings.logging?.sink,
      output: {
        ...cloneValue(this.settings.output || {}),
        compression: this.getOutputCompression(),
        outputName: this.normalizeOutputName(this.outputName || this.settings.output?.outputName || ""),
      },
      signal: this.abortController.signal,
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
}

export { TrimWorkflowController };
