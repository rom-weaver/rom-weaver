import type { ComponentType } from "preact";
import { createLogger } from "../lib/logging.ts";
import type { GuidedSample } from "../public/react/guided-sample-start.ts";
import type { ApplyPatchFormProps, CreatePatchFormProps, TrimPatchFormProps } from "../public/react/public-types.ts";
import type { ToolsFormProps } from "./components/tools-form.tsx";
import { createAsyncComponent } from "./async-component.tsx";
import type { WebappView } from "./webapp-state-types.ts";

/**
 * Workflow forms are the bulk of the route-exclusive bundle weight, and a
 * visitor only ever lands on one of them. Each one is its own chunk here so a
 * first load parses the tab it opened rather than all four.
 *
 * The catch is the prerendered landing shell (rom-weaver-prerender-shell): the
 * markup index.html paints already contains the landing tab's fully rendered
 * form, so an async fallback on the first client render would blank the shell
 * the browser just painted. `preloadWorkflowRoute` therefore resolves the
 * landing route BEFORE the first mount (and before renderToString on the build
 * side); a preloaded route renders its real component synchronously.
 */

const logger = createLogger("workflow-routes");

type WorkflowRouteProps = {
  creator: CreatePatchFormProps;
  docs: {
    active: boolean;
    onGuideIntent: (guide: GuidedSample) => void;
    onStartGuide: (guide: GuidedSample) => boolean | void;
    slug: string;
  };
  patcher: ApplyPatchFormProps;
  tools: ToolsFormProps;
  trim: TrimPatchFormProps;
};

type WorkflowRouteComponent<View extends WebappView> = ComponentType<WorkflowRouteProps[View]>;

type WorkflowRoute<View extends WebappView> = {
  Component: WorkflowRouteComponent<View>;
  preload: () => Promise<unknown>;
};

const createWorkflowRoute = <View extends WebappView>(
  view: View,
  load: () => Promise<{ default: WorkflowRouteComponent<View> }>,
): WorkflowRoute<View> => {
  const route = createAsyncComponent<WorkflowRouteProps[View]>(() =>
    load().then((module) => {
      logger.trace("Workflow route loaded", { view });
      return module;
    }),
  );
  return { Component: route.Component, preload: route.preload };
};

const CreatorRoute = createWorkflowRoute("creator", () =>
  import("../public/react/create-patch-form.tsx").then((module) => ({ default: module.CreatePatchForm })),
);
const DocsRoute = createWorkflowRoute("docs", () =>
  import("./docs-page.tsx").then((module) => ({ default: module.DocsPage })),
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
  docs: DocsRoute,
  patcher: PatcherRoute,
  tools: ToolsRoute,
  trim: TrimRoute,
} as const;

const CreatePatchRoute = CreatorRoute.Component;
const DocsPageRoute = DocsRoute.Component;
const ApplyPatchRoute = PatcherRoute.Component;
const ToolsRouteForm = ToolsRoute.Component;
const TrimPatchRoute = TrimRoute.Component;

/** Resolve one route's chunk. Awaited before the first mount so the landing tab never suspends. */
const preloadWorkflowRoute = (view: WebappView): Promise<unknown> => WORKFLOW_ROUTES[view].preload();

export { ApplyPatchRoute, CreatePatchRoute, DocsPageRoute, preloadWorkflowRoute, ToolsRouteForm, TrimPatchRoute };
