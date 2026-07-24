import { GitCompare, RotateCcw, Save, Scissors, Wrench } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getWorkbenchActivity, subscribeWorkbenchActivity } from "../lib/activity-store.ts";
import type { BundleApplySession } from "../lib/bundle/bundle-session-model.ts";
import { readDataTransferFiles } from "../lib/input/dropped-files.ts";
import { createLogger } from "../lib/logging.ts";
import { markDropReceived, markResultPaintedAfterFinish } from "../lib/perf/op-perf-marks.ts";
import { perfNow, recordDrop } from "../lib/runtime/perf-latency.ts";
import { preloadBrowserRuntime } from "../platform/browser/browser-api.ts";
import { ApplyBandaidIcon } from "../public/react/components/apply-bandaid-icon.tsx";
import { runFlatViewTransition } from "../public/react/components/ds/flat-transition.ts";
import { ConfirmDialog, Modal } from "../public/react/components/ds/index.ts";
import type { PageFileDrop } from "../public/react/public-types.ts";
// Deliberately NOT the ../public/react/index.tsx barrel: that barrel re-exports
// every workflow form, so a static import of it pulls all four route chunks
// back into the entry and defeats the split below.
import { RomWeaverSettingsProvider } from "../public/react/settings-context.tsx";
import { setActiveSelectionForm } from "../public/react/input-selection-handler.ts";
import { useUiLocalizer } from "../public/react/settings-context.tsx";
import { CHANNEL_BADGE } from "./build-channel.ts";
import { APP_BUILD_VERSION, APP_DISPLAY_VERSION } from "./build-version.ts";
import { ChangelogDialog } from "./components/changelog-dialog.tsx";
import { Masthead, UpdateBanner } from "./components/shell.tsx";
import { ProcessingWakeLockNotice } from "./components/wake-lock-notice.tsx";
import { resolveHostIngestFiles, subscribeHostIngest } from "./host-ingest.ts";
import { DONATE_URL, GITHUB_URL } from "./project-links.ts";
import type { SettingsDraftState } from "./settings/settings-state.ts";
import { UrlSessionBanner } from "./url-session/url-session-banner.tsx";
import { useUrlSessionBoot } from "./url-session/use-url-session-boot.ts";
import type { WebappRootProps } from "./webapp-root-types.ts";
import {
  ApplyPatchRoute,
  CreatePatchRoute,
  preloadIdleWorkflowRoutes,
  ToolsRouteForm,
  TrimPatchRoute,
} from "./workflow-routes.tsx";
import { WORKFLOW_SEO_ROUTES } from "./workflow-seo.mjs";

const WORKFLOW_TABS = [
  // "Weave": the tab both applies patch chains and edits/exports them as bundles.
  { href: "weave", icon: <ApplyBandaidIcon className="apply-tab-icon" />, id: "patcher", label: "Weave" },
  { href: "create", icon: <GitCompare aria-hidden="true" />, id: "creator", label: "Create" },
  { href: "trim", icon: <Scissors aria-hidden="true" />, id: "trim", label: "Trim" },
  { href: "tools", icon: <Wrench aria-hidden="true" />, id: "tools", label: "Tools" },
];

// The trace inspector is the single largest dialog in the bundle and opens from
// a masthead button, so it only downloads once someone asks for it.
const LogDialog = lazy(() => import("./components/log-dialog.tsx").then((module) => ({ default: module.LogDialog })));

// The settings panel drags in the whole settings-metadata graph (field metadata,
// codec combobox, compression profile copy) that nothing on the workflow surface
// needs, so it loads on demand and is warmed at idle to keep first open instant.
const loadSettingsPanel = () => import("./webapp-settings.tsx");
const SettingsPanel = lazy(() => loadSettingsPanel().then((module) => ({ default: module.SettingsPanel })));

const warmSettingsPanel = (): (() => void) => {
  const warm = () => {
    void loadSettingsPanel().catch((error: unknown) => {
      // The lazy wrapper still owns the user-visible failure on a real open.
      logger.warn("Settings panel preload failed", {
        message: error instanceof Error ? error.message : String(error || ""),
      });
    });
  };
  if (typeof requestIdleCallback !== "function") {
    const timer = setTimeout(warm, 1000);
    return () => clearTimeout(timer);
  }
  const handle = requestIdleCallback(warm, { timeout: 5000 });
  return () => cancelIdleCallback(handle);
};

