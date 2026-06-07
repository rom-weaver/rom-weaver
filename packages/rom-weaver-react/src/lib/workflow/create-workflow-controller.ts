import { ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY } from "rom-weaver-wasm/format-metadata";

import type { CreateWorkflowParentCompression, CreateWorkflowSourceState } from "../../types/create-workflow.ts";
import type { WorkflowProgress } from "../../types/progress.ts";
import type { CreateResult, SelectedInputInfo } from "../../types/public.ts";
import type { SelectionCandidate } from "../../types/selection.ts";
import type { CreateSettings, PatchFormat } from "../../types/settings.ts";
import type { WorkflowOptions, WorkflowWarning } from "../../types/workflow-controller.ts";
import type { CreatePatchInput, CreateWorkflowOptions } from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import {
  createPatchFormatSupportsCreateSizes,
  getCreatePatchFormatSizeErrorMessage,
  normalizeCreatePatchFormat,
} from "../create/patch-format-limits.ts";
import { createWorkflowDeps, runCreateWorkflow } from "../create/workflow.ts";
import { RomWeaverError, throwIfAborted, withAbortSignal } from "../errors.ts";
import { getFileNameWithoutExtension } from "../input/path-utils.ts";
import { wrapPublicOutput } from "../output/index.ts";
import {
  cloneCandidate,
  cloneValue,
  cloneWarning,
  createWorkflowId,
  createWorkflowProgress,
  getPreparationProgressStage,
  isRecord,
} from "./controller-utils.ts";
import {
  type SharedRomSourceSession,
  type SharedRomStagedSource,
  StagedRomSourceController,
} from "./staged-rom-source.ts";
import {
  calculateStandardInputChecksumsForFile,
  getAssetDecompressionTimeMs,
  getAssetParentCompressions,
  getAssetSourceSize,
  getInputAssetChecksums,
  getPatchFilePrecomputedChecksums,
  getPrimaryInputAsset,
  isChecksummableInputAsset,
  type StandardWorkflowChecksums,
} from "./staged-source-checksums.ts";
import { WorkflowController } from "./workflow-controller.ts";
import { traceWorkflowControllerEvent } from "./workflow-tracing.ts";

type SourceValidator<TSource> = (sources: TSource | TSource[] | undefined) => void;
type SourceRole = "modified" | "original";
type SourceStatus = CreateWorkflowSourceState["status"];
type ParentCompression = CreateWorkflowParentCompression;
type CreateWorkflowChecksums = StandardWorkflowChecksums;
type InternalSourceState = {
  id: string;
  fileName?: string;
  status: SourceStatus;
  candidates: SelectionCandidate[];
  parentCompressions: ParentCompression[];
  selectedCandidateId?: string;
  size?: number;
  sourceSize?: number;
  checksums?: CreateWorkflowChecksums;
  checksumTimeMs?: number;
  decompressionTimeMs?: number;
  wasDecompressed?: boolean;
  warnings: WorkflowWarning[];
  role: SourceRole;
};
type StagedSource<TSource> = SharedRomStagedSource<TSource, InternalSourceState>;
type SourceSession<TSource> = SharedRomSourceSession<TSource, InternalSourceState>;

const SUPPORTED_CREATE_PATCH_TYPES = new Set<PatchFormat | string>(
  ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.supportedCreateFormats,
);
const CREATE_OUTPUT_FORMATS = new Set(["7z", "none", "zip"]);

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
        selectedCandidateId: state.selectedCandidateId,
        size: state.size,
        sourceSize: state.sourceSize,
        status: state.status,
        warnings: state.warnings.map(cloneWarning),
        wasDecompressed: state.wasDecompressed,
      } satisfies CreateWorkflowSourceState)
    : null;

