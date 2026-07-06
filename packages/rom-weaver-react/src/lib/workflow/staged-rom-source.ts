import type { WorkflowKind } from "../../types/progress.ts";
import type { CandidateSelectionRequest, SelectFile, SelectionCandidate } from "../../types/selection.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { ApplyWorkflowOptions, CreateWorkflowOptions } from "../../types/workflow-runtime-types.ts";
import { RomWeaverError, toRomWeaverError } from "../errors.ts";
import { getInputPreparationMetrics, type InputAsset } from "../input/input-assets.ts";
import {
  getBinarySourceSize,
  prepareInputAssets,
  prepareMultipleDirectInputAssets,
} from "../input/input-preparation-service.ts";
import { getBaseFileName } from "../input/path-utils.ts";
import { chdModeFromMetadata } from "../input/rom-specific-file-utils.ts";
import { resolveAutomaticSelection, selectionToArchiveEntry } from "../input/selection.ts";
import {
  cloneCandidate,
  cloneWarning,
  getPreparationProgressStage,
  getSourceFileName,
  getSourceSize,
  isRecord,
} from "./controller-utils.ts";
import {
  cloneParentCompressions,
  normalizeParentCompressions,
  releasePreparedRomSource,
  releasePreparedRomSourceAndWait,
} from "./staged-source-cleanup.ts";
import {
  canRecoverWithCandidateSelection,
  createSelectionSkippedError,
  isInteractiveSelectionCancelledError,
} from "./staged-source-selection.ts";
import type {
  PreparationProgress,
  SessionIdFactory,
  SharedRomSourceSession,
  SharedRomSourceState,
  SharedRomStagedSource,
  SourceIdFactory,
  StagedRomSourceControllerOptions,
  WorkflowOptionsFactory,
} from "./staged-source-types.ts";

const MAX_SELECTION_RETRY_COUNT = 12;

const getDefaultPreparedFileName = (asset: InputAsset | undefined, fallback: string) =>
  getBaseFileName(asset?.file.fileName || asset?.fileName || fallback || "input.bin");

class StagedRomSourceController<TSource, TState extends SharedRomSourceState> {
  private nextCandidateSequence = 0;
  private readonly clearRequestsWhenSinglePatchableAsset: boolean;
  private readonly emitProgress: StagedRomSourceControllerOptions<TState>["emitProgress"];
  private readonly getExecutionOptions: WorkflowOptionsFactory;
  private readonly getPreparedFileName: NonNullable<StagedRomSourceControllerOptions<TState>["getPreparedFileName"]>;
  private readonly getSessionId?: SessionIdFactory<TState["role"]>;
  private readonly getSourceId: SourceIdFactory<TState["role"]>;
  private readonly id: string;
  private readonly releasePreparedOnSelection: "always" | "when-empty";
  private readonly runtime: WorkflowRuntime;
  private readonly selectFile?: SelectFile;
  private readonly trace?: StagedRomSourceControllerOptions<TState>["trace"];
  private readonly workflow: WorkflowKind;

  constructor(options: StagedRomSourceControllerOptions<TState>) {
    this.clearRequestsWhenSinglePatchableAsset = options.clearRequestsWhenSinglePatchableAsset === true;
    this.emitProgress = options.emitProgress;
    this.getExecutionOptions = options.getExecutionOptions;
    this.getPreparedFileName = options.getPreparedFileName || getDefaultPreparedFileName;
    this.getSessionId = options.getSessionId;
    this.getSourceId = options.getSourceId;
    this.id = options.id;
    this.releasePreparedOnSelection = options.releasePreparedOnSelection || "when-empty";
    this.runtime = options.runtime;
    this.selectFile = options.selectFile;
    this.trace = options.trace;
    this.workflow = options.workflow;
  }

  createInitialSource(
    role: TState["role"],
    source: TSource,
    index: number,
    options: { id?: string } = {},
  ): SharedRomStagedSource<TSource, TState> {
    const fileName = getSourceFileName(source, `${role}-${index + 1}`);
    const sourceSize = getSourceSize(source);
    return {
      index,
      internalCandidates: new Map(),
      parentCompressions: [],
      source,
      state: {
        candidates: [],
        fileName,
        id: options.id || this.getSourceId(role, index, source),
        order: index,
        parentCompressions: [],
        role,
        size: sourceSize,
        sourceSize,
        status: "loading",
        warnings: [],
      } as unknown as TState,
    };
  }

