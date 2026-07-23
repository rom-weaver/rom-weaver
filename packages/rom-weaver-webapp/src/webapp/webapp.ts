/* RomWeaver (complete webapp implementation) v20240809 - Marc Robledo 2016-2024 - http://www.marcrobledo.com/license */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { collectBrowserInfo } from "../lib/browser-info.ts";
import { configureLogger, createLogger } from "../lib/logging.ts";
import { getBrowserStorageEstimateState } from "../storage/browser/browser-storage-estimate.ts";
import { markRomWeaverRunnerStale } from "../workers/rom-weaver/rom-weaver-runner.ts";
import { APP_BUILD_VERSION, APP_VERSION, COMMIT_HASH, DIRTY_HASH, GIT_BRANCH } from "./build-version.ts";
import { installLogStore } from "./log-store.ts";
import { createEmptyVitePageUpdateState, createVitePageUpdateState, getPageUpdateState } from "./page-update-state.ts";
import { createPwaServiceWorkerClient } from "./pwa/pwa-service-worker-client.ts";
import { createServiceWorkerBootGate } from "./pwa/service-worker-boot-gate.ts";
import { LOCAL_STORAGE_SETTINGS_ID, type SettingsState } from "./settings/settings-state.ts";
import {
  getDiscardSettingsConfirmationMessage,
  getUnloadConfirmationMessage,
  shouldConfirmDiscardSettings,
  shouldWarnBeforeUnload,
} from "./unload-guard.ts";
import { readUrlSessionRequest } from "./url-session/url-session-request.ts";
import { createWebappRootController, readWorkflowViewFromPath } from "./webapp-controller.ts";
import { resolveThreads, selectViewWithTransition, WebappRoot } from "./webapp-root.tsx";
import { type ConfirmationDialogState, createEmptyConfirmationDialogState } from "./webapp-root-types.ts";

// Webapp controller invariants now live across `settings-state` and `webapp-controller`:
// localStorage.setItem(LOCAL_STORAGE_SETTINGS_ID, JSON.stringify(settings))
// SETTINGS_VALID_CHD_CREATECD_CODECS = ['cdzs', 'cdlz', 'cdzl', 'cdfl']
// validCodecs.indexOf(codec) === -1
// rawDraft.compressionProfile
// normalizeOptionalIntegerOverride
// getCompressionLevelsForSettings(settings)

const SERVICE_WORKER_ENABLED = __SERVICE_WORKER_ENABLED__;
const SERVICE_WORKER_CACHE_PREFIX = "precache-rom-weaver-";
const SERVICE_WORKER_CACHE_VERSION_TIMEOUT_MS = 1500;
const SERVICE_WORKER_UPDATE_INTERVAL_MS = __SERVICE_WORKER_UPDATE_INTERVAL_MS__;
// Once controlled but still not isolated this long, the gate reloads to retry the COOP/COEP handshake.
const SERVICE_WORKER_BOOT_GATE_STUCK_RELOAD_MS = 2000;
// Absolute backstop before booting un-isolated (covers a worker that never installs).
const SERVICE_WORKER_BOOT_GATE_TIMEOUT_MS = 10000;
// Cap on gate-initiated reloads so a browser that can never isolate is not stuck reloading.
const SERVICE_WORKER_BOOT_GATE_MAX_RELOADS = 3;

installLogStore();

const logger = createLogger("webapp");
let confirmationDialogState = createEmptyConfirmationDialogState();
let renderWebappRootIfReady = () => undefined;
let resolvePendingConfirmation: ((accepted: boolean) => void) | null = null;
let vitePageUpdateState = createEmptyVitePageUpdateState();
// Suppresses the first render until cross-origin isolation settles so the un-isolated first document
// never flashes before the service worker reloads the page. Decided synchronously at construction.
const serviceWorkerBootGate = createServiceWorkerBootGate({
  logger,
  maxReloads: SERVICE_WORKER_BOOT_GATE_MAX_RELOADS,
  navigator: typeof navigator === "undefined" ? undefined : navigator,
  serviceWorkerEnabled: SERVICE_WORKER_ENABLED,
  sessionStorage: typeof sessionStorage === "undefined" ? undefined : sessionStorage,
  stuckReloadMs: SERVICE_WORKER_BOOT_GATE_STUCK_RELOAD_MS,
  timeoutMs: SERVICE_WORKER_BOOT_GATE_TIMEOUT_MS,
  window: typeof window === "undefined" ? undefined : window,
});
const VITE_PAGE_RELOAD_TIMEOUT_MS = 20;
const VITE_RELOAD_PATTERN = /\blocation\.reload\s*\(/;

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
  appVersion: APP_BUILD_VERSION,
  cachePrefix: SERVICE_WORKER_CACHE_PREFIX,
  cacheVersionTimeoutMs: SERVICE_WORKER_CACHE_VERSION_TIMEOUT_MS,
  document: typeof document === "undefined" ? undefined : document,
  enabled: SERVICE_WORKER_ENABLED,
  navigator: typeof navigator === "undefined" ? undefined : navigator,
  onConfirmReload: confirmReloadUpdate,
  onStateChange: () => {
    renderWebappRootIfReady();
  },
  sessionStorage: typeof sessionStorage === "undefined" ? undefined : sessionStorage,
  shouldAutoApplyUpdate: () => !shouldWarnBeforeUnload(getNavigationGuardState()),
  updateIntervalMs: SERVICE_WORKER_UPDATE_INTERVAL_MS,
  window: typeof window === "undefined" ? undefined : window,
});

