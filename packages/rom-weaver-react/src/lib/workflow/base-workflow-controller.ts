import type { WorkflowKind, WorkflowProgress } from "../../types/progress.ts";
import type { SelectedInputInfo } from "../../types/public.ts";
import type { SelectionCandidate } from "../../types/selection.ts";
import type { CommonSettings } from "../../types/settings.ts";
import type { WorkflowOptions, WorkflowWarning } from "../../types/workflow-controller.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { RomWeaverError, throwIfAborted, toRomWeaverError } from "../errors.ts";
import { cloneValue, createWorkflowId, createWorkflowProgress } from "./controller-utils.ts";
import { StagedRomSourceController } from "./staged-rom-source.ts";
import type { SharedRomSourceState, StagedRomSourceControllerOptions } from "./staged-source-types.ts";
import { WorkflowController } from "./workflow-controller.ts";
import { traceWorkflowControllerEvent } from "./workflow-tracing.ts";

type SourceValidator<TSource> = (sources: TSource | TSource[] | undefined) => void;

/** Progress event accepted by {@link BaseWorkflowController.emitProgress}. The `workflow`
 * discriminator is optional here because the base always overrides it with `this.workflow`. */
type WorkflowProgressEvent = Omit<Parameters<typeof createWorkflowProgress>[1], "workflow"> & {
  workflow?: WorkflowProgress["workflow"];
};

/** The per-controller fields of a {@link StagedRomSourceController}; the base fills the rest. */
type StagedControllerOverrides<TState extends SharedRomSourceState> = Pick<
  StagedRomSourceControllerOptions<TState>,
  "getExecutionOptions" | "getSourceId"
> &
  Partial<
    Pick<
      StagedRomSourceControllerOptions<TState>,
      "getPreparedFileName" | "getSessionId" | "releasePreparedOnSelection"
    >
  >;

/** Minimal staged-source shape needed to build a {@link SelectedInputInfo}. */
type SelectableStagedSource = {
  state: {
    candidates: SelectionCandidate[];
    fileName?: string;
    id: string;
    selectedCandidateId?: string;
    size?: number;
  };
};

/** Minimal staged-source shape needed to record a warning. */
type WarnableStagedSource = {
  state: {
    role: WorkflowWarning["role"];
    warnings: WorkflowWarning[];
  };
};

/** Fields every workflow snapshot exposes; each controller extends this with its source/output state. */
type BaseWorkflowSnapshot = {
  /** Stable workflow id (mirrors {@link BaseWorkflowController.id}). */
  id: string;
  /** True while any mutation (a `set...` call or `run`) is queued or executing. */
  busy: boolean;
  /** True when {@link BaseWorkflowController.run} can be called without a validation error. */
  ready: boolean;
};

/**
 * Shared machinery for the trim/create/apply workflow controllers: identity, settings,
 * abort/dispose lifecycle, progress emission, tracing, mutation queuing, the common
 * staged-source-controller wiring, and a `useSyncExternalStore`-friendly reactive snapshot
 * ({@link subscribe} + {@link getSnapshot}). Subclasses keep only their workflow-specific source
 * cardinality, output naming, execution options, run logic, and {@link computeSnapshot}.
 */
abstract class BaseWorkflowController<
  TSource,
  TSettings extends CommonSettings,
  TSnapshot extends BaseWorkflowSnapshot,
