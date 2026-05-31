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
    ROM_WEAVER_ERUDA_ENABLED?: boolean;
    ROM_WEAVER_ERUDA_LOADER?: {
      setEnabled: (enabled: RuntimeValue) => void;
      syncFromStoredSettings: () => void;
      isEnabled: () => boolean;
    };
    ROM_WEAVER_BROWSER_DIAGNOSTICS?: import("./browser-runtime-diagnostics.ts").BrowserRuntimeDiagnosticsApi;
    ROM_WEAVER_MOBILE_SAFARI_DIAGNOSTICS?: import("./browser-runtime-diagnostics.ts").BrowserRuntimeDiagnosticsApi;
    __ROM_WEAVER_ERUDA_INITIALIZED__?: boolean;
    eruda?: {
      init: () => void;
      destroy?: () => void;
      hide?: () => void;
    };
  }
}

export {};
