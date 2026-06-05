import GitCompare from "lucide-react/dist/esm/icons/git-compare.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import Save from "lucide-react/dist/esm/icons/save.js";
import Scissors from "lucide-react/dist/esm/icons/scissors.js";
import { useEffect, useState } from "react";
import { preloadBrowserRuntime } from "../platform/browser/browser-api.ts";
import { ApplyBandaidIcon } from "../public/react/components/apply-bandaid-icon.tsx";
import { ConfirmDialog, Modal } from "../public/react/components/ds/index.ts";
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

function WebappRoot({ state, serviceWorkerCache, pageUpdate, confirmationDialog, actions }: WebappRootProps) {
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const workerThreads = state.settings.workerThreads;
  useEffect(() => {
    void preloadBrowserRuntime({ workerThreads });
  }, [workerThreads]);

  return (
    <RomWeaverSettingsProvider settings={state.settings}>
      <div className="rw-app" id="column">
        <div className="app">
          <Topbar
            currentTab={state.currentView}
            logoSrc={ROOT_LOGO_URL}
            onOpenSettings={actions.onOpenSettings}
            onSelectTab={(id) => actions.onSelectView(id as WebappRootProps["state"]["currentView"])}
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
              startup={state.startup}
            />
          ) : null}
          {state.currentView === "creator" ? (
            <CreatePatchForm
              onModifiedChange={actions.onCreatorModifiedChange}
              onOriginalChange={actions.onCreatorOriginalChange}
              onPatchTypeChange={actions.onCreatorPatchTypeChange}
              onSettingsChange={actions.onCreatorSettingsChange}
            />
          ) : null}
          {state.currentView === "trim" ? (
            <TrimPatchForm
              onOutputFormatChange={actions.onTrimOutputFormatChange}
              onSettingsChange={actions.onTrimSettingsChange}
              onSourceChange={actions.onTrimSourceChange}
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
