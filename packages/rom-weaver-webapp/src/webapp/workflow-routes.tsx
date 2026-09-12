import { type ComponentType, lazy } from "react";
import { createLogger } from "../lib/logging.ts";
import type { ApplyPatchFormProps, CreatePatchFormProps, TrimPatchFormProps } from "../public/react/public-types.ts";
import type { PpfUndoFormProps } from "./components/ppf-undo-form.tsx";
import type { SaveEditorProps } from "./components/save-editor.tsx";
import type { IdentifyFormProps } from "./components/identify-form.tsx";
import type { HomePageProps } from "./components/home-page.tsx";
import type { WhatsNewPageProps } from "./whats-new-page.tsx";
import type { WebappView } from "./webapp-state-types.ts";

/**
 * Each workflow loads in a separate chunk so the entry bundle does not include every form.
 * Client boot and prerender MUST preload the initial route to avoid replacing its rendered shell with a Suspense fallback.
 */

const logger = createLogger("workflow-routes");

type WorkflowRouteProps = {
  creator: CreatePatchFormProps;
  docs: {
    active: boolean;
    onSelectTab?: (id: string) => void;
    slug: string;
  };
  home: HomePageProps;
  identify: IdentifyFormProps;
  patcher: ApplyPatchFormProps;
  test: {
    active?: boolean;
  };
  "ppf-undo": PpfUndoFormProps;
  "save-editor": SaveEditorProps;
  trim: TrimPatchFormProps;
  "whats-new": WhatsNewPageProps;
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
const DocsRoute = createWorkflowRoute("docs", () =>
  import("./docs-page.tsx").then(async (module) => {
    // Each guide's HTML is its own chunk; without the landing guide's the
    // article would mount empty and pop in a frame later.
    await module.preloadDocsHtml().catch(() => undefined);
    return { default: module.DocsPage };
  }),
);
const PatcherRoute = createWorkflowRoute("patcher", () =>
  import("../public/react/apply-patch-form.tsx").then((module) => ({ default: module.ApplyPatchForm })),
);
const HomeRoute = createWorkflowRoute("home", () =>
  import("./components/home-page.tsx").then((module) => ({ default: module.HomePage })),
);
const IdentifyRoute = createWorkflowRoute("identify", () =>
  import("./components/identify-form.tsx").then((module) => ({ default: module.IdentifyForm })),
);
const TestRoute = createWorkflowRoute("test", () =>
  import("../public/react/emulator-test-view.tsx").then((module) => ({ default: module.EmulatorTestView })),
);
const PpfUndoRoute = createWorkflowRoute("ppf-undo", () =>
  import("./components/ppf-undo-form.tsx").then((module) => ({ default: module.PpfUndoForm })),
);
const SaveEditorRoute = createWorkflowRoute("save-editor", () =>
  import("./components/save-editor.tsx").then((module) => ({ default: module.SaveEditor })),
);
const TrimRoute = createWorkflowRoute("trim", () =>
  import("../public/react/trim-form.tsx").then((module) => ({ default: module.TrimPatchForm })),
);
const WhatsNewRoute = createWorkflowRoute("whats-new", () =>
  import("./whats-new-page.tsx").then((module) => ({ default: module.WhatsNewPage })),
);

const WORKFLOW_ROUTES = {
  creator: CreatorRoute,
  docs: DocsRoute,
  home: HomeRoute,
  identify: IdentifyRoute,
  patcher: PatcherRoute,
  test: TestRoute,
  "ppf-undo": PpfUndoRoute,
  "save-editor": SaveEditorRoute,
  trim: TrimRoute,
  "whats-new": WhatsNewRoute,
} as const;

const CreatePatchRoute = CreatorRoute.Component;
const DocsPageRoute = DocsRoute.Component;
const ApplyPatchRoute = PatcherRoute.Component;
const EmulatorTestRoute = TestRoute.Component;
const HomePageRoute = HomeRoute.Component;
const IdentifyRouteForm = IdentifyRoute.Component;
const PpfUndoRouteForm = PpfUndoRoute.Component;
const SaveEditorRouteForm = SaveEditorRoute.Component;
const TrimPatchRoute = TrimRoute.Component;
const WhatsNewPageRoute = WhatsNewRoute.Component;

/** Resolve one route's chunk. Awaited before the first mount so the landing tab never suspends. */
const preloadWorkflowRoute = (view: WebappView): Promise<unknown> => WORKFLOW_ROUTES[view].preload();

/**
 * Resolve one guide's HTML chunk (defaults to the guide named by the current
 * URL). Prerender and the client boot await this alongside the docs route
 * chunk so a docs document hydrates onto the article it already shows.
 */
const preloadDocsRouteHtml = (slug?: string): Promise<unknown> =>
  import("./docs-page.tsx").then((module) => module.preloadDocsHtml(slug));

export {
  ApplyPatchRoute,
  CreatePatchRoute,
  DocsPageRoute,
  EmulatorTestRoute,
  HomePageRoute,
  IdentifyRouteForm,
  preloadDocsRouteHtml,
  preloadWorkflowRoute,
  PpfUndoRouteForm,
  SaveEditorRouteForm,
  TrimPatchRoute,
  WhatsNewPageRoute,
};
