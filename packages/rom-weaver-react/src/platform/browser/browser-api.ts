import { ApplyWorkflowController } from "../../lib/workflow/apply-workflow-controller.ts";
import type { ApplyWorkflowInputState, ApplyWorkflowPatchState } from "../../types/apply-workflow.ts";
import type { BrowserSaveDestination } from "../../types/output.ts";
import type { WorkflowProgress } from "../../types/progress.ts";
import type { ApplyResult } from "../../types/public.ts";
import type { ApplySettings, CompressionFormat } from "../../types/settings.ts";
import type { BrowserSourceRef } from "../../types/source.ts";
import type { WorkflowOptions } from "../../types/workflow-public.ts";
import { createPublicSourcesValidator, createPublicSourceValidator } from "../shared/public-source-validation.ts";
import { configureBrowserAssetBaseUrl } from "./browser-asset-base.ts";
import { browserRuntime } from "./workflow-runtime.ts";

const assertPublicSources = createPublicSourcesValidator<BrowserSourceRef>(
  createPublicSourceValidator({ environmentLabel: "browser" }),
);
let runtimePreloadStarted = false;

const startRuntimePreload = () => {
  if (runtimePreloadStarted) return;
  runtimePreloadStarted = true;
  browserRuntime.preload?.preloadCapability?.("compression", () => undefined).catch(() => undefined);
  browserRuntime.preload?.preloadCapability?.("checksum", () => undefined).catch(() => undefined);
};

export type {
  BrowserSaveDestination,
  PublicOutput,
} from "../../types/output.ts";
export type { ProgressSink, WorkflowProgress } from "../../types/progress.ts";
export type {
  ApplyResult,
  BrowserApplyResult,
} from "../../types/public.ts";
export type {
  CandidateSelectionRequest,
  SelectFile,
  SelectionCandidate,
  SelectionFileCandidate,
  SelectionGroupCandidate,
} from "../../types/selection.ts";
export type { ApplySettings } from "../../types/settings.ts";
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
    startRuntimePreload();
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

startRuntimePreload();

export { ApplyWorkflow };
