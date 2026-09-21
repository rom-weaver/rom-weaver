import {
  BookOpen,
  Gamepad2,
  GitCompare,
  House,
  Package,
  RotateCcw,
  Rows3,
  Save as SaveIcon,
  ScanSearch,
  Scissors,
  ListTree,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useMemo,
} from "react";
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
import { notifyGuidedSampleView } from "../public/react/guided-sample-start.ts";
import { requestEmulatorStartFromUserAction } from "../public/react/emulator-audio-context.ts";
import type { PageFileDrop } from "../public/react/public-types.ts";
// Deliberately NOT the ../public/react/index.tsx barrel: that barrel re-exports
// every workflow form, so a static import of it pulls all four route chunks
// back into the entry and defeats the split below.
import { RomWeaverSettingsProvider } from "../public/react/settings-context.tsx";
import { setActiveSelectionForm } from "../public/react/input-selection-handler.ts";
import type { RomLookupResult, RomLookupResultRequest, RomLookupSelection } from "../public/react/use-rom-lookup.ts";
import { useUiLocalizer } from "../public/react/settings-context.tsx";
import { scheduleBrowserRuntimePreload } from "./browser-runtime-preload.ts";
import { CHANNEL_BADGE } from "./build-channel.ts";
import { readAppBaseUrl } from "./webapp-controller.ts";
import { APP_BUILD_VERSION, APP_VERSION, COMMITS_SINCE_VERSION, DIRTY_HASH } from "./build-version.ts";
import { RelatedStrip } from "./components/related-strip.tsx";
import { Masthead, UpdateBanner } from "./components/shell.tsx";
import type { WorkflowTab } from "./components/shell.tsx";
import { useScreenWakeLock } from "./components/wake-lock-notice.tsx";
import { resolveHostIngestFiles, subscribeHostIngest } from "./host-ingest.ts";
import { ABOUT_URL, DONATE_URL, GITHUB_URL, PRIVACY_URL } from "./project-links.ts";
import { getSettingsUiState, SETTINGS_FIELD_METADATA } from "./settings/settings-state.ts";
import { shouldWarnBeforeUnload } from "./unload-guard.ts";
import type { WebappView } from "./webapp-state-types.ts";
import { UrlSessionBanner } from "./url-session/url-session-banner.tsx";
import { useUrlSessionBoot } from "./url-session/use-url-session-boot.ts";
import { readUpdateDismissed, writeUpdateDismissed } from "./update-dismissal.ts";
import { useOfflineStatus } from "./use-offline-status.ts";
import { isFileDragTransfer, isInsideLocalDropZone, usePageDragging } from "./use-page-drag.ts";
import { loadLogDialog, loadSettingsPanel, useUnifiedDialog } from "./use-unified-dialog.ts";
import type { WebappRootProps } from "./webapp-root-types.ts";
import {
  ApplyPatchRoute,
  BundleRoute,
  CreatePatchRoute,
  DocsPageRoute,
  EmulatorTestRoute,
  HomePageRoute,
  IdentifyRouteForm,
  preloadWorkflowRoute,
  PpfUndoRouteForm,
  SaveEditorRouteForm,
  TrimPatchRoute,
  WhatsNewPageRoute,
} from "./workflow-routes.tsx";
import { SITE_NAME, WORKFLOW_SEO_ROUTES } from "./workflow-seo.mjs";

const WORKFLOW_TABS: WorkflowTab[] = [
  {
    dock: true,
    group: "patches",
    href: "apply-patches",
    icon: <ApplyBandaidIcon className="apply-tab-icon" />,
    id: "patcher",
    label: "Apply Patches",
    railLabel: "Apply",
  },
  {
    dock: true,
    group: "patches",
    href: "create-patch",
    icon: <GitCompare aria-hidden="true" />,
    id: "creator",
    label: "Create Patch",
    railLabel: "Create",
  },
  {
    group: "patches",
    href: "bundle-patches",
    icon: <Package aria-hidden="true" />,
    id: "bundle",
    label: "Bundle Patches",
    railLabel: "Bundle",
  },
  {
    beta: true,
    group: "patches",
    href: "ppf-undo",
    icon: <RotateCcw aria-hidden="true" />,
    id: "ppf-undo",
    label: "PPF undo",
  },
  {
    group: "roms",
    href: "identify-rom",
    icon: <ScanSearch aria-hidden="true" />,
    id: "identify",
    label: "Identify ROM",
    railLabel: "Identify",
  },
  {
    beta: true,
    group: "roms",
    href: "trim-rom",
    icon: <Scissors aria-hidden="true" />,
    id: "trim",
    label: "Trim ROM",
    railLabel: "Trim",
  },
  {
    dock: true,
    group: "roms",
    href: "test-rom",
    icon: <Gamepad2 aria-hidden="true" />,
    id: "test",
    label: "Test ROM",
    railLabel: "Test",
  },
  {
    beta: true,
    group: "roms",
    href: "save-editor",
    icon: <SaveIcon aria-hidden="true" />,
    id: "save-editor",
    label: "Save Editor",
    railLabel: "Saves",
  },
  // Reference rather than a workflow, so it sits with the project links.
  { group: "project", href: "docs", icon: <BookOpen aria-hidden="true" />, id: "docs", label: "Docs" },
];

