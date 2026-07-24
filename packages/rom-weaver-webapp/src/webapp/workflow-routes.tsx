import { type ComponentType, lazy } from "react";
import { createLogger } from "../lib/logging.ts";
import type { ApplyPatchFormProps, CreatePatchFormProps, TrimPatchFormProps } from "../public/react/public-types.ts";
import type { ToolsFormProps } from "./components/tools-form.tsx";
import type { WorkflowView } from "./webapp-state-types.ts";

/**
 * Workflow forms are the bulk of the route-exclusive bundle weight, and a
 * visitor only ever lands on one of them. Each one is its own chunk here so a
 * first load parses the tab it opened rather than all four.
 *
 * The catch is the prerendered landing shell (rom-weaver-prerender-shell): the
 * markup index.html paints already contains the landing tab's fully rendered
 * form, so a Suspense fallback on the first client render would blank the shell
 * the browser just painted. `preloadWorkflowRoute` therefore resolves the
 * landing route BEFORE the first mount (and before renderToString on the build
 * side); a preloaded route renders its real component synchronously and never
 * suspends. Suspense only ever engages for a tab the visitor switches to.
 */

const logger = createLogger("workflow-routes");

type WorkflowRouteProps = {
  creator: CreatePatchFormProps;
  patcher: ApplyPatchFormProps;
  tools: ToolsFormProps;
  trim: TrimPatchFormProps;
};

type WorkflowRouteComponent<View extends WorkflowView> = ComponentType<WorkflowRouteProps[View]>;

type WorkflowRoute<View extends WorkflowView> = {
  Component: WorkflowRouteComponent<View>;
  preload: () => Promise<unknown>;
};

const createWorkflowRoute = <View extends WorkflowView>(
  view: View,
  load: () => Promise<{ default: WorkflowRouteComponent<View> }>,
): WorkflowRoute<View> => {
  const LazyComponent = lazy(load);
  let preloaded: WorkflowRouteComponent<View> | null = null;
  let pending: Promise<unknown> | null = null;
  // Frozen on first render: a preload that lands after the route already
  // rendered through the lazy wrapper must not swap the element type, which
  // would remount a live workflow and discard the visitor's staged work.
  let rendered: WorkflowRouteComponent<View> | null = null;
  const preload = () => {
    pending ??= load().then(
      (module) => {
        preloaded = module.default;
        logger.trace("Workflow route loaded", { view });
        return module.default;
      },
      (error) => {
        // Leave `pending` set to the rejected promise's replacement so a retry
        // is possible; the lazy wrapper still owns the user-visible failure.
        pending = null;
        logger.warn("Workflow route failed to load", {
          message: error instanceof Error ? error.message : String(error || ""),
          view,
        });
        return null;
      },
    );
    return pending;
  };
  const Component = (props: WorkflowRouteProps[View]) => {
    rendered ??= preloaded ?? LazyComponent;
    const Resolved = rendered;
    return <Resolved {...props} />;
  };
  return { Component, preload };
};

const CreatorRoute = createWorkflowRoute("creator", () =>
  import("../public/react/create-patch-form.tsx").then((module) => ({ default: module.CreatePatchForm })),
);
const PatcherRoute = createWorkflowRoute("patcher", () =>
  import("../public/react/apply-patch-form.tsx").then((module) => ({ default: module.ApplyPatchForm })),
);
const ToolsRoute = createWorkflowRoute("tools", () =>
  import("./components/tools-form.tsx").then((module) => ({ default: module.ToolsForm })),
);
const TrimRoute = createWorkflowRoute("trim", () =>
  import("../public/react/trim-form.tsx").then((module) => ({ default: module.TrimPatchForm })),
);

const WORKFLOW_ROUTES = {
  creator: CreatorRoute,
  patcher: PatcherRoute,
  tools: ToolsRoute,
  trim: TrimRoute,
} as const;

const CreatePatchRoute = CreatorRoute.Component;
const ApplyPatchRoute = PatcherRoute.Component;
const ToolsRouteForm = ToolsRoute.Component;
const TrimPatchRoute = TrimRoute.Component;

/** Resolve one route's chunk. Awaited before the first mount so the landing tab never suspends. */
const preloadWorkflowRoute = (view: WorkflowView): Promise<unknown> => WORKFLOW_ROUTES[view].preload();

/** Warm the tabs the visitor did not land on, so switching tabs never waits on a network round trip. */
const preloadIdleWorkflowRoutes = (activeView: WorkflowView): (() => void) => {
  const warm = () => {
    for (const view of Object.keys(WORKFLOW_ROUTES) as WorkflowView[]) {
      if (view !== activeView) void WORKFLOW_ROUTES[view].preload();
    }
  };
  if (typeof requestIdleCallback !== "function") {
    const timer = setTimeout(warm, 1000);
    return () => clearTimeout(timer);
  }
  const handle = requestIdleCallback(warm, { timeout: 5000 });
  return () => cancelIdleCallback(handle);
};

export {
  ApplyPatchRoute,
  CreatePatchRoute,
  preloadIdleWorkflowRoutes,
  preloadWorkflowRoute,
  ToolsRouteForm,
  TrimPatchRoute,
};
