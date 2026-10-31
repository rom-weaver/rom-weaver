import { getSoftNavigationUrl } from "./soft-navigation.ts";
import { discardShellSelections } from "./shell-click-replay.ts";
import { trackSelectionDelivery } from "../lib/input/selection-delivery.ts";
import {
  Archive,
  BookOpen,
  FileDiff,
  Gamepad,
  Hash,
  House,
  PackageOpen,
  RotateCcw,
  Save as SaveIcon,
  ScanSearch,
  Scissors,
  Spool,
  Stamp,
  Undo2,
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
import type { WeaveApplySession } from "../lib/weave/weave-session-model.ts";
import { readDataTransferFiles } from "../lib/input/dropped-files.ts";
import { createLogger } from "../lib/logging.ts";
import { markDropReceived, markResultPaintedAfterFinish } from "../lib/perf/op-perf-marks.ts";
import { perfNow, recordDrop } from "../lib/runtime/perf-latency.ts";
import { getDefaultBrowserThreadCount } from "../platform/shared/compression-options.ts";
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
import {
  classifyDropEntry,
  countDropEntries,
  isEmulatorSaveExportName,
  isUsableDropFile,
  planDropDestinations,
  planDropRedirect,
  readDropEntries,
} from "../public/react/drop-destination.ts";
import { scheduleBrowserRuntimePreload } from "./browser-runtime-preload.ts";
import { CHANNEL_BADGE } from "./build-channel.ts";
import { observePanelHeadFit } from "./panel-head-fit.ts";
import { readAppBaseUrl } from "./webapp-controller.ts";
import { releaseLargeEntriesOnLargeInput } from "./large-input-release.ts";
import { APP_BUILD_VERSION, APP_VERSION, COMMITS_SINCE_VERSION, DIRTY_HASH } from "./build-version.ts";
import type { DropRouteRequest } from "./components/drop-route-dialog.tsx";
import type { EmulatorSaveImportRequest } from "./components/emulator-saves-panel.tsx";
import { releaseLargeEntriesOnRunStart } from "../public/react/emulator-session-store.ts";
import { LoadErrorBoundary } from "./components/load-error-boundary.tsx";
import { PausedGameBanner } from "./components/paused-game-banner.tsx";
import { RelatedStrip } from "./components/related-strip.tsx";
import { Masthead } from "./components/shell.tsx";
import type { WorkflowTab } from "./components/shell.tsx";
// Static, unlike the routes: a deploy that is waiting has already replaced
// the old hashed chunks on the host, so a lazy banner could no longer load.
import { UpdateBanner, type UpdateBannerKind } from "./components/update-banner.tsx";
import { useScreenWakeLock } from "./components/wake-lock-notice.tsx";
import { resolveHostIngestFiles, subscribeHostIngest } from "./host-ingest.ts";
import { runAppearanceTransition } from "./appearance-transition.ts";
import { ABOUT_URL, DONATE_URL, GITHUB_URL, PRIVACY_URL } from "./project-links.ts";
import { getSettingsUiState, SETTINGS_FIELD_METADATA } from "./settings/settings-state.ts";
import { shouldWarnBeforeUnload } from "./unload-guard.ts";
import type { WebappView } from "./webapp-state-types.ts";
import { UrlSessionBanner } from "./url-session/url-session-banner.tsx";
import { useUrlSessionBoot } from "./url-session/use-url-session-boot.ts";
import { readUpdateDismissed, writeUpdateDismissed } from "./update-dismissal.ts";
import { useOfflineStatus } from "./use-offline-status.ts";
import { useUpdatedSince } from "./use-updated-since.ts";
import { isFileDragTransfer, isInsideLocalDropZone, usePageDragging } from "./use-page-drag.ts";
import { loadLogDialog, loadSettingsPanel, useUnifiedDialog } from "./use-unified-dialog.ts";
import type { WebappRootProps } from "./webapp-root-types.ts";
import {
  ApplyPatchRoute,
  WeaveRoute,
  ChecksumRouteForm,
  CreatePatchRoute,
  CompressRouteForm,
  DocsPageRoute,
  EmulatorTestRoute,
  ExtractRouteForm,
  HomePageRoute,
  IdentifyRouteForm,
  preloadWorkflowRoute,
  PpfUndoRouteForm,
  SaveEditorRouteForm,
  TrimPatchRoute,
  WhatsNewPageRoute,
} from "./workflow-routes.tsx";
import { WORKFLOW_ENTRY_ROUTES, WORKFLOW_SEO_ROUTES, withChannelBadge } from "./workflow-seo.mjs";

const WORKFLOW_TABS: WorkflowTab[] = [
  {
    dock: true,
    group: "patches",
    href: "apply-rom-patches",
    icon: <Stamp aria-hidden="true" />,
    id: "patcher",
    label: "Apply Patches",
    railLabel: "Apply",
  },
  {
    dock: true,
    group: "patches",
    href: "create-rom-patch",
    icon: <FileDiff aria-hidden="true" />,
    id: "creator",
    label: "Create Patch",
    railLabel: "Create",
  },
  {
    group: "patches",
    href: "weave-rom-patches",
    icon: <Spool aria-hidden="true" />,
    id: "weave",
    label: "Weave Patches",
    railLabel: "Weave",
  },
  {
    group: "patches",
    href: "ppf-undo",
    icon: <Undo2 aria-hidden="true" />,
    id: "ppf-undo",
    label: "PPF undo",
  },
  {
    dock: true,
    group: "roms",
    href: "identify-rom",
    icon: <ScanSearch aria-hidden="true" />,
    id: "identify",
    label: "Identify ROM",
    railLabel: "Identify",
  },
  {
    group: "files",
    href: "file-checksum",
    icon: <Hash aria-hidden="true" />,
    id: "checksum",
    label: "Checksum file",
    railLabel: "Checksum",
  },
  {
    group: "files",
    href: "compress-files",
    icon: <Archive aria-hidden="true" />,
    id: "compress",
    label: "Compress files",
    railLabel: "Compress",
  },
  {
    group: "files",
    href: "extract-files",
    icon: <PackageOpen aria-hidden="true" />,
    id: "extract",
    label: "Extract files",
    railLabel: "Extract",
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
    href: "play-rom",
    icon: <Gamepad aria-hidden="true" />,
    id: "test",
    label: "Test ROM",
    railLabel: "Test",
  },
  {
    beta: true,
    group: "roms",
    href: "rom-save-editor",
    icon: <SaveIcon aria-hidden="true" />,
    id: "save-editor",
    label: "Save Editor",
  },
  {
    group: "project",
    href: "/docs",
    icon: <BookOpen aria-hidden="true" />,
    id: "docs",
    label: "Docs",
  },
];

/**
 * Tab hrefs are bare slugs except Docs (`/docs`), and the 404 page is served at
 * whatever path missed, so each resolves against the app base: a doubled slash
 * would be a protocol-relative URL, and a bare `/slug` would escape a
 * subdirectory deployment.
 */
const appPathHref = (href: string, appBaseUrl: string): string =>
  // The server render has no window, so its base is the bare "/"; the throwaway origin only lets that parse.
  new URL(href.replace(/^\/+/, ""), new URL(appBaseUrl, "https://app.invalid")).pathname;

// Keep the trace inspector out of the initial weave, but share its loader so
// the masthead and idle post-boot preload can fetch the same promise.
const LogDialog = lazy(loadLogDialog);
const SettingsPanel = lazy(loadSettingsPanel);
// Only a drop that could go to more than one place opens it, so it stays out of the entry chunk.
const DropRouteDialog = lazy(() =>
  import("./components/drop-route-dialog.tsx").then((module) => ({ default: module.DropRouteDialog })),
);
type BrowserApiModule = typeof import("../platform/browser/browser-api.ts");
const preloadBrowserRuntime = (options: Parameters<BrowserApiModule["preloadBrowserRuntime"]>[0] = {}) =>
  import("../platform/browser/browser-api.ts").then(({ preloadBrowserRuntime: preload }) => preload(options));

const logger = createLogger("webapp-root");

const syncWorkflowSeoMetadata = (view: WebappView, workflowEntry: WebappRootProps["workflowEntry"]) => {
  if (view === "docs") return;
  if (view === "whats-new") {
    document.title = withChannelBadge("What's new | rom-weaver", CHANNEL_BADGE);
    return;
  }
  let route: { title: string; description: string; slug: string } | undefined =
    WORKFLOW_SEO_ROUTES[view as keyof typeof WORKFLOW_SEO_ROUTES];
  if (workflowEntry && WORKFLOW_ENTRY_ROUTES[workflowEntry].view === view) {
    route = WORKFLOW_ENTRY_ROUTES[workflowEntry];
  }
  if (!route) {
    const tab = WORKFLOW_TABS.find((entry) => entry.id === view);
    document.title = withChannelBadge(tab ? `${tab.label} | rom-weaver` : "rom-weaver", CHANNEL_BADGE);
    return;
  }
  const title = withChannelBadge(route.title, CHANNEL_BADGE);
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

/** The workflow panel's heading controls, refitted to the room beside the first step's title. */
const WorkflowPanelHead = ({ children, threads }: { children: React.ReactNode; threads: boolean }) => {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => (ref.current ? observePanelHeadFit(ref.current) : undefined), []);
  return (
    <div className="workflow-panel-head" data-threads={threads ? "" : undefined} ref={ref}>
      {children}
    </div>
  );
};

/** File-detail switch for the workflow panel's `0x01` heading band. */
const PanelViewToggle = ({ detailed, onChange }: { detailed: boolean; onChange: (enabled: boolean) => void }) => {
  const localizer = useUiLocalizer();
  const simpleLabel = localizer.message("ui.view.simple");
  const detailedLabel = localizer.message("ui.view.detailed");
  // The switch keeps one accessible name; its checked state carries on/off.
  return (
    <label className="panel-view-toggle">
      <input
        aria-checked={detailed}
        aria-label={`${simpleLabel} / ${detailedLabel}`}
        checked={detailed}
        onChange={(event) => onChange(event.currentTarget.checked)}
        role="switch"
        type="checkbox"
      />
      <span>{detailed ? detailedLabel : simpleLabel}</span>
    </label>
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

/* While a routed drop is read and handed to its workflow, the veil stays
   up and says where the files are going; a drop that stays put never sets it. */
type DropRouting = { phase: "reading" } | { phase: "opening"; view: WebappView };
// Long enough to read the destination over the newly opened workflow.
const DROP_ROUTING_HOLD_MS = 450;

const DropVeil = ({ dragging, routing }: { dragging: boolean; routing: DropRouting | null }) => {
  const localizer = useUiLocalizer();
  // The veil fades out after routing ends; keep its last words until the next
  // drag so the fade never flashes back to "Release to add files".
  const lastRoutingRef = useRef(routing);
  if (routing) lastRoutingRef.current = routing;
  else if (dragging) lastRoutingRef.current = null;
  const shown = lastRoutingRef.current;
  const destination = shown?.phase === "opening" ? WORKFLOW_TABS.find((tab) => tab.id === shown.view) : undefined;
  const opening = destination ? localizer.message("ui.drop.opening", { page: destination.label }) : "";
  return (
    <>
      <div aria-hidden="true" className="dropveil">
        {/* Keyed by phase so each change of words replays the pill's entrance. */}
        <span className="dropveil-text" key={destination?.id ?? shown?.phase ?? "release"}>
          {destination ? (
            destination.icon
          ) : (
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M9 3 3 9l12 12 6-6Z" />
              <path d="m9 8.5 2 2m-4 1 2 2m3-7 2 2" />
            </svg>
          )}
          <span>
            {destination
              ? opening
              : localizer.message(shown?.phase === "reading" ? "ui.drop.staging" : "ui.drop.release")}
          </span>
        </span>
      </div>
      <p className="sr-only" role="status">
        {routing ? opening : ""}
      </p>
    </>
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

const NotFoundPage = ({ assetBaseUrl, onSelectTab }: { assetBaseUrl: string; onSelectTab: (id: string) => void }) => {
  const localizer = useUiLocalizer();
  return (
    <section aria-labelledby="not-found-title" className="not-found-page">
      <div className="not-found-content">
        <h1 aria-label={localizer.message("ui.notFound.heading")} className="not-found-title" id="not-found-title">
          <span aria-hidden="true" className="not-found-code">
            404
          </span>
          <span aria-hidden="true" className="not-found-label">
            {localizer.message("ui.notFound.label")}
          </span>
        </h1>
        <p className="not-found-copy">{localizer.message("ui.notFound.copy")}</p>
        <div className="not-found-actions">
          <a className="btn primary not-found-home" href={appPathHref("apply-rom-patches", assetBaseUrl)}>
            <House aria-hidden="true" />
            {localizer.message("ui.home.applyPatchCta")}
          </a>
          <a className="btn ghost not-found-docs" href={appPathHref("docs", assetBaseUrl)}>
            <BookOpen aria-hidden="true" />
            {localizer.message("ui.notFound.browseDocs")}
          </a>
        </div>
        <RelatedStrip entryKey="not-found" onSelectTab={onSelectTab} />
      </div>
    </section>
  );
};

function WebappRoot({
  state,
  pageUpdate,
  confirmationDialog,
  agentApprovalDialog,
  actions,
  serviceWorkerCache,
  urlSession,
  docsSlug = "docs",
  workflowEntry = null,
  creatorMode = null,
  notFound: initiallyNotFound = false,
  assetBaseUrl,
}: WebappRootProps) {
  const [recoveredDrop, setRecoveredDrop] = useState(false);
  const notFound = initiallyNotFound && !recoveredDrop;
  // The prerendered shell resolves asset links against "/" (no window to read
  // the origin from), so hydration passes the same value and only the render
  // after it adopts the real base - otherwise React sees every href mismatch.
  const resolvedAssetBaseUrl = assetBaseUrl ?? readAppBaseUrl();
  useEntryAnimationLock();
  useEffect(() => {
    if (notFound) return;
    syncWorkflowSeoMetadata(state.currentView, workflowEntry);
  }, [notFound, state.currentView, workflowEntry]);
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
  const updateReadyOpen =
    previewRuntimeState === null
      ? pageUpdate.ready && !updateDismissed
      : previewRuntimeState === "update" && !previewUpdateDismissed;
  const updatedSince = useUpdatedSince(state.currentView);
  // A waiting deploy takes the banner first; reloading into it announces both updates at once.
  let updateBannerKind: UpdateBannerKind | null = updatedSince.announce ? "updated" : null;
  if (updateReadyOpen) updateBannerKind = "ready";
  const dismissUpdateBanner = () => {
    if (updateBannerKind === "updated") {
      updatedSince.acknowledge();
      return;
    }
    if (previewRuntimeState !== null) {
      setPreviewUpdateDismissed(true);
      return;
    }
    setUpdateDismissed(true);
    writeUpdateDismissed();
  };
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
  const [pageDrops, setPageDrops] = useState<WebappRootPageDrop[]>([]);
  const pageDrop = pageDrops[0];
  const pendingDropsRef = useRef(new Map<number, () => void>());
  const routingQueueRef = useRef(Promise.resolve());
  const routingGenerationRef = useRef(0);
  const routeChoiceRef = useRef<(() => void) | null>(null);
  const pageDropIdRef = useRef(0);
  const [dropRoute, setDropRoute] = useState<DropRouteRequest | null>(null);
  const [saveImport, setSaveImport] = useState<EmulatorSaveImportRequest | null>(null);
  const clearSaveImport = useCallback(() => setSaveImport(null), []);
  const [dropRouting, setDropRouting] = useState<DropRouting | null>(null);
  const dropRoutingTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cancelFileRouting = useCallback(() => {
    discardShellSelections();
    clearTimeout(dropRoutingTimerRef.current);
    setDropRouting(null);
    routingGenerationRef.current += 1;
    routingQueueRef.current = Promise.resolve();
    for (const resolve of pendingDropsRef.current.values()) resolve();
    pendingDropsRef.current.clear();
    routeChoiceRef.current?.();
    routeChoiceRef.current = null;
    setPageDrops([]);
    setDropRoute(null);
  }, []);
  useEffect(() => {
    const handleSoftNavigation = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;
      const current = new URL(window.location.href);
      const destination = getSoftNavigationUrl(event, anchor, current);
      if (destination && (destination.pathname !== current.pathname || destination.search !== current.search)) {
        cancelFileRouting();
      }
    };
    window.addEventListener("popstate", cancelFileRouting);
    document.addEventListener("click", handleSoftNavigation, true);
    return () => {
      window.removeEventListener("popstate", cancelFileRouting);
      document.removeEventListener("click", handleSoftNavigation, true);
    };
  }, [cancelFileRouting]);
  const enqueuePageDrop = useCallback(
    (view: WebappView, files: File[]) =>
      new Promise<void>((resolve) => {
        pageDropIdRef.current += 1;
        const id = pageDropIdRef.current;
        pendingDropsRef.current.set(id, resolve);
        const onConsumed = () => {
          pendingDropsRef.current.delete(id);
          setPageDrops((previous) => previous.filter((entry) => entry.drop.id !== id));
          resolve();
        };
        setPageDrops((previous) => [...previous, { view, drop: { files, id, onConsumed } }]);
      }),
    [],
  );
  useEffect(
    () => () => {
      discardShellSelections();
      routingGenerationRef.current += 1;
      for (const resolve of pendingDropsRef.current.values()) resolve();
      pendingDropsRef.current.clear();
      routeChoiceRef.current?.();
    },
    [],
  );
  // Sets the veil's routing phase; a hold clears it after that many ms.
  const showDropRouting = useCallback((routing: DropRouting | null, holdMs?: number) => {
    clearTimeout(dropRoutingTimerRef.current);
    setDropRouting(routing);
    if (routing && holdMs !== undefined) {
      dropRoutingTimerRef.current = setTimeout(() => setDropRouting(null), holdMs);
    }
  }, []);
  useEffect(() => () => clearTimeout(dropRoutingTimerRef.current), []);
  const threads = state.settings.threads;
  const threadCount = resolveThreads(threads);
  useLayoutEffect(() => notifyGuidedSampleView(state.currentView), [state.currentView]);
  useLayoutEffect(() => {
    document.documentElement.dataset.betaToolsEnabled = state.settings.betaToolsEnabled ? "true" : "false";
  }, [state.settings.betaToolsEnabled]);
  // Hydration reads the served lang as the language the prerender used, so the attribute only follows the
  // active locale once the tree is mounted.
  useLayoutEffect(() => {
    document.documentElement.lang = state.settings.language;
  }, [state.settings.language]);
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
    closeDialogForNavigation,
    handleDialogTabChange,
    logOpen,
    logTab,
    openAboutTab,
    openLogsTab,
    openSettingsTab,
    openStatusTab,
    openStorageTab,
    preloadLogDialog,
    preloadSettingsPanel,
    saveSettings,
    settingsFocusHint,
  } = useUnifiedDialog(actions, state);
  // A backup the dialog closed on before Saves & storage mounted MUST NOT import on a later visit.
  const logWasOpenRef = useRef(false);
  useEffect(() => {
    if (logWasOpenRef.current && !logOpen) setSaveImport(null);
    logWasOpenRef.current = logOpen;
  }, [logOpen]);
  /* Every workflow the user has visited stays mounted, so a single page drop
     would otherwise reach all of them at once - two forms staging the same file
     and overwriting each other's activity-store entry. The drop goes ONLY to the
     view it was made on, and only while that view is still the current one. */
  const pageDropFor = (view: WebappView) =>
    pageDrop && pageDrop.view === view && state.currentView === view ? pageDrop.drop : null;
  const openWhatsNew = useCallback(() => {
    cancelFileRouting();
    pendingViewRef.current = null;
    selectViewWithTransition(() => actions.onSelectView("whats-new"));
  }, [actions, cancelFileRouting]);
  // Docs guides live one level down (`/docs/<slug>`), so a bare slug would resolve to `/docs/apply-rom-patches`, the Apply guide, not the tool.
  const resolveTabHrefs = notFound || state.currentView === "docs";
  // One identity per shell, so Find's index is not rebuilt on every render of the 404 page.
  const mastheadTabs = useMemo(
    () =>
      resolveTabHrefs
        ? WORKFLOW_TABS.map((tab) => ({ ...tab, href: appPathHref(tab.href, resolvedAssetBaseUrl) }))
        : WORKFLOW_TABS,
    [resolveTabHrefs, resolvedAssetBaseUrl],
  );

  // The settings console draws its own copy of the phone dock: a modal makes the real one inert.
  const dockTabs = useMemo(() => mastheadTabs.filter((tab) => tab.dock && !tab.beta), [mastheadTabs]);

  // The nav's own tab switch. Shared with the related-links strips (workflow
  // results, the docs footer, the not-found page) so every "go here next"
  // affordance in the app resolves through this one router.
  const handleSelectTab = useCallback(
    (id: string) => {
      cancelFileRouting();
      if (notFound) {
        if (id === "home") {
          window.location.assign(resolvedAssetBaseUrl);
          return;
        }
        // The nav can also reach a view with no WorkflowTab entry (What's
        // new), so it falls back to the id itself as the slug.
        const href = WORKFLOW_TABS.find((tab) => tab.id === id)?.href ?? id;
        if (href) window.location.assign(appPathHref(href, resolvedAssetBaseUrl));
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
    [actions, cancelFileRouting, notFound, resolvedAssetBaseUrl],
  );

  // URL-session sources land in the matching workflow's drop pipeline exactly
  // like a page-level drop (classification and routing stay Rust-driven).
  const deliverUrlSessionFiles = useCallback(
    (files: File[]) => {
      const sessionView = urlSession?.request?.kind === "weave" ? "weave" : "patcher";
      actions.onSelectView(sessionView);
      cancelFileRouting();
      void enqueuePageDrop(sessionView, files);
    },
    [actions, cancelFileRouting, enqueuePageDrop, urlSession?.request?.kind],
  );
  // Hands a routed drop to its workflow exactly like a page-level drop on that tab.
  const deliverDrop = useCallback(
    async (view: WebappView, files: File[]) => {
      setDropRoute(null);
      if (!files.length) return;
      const finishChoice = routeChoiceRef.current;
      routeChoiceRef.current = null;
      logger.debug("delivering routed drop", { count: files.length, from: currentViewRef.current, view });
      if (view === "test" && currentViewRef.current !== view) requestEmulatorStartFromUserAction();
      if (notFound) {
        setRecoveredDrop(true);
        actions.onSelectView(view);
      } else if (currentViewRef.current !== view) {
        pendingViewRef.current = null;
        const generation = routingGenerationRef.current;
        selectViewWithTransition(() => {
          if (generation === routingGenerationRef.current) actions.onSelectView(view);
        });
      }
      await enqueuePageDrop(view, files);
      finishChoice?.();
    },
    [actions, enqueuePageDrop, notFound],
  );
  const routeFiles = useCallback(
    (selected: File[] | Promise<File[]>, fromDrop = false, directView?: WebappView) => {
      const from = currentViewRef.current;
      const generation = routingGenerationRef.current;
      const delivery = routingQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          if (generation !== routingGenerationRef.current) return;
          const dropped = await selected;
          if (!dropped.length || generation !== routingGenerationRef.current) return;
          const routeVeil: typeof showDropRouting = (routing, holdMs) => {
            if (fromDrop) showDropRouting(routing, holdMs);
          };
          // Save backups belong to no workflow. Saves & storage imports them once the rest of the drop is
          // routed, so two dialogs never open at once.
          const backups = dropped.filter((file) => isEmulatorSaveExportName(file.name));
          const files = backups.length ? dropped.filter((file) => !backups.includes(file)) : dropped;
          try {
            if (!files.length) {
              routeVeil(null);
              return;
            }
            if (directView) {
              await enqueuePageDrop(directView, files);
              return;
            }
            routeVeil({ phase: "reading" });
            const entries = await readDropEntries(files);
            if (generation !== routingGenerationRef.current) return;
            const plan = planDropDestinations(countDropEntries(entries));
            const [only] = plan.destinations;
            if (
              only &&
              plan.destinations.length === 1 &&
              entries.every((entry) => isUsableDropFile(only, entry.name, entry.archiveBucket))
            ) {
              routeVeil({ phase: "opening", view: only });
              await preloadWorkflowRoute(only).catch(() => undefined);
              if (generation !== routingGenerationRef.current) return;
              routeVeil({ phase: "opening", view: only }, DROP_ROUTING_HOLD_MS);
              await deliverDrop(only, files);
              return;
            }
            routeVeil(null);
            if (!only) return;
            pageDropIdRef.current += 1;
            setDropRoute({ chooseDestination: true, entries, files, from, id: pageDropIdRef.current });
            await new Promise<void>((resolve) => {
              routeChoiceRef.current = resolve;
            });
          } finally {
            if (backups.length && generation === routingGenerationRef.current) {
              logger.debug("importing dropped save backups", { names: backups.map((file) => file.name) });
              pageDropIdRef.current += 1;
              setSaveImport({ files: backups, id: pageDropIdRef.current });
              openStorageTab();
            }
          }
        })
        .catch((error: unknown) => {
          if (fromDrop && generation === routingGenerationRef.current) showDropRouting(null);
          throw error;
        });
      routingQueueRef.current = delivery;
      return delivery;
    },
    [deliverDrop, enqueuePageDrop, openStorageTab, showDropRouting],
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
  // The `?weave=` boot's decorated session (enablement seed + output defaults + patch metadata);
  // the apply form consumes it once its patch list matches the weave's delivery.
  const [weaveSession, setWeaveSession] = useState<WeaveApplySession | null>(null);
  const urlSessionBoot = useUrlSessionBoot(
    notFound ? null : (urlSession?.request ?? null),
    deliverUrlSessionFiles,
    setWeaveSession,
  );

  useEffect(() => {
    setVisitedViews((previous) => (previous.includes(state.currentView) ? previous : [...previous, state.currentView]));
  }, [state.currentView]);
  useEffect(() => releaseLargeEntriesOnRunStart(), []);
  useEffect(() => releaseLargeEntriesOnLargeInput(() => currentViewRef.current === "test"), []);
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

  const pageDragging = usePageDragging();
  // Page-level drag: dropping a file anywhere on the page (outside a dropzone
  // box) forwards it to the active tab's unified drop handler via `pageDrop`.
  useEffect(() => {
    const handlePageDragOver = (event: DragEvent) => {
      if (isInsideLocalDropZone(event) || !isFileDragTransfer(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const handlePageDrop = (event: DragEvent) => {
      if (isInsideLocalDropZone(event) || !isFileDragTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      if (logOpen || state.settingsDialogOpen || confirmationDialog.open || agentApprovalDialog?.state.open) return;
      const droppedAtMs = perfNow();
      // Read synchronously so dropped folders are captured before the transfer
      // clears; routing/classification is owned by the active tab's unified drop
      // handler, so the page-level listener just forwards every file to it.
      const droppedView = state.currentView;
      const needsDestination = notFound || ["home", "docs", "whats-new"].includes(droppedView);
      // Hold the veil from the drop itself so it never fades out and back in
      // while the transfer is read.
      if (needsDestination) showDropRouting({ phase: "reading" });
      const readFiles = readDataTransferFiles(event.dataTransfer).then((files) => {
        markDropReceived();
        for (const file of files) recordDrop(file.name, droppedAtMs);
        logger.trace("unified drop zone received files", {
          count: files.length,
          names: files.map((file) => file.name),
          source: "page",
        });
        return files;
      });
      trackSelectionDelivery(event, routeFiles(readFiles, true, needsDestination ? undefined : droppedView));
    };
    // A workflow that cannot use a drop offers the one that can. This runs in
    // the capture phase, ahead of the tab's own drop zones, and only claims the
    // drop when the file names alone already call for a redirect.
    const handleRedirectDrop = (event: DragEvent) => {
      if (notFound) return;
      if (!(event.dataTransfer && isFileDragTransfer(event.dataTransfer))) return;
      if (logOpen || state.settingsDialogOpen || confirmationDialog.open || agentApprovalDialog?.state.open) return;
      const names = Array.from(event.dataTransfer.files, (file) => ({ name: file.name }));
      const needsDestination =
        state.currentView === "save-editor" &&
        names.some((entry) => ["rom", "patch"].includes(classifyDropEntry(entry)));
      const redirect = planDropRedirect(state.currentView, countDropEntries(names));
      const hasBackup = names.some((entry) => classifyDropEntry(entry) === "backup");
      if (!(needsDestination || redirect || hasBackup)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const fromView = state.currentView;
      void readDataTransferFiles(event.dataTransfer).then((files) => {
        if (!files.length || currentViewRef.current !== fromView) return;
        if (needsDestination || (hasBackup && redirect)) {
          void routeFiles(files, true);
          return;
        }
        if (hasBackup) {
          // Any workflow can receive a backup: it is imported, and the rest stays with this workflow.
          void routeFiles(files, true, fromView);
          return;
        }
        pageDropIdRef.current += 1;
        setDropRoute({ files, from: fromView, id: pageDropIdRef.current });
      });
    };
    document.addEventListener("dragover", handlePageDragOver);
    document.addEventListener("drop", handleRedirectDrop, true);
    document.addEventListener("drop", handlePageDrop);
    return () => {
      document.removeEventListener("dragover", handlePageDragOver);
      document.removeEventListener("drop", handleRedirectDrop, true);
      document.removeEventListener("drop", handlePageDrop);
    };
  }, [
    agentApprovalDialog?.state.open,
    confirmationDialog.open,
    logOpen,
    notFound,
    routeFiles,
    showDropRouting,
    state.currentView,
    state.settingsDialogOpen,
  ]);

  // A chunk usually fails to load because a deploy replaced it, so apply the waiting update when there is one.
  const reloadAfterLoadFailure = () => (pageUpdate.ready ? actions.onReloadUpdate() : window.location.reload());
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
          <WorkflowPanelHead threads={view === "weave" || view === "patcher" || view === "creator" || view === "trim"}>
            {view === "weave" || view === "patcher" || view === "creator" || view === "trim" ? (
              <PanelThreadCount
                count={threadCount}
                onOpenThreads={() => openSettingsTab(SETTINGS_FIELD_METADATA.threads.id)}
                onPreloadSettings={preloadSettingsPanel}
              />
            ) : null}
            {view === "checksum" ? null : (
              <PanelViewToggle
                detailed={state.settings.detailedViewEnabled === true}
                onChange={actions.onDetailedViewEnabledChange}
              />
            )}
            <ResetButton onReset={actions.onReset} />
          </WorkflowPanelHead>
        )}
        <div className="workflow-body">
          {/* A route that fails to load takes down only its own panel, so the others keep their staged work. */}
          <LoadErrorBoundary area={view} onReload={reloadAfterLoadFailure}>
            {/* Only ever engages for a tab switch: the landing route is preloaded before the first mount. */}
            <Suspense
              fallback={
                <h1 className="sr-only">
                  {view === "whats-new" ? "What's new" : WORKFLOW_TABS.find((tab) => tab.id === view)?.label}
                </h1>
              }
            >
              {form}
            </Suspense>
          </LoadErrorBoundary>
        </div>
      </section>
    ) : null;
  // The cheat page owns its mode; elsewhere a `?mode=` request picks it.
  let creatorEntry = creatorMode ?? undefined;
  if (workflowEntry === "create-rom-cheat-patch") creatorEntry = "cheats";
  const pageHasPendingChanges = shouldWarnBeforeUnload({
    creatorState: state.creatorSession,
    outputState: state.patcherSession,
    patchStackState: { items: Array.from({ length: state.patcherSession.patchCount }) },
    patcherFormEdited: !!(state.patcherSession.outputName.trim() || state.patcherSession.outputCompression !== "none"),
    romFilePresent: state.patcherSession.romFilePresent,
    ppfUndoActive: state.ppfUndoSession?.active ?? false,
    compressActive: state.compressSession?.active ?? false,
    saveEditorActive: state.saveEditorSession?.active ?? false,
    trimState: state.trimSession,
    webappState: state,
  });
  return (
    <RomWeaverSettingsProvider assetBaseUrl={resolvedAssetBaseUrl} settings={state.settings}>
      <div
        className={`rw-app${pageDragging ? " rw-page-dragging" : ""}${dropRouting ? " rw-drop-routing" : ""}`}
        id="column"
      >
        {/* The last resort for what the panels' own boundaries do not cover, such as the lazy dialogs. */}
        <LoadErrorBoundary area="app" fullPage onReload={reloadAfterLoadFailure}>
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
              onOpenAbout={openAboutTab}
              onOpenLog={openLogsTab}
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
            {/* Mounted from the first reason to announce anything, so a closing banner can still slide away. */}
            {pageUpdate.ready || previewRuntimeState === "update" || updatedSince.since ? (
              <UpdateBanner
                kind={updateBannerKind}
                onDismiss={dismissUpdateBanner}
                onOpenWhatsNew={openWhatsNew}
                onReload={actions.onReloadUpdate}
                since={updatedSince.announce ? updatedSince.since : null}
              />
            ) : null}
            <UrlSessionBanner onRetry={urlSessionBoot.retry} state={urlSessionBoot.state} />
            <PausedGameBanner active={state.currentView !== "test"} onOpenTest={() => handleSelectTab("test")} />
            <ActivityWakeLock pageHasPendingChanges={pageHasPendingChanges} />
            <main className={notFound ? "workbench is-not-found" : "workbench"} id="main-content" tabIndex={-1}>
              {notFound ? (
                <NotFoundPage assetBaseUrl={resolvedAssetBaseUrl} onSelectTab={handleSelectTab} />
              ) : (
                <>
                  {isViewMounted("home") ? (
                    // `panel` is what puts this in the workbench's shared grid cell
                    // (banners.css); without it the drop veil takes row 1 and the
                    // landing page starts a veil's height down the page.
                    <div className="panel" hidden={state.currentView !== "home"}>
                      <LoadErrorBoundary area="home" onReload={reloadAfterLoadFailure}>
                        <Suspense fallback={null}>
                          <HomePageRoute baseUrl={resolvedAssetBaseUrl} onFiles={routeFiles} />
                        </Suspense>
                      </LoadErrorBoundary>
                    </div>
                  ) : null}
                  {workflowPanel(
                    "patcher",
                    <ApplyPatchRoute
                      cheatsPage={workflowEntry === "apply-cheats"}
                      weaveSession={weaveSession}
                      onWeavePackageChange={actions.onPatcherWeavePackageChange}
                      onInputsChange={actions.onPatcherInputsChange}
                      onPatchesChange={actions.onPatcherPatchesChange}
                      onSelectTab={handleSelectTab}
                      onSelectView={() => handleSelectTab("test")}
                      onSettingsChange={actions.onPatcherSettingsChange}
                      pageDrop={pageDropFor("patcher")}
                      romLookupRequest={applyRomLookupRequest}
                      startup={state.startup}
                    />,
                  )}
                  {workflowPanel(
                    "weave",
                    <WeaveRoute
                      mode="weave"
                      weaveSession={weaveSession}
                      onWeavePackageChange={actions.onPatcherWeavePackageChange}
                      onInputsChange={actions.onPatcherInputsChange}
                      onPatchesChange={actions.onPatcherPatchesChange}
                      onSelectTab={handleSelectTab}
                      onSelectView={() => handleSelectTab("test")}
                      onSettingsChange={actions.onPatcherSettingsChange}
                      pageDrop={pageDropFor("weave")}
                      startup={state.startup}
                    />,
                  )}
                  {workflowPanel(
                    "creator",
                    <CreatePatchRoute
                      entry={creatorEntry}
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
                    <DocsPageRoute
                      active={state.currentView === "docs"}
                      onSelectTab={handleSelectTab}
                      slug={docsSlug}
                    />,
                  )}
                  {workflowPanel(
                    "whats-new",
                    <WhatsNewPageRoute
                      active={state.currentView === "whats-new"}
                      onReload={actions.onReloadUpdate}
                      since={updatedSince.since}
                      updateReady={pageUpdate.ready}
                    />,
                  )}
                  {workflowPanel("extract", <ExtractRouteForm pageDrop={pageDropFor("extract")} />)}
                  {workflowPanel(
                    "compress",
                    <CompressRouteForm
                      onSessionChange={actions.onCompressSessionChange}
                      pageDrop={pageDropFor("compress")}
                    />,
                  )}
                  {workflowPanel(
                    "identify",
                    <IdentifyRouteForm
                      lookupRequest={identifyLookupRequest}
                      onLookupResultChange={carryIdentifyResultToApply}
                      onUseFilesInApply={(files) => deliverDrop("patcher", files)}
                      onSelectTab={handleSelectTab}
                      pageDrop={pageDropFor("identify")}
                    />,
                  )}
                  {workflowPanel("checksum", <ChecksumRouteForm pageDrop={pageDropFor("checksum")} />)}
                  {workflowPanel(
                    "test",
                    <EmulatorTestRoute active={state.currentView === "test"} pageDrop={pageDropFor("test")} />,
                  )}
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
                </>
              )}
              <DropVeil dragging={pageDragging} routing={dropRouting} />
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
                dockTabs={dockTabs}
                initialTab={logTab}
                licensesHref={`${resolvedAssetBaseUrl}docs/notices`}
                onOpenWhatsNew={() => {
                  closeDialogForNavigation();
                  openWhatsNew();
                }}
                level={state.settings.logLevel}
                onClose={closeDialog}
                onLevelChange={actions.onLogLevelChange}
                onSelectDockTab={(id) => {
                  // Like About's What's new: the console's entries stay, so Back returns to it.
                  closeDialogForNavigation();
                  handleSelectTab(id);
                }}
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
                emulatorSaveImport={saveImport}
                onEmulatorSaveImportStarted={clearSaveImport}
                settingsPanel={
                  <Suspense fallback={null}>
                    <SettingsPanel
                      draftSettings={state.draftSettings as Parameters<typeof getSettingsUiState>[0]}
                      onDraftChange={(field, value) =>
                        // The accent previews and persists at once, like the theme; the rest wait for Save.
                        field === "accent" && typeof value === "string"
                          ? runAppearanceTransition(() => actions.onAccentChange(value), "accent")
                          : actions.onDraftChange(field, value)
                      }
                      uiState={getSettingsUiState(state.draftSettings as Parameters<typeof getSettingsUiState>[0])}
                      validation={state.validation}
                    />
                  </Suspense>
                }
                updateReady={pageUpdate.ready}
              />
            </Suspense>
          ) : null}
          {dropRoute ? (
            <Suspense fallback={null}>
              <DropRouteDialog
                key={dropRoute.id}
                labelFor={(view) => WORKFLOW_TABS.find((tab) => tab.id === view)?.label ?? view}
                onCancel={() => {
                  setDropRoute(null);
                  routeChoiceRef.current?.();
                  routeChoiceRef.current = null;
                }}
                onDeliver={deliverDrop}
                request={dropRoute}
              />
            </Suspense>
          ) : null}
        </LoadErrorBoundary>
        {/* Outside the boundary: the notice's Reload asks here before it drops staged work. */}
        <ConfirmDialog
          body={confirmationDialog.message}
          cancelLabel={confirmationDialog.cancelLabel}
          confirmLabel={confirmationDialog.confirmLabel}
          onCancel={actions.onCancelConfirmation}
          onConfirm={actions.onConfirmConfirmation}
          open={confirmationDialog.open}
          title={confirmationDialog.title}
        />
        {agentApprovalDialog ? (
          <ConfirmDialog
            body={agentApprovalDialog.state.message}
            cancelLabel={agentApprovalDialog.state.cancelLabel}
            confirmLabel={agentApprovalDialog.state.confirmLabel}
            onCancel={agentApprovalDialog.onCancel}
            onConfirm={agentApprovalDialog.onConfirm}
            open={agentApprovalDialog.state.open}
            title={agentApprovalDialog.state.title}
          />
        ) : null}
      </div>
    </RomWeaverSettingsProvider>
  );
}

export { resolveThreads, selectViewWithTransition, WebappRoot };