// Keep the trace inspector out of the initial bundle, but share its loader so
// the masthead and idle post-boot preload can fetch the same promise.
const LogDialog = lazy(loadLogDialog);
const SettingsPanel = lazy(loadSettingsPanel);
type BrowserApiModule = typeof import("../platform/browser/browser-api.ts");
const preloadBrowserRuntime = (options: Parameters<BrowserApiModule["preloadBrowserRuntime"]>[0] = {}) =>
  import("../platform/browser/browser-api.ts").then(({ preloadBrowserRuntime: preload }) => preload(options));

const logger = createLogger("webapp-root");

const syncWorkflowSeoMetadata = (view: WebappView) => {
  if (view === "docs") return;
  if (view === "whats-new") {
    document.title = "rom-weaver - What's new";
    return;
  }
  let route = null;
  if (view === "creator") route = WORKFLOW_SEO_ROUTES.creator;
  else if (view === "bundle") route = WORKFLOW_SEO_ROUTES.bundle;
  else if (view === "home") route = WORKFLOW_SEO_ROUTES.home;
  else if (view === "identify") route = WORKFLOW_SEO_ROUTES.identify;
  else if (view === "patcher") route = WORKFLOW_SEO_ROUTES.patcher;
  else if (view === "test") route = WORKFLOW_SEO_ROUTES.test;
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
    <button aria-label={localizer.message("ui.settings.reset")} className="reset-btn" onClick={onReset} type="button">
      <RotateCcw aria-hidden="true" />
      <span>{localizer.message("ui.settings.reset")}</span>
    </button>
  );
};

/** File-detail switch for the workflow panel's `0x01` heading band. */
const PanelViewToggle = ({ detailed, onChange }: { detailed: boolean; onChange: (enabled: boolean) => void }) => {
  const localizer = useUiLocalizer();
  const label = localizer.message(detailed ? "ui.view.detailed" : "ui.view.simple");
  const action = localizer.message(detailed ? "ui.view.switchToSimple" : "ui.view.switchToDetailed");
  return (
    <button
      aria-label={action}
      aria-pressed={detailed}
      className="panel-view-toggle"
      onClick={() => onChange(!detailed)}
      type="button"
    >
      {detailed ? <ListTree aria-hidden="true" /> : <Rows3 aria-hidden="true" />}
      <span>{label}</span>
    </button>
  );
};

const PanelThreadCount = ({
  count,
  onOpenThreads,
  onPreloadSettings,
}: {
  count: number;
  onOpenThreads: () => void;
  onPreloadSettings?: () => void;
}) => {
  const localizer = useUiLocalizer();
  const singular = localizer.message("ui.env.thread");
  const plural = localizer.message("ui.env.threads");
  return (
    <button
      aria-haspopup="dialog"
      className="panel-threads-btn"
      data-thread-plural={plural}
      data-thread-singular={singular}
      onClick={onOpenThreads}
      onFocus={onPreloadSettings}
      onPointerDown={onPreloadSettings}
      onPointerEnter={onPreloadSettings}
      type="button"
    >
      <span className="panel-threads-text">
        <span className="panel-threads-count">{count}</span>{" "}
        <span className="panel-threads-word">{count === 1 ? singular : plural}</span>
      </span>
    </button>
  );
};