if (typeof window !== "undefined") {
  window.ROM_WEAVER_SERVICE_WORKER = {
    forceCacheAndReload: () => serviceWorkerClient.forceCacheAndReload(),
    getState: () => serviceWorkerClient.getState(),
    refreshCacheVersion: () => serviceWorkerClient.refreshCacheVersion(),
  };
}

if (FORCE_HTTPS_HOSTS.indexOf(location.hostname) !== -1 && location.protocol === "http:")
  location.href = window.location.href.replace("http:", "https:");
else serviceWorkerClient.initialize();

// `?bundle=` / `?rom=&patch=` URL API, parsed once per page lifetime. The
// params stay in the address bar so the session URL remains shareable; only
// this boot-time read consumes them.
const urlSessionParse =
  typeof window === "undefined"
    ? { request: null, warnings: [] }
    : readUrlSessionRequest(window.location.search, window.location.href);
for (const warning of urlSessionParse.warnings) {
  logger.warn(`url session: ${warning}`);
}

const applySettingsToRuntime = (settings: SettingsState) => {
  configureLogger({ level: typeof settings.logLevel === "string" ? settings.logLevel : undefined });
  logger.debug("Applying runtime settings", {
    logLevel: settings.logLevel,
    threads: settings.threads,
  });
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
applySettingsToRuntime(webappController.getState().settings);
logger.info("Browser environment", collectBrowserInfo());

let webappRootInitialized = false;
let appRoot: Root | null = null;

const markWebappMounted = () => {
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
    toolsActive: state.toolsSession.active,
    trimState: {
      outputName: state.trimSession.outputName,
      sourceFilePresent: state.trimSession.sourceFilePresent,
    },
    webappState: state,
  };
};

const isLikelyViteReloadTimer = (handler: TimerHandler, timeout?: number) => {
  if (timeout !== VITE_PAGE_RELOAD_TIMEOUT_MS) return false;
  if (typeof handler === "function") return VITE_RELOAD_PATTERN.test(Function.prototype.toString.call(handler));
  if (typeof handler === "string") return handler.indexOf("location.reload") !== -1;
  return false;
};

const installViteReloadGuard = () => {
  if (!(import.meta.hot && typeof window !== "undefined")) return;
  const guardedSetTimeout = window.setTimeout as typeof window.setTimeout & { __romWeaverViteReloadGuard?: boolean };
  if (guardedSetTimeout.__romWeaverViteReloadGuard) return;
  const originalSetTimeout = window.setTimeout.bind(window) as typeof window.setTimeout;
  const nextSetTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (isLikelyViteReloadTimer(handler, timeout)) {
      deferViteReload({ source: "vite" });
      return originalSetTimeout(() => undefined, 0);
    }
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof window.setTimeout & { __romWeaverViteReloadGuard?: boolean };
  nextSetTimeout.__romWeaverViteReloadGuard = true;
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
    window.location.reload();
    return true;
  }
  return false;
};

import.meta.hot?.on("rom-weaver:reload-available", (payload) => {
  markRomWeaverRunnerStale();
  vitePageUpdateState = createVitePageUpdateState(payload);
  renderWebappRootIfReady();
});
import.meta.hot?.on("vite:beforeFullReload", (payload) => {
  // Defer full reload to the in-app update guard.
  markRomWeaverRunnerStale();
  deferViteReload({ label: payload?.path, source: "vite" });
});

