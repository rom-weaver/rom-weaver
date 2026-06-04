import type { CreateWorkflowParentCompression, CreateWorkflowSourceState } from "../../types/create-workflow.ts";
import type { WorkflowProgress } from "../../types/progress.ts";
import type { CreateResult, SelectedInputInfo } from "../../types/public.ts";
import type { CandidateSelectionRequest, SelectionCandidate } from "../../types/selection.ts";
import type { CreateSettings, PatchFormat } from "../../types/settings.ts";
import type { WorkflowOptions, WorkflowWarning } from "../../types/workflow-controller.ts";
import type { CreatePatchInput, CreateWorkflowOptions } from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { createWorkflowDeps, runCreateWorkflow } from "../create/workflow.ts";
import { RomWeaverError, throwIfAborted, toRomWeaverError, withAbortSignal } from "../errors.ts";
import { getPatchFileCleanup } from "../input/binary-service.ts";
import { getInputPreparationMetrics, type InputAsset } from "../input/input-assets.ts";
import { prepareInputAssets, prepareMultipleDirectInputAssets } from "../input/input-preparation-service.ts";
import { getFileNameWithoutExtension } from "../input/path-utils.ts";
import { selectionToArchiveEntry } from "../input/selection.ts";
import { wrapPublicOutput } from "../output/index.ts";
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
type SourceRole = "modified" | "original";
type SourceStatus = CreateWorkflowSourceState["status"];
type ParentCompression = CreateWorkflowParentCompression;
type InternalSourceState = {
  id: string;
  fileName?: string;
  status: SourceStatus;
  candidates: SelectionCandidate[];
  parentCompressions: ParentCompression[];
  selectedCandidateId?: string;
  size?: number;
  sourceSize?: number;
  decompressionTimeMs?: number;
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
type SourceSession<TSource> = {
  role: SourceRole;
  sources: TSource[];
  stages: StagedSource<TSource>[];
  view: StagedSource<TSource>;
  synthetic: boolean;
};
type PreparationProgress = {
  current?: number;
  details?: unknown;
  hasProgress?: boolean;
  label?: string;
  message?: string;
  percent?: number | null;
  total?: number;
};

const SUPPORTED_CREATE_PATCH_TYPES = new Set<PatchFormat | string>([
  "aps",
  "bdf",
  "bps",
  "ebp",
  "ips",
  "pmsr",
  "ppf",
  "rup",
  "ups",
  "vcdiff",
  "xdelta",
]);
const CREATE_OUTPUT_FORMATS = new Set(["7z", "none", "zip"]);

const cloneSourceState = (state: InternalSourceState | null | undefined) =>
  state
    ? ({
        candidates: state.candidates.map(cloneCandidate),
        decompressionTimeMs: state.decompressionTimeMs,
        fileName: state.fileName,
        id: state.id,
        parentCompressions: state.parentCompressions.map((entry) => ({ ...entry })),
        selectedCandidateId: state.selectedCandidateId,
        size: state.size,
        sourceSize: state.sourceSize,
        status: state.status,
        warnings: state.warnings.map(cloneWarning),
        wasDecompressed: state.wasDecompressed,
      } satisfies CreateWorkflowSourceState)
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

class CreateWorkflowController<TSource, TDestination> extends WorkflowController<{ progress: WorkflowProgress }> {
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
  private patchType?: PatchFormat | string;
  private outputName = "";
  private manualOutputName = false;
  private originalSession?: SourceSession<TSource>;
  private modifiedSession?: SourceSession<TSource>;

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
    this.patchType = this.settings.format;
    if (typeof this.settings.output?.outputName === "string") {
      this.manualOutputName = true;
      this.outputName = this.settings.output.outputName;
    }
    if (!this.manualOutputName) this.outputName = this.buildAutomaticOutputName();
    if (options.signal?.aborted) this.abortController.abort(options.signal.reason);
    else options.signal?.addEventListener("abort", () => this.abort(options.signal?.reason), { once: true });
  }

  getOriginal(): CreateWorkflowSourceState | null {
    return cloneSourceState(this.originalSession?.view.state);
  }

  getModified(): CreateWorkflowSourceState | null {
    return cloneSourceState(this.modifiedSession?.view.state);
  }

  async setOriginal(source: TSource | TSource[]): Promise<void> {
    return this.setSource("setOriginal", "original", source);
  }

  async setModified(source: TSource | TSource[]): Promise<void> {
    return this.setSource("setModified", "modified", source);
  }

  async setPatchType(patchType: PatchFormat | string): Promise<void> {
    return this.mutate("setPatchType", async () => {
      this.patchType = patchType;
      if (!this.manualOutputName) this.outputName = this.buildAutomaticOutputName();
    });
  }

  async setOutputName(name: string): Promise<void> {
    return this.mutate("setOutputName", async () => {
      const normalizedName = name.trim();
      this.manualOutputName = !!normalizedName;
      this.outputName = this.manualOutputName ? name : this.buildAutomaticOutputName();
    });
  }

  async setSettings(settings: Partial<CreateSettings>): Promise<void> {
    return this.mutate("setSettings", async () => {
      this.settings = cloneValue(settings || {});
      if (this.settings.format) this.patchType = this.settings.format;
      if (typeof this.settings.output?.outputName === "string" && this.settings.output.outputName.trim()) {
        this.manualOutputName = true;
        this.outputName = this.settings.output.outputName;
      } else if (!this.manualOutputName) {
        this.outputName = this.buildAutomaticOutputName();
      }
    });
  }

  async run(): Promise<CreateResult<TDestination>> {
    return this.mutate("run", async () => {
      const original = this.getSelectedSourceOwner(this.originalSession);
      const modified = this.getSelectedSourceOwner(this.modifiedSession);
      if (!(original && modified))
        throw new RomWeaverError("INVALID_INPUT", "Original and modified sources are required");
      if (original.state.status !== "ready" || !original.state.selectedCandidateId)
        throw new RomWeaverError("AMBIGUOUS_SELECTION", "Original source requires candidate selection");
      if (modified.state.status !== "ready" || !modified.state.selectedCandidateId)
        throw new RomWeaverError("AMBIGUOUS_SELECTION", "Modified source requires candidate selection");
      const patchType = this.getPatchType();
      if (!SUPPORTED_CREATE_PATCH_TYPES.has(patchType))
        throw new RomWeaverError("UNSUPPORTED_FORMAT", `Unsupported patch type: ${patchType}`);
      this.getOutputCompression();
      const outputName = this.outputName.trim();
      if (!outputName) throw new RomWeaverError("INVALID_SETTINGS", "Output name is required");
      const result = await withAbortSignal(
        runCreateWorkflow(this.createPatchInput(), this.runtime, createWorkflowDeps as never),
        this.abortController.signal,
      );
      const output = wrapPublicOutput<TDestination>(result.output, this.runtime, 0);
      const rawSize = result.sizeSummary?.rawSize ?? result.sizeSummary?.outputSize ?? result.output.size;
      return {
        modified: this.toSelectedInputInfo(modified, "modified"),
        original: this.toSelectedInputInfo(original, "original"),
        output,
        sizeSummary: { ...(result.sizeSummary || {}), outputSize: output.size, rawSize },
        type: result.format as PatchFormat,
      };
    });
  }

  abort(reason?: unknown): void {
    if (!this.abortController.signal.aborted) this.abortController.abort(reason);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.abort();
    await this.releaseSourceSession(this.originalSession);
    await this.releaseSourceSession(this.modifiedSession);
    this.originalSession = undefined;
    this.modifiedSession = undefined;
    this.clearListeners();
    this.disposed = true;
  }

  protected traceTriggerEvent(event: "progress", payload: WorkflowProgress, listenerCount: number): void {
    traceWorkflowControllerEvent(
      {
        logLevel: this.settings.logging?.level,
        onLog: this.settings.logging?.sink,
        workflow: "create",
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
    workflow: WorkflowProgress["workflow"];
  }) {
    this.trigger("progress", createWorkflowProgress(++this.progressSequence, event));
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

  private async setSource(operation: string, role: SourceRole, source: TSource | TSource[]): Promise<void> {
    return this.mutate(operation, async () => {
      this.validateSources?.(source);
      const sources = Array.isArray(source) ? [...source] : [source];
      if (!sources.length) throw new RomWeaverError("INVALID_INPUT", `No ${role} source was provided`);
      try {
        await this.releaseRoleSession(role);
        await this.runtime.preload?.preloadCapability?.("compression", () => undefined, {
          workerThreads: this.settings.workers?.threads,
        });
        const session = await this.stageSourceSession(role, sources);
        if (role === "original") this.originalSession = session;
        else this.modifiedSession = session;
        await this.maybeResolveBlockingSessionSelection(session);
        await this.finalizeSourceStableState(session);
        if (!this.manualOutputName) this.outputName = this.buildAutomaticOutputName();
      } catch (error) {
        await this.releaseRoleSession(role);
        await this.releaseRuntimeSources(sources);
        throw error;
      }
    });
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
      source,
      state: {
        candidates: [],
        fileName,
        id: `${role}-${index + 1}`,
        parentCompressions: [],
        role,
        size: sourceSize,
        sourceSize,
        status: "loading",
        warnings: [],
      },
    };
  }

  private createInitialView(role: SourceRole, sources: TSource[]) {
    const first = sources[0];
    if (first === undefined) throw new RomWeaverError("INVALID_INPUT", `No ${role} source was provided`);
    return this.createInitialSource(role, first, 0);
  }

  private async stageSourceSession(role: SourceRole, sources: TSource[]): Promise<SourceSession<TSource>> {
    if (sources.length === 1) {
      const view = await this.stageSource(this.createInitialSource(role, sources[0] as TSource, 0));
      return { role, sources, stages: [view], synthetic: false, view };
    }
    const requests: CandidateSelectionRequest[] = [];
    const directAssets = await prepareMultipleDirectInputAssets(
      sources as never,
      {
        ...this.createExecutionOptions(),
        onCandidatesFound: (request: CandidateSelectionRequest) => requests.push(request),
      } as never,
    );
    if (directAssets) {
      const view = this.createInitialView(role, sources);
      view.preparedInputAssets = directAssets;
      this.applyPreparedSourceMetadata(view);
      for (const request of requests) this.addCandidateRequest(view, request);
      if (!view.state.candidates.length) this.addDirectCandidate(view, role, 0, view.state.id);
      const selectable = view.state.candidates.filter((candidate) => candidate.selectable);
      if (selectable.length === 1) {
        view.state.selectedCandidateId = selectable[0]?.id;
        view.selectedArchiveEntry = view.internalCandidates.get(selectable[0]?.id || "")?.archiveEntry;
        view.state.status = "ready";
      } else {
        view.state.status = "needsSelection";
      }
      return { role, sources, stages: [view], synthetic: false, view };
    }
    const stages: Array<StagedSource<TSource>> = [];
    for (let index = 0; index < sources.length; index += 1) {
      stages.push(await this.stageSource(this.createInitialSource(role, sources[index] as TSource, index)));
    }
    return this.buildSyntheticSourceSession(role, sources, stages);
  }

  private buildSyntheticSourceSession(
    role: SourceRole,
    sources: TSource[],
    stages: Array<StagedSource<TSource>>,
  ): SourceSession<TSource> {
    const view = this.createInitialView(role, sources);
    view.state.id = role;
    view.state.candidates = stages.flatMap((stage) => stage.state.candidates.map(cloneCandidate));
    view.internalCandidates = new Map();
    for (const stage of stages) {
      for (const [id, candidate] of stage.internalCandidates) {
        view.internalCandidates.set(id, { ...candidate, owner: stage });
      }
    }
    const selectable = view.state.candidates.filter((candidate) => candidate.selectable);
    if (selectable.length === 1) {
      view.state.selectedCandidateId = selectable[0]?.id;
      view.state.status = "ready";
    } else {
      view.state.status = "needsSelection";
    }
    const session = { role, sources, stages, synthetic: true, view };
    this.syncSourceSessionView(session);
    return session;
  }

  private async stageSource(stage: StagedSource<TSource>): Promise<StagedSource<TSource>> {
    const requests: CandidateSelectionRequest[] = [];
    try {
      stage.preparedInputAssets = await this.prepareStageAssets(stage, requests, undefined);
    } catch (error) {
      if (requests.length && !canRecoverWithCandidateSelection(error, requests)) throw error;
      if (!requests.length) this.pushWarning(stage, toRomWeaverError(error));
    }
    for (const request of requests) this.addCandidateRequest(stage, request);
    if (!stage.state.candidates.length) this.addDirectCandidate(stage, stage.state.role, stage.index, stage.state.id);
    const selectable = stage.state.candidates.filter((candidate) => candidate.selectable);
    if (selectable.length === 1) {
      stage.state.selectedCandidateId = selectable[0]?.id;
      stage.selectedArchiveEntry = stage.internalCandidates.get(selectable[0]?.id || "")?.archiveEntry;
      if (this.getPreparedPatchSource(stage)) {
        this.applyPreparedSourceMetadata(stage);
        stage.state.status = "ready";
      } else {
        await this.prepareSelectedSource(stage);
      }
    } else {
      stage.state.status = "needsSelection";
      await this.maybeResolveBlockingStageSelection(stage);
    }
    return stage;
  }

  private async prepareSelectedSource(stage: StagedSource<TSource>): Promise<void> {
    const requests: CandidateSelectionRequest[] = [];
    try {
      if (!stage.preparedInputAssets?.length) {
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

  private async maybeResolveBlockingSessionSelection(session: SourceSession<TSource>): Promise<boolean> {
    if (!(session.view.state.status === "needsSelection" && !session.view.state.selectedCandidateId)) return false;
    const selection = await this.resolveSelectionRequest(
      this.createSelectionRequest(session.view.state),
      this.selectFile,
    );
    if (!selection) return false;
    const owner = session.view.internalCandidates.get(selection.id)?.owner || session.view;
    this.setSelectedCandidate(owner, selection.id);
    await this.prepareSelectedSource(owner);
    this.syncSourceSessionView(session);
    if (session.view.state.status === "needsSelection" && !session.view.state.selectedCandidateId)
      return this.maybeResolveBlockingSessionSelection(session);
    return true;
  }

  private createPreparationOptions(
    stage: StagedSource<TSource>,
    requests: CandidateSelectionRequest[],
  ): Partial<CreateWorkflowOptions> {
    return {
      ...this.createExecutionOptions(),
      onCandidatesFound: (request: CandidateSelectionRequest) => requests.push(request),
      onProgress: (progress: PreparationProgress) => this.emitPreparationProgress(stage, progress),
    } satisfies Partial<CreateWorkflowOptions>;
  }

  private emitPreparationProgress(stage: StagedSource<TSource>, progress: PreparationProgress) {
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
      workflow: "create",
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
    if (!stage.preparedInputAssets?.length) releasePreparedSource(stage);
    stage.state.selectedCandidateId = candidateId;
    stage.selectedArchiveEntry = stage.internalCandidates.get(candidateId)?.archiveEntry;
  }

  private handleSourceSelectionRequests(stage: StagedSource<TSource>, requests: CandidateSelectionRequest[]) {
    stage.internalCandidates.clear();
    stage.state.candidates = [];
    for (const request of requests) this.addCandidateRequest(stage, request);
    stage.state.decompressionTimeMs = undefined;
    stage.state.parentCompressions = [];
    stage.state.selectedCandidateId = undefined;
    stage.state.status = "needsSelection";
    stage.state.wasDecompressed = undefined;
    releasePreparedSource(stage);
  }

  private applyPreparedSourceMetadata(stage: StagedSource<TSource>) {
    const assets = stage.preparedInputAssets || [];
    const preparation = getInputPreparationMetrics(assets);
    stage.state.fileName = assets[0]?.fileName || stage.state.fileName;
    stage.state.parentCompressions = (preparation?.parentCompressions || []).map((entry) => ({ ...entry }));
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

  private addDirectCandidate(stage: StagedSource<TSource>, role: SourceRole, index: number, internalId: string) {
    const publicId = `${this.id}:${role}:${++this.nextCandidateSequence}`;
    const candidate: SelectionCandidate = {
      fileName: stage.state.fileName || `${role}-${index + 1}`,
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

  private syncSourceSessionView(session: SourceSession<TSource>) {
    if (!session.synthetic) return;
    const selectedOwner = this.getSelectedSourceOwner(session);
    session.view.preparedInputAssets = session.stages.flatMap((stage) => stage.preparedInputAssets || []);
    session.view.state.selectedCandidateId =
      selectedOwner?.state.selectedCandidateId ||
      (session.view.state.candidates.filter((candidate) => candidate.selectable).length === 1
        ? session.view.state.candidates.find((candidate) => candidate.selectable)?.id
        : undefined);
    session.view.state.status = session.view.state.selectedCandidateId ? "ready" : "needsSelection";
    session.view.state.fileName = selectedOwner?.state.fileName || session.stages[0]?.state.fileName;
    session.view.state.size =
      selectedOwner?.state.size ||
      session.view.preparedInputAssets?.reduce((total, asset) => total + asset.size, 0) ||
      undefined;
    session.view.state.parentCompressions =
      selectedOwner?.state.parentCompressions.map((entry) => ({ ...entry })) || [];
    session.view.state.sourceSize =
      selectedOwner?.state.sourceSize ||
      session.stages.reduce((total, stage) => total + (stage.state.sourceSize || 0), 0) ||
      undefined;
    session.view.state.decompressionTimeMs = selectedOwner?.state.decompressionTimeMs;
    session.view.state.wasDecompressed = selectedOwner?.state.wasDecompressed;
  }

  private getSelectedSourceOwner(session: SourceSession<TSource> | undefined): StagedSource<TSource> | undefined {
    if (!session) return undefined;
    if (!session.synthetic) return session.view;
    const selectedId = session.view.state.selectedCandidateId;
    if (!selectedId) return undefined;
    return session.view.internalCandidates.get(selectedId)?.owner;
  }

  private async finalizeSourceStableState(session: SourceSession<TSource>) {
    const selected = this.getSelectedSourceOwner(session);
    if (!(selected && session.view.state.status === "ready" && selected.preparedInputAssets?.[0]?.file)) return;
    if (session.synthetic) this.syncSourceSessionView(session);
  }

  private getRuntimeSourcesForStage(stage?: StagedSource<TSource>): unknown[] {
    if (!stage) return [];
    return (stage.preparedInputAssets || []).map((asset) => asset.file);
  }

  private getPreparedPatchSource(stage: StagedSource<TSource>): unknown | undefined {
    return (
      (stage.preparedInputAssets || []).find((asset) => asset.patchable)?.file || stage.preparedInputAssets?.[0]?.file
    );
  }

  private async releaseRuntimeSources(sources: unknown[]): Promise<void> {
    await this.runtime.workerIo?.releaseSources?.(sources).catch(() => undefined);
  }

  private async releaseRoleSession(role: SourceRole) {
    if (role === "original") {
      await this.releaseSourceSession(this.originalSession);
      this.originalSession = undefined;
      return;
    }
    await this.releaseSourceSession(this.modifiedSession);
    this.modifiedSession = undefined;
  }

  private async releaseSourceSession(session?: SourceSession<TSource>) {
    if (!session) return;
    const sessionStages = [...session.stages, ...(session.stages.includes(session.view) ? [] : [session.view])];
    const sources = [...session.sources, ...sessionStages.flatMap((stage) => this.getRuntimeSourcesForStage(stage))];
    await Promise.all(sessionStages.map((stage) => releasePreparedSourceAndWait(stage)));
    await this.releaseRuntimeSources(sources);
  }

  private getPatchType() {
    return String(this.patchType || this.settings.format || "ips");
  }

  private getOutputCompression() {
    const compression = this.settings.output?.compression || "none";
    if (!CREATE_OUTPUT_FORMATS.has(String(compression))) {
      throw new RomWeaverError("INVALID_SETTINGS", `Unsupported create output compression: ${compression}`);
    }
    return compression as "7z" | "none" | "zip";
  }

  private buildAutomaticOutputName() {
    const original = this.getOriginal();
    if (!original?.fileName) return this.outputName;
    const baseName = getFileNameWithoutExtension(original.fileName) || "patch";
    return `${baseName}.${this.getPatchType()}`;
  }

  private createExecutionOptions(): CreateWorkflowOptions {
    const patchType = this.getPatchType();
    return {
      format: patchType,
      input: cloneValue(this.settings.input || {}),
      limits: cloneValue(this.settings.limits || {}),
      logging: cloneValue(this.settings.logging || {}),
      onLog: this.settings.logging?.sink,
      output: {
        ...cloneValue(this.settings.output || {}),
        compression: this.getOutputCompression(),
        outputName: this.outputName || this.settings.output?.outputName,
      },
      patch: this.settings.patch?.metadata ? { metadata: cloneValue(this.settings.patch.metadata) } : undefined,
      workers: cloneValue(this.settings.workers || {}),
    };
  }

  private createPatchInput(): CreatePatchInput {
    const original = this.getSelectedSourceOwner(this.originalSession);
    const modified = this.getSelectedSourceOwner(this.modifiedSession);
    if (!(original && modified))
      throw new RomWeaverError("INVALID_INPUT", "Original and modified sources are required");
    const preparedOriginal = this.getPreparedPatchSource(original);
    const preparedModified = this.getPreparedPatchSource(modified);
    return {
      modified: (preparedModified || modified.source) as never,
      options: {
        ...this.createExecutionOptions(),
        onProgress: (progress) => {
          let stage = getPreparationProgressStage(progress);
          if (progress.stage === "output") stage = "compress";
          else if (progress.stage === "apply") stage = "create";
          let fallbackLabel = "Preparing input...";
          if (stage === "compress") fallbackLabel = "Compressing output...";
          else if (stage === "create") fallbackLabel = "Creating patch...";
          this.emitProgress({
            details: isRecord(progress.details) ? progress.details : undefined,
            hasProgress: progress.hasProgress,
            id: `${this.id}:worker:${stage}`,
            label: progress.label || fallbackLabel,
            percent:
              typeof progress.percent === "number" && Number.isFinite(progress.percent) ? progress.percent : null,
            role: progress.stage === "output" ? "output" : "worker",
            stage,
            workflow: "create",
          });
        },
      },
      original: (preparedOriginal || original.source) as never,
      selectedModifiedEntryName: preparedModified ? undefined : modified.selectedArchiveEntry,
      selectedOriginalEntryName: preparedOriginal ? undefined : original.selectedArchiveEntry,
    };
  }

  private toSelectedInputInfo(source: StagedSource<TSource>, fallback: string): SelectedInputInfo {
    const selected = source.state.selectedCandidateId
      ? source.state.candidates.find((candidate) => candidate.id === source.state.selectedCandidateId)
      : undefined;
    return {
      fileName: source.state.fileName || fallback,
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

export type { CreateWorkflowSourceState };
export { CreateWorkflowController };
