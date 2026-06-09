import GitCompare from "lucide-react/dist/esm/icons/git-compare.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import Save from "lucide-react/dist/esm/icons/save.js";
import Scissors from "lucide-react/dist/esm/icons/scissors.js";
import { useEffect, useRef, useState } from "react";
import { ROM_WEAVER_FILE_FILTERS } from "rom-weaver-wasm/format-metadata";
import { preloadBrowserRuntime } from "../platform/browser/browser-api.ts";
import { ApplyBandaidIcon } from "../public/react/components/apply-bandaid-icon.tsx";
import { ConfirmDialog, Modal } from "../public/react/components/ds/index.ts";
import type { PageFileDrop } from "../public/react/index.tsx";
import { ApplyPatchForm, CreatePatchForm, RomWeaverSettingsProvider, TrimPatchForm } from "../public/react/index.tsx";
import { APP_BUILD_VERSION } from "./build-version.ts";
import { Banner, Footer, Topbar } from "./components/shell.tsx";
import { ProcessingWakeLockNotice } from "./components/wake-lock-notice.tsx";
import { getSettingsUiState } from "./settings/settings-state.ts";
import type { WebappRootProps } from "./webapp-root-types.ts";
import { SettingsPanel } from "./webapp-settings";

const WORKFLOW_TABS = [
  { icon: <ApplyBandaidIcon className="apply-tab-icon" />, id: "patcher", label: "Apply" },
  { icon: <GitCompare aria-hidden="true" />, id: "creator", label: "Create" },
  { icon: <Scissors aria-hidden="true" />, id: "trim", label: "Trim" },
];
const ROOT_LOGO_URL = "./logo.webp";
const PATCH_FILE_SUFFIXES = [
  ...ROM_WEAVER_FILE_FILTERS.patchExtensions.map((extension) => extension.replace(/^\./, "").toLowerCase()),
];
const PATCH_FILE_SUFFIXES_WITH_VARIANTS = [
  ...PATCH_FILE_SUFFIXES,
  ...PATCH_FILE_SUFFIXES.map((suffix) => `${suffix}1`),
];
const ARCHIVE_FILE_SUFFIXES = ROM_WEAVER_FILE_FILTERS.containerExtensions.map((extension) =>
  extension.replace(/^\./, "").toLowerCase(),
);

type WebappRootPageDrop = {
  drop: PageFileDrop;
  view: WebappRootProps["state"]["currentView"];
};

const hasDataTransferType = (types: readonly string[], type: string) => types.includes(type);

const hasFileDataTransferItem = (items: DataTransferItemList) => Array.from(items).some((item) => item.kind === "file");

const isFileDragTransfer = (dataTransfer: DataTransfer | null) =>
  !!dataTransfer && (hasDataTransferType(dataTransfer.types, "Files") || hasFileDataTransferItem(dataTransfer.items));

const getSingleDroppedFile = (dataTransfer: DataTransfer | null) => {
  const files = dataTransfer?.files;
  if (!files) return null;
  if (files.length !== 1) return null;
  return files.item(0);
};

const isInsideLocalDropZone = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest(".rw-app .drop");

const hasKnownFileSuffix = (fileName: string, suffixes: readonly string[]) => {
  const normalized = fileName.trim().toLowerCase();
  return suffixes.some((suffix) => normalized.endsWith(`.${suffix}`));
};

const isPatchFileName = (fileName: string) => hasKnownFileSuffix(fileName, PATCH_FILE_SUFFIXES_WITH_VARIANTS);
const isArchiveFileName = (fileName: string) => hasKnownFileSuffix(fileName, ARCHIVE_FILE_SUFFIXES);

const getPageDropTargetFromElement = (target: EventTarget | null): PageFileDrop["target"] | null => {
  if (!(target instanceof Element)) return null;
  if (target.closest("#rom-weaver-row-patch-stack")) return "patch";
  if (target.closest("#rom-weaver-row-file-rom")) return "input";
  if (target.closest("#patch-builder-row-original")) return "original";
  if (target.closest("#patch-builder-row-modified")) return "modified";
  if (target.closest("#trim-builder-row-source")) return "input";
  return null;
};

