import type { ChecksumRomProbe } from "../../types/checksum.ts";
import type { WorkflowProgress } from "../../types/progress.ts";
import type { SelectedInputInfo, TrimResult } from "../../types/public.ts";
import type { CandidateSelectionRequest, SelectionCandidate } from "../../types/selection.ts";
import type { CreateSettings } from "../../types/settings.ts";
import type {
  TrimWorkflowChecksums,
  TrimWorkflowParentCompression,
  TrimWorkflowSourceState,
} from "../../types/trim-workflow.ts";
import type { WorkflowOptions, WorkflowWarning } from "../../types/workflow-controller.ts";
import type { CreateWorkflowOptions, TrimInput } from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { RomWeaverError, throwIfAborted, toRomWeaverError, withAbortSignal } from "../errors.ts";
import { getPatchFileCleanup } from "../input/binary-service.ts";
import { getInputPreparationMetrics, type InputAsset } from "../input/input-assets.ts";
import { prepareInputAssets } from "../input/input-preparation-service.ts";
import { getFileNameWithoutExtension } from "../input/path-utils.ts";
import { selectionToArchiveEntry } from "../input/selection.ts";
import { wrapPublicOutput } from "../output/index.ts";
import { runTrimWorkflow, trimWorkflowDeps } from "../trim/workflow.ts";
import {
  cloneCandidate,
  cloneValue,
  cloneWarning,
  createWorkflowId,
  createWorkflowProgress,
  getPreparationProgressStage,
  getSourceFileName,
  getSourceSize,
  isRecord,
} from "./controller-utils.ts";
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
  selectedArchiveEntry?: string;
};

const TRIM_INPUT_ROLE: SourceRole = "input";
const TRIM_OUTPUT_FORMATS = new Set(["7z", "none", "zip"]);
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

const releasePreparedSource = (source?: StagedSource<unknown>) => {
  if (!source) return;
  for (const asset of source.preparedInputAssets || []) {
    const cleanup = getPatchFileCleanup(asset.file);
    if (cleanup) void Promise.resolve(cleanup()).catch(() => undefined);
  }
  source.preparedInputAssets = undefined;
};

const releasePreparedSourceAndWait = async (source?: StagedSource<unknown>) => {
  if (!source) return;
  await Promise.all(
    (source.preparedInputAssets || []).map(async (asset) => {
      const cleanup = getPatchFileCleanup(asset.file);
      if (cleanup) await Promise.resolve(cleanup()).catch(() => undefined);
    }),
  );
  source.preparedInputAssets = undefined;
};