> extends WorkflowController<{
  change: void;
  progress: WorkflowProgress;
}> {
  readonly id: string;
  protected readonly runtime: WorkflowRuntime;
  protected readonly validateSources?: SourceValidator<TSource>;
  protected readonly constructorSignal?: AbortSignal;
  protected readonly selectFile?: WorkflowOptions<TSettings>["selectFile"];
  protected readonly workflow: WorkflowKind;
  protected abortController = new AbortController();
  protected disposed = false;
  protected activeMutation: string | null = null;
  protected mutationQueue: Promise<void> | null = null;
  protected progressSequence = 0;
  protected settings: Partial<TSettings>;
  private cachedSnapshot?: TSnapshot;
  private snapshotDirty = true;
  /** Single-modal mutex for interactive selection dialogs. The candidate-selection UI holds exactly
   * one open dialog at a time, so two `selectFile` calls must never overlap. {@link selectFile} is
   * wrapped to run through this lock, so every actual dialog serializes while auto-resolved
   * (no-dialog) selections never block. This lets an eagerly-surfaced patch dialog open as soon as it
   * is ready - gated only behind another open dialog - rather than behind a whole mutation. */
  private selectionLock: Promise<void> = Promise.resolve();

  constructor(
    workflow: WorkflowKind,
    runtime: WorkflowRuntime,
    options: WorkflowOptions<TSettings> = {},
    validateSources?: SourceValidator<TSource>,
  ) {
    super();
    this.workflow = workflow;
    this.runtime = runtime;
    this.validateSources = validateSources;
    this.id = options.id || createWorkflowId();
    this.settings = cloneValue(options.settings || {});
    this.constructorSignal = options.signal;
    // Serialize every actual selection dialog through the single-modal lock at the one place
    // `selectFile` enters the controller, so all callers (this controller and its staged
    // sub-controllers) share one modal without each having to remember to lock.
    const rawSelectFile = options.selectFile;
    this.selectFile = rawSelectFile
      ? (request) => this.withSelectionLock(() => Promise.resolve(rawSelectFile(request)))
      : undefined;
    if (options.signal?.aborted) this.abortController.abort(options.signal.reason);
    else options.signal?.addEventListener("abort", () => this.abort(options.signal?.reason), { once: true });
  }

  abort(reason?: unknown): void {
    if (!this.abortController.signal.aborted) this.abortController.abort(reason);
  }

  /** Run a selection dialog under the single-modal lock (see {@link selectionLock}). Only the dialog
   * is serialized - the caller's surrounding work runs unlocked. */
  private async withSelectionLock<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.selectionLock;
    let release!: () => void;
    this.selectionLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
    }
  }

  /**
   * Subscribe to staged-state changes (the `change` event fires whenever a mutation starts or
   * settles). Returns an unsubscribe function. Pair with {@link getSnapshot} for
   * `useSyncExternalStore`. Note: high-frequency run progress is delivered via the separate
   * `progress` event, not `change`, so the snapshot identity stays stable during a run.
   */
  subscribe(listener: () => void): () => void {
    this.on("change", listener);
    return () => this.off("change", listener);
  }

  /** Immutable view of the current staged state. The same object identity is returned until the
   * next `change`, so it is safe as a `useSyncExternalStore` snapshot. */
  getSnapshot(): TSnapshot {
    if (!this.snapshotDirty && this.cachedSnapshot !== undefined) return this.cachedSnapshot;
    const snapshot = this.computeSnapshot();
    this.cachedSnapshot = snapshot;
    this.snapshotDirty = false;
    return snapshot;
  }

  /** Build the controller-specific snapshot. Called lazily by {@link getSnapshot} and recomputed
   * after each `change`. */
  protected abstract computeSnapshot(): TSnapshot;

  /** Invalidate the cached snapshot and notify subscribers. */
  protected emitChange(): void {
    this.snapshotDirty = true;
    this.trigger("change", undefined);
  }

  /** True while a mutation is queued or executing. */
  protected isBusy(): boolean {
    return this.activeMutation !== null || this.mutationQueue !== null;
  }

  protected trace(message: string, details: Record<string, unknown> = {}): void {
    traceWorkflowControllerEvent(this.traceContext(), message, details);
  }

  private traceContext() {
    return {
      logLevel: this.settings.logging?.level,
      onLog: this.settings.logging?.sink,
      workflow: this.workflow,
      workflowId: this.id,
    };
  }

  protected emitProgress(event: WorkflowProgressEvent): void {
    this.trigger("progress", createWorkflowProgress(++this.progressSequence, { ...event, workflow: this.workflow }));
  }

  /** Build a {@link StagedRomSourceController} with the common wiring, merging per-controller overrides. */
  protected createStagedController<TState extends SharedRomSourceState>(
    overrides: StagedControllerOverrides<TState>,
  ): StagedRomSourceController<TSource, TState> {
    return new StagedRomSourceController<TSource, TState>({
      clearRequestsWhenSinglePatchableAsset: true,
      emitProgress: (event) => this.emitProgress(event),
      getPreparedFileName: (asset, fallback) => asset?.fileName || fallback,
      id: this.id,
      runtime: this.runtime,
      selectFile: this.selectFile,
      trace: (message, details) => this.trace(message, details),
      workflow: this.workflow,
      ...overrides,
    });
  }

  protected assertCanStartOperation(): void {
    if (this.disposed) throw new RomWeaverError("WORKFLOW_DISPOSED", "Workflow has been disposed");
    throwIfAborted(this.abortController.signal);
    throwIfAborted(this.constructorSignal);
  }

  /** Reject concurrent operations (trim's semantics: one mutation at a time). */
  protected async runExclusiveMutation<TValue>(operation: string, callback: () => Promise<TValue>): Promise<TValue> {
    this.assertCanStartOperation();
    if (this.activeMutation) {
      throw new RomWeaverError("WORKFLOW_BUSY", "Workflow is already running another operation", {
        details: { activeOperation: this.activeMutation, operation },
      });
    }
    this.activeMutation = operation;
    this.emitChange();
    try {
      return await callback();
    } finally {
      this.activeMutation = null;
      this.emitChange();
    }
  }

  /** Serialize operations through a promise chain (create/apply semantics). */
  protected async runQueuedMutation<TValue>(
    operation: string,
    callback: () => Promise<TValue>,
    opts: { rearmAbort?: boolean; wrapErrors?: boolean } = {},
  ): Promise<TValue> {
    const execute = async () => {
      this.assertCanStartOperation();
      const operationSignal = this.abortController.signal;
      this.activeMutation = operation;
      try {
        return await callback();
      } catch (error) {
        if (opts.wrapErrors) throw toRomWeaverError(error);
        throw error;
      } finally {
        this.activeMutation = null;
        if (opts.rearmAbort) this.rearmAbortController(operationSignal);
        this.emitChange();
      }
    };
    const previousMutation = this.mutationQueue;
    const run = previousMutation ? previousMutation.catch(() => undefined).then(execute) : execute();
    const queued = run.then(
      () => undefined,
      () => undefined,
    );
    this.mutationQueue = queued;
    this.emitChange();
    queued.finally(() => {
      if (this.mutationQueue === queued) {
        this.mutationQueue = null;
        this.emitChange();
      }
    });
    return run;
  }

  protected rearmAbortController(operationSignal: AbortSignal): void {
    if (!operationSignal.aborted || this.abortController.signal !== operationSignal) return;
    if (this.disposed || this.constructorSignal?.aborted) return;
    this.abortController = new AbortController();
  }

  protected toSelectedInputInfo(source: SelectableStagedSource, fallback = "input"): SelectedInputInfo {
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

  protected pushWarning(
    stage: WarnableStagedSource,
    error: Error & { code?: string; details?: Record<string, unknown> },
  ): void {
    stage.state.warnings.push({
      code: error.code,
      details: error.details,
      message: error.message,
      role: stage.state.role,
    });
  }
}

export type { BaseWorkflowSnapshot, SourceValidator, WorkflowProgressEvent };
export { BaseWorkflowController };
