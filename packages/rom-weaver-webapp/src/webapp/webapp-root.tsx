import { BookOpen, GitCompare, House, RotateCcw, Scissors, Wrench } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { getWorkbenchActivity, subscribeWorkbenchActivity } from "../lib/activity-store.ts";
import type { BundleApplySession } from "../lib/bundle/bundle-session-model.ts";
import { readDataTransferFiles } from "../lib/input/dropped-files.ts";
import { createLogger } from "../lib/logging.ts";
import { markDropReceived, markResultPaintedAfterFinish } from "../lib/perf/op-perf-marks.ts";
import { perfNow, recordDrop } from "../lib/runtime/perf-latency.ts";
import { getDefaultBrowserThreadCount } from "../platform/shared/compression-options.ts";
import { ApplyBandaidIcon } from "../public/react/components/apply-bandaid-icon.tsx";
import { runFlatViewTransition } from "../public/react/components/ds/flat-transition.ts";
import { ConfirmDialog } from "../public/react/components/ds/index.ts";
import { type GuidedSample, notifyGuidedSampleView } from "../public/react/guided-sample-start.ts";
import type { PageFileDrop } from "../public/react/public-types.ts";
// Deliberately NOT the ../public/react/index.tsx barrel: that barrel re-exports
// every workflow form, so a static import of it pulls all four route chunks
// back into the entry and defeats the split below.
import { RomWeaverSettingsProvider } from "../public/react/settings-context.tsx";
import { setActiveSelectionForm } from "../public/react/input-selection-handler.ts";
import { useUiLocalizer } from "../public/react/settings-context.tsx";
import { scheduleBrowserRuntimePreload } from "./browser-runtime-preload.ts";
import { CHANNEL_BADGE } from "./build-channel.ts";
import { readAppBaseUrl } from "./webapp-controller.ts";
import { APP_BUILD_VERSION, APP_VERSION, COMMITS_SINCE_VERSION, DIRTY_HASH } from "./build-version.ts";
import { ChangelogDialog } from "./components/changelog-dialog.tsx";
import type { LogDialogTab, SettingsFocusHint } from "./components/log-dialog.tsx";
import { Masthead, UpdateBanner } from "./components/shell.tsx";
import { ProcessingWakeLockNotice } from "./components/wake-lock-notice.tsx";
import { resolveHostIngestFiles, subscribeHostIngest } from "./host-ingest.ts";
import { DONATE_URL, GITHUB_URL } from "./project-links.ts";
import { getSettingsUiState, SETTINGS_FIELD_METADATA } from "./settings/settings-state.ts";
import type { WebappView } from "./webapp-state-types.ts";
import { UrlSessionBanner } from "./url-session/url-session-banner.tsx";
import { useUrlSessionBoot } from "./url-session/use-url-session-boot.ts";
import type { WebappRootProps } from "./webapp-root-types.ts";
import {
  ApplyPatchRoute,
  CreatePatchRoute,
  DocsPageRoute,
  preloadWorkflowRoute,
  ToolsRouteForm,
  TrimPatchRoute,
} from "./workflow-routes.tsx";
import { SITE_NAME, WORKFLOW_SEO_ROUTES } from "./workflow-seo.mjs";

const WORKFLOW_TABS = [
  // "Apply": the tab both applies patch chains and edits/exports them as bundles.
  { href: "apply", icon: <ApplyBandaidIcon className="apply-tab-icon" />, id: "patcher", label: "Apply" },
  { href: "create", icon: <GitCompare aria-hidden="true" />, id: "creator", label: "Create" },
  // Reference rather than a workflow, but it earns a slot because the people it
  // is written for are the least likely to go looking in an icon tray. It is
  // still never persisted as the tab to resume - see `isResumableWorkflowView`.
  { href: "docs", icon: <BookOpen aria-hidden="true" />, id: "docs", label: "Docs" },
  { href: "trim", icon: <Scissors aria-hidden="true" />, id: "trim", label: "Trim" },
  { href: "tools", icon: <Wrench aria-hidden="true" />, id: "tools", label: "Tools" },
];

const getGuideView = (guide: GuidedSample): WebappView => (guide === "create" ? "creator" : "patcher");

