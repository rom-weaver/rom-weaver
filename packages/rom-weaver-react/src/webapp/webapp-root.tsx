import GitCompare from "lucide-react/dist/esm/icons/git-compare.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import Save from "lucide-react/dist/esm/icons/save.js";
import Scissors from "lucide-react/dist/esm/icons/scissors.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { readDataTransferFiles } from "../lib/input/dropped-files.ts";
import { preloadBrowserRuntime } from "../platform/browser/browser-api.ts";
import { ApplyBandaidIcon } from "../public/react/components/apply-bandaid-icon.tsx";
import { ConfirmDialog, Modal } from "../public/react/components/ds/index.ts";
import type { PageFileDrop } from "../public/react/index.tsx";
import { ApplyPatchForm, CreatePatchForm, RomWeaverSettingsProvider, TrimPatchForm } from "../public/react/index.tsx";
import { useUiLocalizer } from "../public/react/settings-context.tsx";
import { getWorkbenchActivity, subscribeWorkbenchActivity } from "./activity-store.ts";
import { APP_BUILD_VERSION } from "./build-version.ts";
import { LogDialog } from "./components/log-dialog.tsx";
import { Masthead, Selvage, type SelvageState, UpdateBanner } from "./components/shell.tsx";
import { ProcessingWakeLockNotice } from "./components/wake-lock-notice.tsx";
import { createLogger } from "./logging.ts";
import { getSettingsUiState } from "./settings/settings-state.ts";
import type { WebappRootProps } from "./webapp-root-types.ts";
import { SettingsPanel } from "./webapp-settings";

const WORKFLOW_TABS = [
  { icon: <ApplyBandaidIcon className="apply-tab-icon" />, id: "patcher", label: "Apply" },
  { icon: <GitCompare aria-hidden="true" />, id: "creator", label: "Create" },
  { icon: <Scissors aria-hidden="true" />, id: "trim", label: "Trim" },
];
const ROOT_LOGO_URL = "./logo.webp";

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

function WebappRoot({ state, serviceWorkerCache, pageUpdate, confirmationDialog, actions }: WebappRootProps) {
  const [updateDismissed, setUpdateDismissed] = useState(readUpdateDismissed);
  const [logOpen, setLogOpen] = useState(false);
  // Workflow forms keep their local state (staged files, validated patches,
  // finished outputs) in component state, so unmounting on tab switch would
  // silently discard the user's work. Each form mounts on first visit and then
  // stays mounted but hidden, which preserves state across tab switches.
  const [visitedViews, setVisitedViews] = useState<readonly WorkflowView[]>([state.currentView]);
  const [pageDrop, setPageDrop] = useState<WebappRootPageDrop | null>(null);
  const [pageDragging, setPageDragging] = useState(false);
  const pageDropIdRef = useRef(0);
  const activity = useSyncExternalStore(subscribeWorkbenchActivity, getWorkbenchActivity, getWorkbenchActivity);
  const workerThreads = state.settings.workerThreads;
  useEffect(() => {
    void preloadBrowserRuntime({ workerThreads });
  }, [workerThreads]);
  const activePageDrop = pageDrop?.view === state.currentView ? pageDrop.drop : null;

  useEffect(() => {
    setVisitedViews((previous) => (previous.includes(state.currentView) ? previous : [...previous, state.currentView]));
  }, [state.currentView]);
  const isViewMounted = (view: WorkflowView) => state.currentView === view || visitedViews.includes(view);

  // Arm the dropzones while a file is dragged anywhere over the page. `dragover`
  // fires continuously, so a short debounce clears the flag once it stops (drag
  // left the window or dropped) — `dragleave`/`dragend` are unreliable here.
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

  const sessionHasInput =
    state.patcherSession.romFilePresent ||
    state.patcherSession.patchCount > 0 ||
    state.creatorSession.originalFilePresent ||
    state.creatorSession.modifiedFilePresent ||
    state.trimSession.sourceFilePresent;
  const selvageState: SelvageState = activity.state === "idle" && sessionHasInput ? "ready" : activity.state;

  const workflowPanel = (view: WorkflowView, form: React.ReactNode) =>
    isViewMounted(view) ? (
      <section className="panel workflow" hidden={state.currentView !== view} id={`panel-${view}`}>
        <div className="workflow-body">{form}</div>
      </section>
    ) : null;

  return (
    <RomWeaverSettingsProvider settings={state.settings}>
      <div className={pageDragging ? "rw-app rw-page-dragging" : "rw-app"} id="column">
        <div className="app">
          <Masthead
            currentTab={state.currentView}
            devToolsEnabled={state.settings.devTools === true}
            logoSrc={ROOT_LOGO_URL}
            onCopyConsoleLogs={actions.onCopyConsoleLogs}
            onOpenLog={() => setLogOpen(true)}
            onOpenSettings={actions.onOpenSettings}
            onSelectTab={(id) => actions.onSelectView(id as WebappRootProps["state"]["currentView"])}
            onToggleMobileDevTools={actions.onToggleMobileDevTools}
            tabs={WORKFLOW_TABS}
          />
          <UpdateBanner
            onDismiss={() => {
              setUpdateDismissed(true);
              writeUpdateDismissed();
            }}
            onReload={actions.onReloadUpdate}
            open={pageUpdate.ready && !updateDismissed}
            title={pageUpdate.title}
          />
          <ProcessingWakeLockNotice active={activity.state === "running"} />
          <main className="workbench">
            {workflowPanel(
              "patcher",
              <ApplyPatchForm
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
            <DropVeil />
          </main>
        </div>
        <Selvage
          cacheLabel={serviceWorkerCache.label}
          donateHref="https://www.paypal.me/marcrobledo/5"
          githubHref="https://github.com/marcrobledo/rom-weaver/"
          stage={activity.stage}
          state={selvageState}
          threads={resolveWorkerThreads(workerThreads)}
          version={APP_BUILD_VERSION}
        />
        <LogDialog onClose={() => setLogOpen(false)} open={logOpen} />
        <Modal
          headerActions={
            <>
              <button className="btn ghost" onClick={actions.onRestoreDefaults} title="Reset to defaults" type="button">
                <RotateCcw aria-hidden="true" />
                <span className="bl">Reset</span>
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

export { WebappRoot };