const logger = createLogger("webapp-root");

const syncWorkflowSeoMetadata = (view: WorkflowView) => {
  const route =
    view === "creator" ? WORKFLOW_SEO_ROUTES.creator : view === "patcher" ? WORKFLOW_SEO_ROUTES.patcher : null;
  if (!route) {
    const tab = WORKFLOW_TABS.find((entry) => entry.id === view);
    document.title = tab ? `rom-weaver - ${tab.label}` : "rom-weaver";
    return;
  }
  const title = CHANNEL_BADGE ? route.title.replace("RomWeaver", `RomWeaver ${CHANNEL_BADGE}`) : route.title;
  const canonicalUrl = `https://rom-weaver.com/${route.slug}`;
  document.title = title;
  document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute("content", route.description);
  document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.setAttribute("content", title);
  document
    .querySelector<HTMLMetaElement>('meta[property="og:description"]')
    ?.setAttribute("content", route.description);
  document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.setAttribute("content", canonicalUrl);
  document.querySelector<HTMLMetaElement>('meta[name="twitter:title"]')?.setAttribute("content", title);
  document
    .querySelector<HTMLMetaElement>('meta[name="twitter:description"]')
    ?.setAttribute("content", route.description);
  document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.setAttribute("href", canonicalUrl);
};

// Dismissing the update banner is remembered per running build: the same
// pending update never re-prompts on reload, while an actual update changes
// APP_BUILD_VERSION and re-arms the banner for the next one.
const UPDATE_DISMISSED_STORAGE_KEY = "rom-weaver-update-dismissed-build";

const readUpdateDismissed = () => {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(UPDATE_DISMISSED_STORAGE_KEY) === APP_BUILD_VERSION;
  } catch (error) {
    logger.trace("Unable to read update banner dismissal", {
      message: error instanceof Error ? error.message : String(error || ""),
    });
    return false;
  }
};

const writeUpdateDismissed = () => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(UPDATE_DISMISSED_STORAGE_KEY, APP_BUILD_VERSION);
    logger.debug("Update banner dismissed", { build: APP_BUILD_VERSION });
  } catch (error) {
    logger.trace("Unable to persist update banner dismissal", {
      message: error instanceof Error ? error.message : String(error || ""),
    });
  }
};

type WebappRootPageDrop = {
  drop: PageFileDrop;
  view: WebappRootProps["state"]["currentView"];
};

const hasDataTransferType = (types: readonly string[], type: string) => types.includes(type);

const hasFileDataTransferItem = (items: DataTransferItemList) => Array.from(items).some((item) => item.kind === "file");

const isFileDragTransfer = (dataTransfer: DataTransfer | null) =>
  !!dataTransfer && (hasDataTransferType(dataTransfer.types, "Files") || hasFileDataTransferItem(dataTransfer.items));

const isInsideLocalDropZone = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest(".rw-app .drop");

type WorkflowView = WebappRootProps["state"]["currentView"];

const resolveThreads = (threads?: unknown): number => {
  const numeric = typeof threads === "number" ? threads : Number.parseInt(String(threads || ""), 10);
  if (Number.isFinite(numeric) && numeric >= 1) return numeric;
  return typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 0;
};

/* Entry animations (card-in / panel-in / …) must play once per mount, never
   when a hidden tab is re-shown (display:none -> block restarts CSS
   animations). Lock each as it finishes, exactly like the prototype. */
const ENTRY_ANIMATIONS = new Set(["card-in", "panel-in", "drop-in", "chip-in", "fault-in", "trace-in"]);

const useEntryAnimationLock = () => {
  useEffect(() => {
    const lock = (event: AnimationEvent) => {
      if (ENTRY_ANIMATIONS.has(event.animationName) && event.target instanceof HTMLElement)
        event.target.style.animation = "none";
    };
    document.addEventListener("animationend", lock);
    return () => document.removeEventListener("animationend", lock);
  }, []);
};

/* Mode switches crossfade flat - shared with the forms' empty-bench
   transition so all layout swaps use one mechanism. */
