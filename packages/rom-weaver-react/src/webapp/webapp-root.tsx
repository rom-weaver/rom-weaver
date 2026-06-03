import GitCompare from "lucide-react/dist/esm/icons/git-compare.js";
import Puzzle from "lucide-react/dist/esm/icons/puzzle.js";
import { useEffect } from "react";
import { preloadBrowserRuntime } from "../platform/browser/browser-api.ts";
import { ConfirmDialog, Modal } from "../public/react/components/ds/index.ts";
import { ApplyPatchForm, CreatePatchForm, RomWeaverSettingsProvider } from "../public/react/index.tsx";
import { APP_BUILD_VERSION } from "./build-version.ts";
import { Banner, Footer, Topbar } from "./components/shell.tsx";
import { getSettingsUiState } from "./settings/settings-state.ts";
import { ProcessingWakeLockNotice } from "./webapp-layout.tsx";
import type { WebappRootProps } from "./webapp-root-types.ts";
import { SettingsPanel } from "./webapp-settings";

const WORKFLOW_TABS = [
  { icon: <Puzzle aria-hidden="true" />, id: "patcher", label: "Apply" },
  { icon: <GitCompare aria-hidden="true" />, id: "creator", label: "Create" },
];

function WebappRoot({ state, serviceWorkerCache, pageUpdate, confirmationDialog, actions }: WebappRootProps) {
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
            logoSrc="./logo.png"
            onOpenSettings={actions.onOpenSettings}
            onSelectTab={(id) => actions.onSelectView(id as WebappRootProps["state"]["currentView"])}
            tabs={WORKFLOW_TABS}
          />
          {pageUpdate.ready ? <Banner onReload={actions.onReloadUpdate}>{pageUpdate.title}</Banner> : null}
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
              <button className="btn ghost" onClick={actions.onRestoreDefaults} type="button">
                Reset
              </button>
              <button className="btn primary" onClick={actions.onSaveClose} type="button">
                Save
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