  createSelectionRequest(state: TState): CandidateSelectionRequest {
    return {
      candidates: state.candidates.map(cloneCandidate),
      role: state.role,
      sourceName: state.fileName || state.id,
      warnings: state.warnings.map((warning) => warning.message),
    };
  }

  async stageSource(stage: SharedRomStagedSource<TSource, TState>): Promise<SharedRomStagedSource<TSource, TState>> {
    this.trace?.("source.stage.start", {
      fileName: stage.state.fileName,
      order: stage.state.order,
      role: stage.state.role,
      sourceSize: stage.state.sourceSize,
    });
    const requests: CandidateSelectionRequest[] = [];
    try {
      stage.preparedInputAssets = await this.prepareStageAssets(stage, requests, undefined);
    } catch (error) {
      this.trace?.("source.stage.prepare.fail", {
        error,
        fileName: stage.state.fileName,
        order: stage.state.order,
        requestCount: requests.length,
        role: stage.state.role,
      });
      // A dismissed interactive prompt must abort the whole input preparation. Swallowing it (as a
      // warning) lets staging fall through to prepareSelectedSource, which re-extracts and re-prompts
      // a worker with no user to answer — the second prompt wedges and strands its staged OPFS copy.
      if (isInteractiveSelectionCancelledError(error)) throw createSelectionSkippedError(error);
      if (requests.length && !canRecoverWithCandidateSelection(error, requests)) throw error;
      if (!requests.length) this.pushWarning(stage, toRomWeaverError(error));
    }
    if (
      this.clearRequestsWhenSinglePatchableAsset &&
      stage.preparedInputAssets?.filter((asset) => asset.patchable).length === 1
    ) {
      requests.length = 0;
    }
    if (!requests.length) {
      const preparedAssetRequest = this.createPreparedAssetSelectionRequest(stage);
      if (preparedAssetRequest) {
        requests.push(preparedAssetRequest);
        releasePreparedRomSource(stage as never);
      }
    }
    for (const request of requests) this.addCandidateRequest(stage, request);
    if (!stage.state.candidates.length) this.addDirectCandidate(stage, stage.index, stage.state.id);
    const selectable = stage.state.candidates.filter((candidate) => candidate.selectable);
    if (selectable.length === 1) {
      stage.state.selectedCandidateId = selectable[0]?.id;
      stage.selectedArchiveEntry = stage.internalCandidates.get(selectable[0]?.id || "")?.archiveEntry;
      await this.prepareSelectedSource(stage);
    } else {
      stage.state.status = "needsSelection";
    }
    this.trace?.("source.stage.finish", {
      candidateCount: stage.state.candidates.length,
      fileName: stage.state.fileName,
      order: stage.state.order,
      role: stage.state.role,
      status: stage.state.status,
      warningCount: stage.state.warnings.length,
    });
    return stage;
  }

