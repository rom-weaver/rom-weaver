/* RomWeaver (complete webapp implementation) v20240809 - Marc Robledo 2016-2024 - http://www.marcrobledo.com/license */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { configureLogger, createLogger } from "./logging.ts";
import { createEmptyVitePageUpdateState, createVitePageUpdateState, getPageUpdateState } from "./page-update-state.ts";
import { createPwaServiceWorkerClient } from "./pwa/pwa-service-worker-client.ts";
import { LOCAL_STORAGE_SETTINGS_ID } from "./settings/settings-state.ts";
import { clearOpfsOnPageLoad } from "./site-data-cleanup.ts";
import {
  createBeforeUnloadGuard,
  getDiscardSettingsConfirmationMessage,
  getUnloadConfirmationMessage,
  shouldConfirmDiscardSettings,
  shouldWarnBeforeUnload,
} from "./unload-guard.ts";
import { createWebappRootController } from "./webapp-controller.ts";
import { type ConfirmationDialogState, createEmptyConfirmationDialogState } from "./webapp-layout.tsx";
import { WebappRoot } from "./webapp-root.tsx";

// Webapp controller invariants now live across `settings-state` and `webapp-controller`:
// erudaDevTools: false
// loadedSettings.erudaDevTools
// localStorage.setItem(LOCAL_STORAGE_SETTINGS_ID, JSON.stringify(settings))
// ROM_WEAVER_ERUDA_LOADER.setEnabled(settings.erudaDevTools)
// window.ROM_WEAVER_ERUDA_LOADER.setEnabled(settings.erudaDevTools)
// SETTINGS_VALID_CHD_CREATECD_CODECS = ['cdzs', 'cdlz', 'cdzl', 'cdfl']
// validCodecs.indexOf(codec) === -1
// rawDraft.compressionProfile
// normalizeOptionalIntegerOverride
// getCompressionLevelsForSettings(settings)
// initialSettings.oninitialize = () => { webappController.activateInitialView(initialMode, { fallbackOnError: true }) }

const SERVICE_WORKER_ENABLED = __SERVICE_WORKER_ENABLED__;
const SERVICE_WORKER_CACHE_PREFIX = "precache-rom-weaver-";
const SERVICE_WORKER_CACHE_VERSION_TIMEOUT_MS = 1500;
const SERVICE_WORKER_UPDATE_INTERVAL_MS = __SERVICE_WORKER_UPDATE_INTERVAL_MS__;

type RuntimeScalar = string | number | boolean | null | undefined;
type RuntimeValue =
  | RuntimeScalar
  | Blob
  | File
  | FileList
  | ArrayBuffer
  | ArrayBufferView
  | Uint8Array
  | ((...args: never[]) => unknown)
  | { [key: string]: RuntimeValue | undefined }
  | RuntimeValue[];

type RuntimeSettings = Record<string, RuntimeValue> & {
  language?: RuntimeScalar;
  allowDropFiles?: RuntimeScalar;
  ondropfiles?: (...args: RuntimeValue[]) => RuntimeValue;
  oninitialize?: (runtime?: RuntimeValue) => void;
  erudaDevTools?: RuntimeScalar;
};

type WebAppConfig = {
  settings?: RuntimeSettings;
  initialMode?: RuntimeScalar;
};

const logger = createLogger("webapp");

const appConfig: WebAppConfig =
  typeof window !== "undefined" && window.ROM_WEAVER_APP_CONFIG && typeof window.ROM_WEAVER_APP_CONFIG === "object"
    ? (window.ROM_WEAVER_APP_CONFIG as WebAppConfig)
    : {};