const selectViewWithTransition = (select: () => void) => runFlatViewTransition(select, "vt-mode");

const DropVeil = () => {
  const localizer = useUiLocalizer();
  return (
    <div aria-hidden="true" className="dropveil">
      <span className="dropveil-text">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M9 3 3 9l12 12 6-6Z" />
          <path d="m9 8.5 2 2m-4 1 2 2m3-7 2 2" />
        </svg>
        <span>{localizer.message("ui.drop.release")}</span>
      </span>
    </div>
  );
};

/**
 * Activity-store subscribers live OUTSIDE the root component: the stage line
 * updates on every progress tick, and re-rendering the whole workbench per
 * tick makes the weave animations stutter during extraction.
 */
const ActivityWakeLockNotice = () => {
  const activity = useSyncExternalStore(subscribeWorkbenchActivity, getWorkbenchActivity, getWorkbenchActivity);
  return <ProcessingWakeLockNotice active={activity.state === "running"} />;
};

const ActivityFinishMarker = () => {
  const activity = useSyncExternalStore(subscribeWorkbenchActivity, getWorkbenchActivity, getWorkbenchActivity);
  // The bench settles out of a run (running/staging → ready/done) on the commit batched with the result
  // render. Close the perceived-latency tail (romweaver:after-finish) on the paint that reveals the result;
  // skipping the in-progress states avoids firing on an intermediate step of a multi-step action (e.g. a ROM
  // load's extract before its checksum).
  const settled = activity.state !== "running" && activity.state !== "staging";
  useEffect(() => {
    if (settled) markResultPaintedAfterFinish();
  });
  return null;
};

