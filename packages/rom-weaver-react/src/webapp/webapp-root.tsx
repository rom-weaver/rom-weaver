import { type ReactNode, useEffect } from "react";
import { preloadBrowserRuntime } from "../platform/browser/browser-api.ts";
import { ApplyPatchForm, CreatePatchForm, RomWeaverSettingsProvider } from "../public/react/index.tsx";
import { getSettingsUiState } from "./settings/settings-state.ts";
import {
  AppFooter,
  ConfirmationDialog,
  layoutClasses,
  PageUpdateBanner,
  ProcessingWakeLockNotice,
  SettingsDialog,
  SettingsTrigger,
} from "./webapp-layout.tsx";
import type { WebappRootProps } from "./webapp-root-types.ts";
import { SettingsHeaderActions, SettingsPanel, WorkflowTabs } from "./webapp-settings";

function ToolPanelLayout({ children, onOpenSettings }: { children: ReactNode; onOpenSettings: () => void }) {
  return (
    <div className={layoutClasses.toolPanel}>
      <div className={layoutClasses.toolHeader}>
        <SettingsTrigger onClick={onOpenSettings} />
      </div>
      {children}
    </div>
  );
}

function WebappRoot({ state, serviceWorkerCache, pageUpdate, confirmationDialog, actions }: WebappRootProps) {
  const workerThreads = state.settings.workerThreads;
  useEffect(() => {
    void preloadBrowserRuntime({ workerThreads });
  }, [workerThreads]);

  return (
    <RomWeaverSettingsProvider settings={state.settings}>
      <div className={layoutClasses.column} id="column">
        <header className={layoutClasses.header}>
          <h1 className={layoutClasses.title}>
            <span aria-hidden="true" className={layoutClasses.titleIconFrame}>
              <img alt="" className={layoutClasses.titleIcon} src="./rw-logo.svg" />
            </span>
            <span className={layoutClasses.titleWordmark}>
              <span className={layoutClasses.titleAccent}>ROM</span>
              <span>Weaver</span>
            </span>
          </h1>
        </header>
        <div className={layoutClasses.wrapper} id="wrapper">
          <PageUpdateBanner onReloadUpdate={actions.onReloadUpdate} pageUpdate={pageUpdate} />
          <div className={layoutClasses.switchContainer} id="switch-container">
            <div aria-label="Workflow" className={layoutClasses.modeTabs} id="workflow-tabs" role="tablist">
              <WorkflowTabs currentView={state.currentView} onSelectView={actions.onSelectView} />
            </div>
          </div>
          <ProcessingWakeLockNotice active={false} />
          <div className={layoutClasses.tab}>
            {state.currentView === "patcher" ? (
              <div className={layoutClasses.tabPanelVisible}>
                <ToolPanelLayout onOpenSettings={actions.onOpenSettings}>
                  <ApplyPatchForm
                    onInputsChange={actions.onPatcherInputsChange}
                    onPatchesChange={actions.onPatcherPatchesChange}
                    onSettingsChange={actions.onPatcherSettingsChange}
                    startup={state.startup}
                  />
                </ToolPanelLayout>
              </div>
            ) : null}
            {state.currentView === "creator" ? (
              <div className={layoutClasses.tabPanelVisible}>
                <ToolPanelLayout onOpenSettings={actions.onOpenSettings}>
                  <CreatePatchForm
                    onModifiedChange={actions.onCreatorModifiedChange}
                    onOriginalChange={actions.onCreatorOriginalChange}
                    onPatchTypeChange={actions.onCreatorPatchTypeChange}
                    onSettingsChange={actions.onCreatorSettingsChange}
                  />
                </ToolPanelLayout>
              </div>
            ) : null}
          </div>
        </div>
        <SettingsDialog
          actions={
            <SettingsHeaderActions
              onClose={actions.onCloseSettings}
              onRestoreDefaults={actions.onRestoreDefaults}
              onSaveClose={actions.onSaveClose}
            />
          }
          onClose={actions.onCloseSettings}
          open={state.settingsDialogOpen}
        >
          <div className="w-full" id="settings-container" role="document">
            <SettingsPanel
              draftSettings={state.draftSettings as Parameters<typeof getSettingsUiState>[0]}
              onClose={actions.onCloseSettings}
              onDraftChange={actions.onDraftChange}
              onRestoreDefaults={actions.onRestoreDefaults}
              onSaveClose={actions.onSaveClose}
              uiState={getSettingsUiState(state.draftSettings as Parameters<typeof getSettingsUiState>[0])}
              validation={state.validation}
            />
          </div>
        </SettingsDialog>
        <AppFooter serviceWorkerCache={serviceWorkerCache} />
        <ConfirmationDialog
          onCancel={actions.onCancelConfirmation}
          onConfirm={actions.onConfirmConfirmation}
          state={confirmationDialog}
        />
      </div>
    </RomWeaverSettingsProvider>
  );
}

export { WebappRoot };