const PageFooter = () => {
  const localizer = useUiLocalizer();
  return (
    <footer className="page-footer">
      <span>{localizer.message("ui.footer.local")}</span>
      <span className="page-footer-links">
        <a className="page-footer-link" href={ABOUT_URL}>
          {localizer.message("ui.footer.about")}
        </a>
        <a className="page-footer-link" href={PRIVACY_URL}>
          {localizer.message("ui.footer.privacy")}
        </a>
      </span>
    </footer>
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
const ActivityWakeLock = ({ pageHasPendingChanges }: { pageHasPendingChanges: boolean }) => {
  const activity = useSyncExternalStore(subscribeWorkbenchActivity, getWorkbenchActivity, getWorkbenchActivity);
  useScreenWakeLock(pageHasPendingChanges || activity.state === "running" || activity.state === "staging");
  return null;
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
  assetBaseUrl,
}: WebappRootProps) {
  // The prerendered shell resolves asset links against "/" (no window to read
  // the origin from), so hydration passes the same value and only the render
  // after it adopts the real base - otherwise React sees every href mismatch.
  const resolvedAssetBaseUrl = assetBaseUrl ?? readAppBaseUrl();
  useEntryAnimationLock();
  useEffect(() => {
    if (notFound) return;
    syncWorkflowSeoMetadata(state.currentView);
  }, [notFound, state.currentView]);
  const {
    changePreviewRuntimeState,
    previewOfflineProgress,
    previewRuntimeState,
    previewUpdateDismissed,
    setPreviewUpdateDismissed,
  } = useOfflineStatus();
  // Route mid-command wasm host selection prompts to the visible tab's form. All
  // forms stay mounted, so without this the last-mounted form would own prompts.
  useEffect(() => {
    if (notFound) return;
    setActiveSelectionForm(
      state.currentView === "docs" || state.currentView === "whats-new" ? undefined : state.currentView,
    );
  }, [notFound, state.currentView]);
  const [updateDismissed, setUpdateDismissed] = useState(readUpdateDismissed);
  const pendingViewRef = useRef<WebappView | null>(null);
  // Workflow forms keep their local state (staged files, validated patches,
  // finished outputs) in component state, so unmounting on tab switch would
  // silently discard the user's work. Each form mounts on first visit and then
  // stays mounted but hidden, which preserves state across tab switches.
  const [visitedViews, setVisitedViews] = useState<readonly WebappView[]>([state.currentView]);
  const [identifyLookupRequest, setIdentifyLookupRequest] = useState<{
    id: number;
    selection: RomLookupSelection;
  }>();
  const identifyLookupIdRef = useRef(0);
  const [applyRomLookupRequest, setApplyRomLookupRequest] = useState<RomLookupResultRequest>();
  const applyRomLookupIdRef = useRef(0);
  const currentViewRef = useRef(state.currentView);
  currentViewRef.current = state.currentView;
  const [pageDrop, setPageDrop] = useState<WebappRootPageDrop | null>(null);
  const pageDropIdRef = useRef(0);
  const threads = state.settings.threads;
  const threadCount = resolveThreads(threads);
  useLayoutEffect(() => notifyGuidedSampleView(state.currentView), [state.currentView]);
  useLayoutEffect(() => {
    document.documentElement.dataset.betaToolsEnabled = state.settings.betaToolsEnabled ? "true" : "false";
  }, [state.settings.betaToolsEnabled]);
  useLayoutEffect(() => {
    document.documentElement.dataset.onboardingEnabled = state.settings.onboardingEnabled ? "true" : "false";
  }, [state.settings.onboardingEnabled]);
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
    // A guide and the landing page never reach the ROM engine, so they warm the
    // dialogs only and leave the runtime preload to the workflow tabs. Preloading
    // here compiles the WASM module and starts both WASI worker pools, which lands
    // on the main thread right after first paint and blocks it; the workflow tab
    // the visitor clicks through to preloads the same runtime, memoized, so the
    // engine is still warmed exactly once.
    let cancelPreload: () => void = () => undefined;
    if (state.currentView === "docs" || state.currentView === "home") {
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
  const {
    closeDialog,
    handleDialogTabChange,
    logOpen,
    logTab,
    openSettingsTab,
    openStatusTab,
    openStorageTab,
    preloadLogDialog,
    preloadSettingsPanel,
    saveSettings,
    setLogOpen,
    setLogTab,
    settingsFocusHint,
  } = useUnifiedDialog(actions, state);
  /* Every workflow the user has visited stays mounted, so a single page drop
     would otherwise reach all of them at once - two forms staging the same file
     and overwriting each other's activity-store entry. The drop goes ONLY to the
     view it was made on, and only while that view is still the current one. */
  const pageDropFor = (view: WebappView) =>
    pageDrop && pageDrop.view === view && state.currentView === view ? pageDrop.drop : null;
  const openWhatsNew = useCallback(() => {
    pendingViewRef.current = null;
    selectViewWithTransition(() => actions.onSelectView("whats-new"));
  }, [actions]);
  // One identity per shell, so Find's index is not rebuilt on every render of the 404 page.
  const mastheadTabs = useMemo(
    () => (notFound ? WORKFLOW_TABS.map((tab) => ({ ...tab, href: `/${tab.href}` })) : WORKFLOW_TABS),
    [notFound],
  );

  // The nav's own tab switch. Shared with the related-links strips (workflow
  // results, the docs footer, the not-found page) so every "go here next"
  // affordance in the app resolves through this one router.
  const handleSelectTab = useCallback(
    (id: string) => {
      if (notFound) {
        if (id === "home") {
          window.location.assign(resolvedAssetBaseUrl);
          return;
        }
        // The nav can also reach a view with no WorkflowTab entry (What's
        // new), so it falls back to the id itself as the slug.
        const href = WORKFLOW_TABS.find((tab) => tab.id === id)?.href ?? id;
        if (href) window.location.assign(`/${href}`);
        return;
      }
      const view = id as WebappRootProps["state"]["currentView"];
      if (view === "test") requestEmulatorStartFromUserAction();
      if (view === "docs") {
        // Keep the current panel visible until the lazy Docs route is ready;
        // switching first leaves its navigation bar absent for one frame.
        const startingView = currentViewRef.current;
        pendingViewRef.current = view;
        void preloadWorkflowRoute(view).then(() => {
          if (pendingViewRef.current !== view || currentViewRef.current !== startingView) return;
          pendingViewRef.current = null;
          selectViewWithTransition(() => actions.onSelectView(view));
        });
        return;
      }
      pendingViewRef.current = null;
      selectViewWithTransition(() => actions.onSelectView(view));
    },
    [actions, notFound, resolvedAssetBaseUrl],
  );

  // URL-session sources land in the matching workflow's drop pipeline exactly
  // like a page-level drop (classification and routing stay Rust-driven).
  const deliverUrlSessionFiles = useCallback(
    (files: File[]) => {
      const sessionView = urlSession?.request?.kind === "bundle" ? "bundle" : "patcher";
      actions.onSelectView(sessionView);
      pageDropIdRef.current += 1;
      setPageDrop({
        drop: {
          files,
          id: pageDropIdRef.current,
        },
        view: sessionView,
      });
    },
    [actions, urlSession?.request?.kind],
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
  const openIdentifyLookup = useCallback(
    (selection: RomLookupSelection) => {
      identifyLookupIdRef.current += 1;
      setIdentifyLookupRequest({ id: identifyLookupIdRef.current, selection });
      handleSelectTab("identify");
    },
    [handleSelectTab],
  );
  const carryIdentifyResultToApply = useCallback((result: RomLookupResult | undefined) => {
    applyRomLookupIdRef.current += 1;
    setApplyRomLookupRequest({ id: applyRomLookupIdRef.current, result });
  }, []);

  const pageDragging = usePageDragging(notFound, state);
  // Page-level drag: dropping a file anywhere on the page (outside a dropzone
  // box) forwards it to the active tab's unified drop handler via `pageDrop`.
  useEffect(() => {
    if (notFound || state.currentView === "docs" || state.currentView === "whats-new") return undefined;
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
      /* A named section is already a region; it takes its name from the nav
         row that reaches it, since the sidebar is a nav rather than a tablist. */
      <section
        aria-labelledby={`tab-${view}`}
        className="panel workflow"
        hidden={state.currentView !== view}
        id={`panel-${view}`}
      >
        {view === "docs" || view === "whats-new" ? null : (
          <div
            className="workflow-panel-head"
            data-threads={
              view === "bundle" || view === "patcher" || view === "creator" || view === "trim" ? "" : undefined
            }
          >
            {view === "bundle" || view === "patcher" || view === "creator" || view === "trim" ? (
              <PanelThreadCount
                count={threadCount}
                onOpenThreads={() => openSettingsTab(SETTINGS_FIELD_METADATA.threads.id)}
                onPreloadSettings={preloadSettingsPanel}
              />
            ) : null}
            <PanelViewToggle
              detailed={state.settings.detailedViewEnabled === true}
              onChange={actions.onDetailedViewEnabledChange}
            />
            <ResetButton onReset={actions.onReset} />
          </div>
        )}
        <div className="workflow-body">
          {/* Only ever engages for a tab switch: the landing route is preloaded before the first mount. */}
          <Suspense fallback={null}>{form}</Suspense>
        </div>
      </section>
    ) : null;
  const pageHasPendingChanges = shouldWarnBeforeUnload({
    creatorState: state.creatorSession,
    outputState: state.patcherSession,
    patchStackState: { items: Array.from({ length: state.patcherSession.patchCount }) },
    patcherFormEdited: !!(state.patcherSession.outputName.trim() || state.patcherSession.outputCompression !== "none"),
    romFilePresent: state.patcherSession.romFilePresent,
    ppfUndoActive: state.ppfUndoSession?.active ?? false,
    saveEditorActive: state.saveEditorSession?.active ?? false,
    trimState: state.trimSession,
    webappState: state,
  });
  return (
    <RomWeaverSettingsProvider assetBaseUrl={resolvedAssetBaseUrl} settings={state.settings}>
      <div className={pageDragging ? "rw-app rw-page-dragging" : "rw-app"} id="column">
        <div className="app">
          <Masthead
            homeHref={resolvedAssetBaseUrl}
            channelBadge={CHANNEL_BADGE}
            confirmExternalNavigation={actions.onConfirmExternalNavigation}
            currentTab={notFound ? "" : state.currentView}
            docsSlug={docsSlug}
            donateHref={DONATE_URL}
            githubHref={GITHUB_URL}
            onAccentChange={actions.onAccentChange}
            commitsSinceVersion={COMMITS_SINCE_VERSION}
            dirty={Boolean(DIRTY_HASH)}
            onOpenWhatsNew={openWhatsNew}
            onOpenLog={() => {
              setLogTab("logs");
              setLogOpen(true);
            }}
            onOpenStatus={openStatusTab}
            onOpenStorage={openStorageTab}
            onPreloadLog={preloadLogDialog}
            onOpenSettings={() => openSettingsTab()}
            onOpenSettingsField={openSettingsTab}
            onIdentifyQuery={openIdentifyLookup}
            serviceWorkerStatus={serviceWorkerCache.serviceWorkerStatus}
            offlineProgress={previewOfflineProgress}
            previewRuntimeState={previewRuntimeState}
            updateReady={pageUpdate.ready}
            version={APP_VERSION}
            versionTitle={`v${APP_BUILD_VERSION}`}
            onSelectTab={handleSelectTab}
            tabs={mastheadTabs}
          />
          <UpdateBanner
            onDismiss={() => {
              if (previewRuntimeState !== null) {
                setPreviewUpdateDismissed(true);
                return;
              }
              setUpdateDismissed(true);
              writeUpdateDismissed();
            }}
            onOpenWhatsNew={openWhatsNew}
            onReload={actions.onReloadUpdate}
            open={
              previewRuntimeState === null
                ? pageUpdate.ready && !updateDismissed
                : previewRuntimeState === "update" && !previewUpdateDismissed
            }
            title={pageUpdate.title}
          />
          <UrlSessionBanner onRetry={urlSessionBoot.retry} state={urlSessionBoot.state} />
          <ActivityWakeLock pageHasPendingChanges={pageHasPendingChanges} />
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
                    <a className="btn primary not-found-home" href="/apply-patches">
                      <House aria-hidden="true" />
                      Apply Patches
                    </a>
                    <a className="btn ghost not-found-docs" href="/docs">
                      <BookOpen aria-hidden="true" />
                      Browse docs
                    </a>
                  </div>
                  <RelatedStrip entryKey="not-found" onSelectTab={handleSelectTab} />
                </div>
              </section>
            ) : (
              <>
                {isViewMounted("home") ? (
                  // `panel` is what puts this in the workbench's shared grid cell
                  // (banners.css); without it the drop veil takes row 1 and the
                  // landing page starts a veil's height down the page.
                  <div className="panel" hidden={state.currentView !== "home"}>
                    <Suspense fallback={null}>
                      <HomePageRoute baseUrl={resolvedAssetBaseUrl} />
                    </Suspense>
                  </div>
                ) : null}
                {workflowPanel(
                  "patcher",
                  <ApplyPatchRoute
                    bundleSession={bundleSession}
                    onBundlePackageChange={actions.onPatcherBundlePackageChange}
                    onInputsChange={actions.onPatcherInputsChange}
                    onPatchesChange={actions.onPatcherPatchesChange}
                    onSelectTab={handleSelectTab}
                    onSelectView={() => actions.onSelectView("test")}
                    onSettingsChange={actions.onPatcherSettingsChange}
                    pageDrop={pageDropFor("patcher")}
                    romLookupRequest={applyRomLookupRequest}
                    startup={state.startup}
                  />,
                )}
                {workflowPanel(
                  "bundle",
                  <BundleRoute
                    mode="bundle"
                    bundleSession={bundleSession}
                    onBundlePackageChange={actions.onPatcherBundlePackageChange}
                    onInputsChange={actions.onPatcherInputsChange}
                    onPatchesChange={actions.onPatcherPatchesChange}
                    onSelectTab={handleSelectTab}
                    onSelectView={() => actions.onSelectView("test")}
                    onSettingsChange={actions.onPatcherSettingsChange}
                    pageDrop={pageDropFor("bundle")}
                    startup={state.startup}
                  />,
                )}
                {workflowPanel(
                  "creator",
                  <CreatePatchRoute
                    onModifiedChange={actions.onCreatorModifiedChange}
                    onOriginalChange={actions.onCreatorOriginalChange}
                    onPatchTypeChange={actions.onCreatorPatchTypeChange}
                    onSelectTab={handleSelectTab}
                    onSettingsChange={actions.onCreatorSettingsChange}
                    pageDrop={pageDropFor("creator")}
                  />,
                )}
                {workflowPanel(
                  "docs",
                  <DocsPageRoute active={state.currentView === "docs"} onSelectTab={handleSelectTab} slug={docsSlug} />,
                )}
                {workflowPanel(
                  "whats-new",
                  <WhatsNewPageRoute
                    active={state.currentView === "whats-new"}
                    onReload={actions.onReloadUpdate}
                    updateReady={pageUpdate.ready}
                  />,
                )}
                {workflowPanel(
                  "identify",
                  <IdentifyRouteForm
                    lookupRequest={identifyLookupRequest}
                    onLookupResultChange={carryIdentifyResultToApply}
                    onSelectTab={handleSelectTab}
                    pageDrop={pageDropFor("identify")}
                  />,
                )}
                {workflowPanel("test", <EmulatorTestRoute active={state.currentView === "test"} />)}
                {workflowPanel(
                  "trim",
                  <TrimPatchRoute
                    onOutputFormatChange={actions.onTrimOutputFormatChange}
                    onSelectTab={handleSelectTab}
                    onSettingsChange={actions.onTrimSettingsChange}
                    onSourceChange={actions.onTrimSourceChange}
                    pageDrop={pageDropFor("trim")}
                  />,
                )}
                {workflowPanel(
                  "ppf-undo",
                  <PpfUndoRouteForm
                    onSessionChange={actions.onPpfUndoSessionChange}
                    pageDrop={pageDropFor("ppf-undo")}
                  />,
                )}
                {workflowPanel(
                  "save-editor",
                  <SaveEditorRouteForm
                    onSessionChange={actions.onSaveEditorSessionChange}
                    onSelectTab={handleSelectTab}
                    pageDrop={pageDropFor("save-editor")}
                  />,
                )}
                {state.currentView === "docs" || state.currentView === "whats-new" ? null : <DropVeil />}
              </>
            )}
          </main>
          <PageFooter />
          <span className="shell-threads-identity" hidden />
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
              onRestoreDefaults={actions.onRestoreDefaults}
              onSaveSettings={saveSettings}
              onTabChange={handleDialogTabChange}
              open={logOpen}
              serviceWorkerStatus={serviceWorkerCache.serviceWorkerStatus}
              offlineProgress={previewOfflineProgress}
              previewRuntimeState={previewRuntimeState}
              onPreviewRuntimeStateChange={changePreviewRuntimeState}
              onReloadUpdate={actions.onReloadUpdate}
              offlineCopyEnabled={state.settings.offlineCopyEnabled}
              onOfflineCopyEnabledChange={actions.onOfflineCopyEnabledChange}
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