const canRecoverWithCandidateSelection = (error: unknown, requests: CandidateSelectionRequest[]) => {
  if (!requests.length) return false;
  const normalized = toRomWeaverError(error);
  if (normalized.code === "AMBIGUOUS_SELECTION") return true;
  return false;
};

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
  private disposed = false;
  private activeMutation: string | null = null;
  private progressSequence = 0;
  private nextCandidateSequence = 0;
  private settings: Partial<CreateSettings>;
  private outputFormat: "7z" | "none" | "zip" = "none";
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
    const configuredCompression = this.settings.output?.compression;
    if (configuredCompression && TRIM_OUTPUT_FORMATS.has(String(configuredCompression))) {
      this.outputFormat = configuredCompression as "7z" | "none" | "zip";
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
        const stage = await this.stageSource(this.createInitialSource(first, 0, { allowLazyBrowserRomSource: true }));
        this.inputStage = stage;
        await this.maybeResolveBlockingStageSelection(stage);
        if (!this.manualOutputName) this.outputName = this.buildAutomaticOutputName();
      } catch (error) {
        await this.releaseInputStage();
        await this.releaseRuntimeSources(sources);
        throw error;
      }
    });
  }

  async setOutputFormat(format: "7z" | "none" | "zip" | string): Promise<void> {
    return this.mutate("setOutputFormat", async () => {
      const normalized = String(format || "").trim();
      if (TRIM_OUTPUT_FORMATS.has(normalized)) {
        this.outputFormat = normalized as "7z" | "none" | "zip";
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

  private createInitialSource(
    source: TSource,
    index: number,
    options: { allowLazyBrowserRomSource?: boolean } = {},
  ): StagedSource<TSource> {
    const fileName = getSourceFileName(source, `${TRIM_INPUT_ROLE}-${index + 1}`);
    const sourceSize = getSourceSize(source);
    return {
      allowLazyBrowserRomSource: options.allowLazyBrowserRomSource,
      index,
      internalCandidates: new Map(),
      source,
      state: {
        candidates: [],
        fileName,
        id: `${TRIM_INPUT_ROLE}-${index + 1}`,
        parentCompressions: [],
        role: TRIM_INPUT_ROLE,
        size: sourceSize,
        sourceSize,
        status: "loading",
        warnings: [],
      },
    };
  }

  private async stageSource(stage: StagedSource<TSource>): Promise<StagedSource<TSource>> {
    const requests: CandidateSelectionRequest[] = [];
    try {
      stage.preparedInputAssets = await this.prepareStageAssets(stage, requests, undefined);
    } catch (error) {
      if (requests.length && !canRecoverWithCandidateSelection(error, requests)) throw error;
      if (!requests.length) this.pushWarning(stage, toRomWeaverError(error));
    }
    if (stage.preparedInputAssets?.filter((asset) => asset.patchable).length === 1) requests.length = 0;
    for (const request of requests) this.addCandidateRequest(stage, request);
    if (!stage.state.candidates.length) this.addDirectCandidate(stage, stage.index, stage.state.id);
    const selectable = stage.state.candidates.filter((candidate) => candidate.selectable);
    if (selectable.length === 1) {
      stage.state.selectedCandidateId = selectable[0]?.id;
      stage.selectedArchiveEntry = stage.internalCandidates.get(selectable[0]?.id || "")?.archiveEntry;
      await this.prepareSelectedSource(stage);
    } else {
      stage.state.status = "needsSelection";
      await this.maybeResolveBlockingStageSelection(stage);
    }
    return stage;
  }

  private async prepareSelectedSource(stage: StagedSource<TSource>): Promise<void> {
    const requests: CandidateSelectionRequest[] = [];
    const canReusePreparedAssets = !!stage.preparedInputAssets?.length;
    traceWorkflowControllerEvent(
      {
        logLevel: this.settings.logging?.level,
        onLog: this.settings.logging?.sink,
        workflow: "trim",
        workflowId: this.id,
      },
      "prepareSelectedSource",
      {
        assetCount: stage.preparedInputAssets?.length || 0,
        canReusePreparedAssets,
        selectedArchiveEntry: stage.selectedArchiveEntry || "",
        sourceId: stage.state.id,
      },
    );
    try {
      if (!canReusePreparedAssets) {
        stage.preparedInputAssets = await this.prepareStageAssets(stage, requests, stage.selectedArchiveEntry);
      }
      this.applyPreparedSourceMetadata(stage);
      stage.state.status = "ready";
    } catch (error) {
      if (requests.length && !canRecoverWithCandidateSelection(error, requests)) throw error;
      if (requests.length) {
        this.handleSourceSelectionRequests(stage, requests);
        await this.maybeResolveBlockingStageSelection(stage);
        return;
      }
      throw error;
    }
  }

  private createSelectionRequest(state: InternalSourceState): CandidateSelectionRequest {
    return {
      candidates: state.candidates.map(cloneCandidate),
      role: state.role,
      sourceName: state.fileName || state.id,
      warnings: state.warnings.map((warning) => warning.message),
    };
  }

  private async maybeResolveBlockingStageSelection(stage: StagedSource<TSource>): Promise<boolean> {
    if (
      !(stage.state.status === "needsSelection" && !stage.state.selectedCandidateId && stage.state.candidates.length)
    ) {
      return false;
    }
    const selection = await this.resolveSelectionRequest(this.createSelectionRequest(stage.state), this.selectFile);
    if (!selection) return false;
    const owner = stage.internalCandidates.get(selection.id)?.owner || stage;
    this.setSelectedCandidate(owner, selection.id);
    await this.prepareSelectedSource(owner);
    return true;
  }

  private createPreparationOptions(
    stage: StagedSource<TSource>,
    requests: CandidateSelectionRequest[],
  ): Partial<CreateWorkflowOptions> {
    return {
      ...this.createExecutionOptions(),
      onCandidatesFound: (request: CandidateSelectionRequest) => requests.push(request),
      onProgress: (progress) => this.emitPreparationProgress(stage, progress),
    } satisfies Partial<CreateWorkflowOptions>;
  }

  private emitPreparationProgress(
    stage: StagedSource<TSource>,
    progress: {
      current?: number;
      details?: unknown;
      hasProgress?: boolean;
      label?: string;
      message?: string;
      percent?: number | null;
      total?: number;
    },
  ) {
    const progressStage = getPreparationProgressStage(progress, stage.state.role);
    this.emitProgress({
      current: progress.current,
      details: {
        ...(isRecord(progress.details) ? progress.details : {}),
        fileName: stage.state.fileName,
        sourceId: stage.state.id,
      },
      hasProgress: progress.hasProgress,
      id: `${this.id}:${stage.state.id}:${progressStage}`,
      label: progress.label || progress.message || "Preparing input...",
      percent: typeof progress.percent === "number" && Number.isFinite(progress.percent) ? progress.percent : null,
      role: stage.state.role,
      stage: progressStage,
      total: progress.total,
    });
  }

  private async prepareStageAssets(
    stage: StagedSource<TSource>,
    requests: CandidateSelectionRequest[],
    selectedArchiveEntry: string | undefined,
  ): Promise<InputAsset[]> {
    return prepareInputAssets(
      stage.source as never,
      this.createPreparationOptions(stage, requests) as never,
      stage.index,
      this.runtime,
      selectedArchiveEntry,
      { allowLazyBrowserRomSource: !!stage.allowLazyBrowserRomSource },
    );
  }

  private setSelectedCandidate(stage: StagedSource<TSource>, candidateId: string): void {
    if (!stage.internalCandidates.has(candidateId))
      throw new RomWeaverError("SELECTION_NOT_FOUND", `Selection candidate was not found: ${candidateId}`);
    releasePreparedSource(stage);
    stage.state.selectedCandidateId = candidateId;
    stage.selectedArchiveEntry = stage.internalCandidates.get(candidateId)?.archiveEntry;
  }

  private handleSourceSelectionRequests(stage: StagedSource<TSource>, requests: CandidateSelectionRequest[]) {
    stage.internalCandidates.clear();
    stage.state.candidates = [];
    for (const request of requests) this.addCandidateRequest(stage, request);
    stage.state.checksums = undefined;
    stage.state.checksumTimeMs = undefined;
    stage.state.decompressionTimeMs = undefined;
    stage.state.parentCompressions = [];
    stage.state.romProbe = undefined;
    stage.state.selectedCandidateId = undefined;
    stage.state.status = "needsSelection";
    stage.state.wasDecompressed = undefined;
    releasePreparedSource(stage);
  }

  private applyPreparedSourceMetadata(stage: StagedSource<TSource>) {
    const assets = stage.preparedInputAssets || [];
    const preparation = getInputPreparationMetrics(assets);
    stage.state.fileName = assets[0]?.fileName || stage.state.fileName;
    stage.state.size = assets.reduce((total, asset) => total + asset.size, 0) || stage.state.size;
    stage.state.parentCompressions = (preparation?.parentCompressions || []).map((entry) => ({ ...entry }));
    stage.state.sourceSize =
      (typeof preparation?.sourceSize === "number" && Number.isFinite(preparation.sourceSize)
        ? preparation.sourceSize
        : stage.state.sourceSize) || stage.state.size;
    stage.state.decompressionTimeMs =
      typeof preparation?.decompressionTimeMs === "number" && Number.isFinite(preparation.decompressionTimeMs)
        ? preparation.decompressionTimeMs
        : undefined;
    stage.state.wasDecompressed = preparation?.wasDecompressed === true;
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
      stage.internalCandidates.set(publicId, {
        archiveEntry: candidate.selectable ? selectionToArchiveEntry(request, { id: candidate.id }) : undefined,
        candidate,
        owner: stage,
        request,
      });
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

  private addDirectCandidate(stage: StagedSource<TSource>, index: number, internalId: string) {
    const publicId = `${this.id}:${TRIM_INPUT_ROLE}:${++this.nextCandidateSequence}`;
    const candidate: SelectionCandidate = {
      fileName: stage.state.fileName || `${TRIM_INPUT_ROLE}-${index + 1}`,
      id: publicId,
      kind: "rom",
      patchable: true,
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

  private async releaseInputStage() {
    const stage = this.inputStage;
    this.inputStage = undefined;
    if (!stage) return;
    const sources = [stage.source, ...this.getRuntimeSourcesForStage(stage)];
    await releasePreparedSourceAndWait(stage);
    await this.releaseRuntimeSources(sources);
  }

  private getRuntimeSourcesForStage(stage?: StagedSource<TSource>): unknown[] {
    if (!stage) return [];
    return (stage.preparedInputAssets || []).map((asset) => asset.file);
  }

  private getPreparedTrimSource(stage: StagedSource<TSource>): unknown | undefined {
    return (
      (stage.preparedInputAssets || []).find((asset) => asset.patchable)?.file || stage.preparedInputAssets?.[0]?.file
    );
  }

  private async releaseRuntimeSources(sources: unknown[]): Promise<void> {
    await this.runtime.workerIo?.releaseSources?.(sources).catch(() => undefined);
  }

  private getOutputCompression() {
    const compression = this.outputFormat || "none";
    if (!TRIM_OUTPUT_FORMATS.has(String(compression))) {
      throw new RomWeaverError("INVALID_SETTINGS", `Unsupported trim output compression: ${compression}`);
    }
    return compression;
  }

  private buildAutomaticOutputName() {
    const input = this.getInput();
    if (!input?.fileName) return this.outputName;
    const baseName = appendTrimmedMarker(getFileNameWithoutExtension(input.fileName) || "trimmed");
    if (this.outputExtension) {
      return `${baseName}.${this.outputExtension}`;
    }
    if (this.outputFormat === "zip" || this.outputFormat === "7z") return `${baseName}.${this.outputFormat}`;
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