function WebappRoot({ state, pageUpdate, confirmationDialog, actions, urlSession }: WebappRootProps) {
  useEntryAnimationLock();
  useEffect(() => {
    syncWorkflowSeoMetadata(state.currentView);
  }, [state.currentView]);
  // Route mid-command wasm host selection prompts to the visible tab's form. All
  // forms stay mounted, so without this the last-mounted form would own prompts.
  useEffect(() => {
    setActiveSelectionForm(state.currentView);
  }, [state.currentView]);
  const [updateDismissed, setUpdateDismissed] = useState(readUpdateDismissed);
  const [logOpen, setLogOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  // Workflow forms keep their local state (staged files, validated patches,
  // finished outputs) in component state, so unmounting on tab switch would
  // silently discard the user's work. Each form mounts on first visit and then
  // stays mounted but hidden, which preserves state across tab switches.
  const [visitedViews, setVisitedViews] = useState<readonly WorkflowView[]>([state.currentView]);
  const [pageDrop, setPageDrop] = useState<WebappRootPageDrop | null>(null);
  const [pageDragging, setPageDragging] = useState(false);
  const pageDropIdRef = useRef(0);
  const threads = state.settings.threads;
  useEffect(() => {
    void preloadBrowserRuntime({ threads });
  }, [threads]);
  // Warm the tabs the visitor did not land on once the main thread is idle, so
  // a tab switch never waits on a chunk request.
  useEffect(() => preloadIdleWorkflowRoutes(state.currentView), [state.currentView]);
  // Same idea for the settings panel: off the critical path, but resolved well
  // before the masthead button can realistically be pressed.
  useEffect(() => warmSettingsPanel(), []);
  const activePageDrop = pageDrop?.view === state.currentView ? pageDrop.drop : null;

  // URL-session sources land in the apply tab's drop pipeline exactly like a
  // page-level drop (classification and routing stay Rust/extension-driven).
  const deliverUrlSessionFiles = useCallback(
    (files: File[]) => {
      actions.onSelectView("patcher");
      pageDropIdRef.current += 1;
      setPageDrop({
        drop: {
          files,
          id: pageDropIdRef.current,
        },
        view: "patcher",
      });
    },
    [actions],
  );
  useEffect(
    () =>
      subscribeHostIngest((paths) => {
        void resolveHostIngestFiles(paths)
          .then(deliverUrlSessionFiles)
          .catch((error) => logger.error("host OPFS ingest failed", { error: String(error) }));
      }),
    [deliverUrlSessionFiles],
  );
  // The `?bundle=` boot's decorated session (enablement seed + output defaults + patch metadata);
  // the apply form consumes it once its patch list matches the bundle's delivery.
  const [bundleSession, setBundleSession] = useState<BundleApplySession | null>(null);
  const urlSessionBoot = useUrlSessionBoot(urlSession?.request ?? null, deliverUrlSessionFiles, setBundleSession);

  useEffect(() => {
    setVisitedViews((previous) => (previous.includes(state.currentView) ? previous : [...previous, state.currentView]));
  }, [state.currentView]);
  const isViewMounted = (view: WorkflowView) => state.currentView === view || visitedViews.includes(view);

  // Arm the dropzones while a file is dragged anywhere over the page. `dragover`
  // fires continuously, so a short debounce clears the flag once it stops (drag
  // left the window or dropped) - `dragleave`/`dragend` are unreliable here.
  useEffect(() => {
    let clearTimer: ReturnType<typeof setTimeout> | undefined;
    const onDragOver = (event: DragEvent) => {
      if (!isFileDragTransfer(event.dataTransfer)) return;
      setPageDragging(true);
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => setPageDragging(false), 140);
    };
    const stop = () => {
      clearTimeout(clearTimer);
      setPageDragging(false);
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", stop);
    return () => {
      clearTimeout(clearTimer);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", stop);
    };
  }, []);

  // Page-level drag: dropping a file anywhere on the page (outside a dropzone
  // box) forwards it to the active tab's unified drop handler via `pageDrop`.
  useEffect(() => {
    const handlePageDragOver = (event: DragEvent) => {
      if (isInsideLocalDropZone(event.target) || !isFileDragTransfer(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const handlePageDrop = (event: DragEvent) => {
      if (isInsideLocalDropZone(event.target) || !isFileDragTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      if (state.settingsDialogOpen || confirmationDialog.open) return;
      const droppedAtMs = perfNow();
      // Read synchronously so dropped folders are captured before the transfer
      // clears; routing/classification is owned by the active tab's unified drop
      // handler, so the page-level listener just forwards every file to it.
      const droppedView = state.currentView;
      void readDataTransferFiles(event.dataTransfer).then((files) => {
        if (files.length === 0) return;
        markDropReceived();
        for (const file of files) recordDrop(file.name, droppedAtMs);
        logger.trace("unified drop zone received files", {
          count: files.length,
          names: files.map((file) => file.name),
          source: "page",
        });
        pageDropIdRef.current += 1;
        setPageDrop({
          drop: {
            files,
            id: pageDropIdRef.current,
          },
          view: droppedView,
        });
      });
    };
    document.addEventListener("dragover", handlePageDragOver);
    document.addEventListener("drop", handlePageDrop);
    return () => {
      document.removeEventListener("dragover", handlePageDragOver);
      document.removeEventListener("drop", handlePageDrop);
    };
  }, [confirmationDialog.open, state.currentView, state.settingsDialogOpen]);

  const workflowPanel = (view: WorkflowView, form: React.ReactNode) =>
    isViewMounted(view) ? (
      <section
        aria-labelledby={`tab-${view}`}
        className="panel workflow"
        hidden={state.currentView !== view}
        id={`panel-${view}`}
        role="tabpanel"
      >
        <div className="workflow-body">
          {/* Only ever engages for a tab switch: the landing route is preloaded before the first mount. */}
          <Suspense fallback={null}>{form}</Suspense>
        </div>
      </section>
    ) : null;

  return (
    <RomWeaverSettingsProvider settings={state.settings}>
      <div className={pageDragging ? "rw-app rw-page-dragging" : "rw-app"} id="column">
        <div className="app">
          <Masthead
            channelBadge={CHANNEL_BADGE}
            confirmExternalNavigation={actions.onConfirmExternalNavigation}
            currentTab={state.currentView}
            donateHref={DONATE_URL}
            githubHref={GITHUB_URL}
            onOpenLog={() => setLogOpen(true)}
            onOpenSettings={actions.onOpenSettings}
            onReset={actions.onReset}
            onSelectTab={(id) =>
              selectViewWithTransition(() => actions.onSelectView(id as WebappRootProps["state"]["currentView"]))
            }
            settingsOpen={state.settingsDialogOpen}
            tabs={
              state.settings.betaToolsEnabled
                ? WORKFLOW_TABS
                : WORKFLOW_TABS.filter((tab) => tab.id === "patcher" || tab.id === "creator")
            }
            threads={resolveThreads()}
            version={APP_DISPLAY_VERSION}
            versionTitle={`v${APP_BUILD_VERSION}`}
          />
          <UpdateBanner
            onDismiss={() => {
              setUpdateDismissed(true);
              writeUpdateDismissed();
            }}
            onReload={actions.onReloadUpdate}
            onShowChangelog={() => setChangelogOpen(true)}
            open={pageUpdate.ready && !updateDismissed}
            title={pageUpdate.title}
          />
          <ChangelogDialog
            onClose={() => setChangelogOpen(false)}
            onReload={actions.onReloadUpdate}
            open={changelogOpen}
          />
          <UrlSessionBanner onRetry={urlSessionBoot.retry} state={urlSessionBoot.state} />
          <ActivityWakeLockNotice />
          <main className="workbench">
            {workflowPanel(
              "patcher",
              <ApplyPatchRoute
                bundleSession={bundleSession}
                onBundlePackageChange={actions.onPatcherBundlePackageChange}
                onInputsChange={actions.onPatcherInputsChange}
                onPatchesChange={actions.onPatcherPatchesChange}
                onSettingsChange={actions.onPatcherSettingsChange}
                pageDrop={activePageDrop}
                startup={state.startup}
              />,
            )}
            {workflowPanel(
              "creator",
              <CreatePatchRoute
                onModifiedChange={actions.onCreatorModifiedChange}
                onOriginalChange={actions.onCreatorOriginalChange}
                onPatchTypeChange={actions.onCreatorPatchTypeChange}
                onSettingsChange={actions.onCreatorSettingsChange}
                pageDrop={activePageDrop}
              />,
            )}
            {workflowPanel(
              "trim",
              <TrimPatchRoute
                onOutputFormatChange={actions.onTrimOutputFormatChange}
                onSettingsChange={actions.onTrimSettingsChange}
                onSourceChange={actions.onTrimSourceChange}
                pageDrop={activePageDrop}
              />,
            )}
            {workflowPanel(
              "tools",
              <ToolsRouteForm onSessionChange={actions.onToolsSessionChange} pageDrop={activePageDrop} />,
            )}
            <DropVeil />
          </main>
        </div>
        <ActivityFinishMarker />
        {logOpen ? (
          <Suspense fallback={null}>
            <LogDialog
              level={state.settings.logLevel}
              onClose={() => setLogOpen(false)}
              onLevelChange={actions.onLogLevelChange}
              open={logOpen}
            />
          </Suspense>
        ) : null}
        <Modal
          headerActions={
            <>
              <button className="btn ghost" onClick={actions.onRestoreDefaults} title="Reset to defaults" type="button">
                <RotateCcw aria-hidden="true" />
                <span className="bl">Defaults</span>
              </button>
              <button className="btn primary" onClick={actions.onSaveClose} title="Save &amp; close" type="button">
                <Save aria-hidden="true" />
                <span className="bl">Save</span>
              </button>
            </>
          }
          onClose={actions.onCloseSettings}
          open={state.settingsDialogOpen}
          title="Settings"
          variant="settings-modal"
        >
          <Suspense fallback={null}>
            <SettingsPanel
              draftSettings={state.draftSettings as SettingsDraftState}
              onClose={actions.onCloseSettings}
              onDraftChange={actions.onDraftChange}
              onRestoreDefaults={actions.onRestoreDefaults}
              onSaveClose={actions.onSaveClose}
              validation={state.validation}
            />
          </Suspense>
        </Modal>
        <ConfirmDialog
          body={confirmationDialog.message}
          cancelLabel={confirmationDialog.cancelLabel}
          confirmLabel={confirmationDialog.confirmLabel}
          onCancel={actions.onCancelConfirmation}
          onConfirm={actions.onConfirmConfirmation}
          open={confirmationDialog.open}
          title={confirmationDialog.title}
        />
      </div>
    </RomWeaverSettingsProvider>
  );
}

export { ENTRY_ANIMATIONS, resolveThreads, selectViewWithTransition, WebappRoot };
