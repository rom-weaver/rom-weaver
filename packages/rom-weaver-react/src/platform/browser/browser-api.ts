import { ApplyWorkflowController } from "../../lib/workflow/apply-workflow-controller.ts";
import { CreateWorkflowController } from "../../lib/workflow/create-workflow-controller.ts";
import type { ApplyWorkflowInputState, ApplyWorkflowPatchState } from "../../types/apply-workflow.ts";
import type { CreateWorkflowSourceState } from "../../types/create-workflow.ts";
import type { BrowserSaveDestination } from "../../types/output.ts";
import type { WorkflowProgress } from "../../types/progress.ts";
import type { ApplyResult, CreateResult } from "../../types/public.ts";
import type { ApplySettings, CompressionFormat, CreateSettings, WorkerSettings } from "../../types/settings.ts";
import type { BrowserSourceRef } from "../../types/source.ts";
import type { WorkflowOptions } from "../../types/workflow-public.ts";
import { createPublicSourcesValidator, createPublicSourceValidator } from "../shared/public-source-validation.ts";
import { configureBrowserAssetBaseUrl } from "./browser-asset-base.ts";
import { browserRuntime } from "./workflow-runtime.ts";

const assertPublicSources = createPublicSourcesValidator<BrowserSourceRef>(
  createPublicSourceValidator({ environmentLabel: "browser" }),
);
type BrowserRuntimePreloadOptions = {
  workerThreads?: WorkerSettings["threads"] | null;
};

const runtimePreloadKeys = new Set<string>();

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
    .catch(() => {
      runtimePreloadKeys.delete(preloadKey);
    })
    .then(() => undefined);
};

class CreateWorkflow {
  private readonly controller: CreateWorkflowController<BrowserSourceRef, BrowserSaveDestination>;

  constructor(options: WorkflowOptions<CreateSettings> = {}) {
    configureBrowserAssetBaseUrl(options.assetBaseUrl);
    void preloadBrowserRuntime({ workerThreads: options.settings?.workers?.threads });
    this.controller = new CreateWorkflowController(browserRuntime, options, assertPublicSources);
  }

  get id() {
    return this.controller.id;
  }

  on(event: "progress", listener: (event: WorkflowProgress) => void): void {
    this.controller.on(event, listener);
  }

  off(event: "progress", listener: (event: WorkflowProgress) => void): void {
    this.controller.off(event, listener);
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

  run(): Promise<CreateResult<BrowserSaveDestination>> {
    return this.controller.run();
  }

  abort(reason?: unknown): void {
    this.controller.abort(reason);
  }

  dispose(): Promise<void> {
    return this.controller.dispose();
  }
}

export type {
  BrowserSaveDestination,
  PublicOutput,
} from "../../types/output.ts";
export type { ProgressSink, WorkflowProgress } from "../../types/progress.ts";
export type {
  ApplyResult,
  BrowserApplyResult,
  BrowserCreateResult,
  CreateResult,
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

class ApplyWorkflow {
  private readonly controller: ApplyWorkflowController<BrowserSourceRef, BrowserSaveDestination>;

  constructor(options: WorkflowOptions<ApplySettings> = {}) {
    configureBrowserAssetBaseUrl(options.assetBaseUrl);
    void preloadBrowserRuntime({ workerThreads: options.settings?.workers?.threads });
    this.controller = new ApplyWorkflowController(browserRuntime, options, assertPublicSources);
  }

  get id() {
    return this.controller.id;
  }

  on(event: "progress", listener: (event: WorkflowProgress) => void): void {
    this.controller.on(event, listener);
  }

  off(event: "progress", listener: (event: WorkflowProgress) => void): void {
    this.controller.off(event, listener);
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

  run(): Promise<ApplyResult<BrowserSaveDestination>> {
    return this.controller.run();
  }

  abort(reason?: unknown): void {
    this.controller.abort(reason);
  }

  dispose(): Promise<void> {
    return this.controller.dispose();
  }
}

export { ApplyWorkflow, CreateWorkflow, preloadBrowserRuntime };
