declare global {
  const __APP_VERSION__: string;
  const __COMMIT_HASH__: string;
  const __GIT_BRANCH__: string;
  const __DIRTY_HASH__: string;
  const __SERVICE_WORKER_ENABLED__: boolean;
  const __SERVICE_WORKER_UPDATE_INTERVAL_MS__: number;

  interface Window {
    ROM_WEAVER_APP_CONFIG?: Record<string, RuntimeValue>;
    ROM_WEAVER_APP_BOOTSTRAP?: {
      markMounted?: () => void;
      showError?: (messageText?: string) => void;
    };
    ROM_WEAVER_CONSOLE_LOGS?: {
      clear: () => void;
      copy: () => Promise<string>;
      formatJsonLines: () => string;
      getReport: () => import("./console-log-capture.ts").ConsoleLogReport;
      size: () => number;
    };
    ROM_WEAVER_ERUDA_ENABLED?: boolean;
    ROM_WEAVER_ERUDA_PANEL_OPEN?: boolean;
    ROM_WEAVER_ERUDA_LOADER?: {
      open?: () => void;
      isOpen?: () => boolean;
      setEnabled: (enabled: RuntimeValue) => void;
      syncFromStoredSettings: () => void;
      toggle?: () => void;
      isEnabled: () => boolean;
    };
    ROM_WEAVER_BROWSER_DIAGNOSTICS?: import("./browser-runtime-diagnostics.ts").BrowserRuntimeDiagnosticsApi;
    ROM_WEAVER_MOBILE_SAFARI_DIAGNOSTICS?: import("./browser-runtime-diagnostics.ts").BrowserRuntimeDiagnosticsApi;
    ROM_WEAVER_SERVICE_WORKER?: {
      forceCacheAndReload: () => Promise<boolean>;
      getState: () => import("./pwa/service-worker-cache-state.ts").ServiceWorkerCacheState;
      refreshCacheVersion: () => void;
    };
    __ROM_WEAVER_ERUDA_INITIALIZED__?: boolean;
    eruda?: {
      init: (options?: { tool?: string[] }) => void;
      destroy?: () => void;
      hide?: () => void;
      show?: (tool?: string) => void;
    };
  }
}

export {};
