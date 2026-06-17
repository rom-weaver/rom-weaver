import { ApplyWorkflowController } from "../../lib/workflow/apply-workflow-controller.ts";
import { CreateWorkflowController } from "../../lib/workflow/create-workflow-controller.ts";
import { TrimWorkflowController } from "../../lib/workflow/trim-workflow-controller.ts";
import type { BrowserSaveDestination } from "../../types/output.ts";
import type { ApplySettings, CreateSettings, WorkerSettings } from "../../types/settings.ts";
import type { BrowserSourceRef } from "../../types/source.ts";
import type { WorkflowOptions } from "../../types/workflow-public.ts";
import type { RuntimePatchCreateFormatCandidates } from "../../types/workflow-runtime-adapter.ts";
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

// The public browser workflows ARE their UI-agnostic controllers — a thin subclass adds only the
// browser binding (asset-base config + runtime pre-warm + browserRuntime/source-validation wiring).
// All staging/run/progress/`subscribe`/`getSnapshot` methods are inherited directly from the
// controller, so there is no forwarding layer between the webapp and the controller.
class CreateWorkflow extends CreateWorkflowController<BrowserSourceRef, BrowserSaveDestination> {
  constructor(options: WorkflowOptions<CreateSettings> = {}) {
    super(browserRuntime, options, assertPublicSources);
    configureBrowserAssetBaseUrl(options.assetBaseUrl);
    void preloadBrowserRuntime({ workerThreads: options.settings?.workers?.threads });
  }
}

export type { ApplyWorkflowSnapshot } from "../../lib/workflow/apply-workflow-controller.ts";
export type { CreateWorkflowSnapshot } from "../../lib/workflow/create-workflow-controller.ts";
export type { TrimWorkflowSnapshot } from "../../lib/workflow/trim-workflow-controller.ts";
export type { BrowserSaveDestination } from "../../types/output.ts";
export type { WorkflowProgress } from "../../types/progress.ts";
export type {
  BrowserApplyResult,
  BrowserCreateResult,
  BrowserTrimResult,
} from "../../types/public.ts";
export type { CandidateSelectionRequest } from "../../types/selection.ts";
export type { ApplySettings, CreateSettings } from "../../types/settings.ts";

export type { BrowserCreatePatchFormatCandidatesInput, RuntimePatchCreateFormatCandidates };

class ApplyWorkflow extends ApplyWorkflowController<BrowserSourceRef, BrowserSaveDestination> {
  constructor(options: WorkflowOptions<ApplySettings> = {}) {
    super(browserRuntime, options, assertPublicSources);
    configureBrowserAssetBaseUrl(options.assetBaseUrl);
    void preloadBrowserRuntime({ workerThreads: options.settings?.workers?.threads });
  }
}

class TrimWorkflow extends TrimWorkflowController<BrowserSourceRef, BrowserSaveDestination> {
  constructor(options: WorkflowOptions<CreateSettings> = {}) {
    super(browserRuntime, options, assertPublicSources);
    configureBrowserAssetBaseUrl(options.assetBaseUrl);
    void preloadBrowserRuntime({ workerThreads: options.settings?.workers?.threads });
  }
}

export { ApplyWorkflow, CreateWorkflow, getCreatePatchFormatCandidates, preloadBrowserRuntime, TrimWorkflow };