let confirmationDialogState = createEmptyConfirmationDialogState();
let renderWebappRootIfReady = () => undefined;
let resolvePendingConfirmation: ((accepted: boolean) => void) | null = null;
let vitePageUpdateState = createEmptyVitePageUpdateState();
let suppressNextViteReloadTimer = false;
let fileSelectionInProgress = false;
let fileSelectionTrackerInstalled = false;
const VITE_PAGE_RELOAD_TIMEOUT_MS = 20;
const WORKFLOW_PROGRESS_SELECTOR = ".rom-weaver-input-progress";
const VITE_RELOAD_PATTERN = /\blocation\.reload\s*\(/;
const beforeUnloadGuard = createBeforeUnloadGuard({
  target: typeof window === "undefined" ? null : window,
});

const deferViteReload = (payload?: { label?: string; source?: string }) => {
  vitePageUpdateState = createVitePageUpdateState(payload || { source: "vite" });
  renderWebappRootIfReady();
};

function closeConfirmationDialog(accepted: boolean) {
  const resolver = resolvePendingConfirmation;
  resolvePendingConfirmation = null;
  confirmationDialogState = createEmptyConfirmationDialogState();
  renderWebappRootIfReady();
  resolver?.(accepted);
}

function requestConfirmation(
  options: Omit<ConfirmationDialogState, "open"> &
    Partial<Pick<ConfirmationDialogState, "confirmLabel" | "cancelLabel" | "level">>,
) {
  if (resolvePendingConfirmation) closeConfirmationDialog(false);
  confirmationDialogState = {
    ...createEmptyConfirmationDialogState(),
    ...options,
    open: true,
  };
  renderWebappRootIfReady();
  return new Promise<boolean>((resolve) => {
    resolvePendingConfirmation = resolve;
  });
}

async function confirmReloadUpdate() {
  const navigationGuardState = getNavigationGuardState();
  if (!shouldWarnBeforeUnload(navigationGuardState)) return true;
  return requestConfirmation({
    cancelLabel: "Stay here",
    confirmLabel: "Reload now",
    level: "warning",
    message: getUnloadConfirmationMessage(navigationGuardState),
    title: "Reload and lose changes?",
  });
}

const FORCE_HTTPS_HOSTS = ["www.marcrobledo.com"];
const serviceWorkerClient = createPwaServiceWorkerClient({
  cachePrefix: SERVICE_WORKER_CACHE_PREFIX,
  cacheVersionTimeoutMs: SERVICE_WORKER_CACHE_VERSION_TIMEOUT_MS,
  document: typeof document === "undefined" ? undefined : document,
  enabled: SERVICE_WORKER_ENABLED,
  navigator: typeof navigator === "undefined" ? undefined : navigator,
  onBeforeReload: () => {
    beforeUnloadGuard.bypassNextBeforeUnload();
  },
  onConfirmReload: confirmReloadUpdate,
  onStateChange: () => {
    renderWebappRootIfReady();
  },
  updateIntervalMs: SERVICE_WORKER_UPDATE_INTERVAL_MS,
  window: typeof window === "undefined" ? undefined : window,
});

if (FORCE_HTTPS_HOSTS.indexOf(location.hostname) !== -1 && location.protocol === "http:")
  location.href = window.location.href.replace("http:", "https:");
else serviceWorkerClient.initialize();

const getConfiguredRuntimeSettings = (): RuntimeSettings =>
  appConfig.settings && typeof appConfig.settings === "object" ? { ...appConfig.settings } : {};

const getConfiguredInitialMode = () => (typeof appConfig.initialMode === "string" ? appConfig.initialMode : "");

const applySettingsToRuntime = (settings: RuntimeSettings) => {
  configureLogger({ level: typeof settings.logLevel === "string" ? settings.logLevel : undefined });
  logger.debug("Applying runtime settings", {
    logLevel: settings.logLevel,
    workerThreads: settings.workerThreads,
  });
  if (window.ROM_WEAVER_ERUDA_LOADER && typeof window.ROM_WEAVER_ERUDA_LOADER.setEnabled === "function")
    window.ROM_WEAVER_ERUDA_LOADER.setEnabled(settings.erudaDevTools);
};

const webappController = createWebappRootController({
  onApplySettings: applySettingsToRuntime,
  onCreatorViewRequested: () => true,
  onFocusField: (fieldId) => {
    const field = document.getElementById(fieldId);
    if (field) field.focus();
  },
  onLocalizationChange: () => undefined,
  storage: typeof localStorage === "undefined" ? undefined : localStorage,
});
configureLogger({ level: webappController.getState().settings.logLevel });

let webappRootInitialized = false;
let appRoot: Root | null = null;

const markBootstrapMounted = () => {
  const bootstrap = window.ROM_WEAVER_APP_BOOTSTRAP;
  if (bootstrap && typeof bootstrap.markMounted === "function") bootstrap.markMounted();
  const appRootElement = document.getElementById("webapp-root");
  if (appRootElement) appRootElement.removeAttribute("aria-busy");
};

const patcherSessionHasFormChanges = (session: ReturnType<typeof webappController.getState>["patcherSession"]) =>
  !!(session.outputName.trim() || (session.outputCompression && session.outputCompression !== "none"));

const getNavigationGuardState = () => {
  const state = webappController.getState();
  return {
    creatorState: {
      modifiedFilePresent: state.creatorSession.modifiedFilePresent,
      originalFilePresent: state.creatorSession.originalFilePresent,
      outputName: state.creatorSession.outputName,
      patchType: state.creatorSession.patchType,
    },
    outputState: {
      pendingDownloadFileName: state.patcherSession.pendingDownloadFileName,
    },
    patcherFormEdited: patcherSessionHasFormChanges(state.patcherSession),
    patchStackState: {
      items: Array.from({ length: state.patcherSession.patchCount }),
    },
    romFilePresent: state.patcherSession.romFilePresent,
    webappState: state,
  };
};

const syncBeforeUnloadGuard = (): undefined => {
  beforeUnloadGuard.update(shouldWarnBeforeUnload(getNavigationGuardState()));
  return undefined;
};

const isLikelyViteReloadTimer = (handler: TimerHandler, timeout?: number) => {
  if (timeout !== VITE_PAGE_RELOAD_TIMEOUT_MS) return false;
  if (typeof handler === "function") return VITE_RELOAD_PATTERN.test(Function.prototype.toString.call(handler));
  if (typeof handler === "string") return handler.indexOf("location.reload") !== -1;
  return false;
};

const hasVisibleWorkflowProgress = () => {
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return false;
  return !!document.querySelector(WORKFLOW_PROGRESS_SELECTOR);
};

const isDocumentHidden = () => {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "hidden";
};

const shouldDeferViteReload = () =>
  fileSelectionInProgress ||
  hasVisibleWorkflowProgress() ||
  isDocumentHidden() ||
  shouldWarnBeforeUnload(getNavigationGuardState());

const getFileInputFromTarget = (target: EventTarget | null): HTMLInputElement | null => {
  if (!(target instanceof Element)) return null;
  if (target instanceof HTMLInputElement && target.type === "file") return target;
  const nestedInput = target.closest("input[type='file']");
  if (nestedInput instanceof HTMLInputElement) return nestedInput;
  const label = target.closest("label");
  if (!(label instanceof HTMLLabelElement)) return null;
  const labeledInput = label.control || (label.htmlFor ? document.getElementById(label.htmlFor) : null);
  if (labeledInput instanceof HTMLInputElement && labeledInput.type === "file") return labeledInput;
  return null;
};

const installFileSelectionTracker = () => {
  if (fileSelectionTrackerInstalled || typeof document === "undefined" || typeof window === "undefined") return;
  fileSelectionTrackerInstalled = true;
  const beginSelection = (event: Event) => {
    const input = getFileInputFromTarget(event.target);
    if (!input || input.disabled) return;
    fileSelectionInProgress = true;
  };
  const endSelection = (event?: Event) => {
    if (event) {
      const input = getFileInputFromTarget(event.target);
      if (!input) return;
    }
    fileSelectionInProgress = false;
  };
  document.addEventListener("click", beginSelection, true);
  document.addEventListener("change", endSelection, true);
  document.addEventListener("cancel", endSelection, true);
  window.addEventListener("focus", () => endSelection());
};

const installViteDirtyReloadGuard = () => {
  if (!(import.meta.hot && typeof window !== "undefined")) return;
  const guardedSetTimeout = window.setTimeout as typeof window.setTimeout & { __romPatcherDirtyGuard?: boolean };
  if (guardedSetTimeout.__romPatcherDirtyGuard) return;
  const originalSetTimeout = window.setTimeout.bind(window) as typeof window.setTimeout;
  const nextSetTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (suppressNextViteReloadTimer && isLikelyViteReloadTimer(handler, timeout)) {
      return originalSetTimeout(() => undefined, 0);
    }
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof window.setTimeout & { __romPatcherDirtyGuard?: boolean };
  nextSetTimeout.__romPatcherDirtyGuard = true;
  window.setTimeout = nextSetTimeout;
};

const reloadPendingUpdate = async (): Promise<boolean> => {
  const pageUpdate = getPageUpdateState({
    serviceWorkerCache: serviceWorkerClient.getState(),
    vite: vitePageUpdateState,
  });
  if (pageUpdate.source === "service-worker") return serviceWorkerClient.reloadPendingUpdate();
  if (pageUpdate.source === "vite") {
    if (!(await confirmReloadUpdate())) return false;
    beforeUnloadGuard.bypassNextBeforeUnload();
    window.location.reload();
    return true;
  }
  return false;
};

import.meta.hot?.on("rom-weaver:reload-available", (payload) => {
  vitePageUpdateState = createVitePageUpdateState(payload);
  renderWebappRootIfReady();
});
import.meta.hot?.on("vite:beforeFullReload", (payload) => {
  if (!shouldDeferViteReload()) return;
  suppressNextViteReloadTimer = true;
  queueMicrotask(() => {
    suppressNextViteReloadTimer = false;
  });
  deferViteReload({ label: payload?.path, source: "vite" });
});

const renderWebappRoot = (): undefined => {
  if (!appRoot) {
    const appRootElement = document.getElementById("webapp-root");
    if (appRootElement) appRoot = createRoot(appRootElement);
  }
  const root = appRoot;
  if (!root) return undefined;
  const serviceWorkerCache = serviceWorkerClient.getState();
  flushSync(() => {
    root.render(
      createElement(WebappRoot, {
        actions: {
          onCancelConfirmation: () => closeConfirmationDialog(false),
          onCloseSettings: () => {
            const state = webappController.getState();
            if (!shouldConfirmDiscardSettings(state)) {
              webappController.closeSettings();
              return;
            }
            void (async () => {
              const accepted = await requestConfirmation({
                cancelLabel: "Keep editing",
                confirmLabel: "Discard changes",
                level: "warning",
                message: getDiscardSettingsConfirmationMessage(),
                title: "Discard settings changes?",
              });
              if (accepted) webappController.discardDraftSettings();
            })();
          },
          onConfirmConfirmation: () => closeConfirmationDialog(true),
          onCreatorModifiedChange: (file) => webappController.setCreatorModifiedState(file),
          onCreatorOriginalChange: (file) => webappController.setCreatorOriginalState(file),
          onCreatorPatchTypeChange: (patchType) => webappController.setCreatorPatchType(patchType),
          onCreatorSettingsChange: (settings) => webappController.setCreatorSettingsState(settings),
          onDraftChange: (field, value) =>
            webappController.updateDraftSetting(
              field as Parameters<typeof webappController.updateDraftSetting>[0],
              value,
            ),
          onOpenSettings: () => webappController.openSettings(),
          onPatcherInputsChange: (inputs) => webappController.setPatcherInputState(inputs),
          onPatcherPatchesChange: (patches) => webappController.setPatcherPatchState(patches),
          onPatcherSettingsChange: (settings) => webappController.setPatcherSettingsState(settings),
          onReloadUpdate: () => {
            void reloadPendingUpdate();
          },
          onRestoreDefaults: () => webappController.restoreDefaults(),
          onSaveClose: () => {
            webappController.saveDraftSettings();
          },
          onSelectView: (view) => webappController.selectView(view),
        },
        confirmationDialog: confirmationDialogState,
        pageUpdate: getPageUpdateState({
          serviceWorkerCache,
          vite: vitePageUpdateState,
        }),
        serviceWorkerCache,
        state: webappController.getState(),
      }),
    );
  });
  markBootstrapMounted();
  return undefined;
};
renderWebappRootIfReady = renderWebappRoot;

webappController.subscribe(renderWebappRoot);
webappController.subscribe(syncBeforeUnloadGuard);
installViteDirtyReloadGuard();
installFileSelectionTracker();

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key !== LOCAL_STORAGE_SETTINGS_ID) return;
    if (typeof localStorage !== "undefined" && event.storageArea && event.storageArea !== localStorage) return;
    webappController.reloadPersistedSettings();
  });
}

const initializeWebapp = () => {
  if (webappRootInitialized) return;
  webappRootInitialized = true;

  serviceWorkerClient.refreshCacheVersion();
  webappController.setStartupState("loading");
  renderWebappRoot();
  syncBeforeUnloadGuard();

  const initialMode = getConfiguredInitialMode() || "patcher";
  webappController.setStartupState("ready");
  webappController.activateInitialView(initialMode, { fallbackOnError: true });
  const configuredOnInitialize = getConfiguredRuntimeSettings().oninitialize;
  if (typeof configuredOnInitialize === "function") configuredOnInitialize();
};

const initializeWebappAfterOpfsCleanup = () => {
  void clearOpfsOnPageLoad().then(initializeWebapp, initializeWebapp);
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeWebappAfterOpfsCleanup, { once: true });
} else {
  initializeWebappAfterOpfsCleanup();
}
