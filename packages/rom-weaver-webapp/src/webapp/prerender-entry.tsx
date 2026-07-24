import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { getPageUpdateState, createEmptyVitePageUpdateState } from "./page-update-state.ts";
import { createServiceWorkerCacheState } from "./pwa/service-worker-cache-state.ts";
import { createWebappRootController } from "./webapp-controller.ts";
import { createEmptyConfirmationDialogState } from "./webapp-root-types.ts";
import type { WebappRootProps } from "./webapp-root-types.ts";
import { WebappRoot } from "./webapp-root.tsx";
import { preloadWorkflowRoute } from "./workflow-routes.tsx";

/**
 * Build-time prerender of the landing shell: the exact markup the client's
 * first committed render produces (startup ready, requested public tab, no session),
 * rendered through react-dom/server so index.html can ship it inside
 * #webapp-root and the browser can paint the real shell before the bundle
 * executes. The client keeps createRoot (replace, not hydrate); see
 * renderWebappRoot in webapp.ts.
 *
 * Workflow forms are lazy route chunks, so the requested tab's module is
 * resolved first - renderToString cannot suspend, and a preloaded route renders
 * synchronously.
 */

const noop = () => undefined;

const createPrerenderActions = (): WebappRootProps["actions"] => ({
  onCancelConfirmation: noop,
  onCloseSettings: noop,
  onConfirmConfirmation: noop,
  onConfirmExternalNavigation: () => Promise.resolve(true),
  onCreatorModifiedChange: noop,
  onCreatorOriginalChange: noop,
  onCreatorPatchTypeChange: noop,
  onCreatorSettingsChange: noop,
  onDraftChange: noop,
  onLogLevelChange: noop,
  onOpenSettings: noop,
  onPatcherBundlePackageChange: noop,
  onPatcherInputsChange: noop,
  onPatcherPatchesChange: noop,
  onPatcherSettingsChange: noop,
  onReloadUpdate: noop,
  onReset: noop,
  onRestoreDefaults: noop,
  onSaveClose: noop,
  onSelectView: noop,
  onToolsSessionChange: noop,
  onTrimOutputFormatChange: noop,
  onTrimSettingsChange: noop,
  onTrimSourceChange: noop,
});

const renderLandingShellHtml = async (
  currentView: Extract<WebappRootProps["state"]["currentView"], "patcher" | "creator"> = "patcher",
): Promise<string> => {
  await preloadWorkflowRoute(currentView);
  const controller = createWebappRootController({
    onApplySettings: noop,
    onCreatorViewRequested: () => true,
    onFocusField: noop,
    onLocalizationChange: noop,
    storage: undefined,
  });
  const state = {
    ...controller.getState(),
    currentView,
    // Match the state of the client's first painted frame: initializeWebapp
    // runs loading -> ready synchronously before the browser can paint.
    startup: { message: "", status: "ready" as const },
  };
  return renderToString(
    createElement(WebappRoot, {
      actions: createPrerenderActions(),
      confirmationDialog: createEmptyConfirmationDialogState(),
      pageUpdate: getPageUpdateState({
        serviceWorkerCache: { updateReady: false },
        vite: createEmptyVitePageUpdateState(),
      }),
      serviceWorkerCache: createServiceWorkerCacheState(),
      state,
      urlSession: null,
    }),
  );
};

export { renderLandingShellHtml };