// Keep the trace inspector out of the initial bundle, but share its loader so
// the masthead and idle post-boot preload can fetch the same promise.
const loadLogDialog = () => import("./components/log-dialog.tsx").then((module) => ({ default: module.LogDialog }));
const LogDialog = lazy(loadLogDialog);
const loadSettingsPanel = () => import("./webapp-settings.tsx").then((module) => ({ default: module.SettingsPanel }));
const SettingsPanel = lazy(loadSettingsPanel);
type BrowserApiModule = typeof import("../platform/browser/browser-api.ts");
const preloadBrowserRuntime = (options: Parameters<BrowserApiModule["preloadBrowserRuntime"]>[0] = {}) =>
  import("../platform/browser/browser-api.ts").then(({ preloadBrowserRuntime: preload }) => preload(options));

const logger = createLogger("webapp-root");

const syncWorkflowSeoMetadata = (view: WebappView) => {
  if (view === "docs") return;
  const route =
    view === "creator" ? WORKFLOW_SEO_ROUTES.creator : view === "patcher" ? WORKFLOW_SEO_ROUTES.patcher : null;
  if (!route) {
    const tab = WORKFLOW_TABS.find((entry) => entry.id === view);
    document.title = tab ? `rom-weaver - ${tab.label}` : "rom-weaver";
    return;
  }
  const title = CHANNEL_BADGE ? route.title.replace(SITE_NAME, `${SITE_NAME} ${CHANNEL_BADGE}`) : route.title;
  const canonicalUrl = `https://rom-weaver.com/${route.slug}`;
  document.title = title;
  document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute("content", route.description);
  document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.setAttribute("content", title);
  document
    .querySelector<HTMLMetaElement>('meta[property="og:description"]')
    ?.setAttribute("content", route.description);
  document.querySelector<HTMLMetaElement>('meta[property="og:type"]')?.setAttribute("content", "website");
  document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.setAttribute("content", canonicalUrl);
  document.querySelector<HTMLMetaElement>('meta[name="twitter:title"]')?.setAttribute("content", title);
  document
    .querySelector<HTMLMetaElement>('meta[name="twitter:description"]')
    ?.setAttribute("content", route.description);
  document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.setAttribute("href", canonicalUrl);
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

/* "auto" must resolve exactly the way the runtime and the Threads setting's
   `auto (N)` placeholder resolve it - raw hardwareConcurrency disagrees with
   both (it ignores the 4-thread floor and the non-isolated 1-thread case). */
const resolveThreads = (threads?: unknown): number => {
  const numeric = typeof threads === "number" ? threads : Number.parseInt(String(threads || ""), 10);
  if (Number.isFinite(numeric) && numeric >= 1) return numeric;
  return getDefaultBrowserThreadCount();
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

/** Reset is a labelled, contextual workflow action now, not a global icon. */
const ResetButton = ({ onReset }: { onReset: () => void }) => {
  const localizer = useUiLocalizer();
  return (
    <button className="btn ghost slim reset-btn" onClick={onReset} type="button">
      <RotateCcw aria-hidden="true" />
      <span>{localizer.message("ui.settings.reset")}</span>
    </button>
  );
};

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

function WebappRoot({
  state,
  pageUpdate,
  confirmationDialog,
  actions,
  serviceWorkerCache,
  urlSession,
  docsSlug = "docs",
  notFound = false,
}: WebappRootProps) {
  useEntryAnimationLock();
  useEffect(() => {
    if (notFound) return;
    syncWorkflowSeoMetadata(state.currentView);
  }, [notFound, state.currentView]);
  // Route mid-command wasm host selection prompts to the visible tab's form. All
  // forms stay mounted, so without this the last-mounted form would own prompts.
  useEffect(() => {
    if (notFound) return;
    setActiveSelectionForm(state.currentView === "docs" ? undefined : state.currentView);
  }, [notFound, state.currentView]);
  const [logOpen, setLogOpen] = useState(false);
  const [logTab, setLogTab] = useState<LogDialogTab>("status");
  const [settingsFocusHint, setSettingsFocusHint] = useState<SettingsFocusHint | null>(null);
  // The settings tab owns a draft, so closing it runs the controller's
  // discard-confirmation flow first; the dialog itself only closes once that
  // flow actually clears `settingsDialogOpen`.
  const settingsCloseArmedRef = useRef(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  // Workflow forms keep their local state (staged files, validated patches,
  // finished outputs) in component state, so unmounting on tab switch would
  // silently discard the user's work. Each form mounts on first visit and then
  // stays mounted but hidden, which preserves state across tab switches.
  const [visitedViews, setVisitedViews] = useState<readonly WebappView[]>([state.currentView]);
  const [pageDrop, setPageDrop] = useState<WebappRootPageDrop | null>(null);
  const [pageDragging, setPageDragging] = useState(false);
  const pageDropIdRef = useRef(0);
  const threads = state.settings.threads;
  useLayoutEffect(() => notifyGuidedSampleView(state.currentView), [state.currentView]);
  useLayoutEffect(() => {
    document.documentElement.dataset.betaToolsEnabled = state.settings.betaToolsEnabled ? "true" : "false";
  }, [state.settings.betaToolsEnabled]);
  const preloadGuide = useCallback(
    (guide: GuidedSample) => {
      void preloadWorkflowRoute(getGuideView(guide));
      void preloadBrowserRuntime({ threads });
    },
    [threads],
  );
  const startGuide = useCallback(
    (guide: GuidedSample) => {
      const targetHasFiles =
        guide === "create"
          ? state.creatorSession.originalFilePresent || state.creatorSession.modifiedFilePresent
          : state.patcherSession.romFilePresent || state.patcherSession.patchCount > 0;
      if (targetHasFiles) return false;
      preloadGuide(guide);
      selectViewWithTransition(() => actions.onStartGuide(guide));
      return true;
    },
    [
      actions,
      preloadGuide,
      state.creatorSession.modifiedFilePresent,
      state.creatorSession.originalFilePresent,
      state.patcherSession.patchCount,
      state.patcherSession.romFilePresent,
    ],
  );
  useEffect(() => {
    if (notFound) return;
    let cancelled = false;
    const preloadDialogsWhenIdle = () => {
      if (cancelled) return;
      void loadLogDialog().catch(() => undefined);
      void loadSettingsPanel().catch(() => undefined);
    };
    const scheduleDialogPreload = () => {
      if (cancelled) return;
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(preloadDialogsWhenIdle, { timeout: 2000 });
      } else {
        window.setTimeout(preloadDialogsWhenIdle, 0);
      }
    };
    // A guide never reaches the ROM engine, so it warms the dialogs and leaves
    // the runtime preload to the workflow tabs.
    let cancelPreload: () => void = () => undefined;
    if (state.currentView === "docs") {
      scheduleDialogPreload();
    } else {
      cancelPreload = scheduleBrowserRuntimePreload(() => {
        if (cancelled) return;
        void preloadBrowserRuntime({ threads }).then(scheduleDialogPreload);
      });
    }
    return () => {
      cancelled = true;
      cancelPreload();
    };
  }, [notFound, state.currentView, threads]);
  const preloadSettingsPanel = useCallback(() => {
    void loadSettingsPanel().catch(() => undefined);
  }, []);
  // The panel is lazy, but the dialog opens immediately: its tab rail is the
  // header, so a still-loading panel shows a usable frame rather than a bare
  // one. Hover/focus/idle preloads mean it is almost always already resident.
  const openSettingsTab = useCallback(
    (fieldId?: string) => {
      preloadSettingsPanel();
      settingsCloseArmedRef.current = false;
      setSettingsFocusHint(fieldId ? { fieldId, token: Date.now() } : null);
      setLogTab("settings");
      setLogOpen(true);
      actions.onOpenSettings();
    },
    [actions, preloadSettingsPanel],
  );
  const handleDialogTabChange = useCallback(
    (tab: LogDialogTab) => {
      setLogTab(tab);
      // Reaching Settings from inside the dialog must stage a draft exactly the
      // way the gear does, or the panel would edit a stale one.
      if (tab === "settings") {
        preloadSettingsPanel();
        actions.onOpenSettings();
      }
    },
    [actions, preloadSettingsPanel],
  );
  const closeDialog = useCallback(() => {
    if (!state.settingsDialogOpen) {
      setLogOpen(false);
      return;
    }
    settingsCloseArmedRef.current = true;
    actions.onCloseSettings();
  }, [actions, state.settingsDialogOpen]);
  const saveSettings = useCallback(() => {
    settingsCloseArmedRef.current = true;
    actions.onSaveClose();
  }, [actions]);
  useEffect(() => {
    if (state.settingsDialogOpen || !settingsCloseArmedRef.current) return;
    settingsCloseArmedRef.current = false;
    logger.trace("unified dialog closing after the settings draft settled");
    setLogOpen(false);
  }, [state.settingsDialogOpen]);
  const activePageDrop = pageDrop?.view === state.currentView ? pageDrop.drop : null;
  const preloadLogDialog = useCallback(() => {
    void loadLogDialog().catch(() => undefined);
  }, []);

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
  const urlSessionBoot = useUrlSessionBoot(
    notFound ? null : (urlSession?.request ?? null),
    deliverUrlSessionFiles,
    setBundleSession,
  );

  useEffect(() => {
    setVisitedViews((previous) => (previous.includes(state.currentView) ? previous : [...previous, state.currentView]));
  }, [state.currentView]);
  const isViewMounted = (view: WebappView) => state.currentView === view || visitedViews.includes(view);

  // Arm the dropzones while a file is dragged anywhere over the page. `dragover`
  // fires continuously, so a short debounce clears the flag once it stops (drag
  // left the window or dropped) - `dragleave`/`dragend` are unreliable here.
  useEffect(() => {
    if (notFound || state.currentView === "docs") {
      setPageDragging(false);
      return undefined;
    }
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
  }, [notFound, state.currentView]);

  // Page-level drag: dropping a file anywhere on the page (outside a dropzone
  // box) forwards it to the active tab's unified drop handler via `pageDrop`.
  useEffect(() => {
    if (notFound || state.currentView === "docs") return undefined;
    const handlePageDragOver = (event: DragEvent) => {
      if (isInsideLocalDropZone(event.target) || !isFileDragTransfer(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const handlePageDrop = (event: DragEvent) => {
      if (isInsideLocalDropZone(event.target) || !isFileDragTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      if (logOpen || state.settingsDialogOpen || confirmationDialog.open) return;
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
  }, [confirmationDialog.open, logOpen, notFound, state.currentView, state.settingsDialogOpen]);

  const workflowPanel = (view: WebappView, form: React.ReactNode) =>
    isViewMounted(view) ? (
      <section
        aria-labelledby={`tab-${view}`}
        className="panel workflow"
        hidden={state.currentView !== view}
        id={`panel-${view}`}
        role="tabpanel"
      >
        {view === "docs" ? null : (
          <div className="workflow-panel-head">
            <ResetButton onReset={actions.onReset} />
          </div>
        )}
        <div className="workflow-body">
          {/* Only ever engages for a tab switch: the landing route is preloaded before the first mount. */}
          <Suspense fallback={null}>{form}</Suspense>
        </div>
      </section>
    ) : null;
  return (
    <RomWeaverSettingsProvider assetBaseUrl={readAppBaseUrl()} settings={state.settings}>
      <div className={pageDragging ? "rw-app rw-page-dragging" : "rw-app"} id="column">
        <div className="app">
          <Masthead
            channelBadge={CHANNEL_BADGE}
            confirmExternalNavigation={actions.onConfirmExternalNavigation}
            currentTab={notFound ? "" : state.currentView}
            githubHref={GITHUB_URL}
            onAccentChange={actions.onAccentChange}
            commitsSinceVersion={COMMITS_SINCE_VERSION}
            dirty={Boolean(DIRTY_HASH)}
            donateHref={DONATE_URL}
            onOpenChangelog={() => setChangelogOpen(true)}
            onOpenLog={() => {
              setLogTab("logs");
              setLogOpen(true);
            }}
            onOpenStatus={() => {
              setLogTab("status");
              setLogOpen(true);
            }}
            onPreloadLog={preloadLogDialog}
            onOpenSettings={() => openSettingsTab()}
            onOpenThreads={() => openSettingsTab(SETTINGS_FIELD_METADATA.threads.id)}
            onPreloadSettings={preloadSettingsPanel}
            serviceWorkerStatus={serviceWorkerCache.serviceWorkerStatus}
            threads={resolveThreads(threads)}
            updateReady={pageUpdate.ready}
            version={APP_VERSION}
            versionTitle={`v${APP_BUILD_VERSION}`}
            onSelectTab={(id) => {
              if (notFound) {
                const href = WORKFLOW_TABS.find((tab) => tab.id === id)?.href;
                if (href) window.location.assign(`/${href}`);
                return;
              }
              selectViewWithTransition(() => actions.onSelectView(id as WebappRootProps["state"]["currentView"]));
            }}
            settingsOpen={logOpen && logTab === "settings"}
            tabs={notFound ? WORKFLOW_TABS.map((tab) => ({ ...tab, href: `/${tab.href}` })) : WORKFLOW_TABS}
            tabsControlPanels={!notFound}
          />
          <UpdateBanner onReload={actions.onReloadUpdate} open={pageUpdate.ready} />
          <ChangelogDialog
            onClose={() => setChangelogOpen(false)}
            onReload={actions.onReloadUpdate}
            open={changelogOpen}
          />
          <UrlSessionBanner onRetry={urlSessionBoot.retry} state={urlSessionBoot.state} />
          <ActivityWakeLockNotice />
          <main className={notFound ? "workbench is-not-found" : "workbench"} id="main-content" tabIndex={-1}>
            {notFound ? (
              <section aria-labelledby="not-found-title" className="not-found-page">
                <div className="not-found-content">
                  <h1 aria-label="404: Page not found" className="not-found-title" id="not-found-title">
                    <span aria-hidden="true" className="not-found-code">
                      404
                    </span>
                    <span aria-hidden="true" className="not-found-label">
                      That page is not here.
                    </span>
                  </h1>
                  <p className="not-found-copy">Check the address, or choose where you want to go next.</p>
                  <div className="not-found-actions">
                    <a className="btn primary not-found-home" href="/apply">
                      <House aria-hidden="true" />
                      Apply a patch
                    </a>
                    <a className="btn ghost not-found-docs" href="/docs">
                      <BookOpen aria-hidden="true" />
                      Browse docs
                    </a>
                  </div>
                </div>
              </section>
            ) : (
              <>
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
                  "docs",
                  <DocsPageRoute
                    active={state.currentView === "docs"}
                    onGuideIntent={preloadGuide}
                    onStartGuide={startGuide}
                    slug={docsSlug}
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
                {state.currentView === "docs" ? null : <DropVeil />}
              </>
            )}
          </main>
          {/* the dock is fixed, so the column reserves its height through the one
              variable masthead.css raises below the dock threshold */}
          <div aria-hidden="true" className="dock-pad" />
        </div>
        <ActivityFinishMarker />
        {logOpen ? (
          <Suspense fallback={null}>
            <LogDialog
              initialTab={logTab}
              level={state.settings.logLevel}
              onClose={closeDialog}
              onLevelChange={actions.onLogLevelChange}
              onOpenChangelog={() => setChangelogOpen(true)}
              onReload={actions.onReloadUpdate}
              onRestoreDefaults={actions.onRestoreDefaults}
              onSaveSettings={saveSettings}
              onTabChange={handleDialogTabChange}
              open={logOpen}
              serviceWorkerStatus={serviceWorkerCache.serviceWorkerStatus}
              settingsFocusHint={settingsFocusHint}
              settingsPanel={
                <Suspense fallback={null}>
                  <SettingsPanel
                    draftSettings={state.draftSettings as Parameters<typeof getSettingsUiState>[0]}
                    onDraftChange={actions.onDraftChange}
                    uiState={getSettingsUiState(state.draftSettings as Parameters<typeof getSettingsUiState>[0])}
                    validation={state.validation}
                  />
                </Suspense>
              }
              updateReady={pageUpdate.ready}
            />
          </Suspense>
        ) : null}
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

export { resolveThreads, selectViewWithTransition, WebappRoot };