const resolvePageDropTarget = (
  state: WebappRootProps["state"],
  target: EventTarget | null,
  file: File,
): PageFileDrop["target"] => {
  const elementTarget = getPageDropTargetFromElement(target);
  if (state.currentView === "patcher") {
    if (elementTarget === "input" || elementTarget === "patch") return elementTarget;
    if (isPatchFileName(file.name)) return "patch";
    if (isArchiveFileName(file.name) && state.patcherSession.romFilePresent) return "patch";
    return "input";
  }
  if (state.currentView === "creator") {
    if (elementTarget === "original" || elementTarget === "modified") return elementTarget;
    if (!state.creatorSession.originalFilePresent) return "original";
    if (!state.creatorSession.modifiedFilePresent) return "modified";
    return "modified";
  }
  return "input";
};

function WebappRoot({ state, serviceWorkerCache, pageUpdate, confirmationDialog, actions }: WebappRootProps) {
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [pageDrop, setPageDrop] = useState<WebappRootPageDrop | null>(null);
  const pageDropIdRef = useRef(0);
  const workerThreads = state.settings.workerThreads;
  useEffect(() => {
    void preloadBrowserRuntime({ workerThreads });
  }, [workerThreads]);
  const activePageDrop = pageDrop?.view === state.currentView ? pageDrop.drop : null;

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
      const file = getSingleDroppedFile(event.dataTransfer);
      if (!file) return;
      pageDropIdRef.current += 1;
      setPageDrop({
        drop: {
          file,
          id: pageDropIdRef.current,
          target: resolvePageDropTarget(state, event.target, file),
        },
        view: state.currentView,
      });
    };
    document.addEventListener("dragover", handlePageDragOver);
    document.addEventListener("drop", handlePageDrop);
    return () => {
      document.removeEventListener("dragover", handlePageDragOver);
      document.removeEventListener("drop", handlePageDrop);
    };
  }, [
    confirmationDialog.open,
    state.creatorSession.modifiedFilePresent,
    state.creatorSession.originalFilePresent,
    state.currentView,
    state.patcherSession.patchCount,
    state.patcherSession.romFilePresent,
    state.settingsDialogOpen,
  ]);

  return (
    <RomWeaverSettingsProvider settings={state.settings}>
      <div className="rw-app" id="column">
        <div className="app">
          <Topbar
            currentTab={state.currentView}
            devToolsEnabled={state.settings.devTools === true}
            logoSrc={ROOT_LOGO_URL}
            onCopyConsoleLogs={actions.onCopyConsoleLogs}
            onOpenSettings={actions.onOpenSettings}
            onSelectTab={(id) => actions.onSelectView(id as WebappRootProps["state"]["currentView"])}
            onToggleMobileDevTools={actions.onToggleMobileDevTools}
            tabs={WORKFLOW_TABS}
          />
          {pageUpdate.ready && !updateDismissed ? (
            <Banner onDismiss={() => setUpdateDismissed(true)} onReload={actions.onReloadUpdate}>
              {pageUpdate.title}
            </Banner>
          ) : null}
          <ProcessingWakeLockNotice active={false} />
          {state.currentView === "patcher" ? (
            <ApplyPatchForm
              onInputsChange={actions.onPatcherInputsChange}
              onPatchesChange={actions.onPatcherPatchesChange}
              onSettingsChange={actions.onPatcherSettingsChange}
              pageDrop={activePageDrop}
              startup={state.startup}
            />
          ) : null}
          {state.currentView === "creator" ? (
            <CreatePatchForm
              onModifiedChange={actions.onCreatorModifiedChange}
              onOriginalChange={actions.onCreatorOriginalChange}
              onPatchTypeChange={actions.onCreatorPatchTypeChange}
              onSettingsChange={actions.onCreatorSettingsChange}
              pageDrop={activePageDrop}
            />
          ) : null}
          {state.currentView === "trim" ? (
            <TrimPatchForm
              onOutputFormatChange={actions.onTrimOutputFormatChange}
              onSettingsChange={actions.onTrimSettingsChange}
              onSourceChange={actions.onTrimSourceChange}
              pageDrop={activePageDrop}
            />
          ) : null}
          <Footer
            cacheVersion={serviceWorkerCache.label}
            donateHref="https://www.paypal.me/marcrobledo/5"
            githubHref="https://github.com/marcrobledo/rom-weaver/"
            version={APP_BUILD_VERSION}
          />
        </div>
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
