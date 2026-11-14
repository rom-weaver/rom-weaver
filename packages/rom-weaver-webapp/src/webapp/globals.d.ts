declare global {
  /** The stamped build info in prerendering and the service worker; see build-version.ts. */
  var __ROM_WEAVER_BUILD_INFO__: unknown;
  /** The channel prerendering renders for; see build-channel.ts. */
  var ROM_WEAVER_PRERENDER_CHANNEL: { channel: string; label: string } | undefined;
  /** Hashed file names of the identify manifests under `assets/`; the catalog is null when the data set has none. */
  const __IDENTIFY_MANIFEST_FILES__: { catalog: string | null; index: string };
  const __SERVICE_WORKER_ENABLED__: boolean;
  const __SERVICE_WORKER_UPDATE_INTERVAL_MS__: number;

  interface Window {
    ROM_WEAVER_CONSOLE_LOGS?: {
      clear: () => void;
      copy: () => Promise<string>;
      formatJsonLines: () => string;
      getReport: () => import("./console-log-capture.ts").ConsoleLogReport;
      size: () => number;
    };
    ROM_WEAVER_BROWSER_DIAGNOSTICS?: import("./browser-runtime-diagnostics.ts").BrowserRuntimeDiagnosticsApi;
    ROM_WEAVER_MOBILE_SAFARI_DIAGNOSTICS?: import("./browser-runtime-diagnostics.ts").BrowserRuntimeDiagnosticsApi;
    ROM_WEAVER_SERVICE_WORKER?: {
      forceCacheAndReload: () => Promise<boolean>;
      getState: () => import("./pwa/service-worker-cache-state.ts").ServiceWorkerCacheState;
      refreshCacheVersion: () => void;
    };
  }
}

export {};
