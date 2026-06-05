import { ApplyWorkflowController } from "../../lib/workflow/apply-workflow-controller.ts";
import { CreateWorkflowController } from "../../lib/workflow/create-workflow-controller.ts";
import { TrimWorkflowController } from "../../lib/workflow/trim-workflow-controller.ts";
import type { ApplyWorkflowInputState, ApplyWorkflowPatchState } from "../../types/apply-workflow.ts";
import type { CreateWorkflowSourceState } from "../../types/create-workflow.ts";
import type { BrowserSaveDestination } from "../../types/output.ts";
import type { WorkflowProgress } from "../../types/progress.ts";
import type { ApplyResult, CreateResult, TrimResult } from "../../types/public.ts";
import type { ApplySettings, CompressionFormat, CreateSettings, WorkerSettings } from "../../types/settings.ts";
import type { BrowserSourceRef } from "../../types/source.ts";
import type { TrimWorkflowSourceState } from "../../types/trim-workflow.ts";
import type { RuntimePatchCreateFormatCandidates } from "../../types/workflow-runtime-adapter.ts";
import type { WorkflowOptions } from "../../types/workflow-public.ts";
import { createPublicSourcesValidator, createPublicSourceValidator } from "../shared/public-source-validation.ts";
import { configureBrowserAssetBaseUrl } from "./browser-asset-base.ts";
import { scheduleBrowserRuntimeWarmupExtraction } from "./browser-runtime-warmup.ts";
import { browserRuntime } from "./workflow-runtime.ts";

const assertPublicSources = createPublicSourcesValidator<BrowserSourceRef>(
  createPublicSourceValidator({ environmentLabel: "browser" }),
);
type BrowserRuntimePreloadOptions = {
  workerThreads?: WorkerSettings["threads"] | null;
};
type BrowserCreatePatchFormatCandidatesInput = {
  assetBaseUrl?: string;
  original: BrowserSourceRef;
  modified: BrowserSourceRef;
  workerThreads?: WorkerSettings["threads"] | null;
  settings?: Partial<CreateSettings>;
};

const runtimePreloadKeys = new Set<string>();
type BrowserWorkflowController<TResult> = {
  readonly id: string;
  on(event: "progress", listener: (event: WorkflowProgress) => void): void;
  off(event: "progress", listener: (event: WorkflowProgress) => void): void;
  run(): Promise<TResult>;
  abort(reason?: unknown): void;
  dispose(): Promise<void>;
};

const getRuntimePreloadKey = (workerThreads: BrowserRuntimePreloadOptions["workerThreads"]) => {
  const normalized = String(workerThreads ?? "").trim();
  if (normalized === "auto") return "default";
  return normalized ? `threads:${normalized}` : "default";
};

const preloadBrowserRuntime = (options: BrowserRuntimePreloadOptions = {}) => {
  const preloadKey = getRuntimePreloadKey(options.workerThreads);
  if (runtimePreloadKeys.has(preloadKey)) return Promise.resolve();
  runtimePreloadKeys.add(preloadKey);
  const preloadOptions = preloadKey === "default" ? undefined : { workerThreads: options.workerThreads };
  return Promise.all([
    browserRuntime.preload?.preloadCapability?.("compression", () => undefined, preloadOptions),
    browserRuntime.preload?.preloadCapability?.("checksum", () => undefined, preloadOptions),
  ])
    .then(() => {
      // Runner init (above) warms the WASM module, worker pool, and scratch pool. Schedule one silent
      // dummy extraction at idle so the decode-path JIT and first OPFS input/output handle opens are
      // warm too, so the user's first real extraction starts at steady state.
      scheduleBrowserRuntimeWarmupExtraction();
    })
    .catch(() => {
      runtimePreloadKeys.delete(preloadKey);
    })
    .then(() => undefined);
};

const getCreatePatchFormatCandidates = async ({
  assetBaseUrl,
  modified,
  original,
  settings,
  workerThreads,
}: BrowserCreatePatchFormatCandidatesInput): Promise<RuntimePatchCreateFormatCandidates> => {
  configureBrowserAssetBaseUrl(assetBaseUrl);
  assertPublicSources([original, modified]);
  const candidates = await browserRuntime.patch.createPatchCandidates?.({
    logLevel: settings?.logging?.level,
    modified,
    onLog: settings?.logging?.sink,
    original,
    workerThreads: workerThreads ?? settings?.workers?.threads,
  });
  if (!candidates) throw new Error("Create patch candidate selection is unavailable");
  return candidates;
};

abstract class BrowserWorkflowBase<TResult, TController extends BrowserWorkflowController<TResult>> {
  protected abstract readonly controller: TController;

  get id() {
    return this.controller.id;
  }

  on(event: "progress", listener: (event: WorkflowProgress) => void): void {
    this.controller.on(event, listener);
  }

  off(event: "progress", listener: (event: WorkflowProgress) => void): void {
    this.controller.off(event, listener);
  }

  run(): Promise<TResult> {
    return this.controller.run();
  }

  abort(reason?: unknown): void {
    this.controller.abort(reason);
  }

  dispose(): Promise<void> {
    return this.controller.dispose();
  }
}

class CreateWorkflow extends BrowserWorkflowBase<
  CreateResult<BrowserSaveDestination>,
  CreateWorkflowController<BrowserSourceRef, BrowserSaveDestination>
