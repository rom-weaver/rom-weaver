import GitCompare from "lucide-react/dist/esm/icons/git-compare.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import Save from "lucide-react/dist/esm/icons/save.js";
import Scissors from "lucide-react/dist/esm/icons/scissors.js";
import Wrench from "lucide-react/dist/esm/icons/wrench.js";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getWorkbenchActivity, subscribeWorkbenchActivity } from "../lib/activity-store.ts";
import type { BundleApplySession } from "../lib/bundle/bundle-session-model.ts";
import { readDataTransferFiles } from "../lib/input/dropped-files.ts";
import { createLogger } from "../lib/logging.ts";
import { markResultPaintedAfterFinish } from "../lib/perf/op-perf-marks.ts";
import { preloadBrowserRuntime } from "../platform/browser/browser-api.ts";
import { ApplyBandaidIcon } from "../public/react/components/apply-bandaid-icon.tsx";
import { runFlatViewTransition } from "../public/react/components/ds/flat-transition.ts";
import { ConfirmDialog, Modal } from "../public/react/components/ds/index.ts";
import type { PageFileDrop } from "../public/react/index.tsx";
import { ApplyPatchForm, CreatePatchForm, RomWeaverSettingsProvider, TrimPatchForm } from "../public/react/index.tsx";
import { setActiveSelectionForm } from "../public/react/input-selection-handler.ts";
import { useUiLocalizer } from "../public/react/settings-context.tsx";
import { APP_BUILD_VERSION, APP_DISPLAY_VERSION } from "./build-version.ts";
import { ChangelogDialog } from "./components/changelog-dialog.tsx";
import { LogDialog } from "./components/log-dialog.tsx";
import { Masthead, UpdateBanner } from "./components/shell.tsx";
import { ToolsForm } from "./components/tools-form.tsx";
import { ProcessingWakeLockNotice } from "./components/wake-lock-notice.tsx";
import { resolveHostIngestFiles, subscribeHostIngest } from "./host-ingest.ts";
import { DONATE_URL, GITHUB_URL } from "./project-links.ts";
import { getSettingsUiState } from "./settings/settings-state.ts";
import { UrlSessionBanner } from "./url-session/url-session-banner.tsx";
import { useUrlSessionBoot } from "./url-session/use-url-session-boot.ts";
import type { WebappRootProps } from "./webapp-root-types.ts";
import { SettingsPanel } from "./webapp-settings";

const WORKFLOW_TABS = [
  // "Weave": the tab both applies patch chains and edits/exports them as bundles.
  { icon: <ApplyBandaidIcon className="apply-tab-icon" />, id: "patcher", label: "Weave" },
  { icon: <GitCompare aria-hidden="true" />, id: "creator", label: "Make Patch" },
  { icon: <Scissors aria-hidden="true" />, id: "trim", label: "Trim" },
  { icon: <Wrench aria-hidden="true" />, id: "tools", label: "Tools" },
];
const ROOT_LOGO_URL = "./logo.svg";

const logger = createLogger("webapp-root");

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

const resolveWorkerThreads = (workerThreads: unknown): number => {
  const numeric = typeof workerThreads === "number" ? workerThreads : Number.parseInt(String(workerThreads || ""), 10);
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
  // The page title follows the active workflow tab.
  useEffect(() => {
    const tab = WORKFLOW_TABS.find((entry) => entry.id === state.currentView);
    document.title = tab ? `rom-weaver - ${tab.label}` : "rom-weaver";
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
  const workerThreads = state.settings.workerThreads;
  useEffect(() => {
    void preloadBrowserRuntime({ workerThreads });
  }, [workerThreads]);
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
      // Read synchronously so dropped folders are captured before the transfer
      // clears; routing/classification is owned by the active tab's unified drop
      // handler, so the page-level listener just forwards every file to it.
      const droppedView = state.currentView;
      void readDataTransferFiles(event.dataTransfer).then((files) => {
        if (files.length === 0) return;
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
        <div className="workflow-body">{form}</div>
      </section>
    ) : null;

  return (
    <RomWeaverSettingsProvider settings={state.settings}>
      <div className={pageDragging ? "rw-app rw-page-dragging" : "rw-app"} id="column">
        <div className="app">
          <Masthead
            confirmExternalNavigation={actions.onConfirmExternalNavigation}
            currentTab={state.currentView}
            donateHref={DONATE_URL}
            githubHref={GITHUB_URL}
            logoSrc={ROOT_LOGO_URL}
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
            threads={resolveWorkerThreads(workerThreads)}
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
              <ApplyPatchForm
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
              <CreatePatchForm
                onModifiedChange={actions.onCreatorModifiedChange}
                onOriginalChange={actions.onCreatorOriginalChange}
                onPatchTypeChange={actions.onCreatorPatchTypeChange}
                onSettingsChange={actions.onCreatorSettingsChange}
                pageDrop={activePageDrop}
              />,
            )}
            {workflowPanel(
              "trim",
              <TrimPatchForm
                onOutputFormatChange={actions.onTrimOutputFormatChange}
                onSettingsChange={actions.onTrimSettingsChange}
                onSourceChange={actions.onTrimSourceChange}
                pageDrop={activePageDrop}
              />,
            )}
            {workflowPanel(
              "tools",
              <ToolsForm onSessionChange={actions.onToolsSessionChange} pageDrop={activePageDrop} />,
            )}
            <DropVeil />
          </main>
        </div>
        <ActivityFinishMarker />
        <LogDialog
          level={state.settings.logLevel}
          onClose={() => setLogOpen(false)}
          onLevelChange={actions.onLogLevelChange}
          open={logOpen}
        />
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
          <SettingsPanel
            draftSettings={state.draftSettings as Parameters<typeof getSettingsUiState>[0]}
            onClose={actions.onCloseSettings}
            onDraftChange={actions.onDraftChange}
            onRestoreDefaults={actions.onRestoreDefaults}
            onSaveClose={actions.onSaveClose}
            uiState={getSettingsUiState(state.draftSettings as Parameters<typeof getSettingsUiState>[0])}
            validation={state.validation}
          />
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

export { resolveWorkerThreads, selectViewWithTransition, WebappRoot };