const renderWebappRoot = (): undefined => {
  // Suppress all renders (including reactive ones from the service worker state machine) while the boot
  // gate is closed, so the un-isolated first document stays on the static background until the SW reload.
  if (serviceWorkerBootGate.isGated()) return undefined;
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
          onConfirmExternalNavigation: async () => {
            const navigationGuardState = getNavigationGuardState();
            if (!shouldWarnBeforeUnload(navigationGuardState)) return true;
            return requestConfirmation({
              cancelLabel: "Stay here",
              confirmLabel: "Open link",
              level: "warning",
              message: "Leaving the app may lose your staged files and finished output. Open the link anyway?",
              title: "Leave and lose work?",
            });
          },
          onCreatorModifiedChange: (file) => webappController.setCreatorModifiedState(file),
          onCreatorOriginalChange: (file) => webappController.setCreatorOriginalState(file),
          onCreatorPatchTypeChange: (patchType) => webappController.setCreatorPatchType(patchType),
          onCreatorSettingsChange: (settings) => webappController.setCreatorSettingsState(settings),
          onDraftChange: (field, value) =>
            webappController.updateDraftSetting(
              field as Parameters<typeof webappController.updateDraftSetting>[0],
              value,
            ),
          onLogLevelChange: (level) => webappController.setLogLevel(level),
          onOpenSettings: () => webappController.openSettings(),
          onPatcherBundlePackageChange: (value) => webappController.setBundlePackage(value),
          onPatcherInputsChange: (inputs) => webappController.setPatcherInputState(inputs),
          onPatcherPatchesChange: (patches) => webappController.setPatcherPatchState(patches),
          onPatcherSettingsChange: (settings) => webappController.setPatcherSettingsState(settings),
          onReloadUpdate: () => {
            void reloadPendingUpdate();
          },
          onReset: () => {
            void (async () => {
              const accepted = await requestConfirmation({
                cancelLabel: "Stay here",
                confirmLabel: "Reload page",
                level: "warning",
                message: "Reloading will clear the current page state. Continue?",
                title: "Reset the page?",
              });
              if (accepted) window.location.reload();
            })();
          },
          onRestoreDefaults: () => webappController.restoreDefaults(),
          onSaveClose: () => {
            webappController.saveDraftSettings();
          },
          onSelectView: (view) => webappController.selectView(view),
          onToolsSessionChange: (active) => webappController.setToolsSessionState(active),
          onTrimOutputFormatChange: (format) => webappController.setTrimOutputFormat(format),
          onTrimSettingsChange: (settings) => webappController.setTrimSettingsState(settings),
          onTrimSourceChange: (file) => webappController.setTrimSourceState(file),
        },
        confirmationDialog: confirmationDialogState,
        pageUpdate: getPageUpdateState({
          serviceWorkerCache,
          vite: vitePageUpdateState,
        }),
        serviceWorkerCache,
        state: webappController.getState(),
        urlSession: urlSessionParse.request ? urlSessionParse : null,
      }),
    );
  });
  markWebappMounted();
  return undefined;
};
renderWebappRootIfReady = renderWebappRoot;

webappController.subscribe(renderWebappRoot);
installViteReloadGuard();

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key !== LOCAL_STORAGE_SETTINGS_ID) return;
    if (typeof localStorage !== "undefined" && event.storageArea && event.storageArea !== localStorage) return;
    webappController.reloadPersistedSettings();
  });
  window.addEventListener("popstate", () => {
    const view = readWorkflowViewFromPath();
    if (view && view !== webappController.getState().currentView) {
      selectViewWithTransition(() => {
        const selectedView = webappController.selectView(view, { historyMode: "none" });
        if (selectedView !== view) webappController.selectView(selectedView, { historyMode: "replace" });
      });
    }
  });
}

const initializeWebapp = () => {
  if (webappRootInitialized) return;
  webappRootInitialized = true;

  logger.info("Initializing webapp", {
    branch: GIT_BRANCH,
    buildVersion: APP_BUILD_VERSION,
    commit: COMMIT_HASH,
    dirty: !!DIRTY_HASH,
    dirtyHash: DIRTY_HASH || undefined,
    threads: resolveThreads(webappController.getState().settings.threads),
    version: APP_VERSION,
  });

  serviceWorkerClient.refreshCacheVersion();
  webappController.setStartupState("loading");
  renderWebappRoot();

  // A URL session always lands on the apply tab, whatever the route says.
  const initialMode = urlSessionParse.request ? "patcher" : readWorkflowViewFromPath() || "patcher";
  webappController.setStartupState("ready");
  webappController.activateInitialView(initialMode, { fallbackOnError: true });
};

const bootWebapp = () => {
  initializeWebapp();
  void getBrowserStorageEstimateState().then(
    (storage) => {
      logger.debug("Browser storage initialized", { storage });
    },
    (error) => {
      logger.debug("Browser storage estimate skipped", {
        message: error instanceof Error ? error.message : String(error || ""),
      });
    },
  );
};

const startWebappBoot = () => serviceWorkerBootGate.start(bootWebapp);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startWebappBoot, { once: true });
} else {
  startWebappBoot();
}