class CreateWorkflowController<TSource, TDestination> extends WorkflowController<{ progress: WorkflowProgress }> {
  readonly id: string;
  protected readonly runtime: WorkflowRuntime;
  protected readonly validateSources?: SourceValidator<TSource>;
  private readonly abortController = new AbortController();
  private readonly constructorSignal?: AbortSignal;
  private readonly selectFile?: WorkflowOptions<CreateSettings>["selectFile"];
  private readonly sourceStages: StagedRomSourceController<TSource, InternalSourceState>;
  private disposed = false;
  private activeMutation: string | null = null;
  private mutationQueue: Promise<void> | null = null;
  private progressSequence = 0;
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
    this.sourceStages = new StagedRomSourceController<TSource, InternalSourceState>({
      clearRequestsWhenSinglePatchableAsset: true,
      emitProgress: (event) => this.emitProgress(event),
      getExecutionOptions: () => this.createExecutionOptions(),
      getPreparedFileName: (asset, fallback) => asset?.fileName || fallback,
      getSessionId: (role) => role,
      getSourceId: (role, index) => `${role}-${index + 1}`,
      id: this.id,
      releasePreparedOnSelection: "when-empty",
      runtime: this.runtime,
      selectFile: this.selectFile,
      trace: (message, details = {}) =>
        traceWorkflowControllerEvent(
          {
            logLevel: this.settings.logging?.level,
            onLog: this.settings.logging?.sink,
            workflow: "create",
            workflowId: this.id,
          },
          message,
          details,
        ),
      workflow: "create",
    });
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
      if (!createPatchFormatSupportsCreateSizes(patchType, original.state.size, modified.state.size)) {
        throw new RomWeaverError(
          "UNSUPPORTED_FORMAT",
          getCreatePatchFormatSizeErrorMessage(patchType, original.state.size, modified.state.size) ||
            `Unsupported patch type for create input sizes: ${patchType}`,
        );
      }
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
    const execute = async () => {
      if (this.disposed) throw new RomWeaverError("WORKFLOW_DISPOSED", "Workflow has been disposed");
      throwIfAborted(this.abortController.signal);
      throwIfAborted(this.constructorSignal);
      this.activeMutation = operation;
      try {
        return await callback();
      } finally {
        this.activeMutation = null;
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
        const session = (await this.sourceStages.stageSession(role, sources, {
          allowLazyBrowserRomSource: true,
        })) as SourceSession<TSource>;
        if (role === "original") this.originalSession = session;
        else this.modifiedSession = session;
        await this.sourceStages.maybeResolveBlockingSessionSelection(session);
        await this.finalizeSourceStableState(session);
        if (!this.manualOutputName) this.outputName = this.buildAutomaticOutputName();
      } catch (error) {
        await this.releaseRoleSession(role);
        await this.sourceStages.releaseRuntimeSources(sources);
        throw error;
      }
    });
  }

  private syncSourceSessionView(session: SourceSession<TSource>) {
    this.sourceStages.syncSessionView(session);
  }

  private getSelectedSourceOwner(session: SourceSession<TSource> | undefined): StagedSource<TSource> | undefined {
    return this.sourceStages.getSelectedOwner(session) as StagedSource<TSource> | undefined;
  }

  private async finalizeSourceStableState(session: SourceSession<TSource>) {
    const selected = this.getSelectedSourceOwner(session);
    if (!(selected && session.view.state.status === "ready" && selected.preparedInputAssets?.[0]?.file)) return;
    const checksumStages = session.synthetic ? session.stages : [selected];
    for (let index = 0; index < checksumStages.length; index += 1) {
      const stage = checksumStages[index] as StagedSource<TSource> | undefined;
      if (!(stage && stage.state.status === "ready" && stage.preparedInputAssets?.[0]?.file)) continue;
      const assets = stage.preparedInputAssets || [];
      for (let assetIndex = 0; assetIndex < assets.length; assetIndex += 1) {
        const asset = assets[assetIndex];
        if (!(asset?.file && isChecksummableInputAsset(asset))) continue;
        if (asset.checksums) continue;
        const precomputed = getPatchFilePrecomputedChecksums(asset.file);
        if (precomputed) {
          asset.checksums = precomputed;
          asset.checksumTimeMs = 0;
          continue;
        }
        const checksumFileName = asset.fileName || stage.state.fileName || stage.state.id;
        const checksumStartedAt = Date.now();
        const checksumResult = await calculateStandardInputChecksumsForFile({
          emitProgress: (event) => this.emitProgress(event),
          file: asset.file,
          logLevel: this.settings.logging?.level,
          onLog: this.settings.logging?.sink,
          progressId: session.synthetic
            ? `${this.id}:${stage.state.id}:${index}:${assetIndex}`
            : `${this.id}:${stage.state.id}:${assetIndex}`,
          role: stage.state.role,
          runtime: this.runtime,
          state: {
            decompressionTimeMs: getAssetDecompressionTimeMs(asset, stage.state.decompressionTimeMs),
            fileName: checksumFileName,
            id: stage.state.id,
            order: assetIndex,
            parentCompressions: getAssetParentCompressions(asset, stage.parentCompressions),
            size: asset.size,
            sourceSize: getAssetSourceSize(asset, stage.state.sourceSize),
            wasDecompressed: asset.preparation?.wasDecompressed ?? stage.state.wasDecompressed,
          },
          workflow: "create",
        });
        asset.checksums = checksumResult.checksums;
        asset.romProbe = checksumResult.romProbe;
        asset.checksumTimeMs = Date.now() - checksumStartedAt;
      }
      const primaryAsset = getPrimaryInputAsset(assets);
      const primaryChecksums = getInputAssetChecksums(primaryAsset);
      if (primaryChecksums) {
        stage.state.checksums = primaryChecksums;
        stage.state.checksumTimeMs = primaryAsset?.checksumTimeMs;
      }
    }
    if (session.synthetic) this.syncSourceSessionView(session);
  }

  private getPreparedPatchSource(stage: StagedSource<TSource>): unknown | undefined {
    return (
      (stage.preparedInputAssets || []).find((asset) => asset.patchable)?.file || stage.preparedInputAssets?.[0]?.file
    );
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
    await this.sourceStages.releaseSession(session);
  }

  private getPatchType() {
    return normalizeCreatePatchFormat(String(this.patchType || this.settings.format || "bps"));
  }

  private getOutputCompression() {
    const compression = this.settings.output?.compression || "none";
    if (!CREATE_OUTPUT_FORMATS.has(String(compression))) {
      throw new RomWeaverError("INVALID_SETTINGS", `Unsupported create output compression: ${compression}`);
    }
    return compression as "7z" | "none" | "zip";
  }

  private buildAutomaticOutputName() {
    const modified = this.getModified();
    const original = this.getOriginal();
    const sourceFileName = modified?.fileName || original?.fileName;
    if (!sourceFileName) return this.outputName;
    const baseName = getFileNameWithoutExtension(sourceFileName) || "patch";
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
          else if (progress.stage === "create") stage = "create";
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