  async stageSession(role: TState["role"], sources: TSource[]): Promise<SharedRomSourceSession<TSource, TState>> {
    if (!sources.length) throw new RomWeaverError("INVALID_INPUT", `No ${role} source was provided`);
    this.trace?.("source.session.stage.start", {
      role,
      sourceCount: sources.length,
    });
    if (sources.length === 1) {
      const view = await this.stageSource(this.createInitialSource(role, sources[0] as TSource, 0));
      return { role, sources, stages: [view], synthetic: false, view };
    }

    const requests: CandidateSelectionRequest[] = [];
    const directAssets = await prepareMultipleDirectInputAssets(
      sources as never,
      {
        ...this.getExecutionOptions(),
        onCandidatesFound: (request: CandidateSelectionRequest) => requests.push(request),
      } as never,
    );
    this.trace?.("source.session.stage.multi.direct-assets", {
      found: !!directAssets,
      requestCount: requests.length,
      role,
      sourceCount: sources.length,
    });
    if (directAssets) {
      const view = this.createInitialSource(role, sources[0] as TSource, 0, {
        id: this.getSessionId?.(role),
      });
      view.preparedInputAssets = directAssets;
      view.state.status = "ready";
      if (this.getSessionId) view.state.id = this.getSessionId(role);
      view.state.fileName = directAssets[0]?.fileName || view.state.fileName;
      view.state.size = directAssets.reduce((total, asset) => total + asset.size, 0) || view.state.size;
      view.state.sourceSize =
        sources.reduce((total, source) => total + (getBinarySourceSize(source as never) || 0), 0) ||
        view.state.sourceSize;
      this.applyPreparedSourceMetadata(view);
      if (this.clearRequestsWhenSinglePatchableAsset && directAssets.filter((asset) => asset.patchable).length === 1) {
        requests.length = 0;
      }
      for (const request of requests) this.addCandidateRequest(view, request);
      if (!view.state.candidates.length) this.addDirectCandidate(view, 0, view.state.id);
      // A cohesive multi-track disc (one selectable "cue-disc" group whose tracks
      // are parented to it) auto-resolves to the whole disc — no prompt. The
      // prompt only returns when there is genuine ambiguity (e.g. an unrelated
      // extra ROM alongside the disc).
      const automatic = resolveAutomaticSelection(this.createSelectionRequest(view.state));
      if (automatic) {
        view.state.selectedCandidateId = automatic.id;
        view.selectedArchiveEntry = view.internalCandidates.get(automatic.id)?.archiveEntry;
      } else {
        view.state.status = "needsSelection";
      }
      if (view.state.status === "ready") this.applyPreparedSourceMetadata(view);
      return { role, sources, stages: [view], synthetic: false, view };
    }

    // Declare the whole drop's source sizes up front (known synchronously here) so the Rust batch plan
    // sees every file at once. Each source stages independently and reaches the scheduler staggered, so
    // without this the first file would be planned alone and start at the full thread budget; with it,
    // the first job's thread share already reflects the full simultaneous drop.
    this.runtime.noteIoBatch?.(sources.map((source) => Math.max(0, getBinarySourceSize(source as never) || 0)));
    // Independent sources stage concurrently: each `stageSource` runs its own ingest through
    // `runRomWeaverJson`, whose OperationScheduler admits the I/O ops via that Rust plan (memory fit +
    // which jobs overlap) and gates OPFS path exclusivity. Firing them in one tick lets two ROMs
    // extract+checksum at once; the plan serializes back down whenever the combined working set would
    // exhaust the memory ceiling. allSettled preserves input order, so `stages[i]` matches `sources[i]`.
    // A bare Promise.all would surface the first rejection while silently dropping the already-resolved
    // siblings, orphaning their OPFS scratch copies — the caller releases the pre-stage session, which
    // never received them. So on any rejection, release every fulfilled stage's prepared assets here
    // before rethrowing.
    const settled = await Promise.allSettled(
      sources.map((source, index) => this.stageSource(this.createInitialSource(role, source as TSource, index))),
    );
    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<SharedRomStagedSource<TSource, TState>> =>
        result.status === "fulfilled",
    );
    const rejected = settled.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
    if (rejected) {
      this.trace?.("source.session.stage.multi.partial-failure", {
        error: rejected.reason,
        fulfilledCount: fulfilled.length,
        role,
        sourceCount: sources.length,
      });
      const orphanedRuntimeSources = fulfilled.flatMap((result) => this.getRuntimeSourcesForStage(result.value));
      await Promise.all(fulfilled.map((result) => releasePreparedRomSourceAndWait(result.value as never)));
      await this.releaseRuntimeSources(orphanedRuntimeSources);
      throw rejected.reason;
    }
    const stages = fulfilled.map((result) => result.value);
    return this.buildSyntheticSession(role, sources, stages);
  }

  buildSyntheticSession(
    role: TState["role"],
    sources: TSource[],
    stages: Array<SharedRomStagedSource<TSource, TState>>,
  ): SharedRomSourceSession<TSource, TState> {
    const view = this.createInitialSource(role, sources[0] as TSource, 0, {
      id: this.getSessionId?.(role),
    });
    if (this.getSessionId) view.state.id = this.getSessionId(role);
    view.state.candidates = stages.flatMap((stage) => stage.state.candidates.map(cloneCandidate));
    view.internalCandidates = new Map();
    for (const stage of stages) {
      for (const [id, candidate] of stage.internalCandidates) {
        view.internalCandidates.set(id, { ...candidate, owner: stage });
      }
    }
    view.preparedInputAssets = stages.flatMap((stage) => stage.preparedInputAssets || []);
    view.state.sourceSize = stages.reduce((total, stage) => total + (stage.state.sourceSize || 0), 0) || undefined;
    // Same disc auto-resolution as the direct-asset path: a cohesive disc group
    // is staged whole; only genuine ambiguity falls back to a prompt.
    const automatic = resolveAutomaticSelection(this.createSelectionRequest(view.state));
    if (automatic) {
      view.state.selectedCandidateId = automatic.id;
      view.state.status = "ready";
    } else {
      view.state.status = "needsSelection";
    }
    const session = { role, sources, stages, synthetic: true, view };
    this.syncSessionView(session);
    return session;
  }

  async prepareSelectedSource(stage: SharedRomStagedSource<TSource, TState>): Promise<void> {
    const requests: CandidateSelectionRequest[] = [];
    this.trace?.("source.prepare-selected.enter", {
      assetCount: stage.preparedInputAssets?.length || 0,
      candidateId: stage.state.selectedCandidateId,
      fileName: stage.state.fileName,
      order: stage.state.order,
      role: stage.state.role,
      selectedArchiveEntry: stage.selectedArchiveEntry || "",
    });
    try {
      if (!stage.preparedInputAssets?.length) {
        stage.preparedInputAssets = await this.prepareStageAssets(stage, requests, stage.selectedArchiveEntry);
      }
      this.applyPreparedSourceMetadata(stage);
      stage.state.status = "ready";
    } catch (error) {
      // A dismissed interactive prompt is a deliberate cancel, not a recoverable ambiguity — stop
      // rather than re-prompting (which would wedge a worker and strand its staged copy).
      if (isInteractiveSelectionCancelledError(error)) throw createSelectionSkippedError(error);
      if (requests.length && !canRecoverWithCandidateSelection(error, requests)) throw error;
      if (requests.length) {
        this.handleSourceSelectionRequests(stage, requests);
        await this.maybeResolveBlockingStageSelection(stage);
        return;
      }
      throw error;
    }
  }

  async maybeResolveBlockingStageSelection(stage: SharedRomStagedSource<TSource, TState>): Promise<boolean> {
    if (!(stage.state.status === "needsSelection" && !stage.state.selectedCandidateId && stage.state.candidates.length))
      return false;
    const selection = await this.resolveSelectionRequest(this.createSelectionRequest(stage.state));
    if (!selection) return false;
    const owner = stage.internalCandidates.get(selection.id)?.owner || stage;
    this.setSelectedCandidate(owner, selection.id);
    await this.prepareSelectedSource(owner);
    return true;
  }

  async maybeResolveBlockingSessionSelection(session: SharedRomSourceSession<TSource, TState>): Promise<boolean> {
    if (!(session.view.state.status === "needsSelection" && !session.view.state.selectedCandidateId)) return false;
    return this.maybeResolveBlockingSessionSelectionWithRetryGuard(session, new Set<string>());
  }

  syncSessionView(session: SharedRomSourceSession<TSource, TState>): void {
    if (!session.synthetic) return;
    const view = session.view;
    const selectedOwner = this.getSelectedOwner(session);
    view.preparedInputAssets = session.stages.flatMap((stage) => stage.preparedInputAssets || []);
    view.state.selectedCandidateId =
      selectedOwner?.state.selectedCandidateId ||
      (view.state.candidates.filter((candidate) => candidate.selectable).length === 1
        ? view.state.candidates.find((candidate) => candidate.selectable)?.id
        : undefined);
    view.state.status = view.state.selectedCandidateId ? "ready" : "needsSelection";
    view.state.fileName = selectedOwner?.state.fileName || session.stages[0]?.state.fileName;
    view.state.size =
      selectedOwner?.state.size ||
      view.preparedInputAssets?.reduce((total, asset) => total + asset.size, 0) ||
      undefined;
    view.state.sourceSize =
      selectedOwner?.state.sourceSize ||
      session.stages.reduce((total, stage) => total + (stage.state.sourceSize || 0), 0) ||
      undefined;
    view.state.chdMode = selectedOwner?.state.chdMode;
    view.state.decompressionTimeMs = selectedOwner?.state.decompressionTimeMs;
    view.state.wasDecompressed = selectedOwner?.state.wasDecompressed;
    view.parentCompressions = cloneParentCompressions(selectedOwner?.parentCompressions);
    view.state.parentCompressions = cloneParentCompressions(selectedOwner?.parentCompressions);
    if (selectedOwner && "checksums" in selectedOwner.state) view.state.checksums = selectedOwner.state.checksums;
    if (selectedOwner && "checksumVariants" in selectedOwner.state)
      view.state.checksumVariants = selectedOwner.state.checksumVariants;
    if (selectedOwner && "checksumTimeMs" in selectedOwner.state)
      view.state.checksumTimeMs = selectedOwner.state.checksumTimeMs;
    if (selectedOwner && "romProbe" in selectedOwner.state) view.state.romProbe = selectedOwner.state.romProbe;
    if (selectedOwner && "romType" in selectedOwner.state) view.state.romType = selectedOwner.state.romType;
  }

  getSelectedOwner(
    session: SharedRomSourceSession<TSource, TState> | undefined,
  ): SharedRomStagedSource<TSource, TState> | undefined {
    if (!session) return undefined;
    if (!session.synthetic) return session.view;
    const selectedId = session.view.state.selectedCandidateId;
    if (!selectedId) return undefined;
    return session.view.internalCandidates.get(selectedId)?.owner;
  }

  applyPreparedSourceMetadata(stage: SharedRomStagedSource<TSource, TState>): void {
    const assets = stage.preparedInputAssets || [];
    const preparation = getInputPreparationMetrics(assets);
    stage.parentCompressions = normalizeParentCompressions(preparation?.parentCompressions);
    stage.state.parentCompressions = cloneParentCompressions(stage.parentCompressions);
    stage.state.fileName = this.getPreparedFileName(assets[0], stage.state.fileName || stage.state.id);
    stage.state.size = assets.reduce((total, asset) => total + asset.size, 0) || stage.state.size;
    stage.state.sourceSize =
      (typeof preparation?.sourceSize === "number" && Number.isFinite(preparation.sourceSize)
        ? preparation.sourceSize
        : stage.state.sourceSize) || stage.state.size;
    stage.state.chdMode =
      assets.map((asset) => chdModeFromMetadata(asset.file.metadata)).find((mode) => mode) ||
      (assets.some((asset) => asset.file.metadata?.cuePath) ? "cd" : stage.state.chdMode);
    stage.state.decompressionTimeMs =
      typeof preparation?.decompressionTimeMs === "number" && Number.isFinite(preparation.decompressionTimeMs)
        ? preparation.decompressionTimeMs
        : undefined;
    stage.state.wasDecompressed = preparation?.wasDecompressed === true;
  }

  getRuntimeSourcesForStage(stage?: SharedRomStagedSource<TSource, TState>): unknown[] {
    if (!stage) return [];
    return (stage.preparedInputAssets || []).map((asset) => asset.file);
  }

  async releaseSession(session?: SharedRomSourceSession<TSource, TState>): Promise<void> {
    if (!session) return;
    const sessionStages = [...session.stages, ...(session.stages.includes(session.view) ? [] : [session.view])];
    const sources = [...session.sources, ...sessionStages.flatMap((stage) => this.getRuntimeSourcesForStage(stage))];
    await Promise.all(sessionStages.map((stage) => releasePreparedRomSourceAndWait(stage as never)));
    await this.releaseRuntimeSources(sources);
  }

  async releaseRuntimeSources(sources: unknown[]): Promise<void> {
    await this.runtime.workerIo?.releaseSources?.(sources).catch(() => undefined);
  }

  resetStageForSelection(stage: SharedRomStagedSource<TSource, TState>): void {
    stage.state.checksums = undefined;
    stage.state.checksumVariants = undefined;
    stage.state.checksumTimeMs = undefined;
    stage.state.chdMode = undefined;
    stage.state.decompressionTimeMs = undefined;
    stage.state.parentCompressions = [];
    stage.state.romProbe = undefined;
    stage.state.romType = undefined;
    stage.state.selectedCandidateId = undefined;
    stage.state.status = "needsSelection";
    stage.state.wasDecompressed = undefined;
    stage.parentCompressions = [];
  }

  private async maybeResolveBlockingSessionSelectionWithRetryGuard(
    session: SharedRomSourceSession<TSource, TState>,
    attemptedSelectionKeys: Set<string>,
  ): Promise<boolean> {
    if (attemptedSelectionKeys.size >= MAX_SELECTION_RETRY_COUNT)
      throw new RomWeaverError(
        "INVALID_INPUT",
        `${session.view.state.fileName || "Input"} could not be prepared after repeated archive selection attempts`,
      );
    const selection = await this.resolveSelectionRequest(this.createSelectionRequest(session.view.state));
    if (!selection) return false;
    const owner = session.view.internalCandidates.get(selection.id)?.owner || session.view;
    const internalCandidate = owner.internalCandidates.get(selection.id);
    if (!internalCandidate)
      throw new RomWeaverError("SELECTION_NOT_FOUND", `Selection candidate was not found: ${selection.id}`);
    const retryIdentity =
      internalCandidate.archiveEntry ||
      ("fileName" in internalCandidate.candidate ? String(internalCandidate.candidate.fileName || "") : "") ||
      owner.selectedArchiveEntry ||
      owner.state.fileName ||
      owner.state.id;
    const candidateRetryIdentity = String(internalCandidate.candidate.id || "")
      .trim()
      .toLowerCase();
    const normalizedRetryIdentity = (
      candidateRetryIdentity ||
      getBaseFileName(retryIdentity) ||
      String(retryIdentity || owner.state.id)
    ).toLowerCase();
    const selectionRetryKey = `${owner.state.id}:${normalizedRetryIdentity}`;
    if (attemptedSelectionKeys.has(selectionRetryKey))
      throw new RomWeaverError(
        "INVALID_INPUT",
        `${owner.state.fileName || "Input"} could not be prepared after repeated archive selection attempts`,
      );
    attemptedSelectionKeys.add(selectionRetryKey);
    this.setSelectedCandidate(owner, selection.id);
    // Mirror the pick onto the session view. For a synthetic session the owner is a sub-stage, so
    // setSelectedCandidate only marks the stage — getSelectedOwner/syncSessionView resolve the choice
    // through view.state.selectedCandidateId. Without this the view stays needsSelection and the
    // "which ROM?" dialog re-prompts in a loop (broken multi-file input selection).
    session.view.state.selectedCandidateId = selection.id;
    await this.prepareSelectedSource(owner);
    this.syncSessionView(session);
    if (session.view.state.status === "needsSelection" && !session.view.state.selectedCandidateId)
      return this.maybeResolveBlockingSessionSelectionWithRetryGuard(session, attemptedSelectionKeys);
    return true;
  }

  private createPreparationOptions(
    stage: SharedRomStagedSource<TSource, TState>,
    requests: CandidateSelectionRequest[],
  ): Partial<ApplyWorkflowOptions & CreateWorkflowOptions> {
    return {
      ...this.getExecutionOptions(),
      onCandidatesFound: (request: CandidateSelectionRequest) => requests.push(request),
      onProgress: (progress: PreparationProgress) => this.emitPreparationProgress(stage, progress),
    };
  }

  private emitPreparationProgress(stage: SharedRomStagedSource<TSource, TState>, progress: PreparationProgress): void {
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
      workflow: this.workflow,
    });
  }

  private async prepareStageAssets(
    stage: SharedRomStagedSource<TSource, TState>,
    requests: CandidateSelectionRequest[],
    selectedArchiveEntry: string | undefined,
  ): Promise<InputAsset[]> {
    return prepareInputAssets(
      stage.source as never,
      this.createPreparationOptions(stage, requests) as never,
      stage.index,
      this.runtime,
      selectedArchiveEntry,
    );
  }

  private setSelectedCandidate(stage: SharedRomStagedSource<TSource, TState>, candidateId: string): void {
    if (!stage.internalCandidates.has(candidateId))
      throw new RomWeaverError("SELECTION_NOT_FOUND", `Selection candidate was not found: ${candidateId}`);
    if (this.releasePreparedOnSelection === "always" || !stage.preparedInputAssets?.length)
      releasePreparedRomSource(stage as never);
    stage.state.selectedCandidateId = candidateId;
    stage.selectedArchiveEntry = stage.internalCandidates.get(candidateId)?.archiveEntry;
  }

  // A multi-track disc (cue/gdi sheet plus the tracks it groups) is one logical ROM, not an
  // ambiguous set of independent candidates: its tracks all share the sheet's groupId. Treat it
  // as resolved so it collapses into a single disc card with no prompt, matching how a loose
  // bin+cue disc is handled. Genuine ambiguity (an unrelated extra ROM alongside the disc, so the
  // patchable assets do not all share the one sheet group) still falls through to a prompt.
  private isCohesiveDiscGroup(assets: InputAsset[]): boolean {
    const sheetGroupIds = new Set(
      assets
        .filter((asset) => (asset.kind === "cue" || asset.kind === "gdi") && asset.groupId)
        .map((asset) => asset.groupId),
    );
    if (sheetGroupIds.size !== 1) return false;
    const [groupId] = [...sheetGroupIds];
    const patchableAssets = assets.filter((asset) => asset.patchable);
    return patchableAssets.length > 0 && patchableAssets.every((asset) => asset.groupId === groupId);
  }

  private createPreparedAssetSelectionRequest(
    stage: SharedRomStagedSource<TSource, TState>,
  ): CandidateSelectionRequest | null {
    const assets = stage.preparedInputAssets || [];
    if (assets.filter((asset) => asset.patchable).length <= 1) return null;
    if (this.isCohesiveDiscGroup(assets)) return null;
    return {
      candidates: assets.map((asset) => ({
        fileName: asset.fileName,
        id: asset.id,
        kind: asset.kind,
        patchable: asset.patchable,
        path: asset.fileName,
        selectable: asset.patchable,
        size: asset.size,
        type: "file",
      })),
      role: stage.state.role,
      sourceIndex: stage.index,
      sourceName: stage.state.fileName || stage.state.id,
      warnings: stage.state.warnings.map((warning) => warning.message),
    };
  }

  private handleSourceSelectionRequests(
    stage: SharedRomStagedSource<TSource, TState>,
    requests: CandidateSelectionRequest[],
  ) {
    stage.internalCandidates.clear();
    stage.state.candidates = [];
    for (const request of requests) this.addCandidateRequest(stage, request);
    this.resetStageForSelection(stage);
    releasePreparedRomSource(stage as never);
  }

  private addCandidateRequest(stage: SharedRomStagedSource<TSource, TState>, request: CandidateSelectionRequest) {
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

  private addDirectCandidate(stage: SharedRomStagedSource<TSource, TState>, index: number, internalId: string) {
    const publicId = `${this.id}:${stage.state.role}:${++this.nextCandidateSequence}`;
    const candidate: SelectionCandidate = {
      fileName: stage.state.fileName || `${stage.state.role}-${index + 1}`,
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

  private async resolveSelectionRequest(request: CandidateSelectionRequest): Promise<{ id: string } | null> {
    if (!this.selectFile) return null;
    const selection = await this.selectFile({
      ...request,
      candidates: request.candidates.map(cloneCandidate),
      warnings: [...request.warnings],
    });
    return selection?.id ? { id: selection.id } : null;
  }

  private pushWarning(
    stage: SharedRomStagedSource<TSource, TState>,
    error: Error & { code?: string; details?: Record<string, unknown> },
  ) {
    stage.state.warnings.push(
      cloneWarning({
        code: error.code,
        details: error.details,
        message: error.message,
        role: stage.state.role,
      }),
    );
  }
}

export type {
  SharedInternalCandidate,
  SharedRomSourceSession,
  SharedRomStagedSource,
} from "./staged-source-types.ts";
export { StagedRomSourceController };