> {
  protected readonly controller: CreateWorkflowController<BrowserSourceRef, BrowserSaveDestination>;

  constructor(options: WorkflowOptions<CreateSettings> = {}) {
    super();
    configureBrowserAssetBaseUrl(options.assetBaseUrl);
    void preloadBrowserRuntime({ workerThreads: options.settings?.workers?.threads });
    this.controller = new CreateWorkflowController(browserRuntime, options, assertPublicSources);
  }

  setOriginal(source: BrowserSourceRef | BrowserSourceRef[]): Promise<void> {
    return this.controller.setOriginal(source);
  }

  getOriginal(): CreateWorkflowSourceState | null {
    return this.controller.getOriginal();
  }

  setModified(source: BrowserSourceRef | BrowserSourceRef[]): Promise<void> {
    return this.controller.setModified(source);
  }

  getModified(): CreateWorkflowSourceState | null {
    return this.controller.getModified();
  }

  setPatchType(patchType: NonNullable<CreateSettings["format"]>): Promise<void> {
    return this.controller.setPatchType(patchType);
  }

  setOutputName(name: string): Promise<void> {
    return this.controller.setOutputName(name);
  }

  setSettings(settings: Partial<CreateSettings>): Promise<void> {
    return this.controller.setSettings(settings);
  }
}

export type { BrowserSaveDestination, PublicOutput } from "../../types/output.ts";
export type { BrowserCreatePatchFormatCandidatesInput, RuntimePatchCreateFormatCandidates };
export type { ProgressSink, WorkflowProgress } from "../../types/progress.ts";
export type {
  ApplyResult,
  BrowserApplyResult,
  BrowserCreateResult,
  BrowserTrimResult,
  CreateResult,
  TrimResult,
} from "../../types/public.ts";
export type {
  CandidateSelectionRequest,
  SelectFile,
  SelectionCandidate,
  SelectionFileCandidate,
  SelectionGroupCandidate,
} from "../../types/selection.ts";
export type { ApplySettings, CreateSettings } from "../../types/settings.ts";
export type {
  BrowserSourceObject,
  BrowserSourceRef,
  SourceObject,
  SourceRef,
} from "../../types/source.ts";

class ApplyWorkflow extends BrowserWorkflowBase<
  ApplyResult<BrowserSaveDestination>,
  ApplyWorkflowController<BrowserSourceRef, BrowserSaveDestination>
> {
  protected readonly controller: ApplyWorkflowController<BrowserSourceRef, BrowserSaveDestination>;

  constructor(options: WorkflowOptions<ApplySettings> = {}) {
    super();
    configureBrowserAssetBaseUrl(options.assetBaseUrl);
    void preloadBrowserRuntime({ workerThreads: options.settings?.workers?.threads });
    this.controller = new ApplyWorkflowController(browserRuntime, options, assertPublicSources);
  }

  setInput(input: BrowserSourceRef | BrowserSourceRef[]): Promise<void> {
    return this.controller.setInput(input);
  }

  clearInput(): Promise<void> {
    return this.controller.clearInput();
  }

  getInput(): ApplyWorkflowInputState | null {
    return this.controller.getInput();
  }

  addPatch(patch: BrowserSourceRef): Promise<void> {
    return this.controller.addPatch(patch);
  }

  clearPatches(): Promise<void> {
    return this.controller.clearPatches();
  }

  getPatches(): ApplyWorkflowPatchState[] {
    return this.controller.getPatches();
  }

  setSettings(settings: Partial<ApplySettings>): Promise<void> {
    return this.controller.setSettings(settings);
  }

  setOutputName(name: string): Promise<void> {
    return this.controller.setOutputName(name);
  }

  setOutputFormat(format: CompressionFormat): Promise<void> {
    return this.controller.setOutputFormat(format);
  }

  setPatchTarget(index: number, targetInputId: string | "auto"): Promise<void> {
    return this.controller.setPatchTarget(index, targetInputId);
  }
}

class TrimWorkflow extends BrowserWorkflowBase<
  TrimResult<BrowserSaveDestination>,
  TrimWorkflowController<BrowserSourceRef, BrowserSaveDestination>
> {
  protected readonly controller: TrimWorkflowController<BrowserSourceRef, BrowserSaveDestination>;

  constructor(options: WorkflowOptions<CreateSettings> = {}) {
    super();
    configureBrowserAssetBaseUrl(options.assetBaseUrl);
    void preloadBrowserRuntime({ workerThreads: options.settings?.workers?.threads });
    this.controller = new TrimWorkflowController(browserRuntime, options, assertPublicSources);
  }

  setInput(source: BrowserSourceRef | BrowserSourceRef[]): Promise<void> {
    return this.controller.setInput(source);
  }

  getInput(): TrimWorkflowSourceState | null {
    return this.controller.getInput();
  }

  setOutputName(name: string): Promise<void> {
    return this.controller.setOutputName(name);
  }

  setOutputFormat(format: string): Promise<void> {
    return this.controller.setOutputFormat(format);
  }
}

export { ApplyWorkflow, CreateWorkflow, getCreatePatchFormatCandidates, preloadBrowserRuntime, TrimWorkflow };
