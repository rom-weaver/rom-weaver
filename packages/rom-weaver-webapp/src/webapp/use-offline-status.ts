import { useCallback, useEffect, useState } from "react";
import type { OfflineWarmupDisplayProgress, RuntimeState } from "./components/shell.tsx";
import { isReactWebappDevelopmentMode } from "./development-defaults.ts";
import {
  createOfflineWarmupProgressGate,
  getOfflineCopyState,
  listenForOfflinePrecacheProgress,
  listenForServiceWorkerLog,
  persistOfflineReady,
  queryOfflineReadyState,
  readPersistedOfflineReady,
  scheduleOfflineWarmup,
} from "./pwa/offline-warmup-client.ts";

/** Offline warm-up progress plus the development-only runtime-state preview. */
const useOfflineStatus = () => {
  // Offline readiness requires the app, EmulatorJS, and required or selected identify groups to be cached.
  // Unknown or incomplete progress keeps the status at installing.
  const [offlineProgress, setOfflineProgress] = useState<OfflineWarmupDisplayProgress | null>(() =>
    readPersistedOfflineReady() ? { cachedBytes: 0, ready: true, totalBytes: 0 } : null,
  );
  const [previewUpdateDismissed, setPreviewUpdateDismissed] = useState(false);
  const [previewRuntimeState, setPreviewRuntimeState] = useState<RuntimeState | null>(null);
  const changePreviewRuntimeState = useCallback((state: RuntimeState | null) => {
    if (!isReactWebappDevelopmentMode()) return;
    setPreviewRuntimeState(state);
    setPreviewUpdateDismissed(false);
  }, []);
  const previewOfflineProgress =
    previewRuntimeState === "installing" ? { cachedBytes: 40, ready: false, totalBytes: 100 } : offlineProgress;
  const onWarmupProgress = useCallback((progress: OfflineWarmupDisplayProgress) => {
    const next = { ...progress, ready: getOfflineCopyState().enabled && progress.ready };
    setOfflineProgress(next);
    persistOfflineReady(next.ready);
  }, []);
  useEffect(() => {
    const progressGate = createOfflineWarmupProgressGate(onWarmupProgress);
    // A page that loads after the warm-up finished gets no progress events;
    // ask the worker once so the chip does not stay "installing" forever.
    void queryOfflineReadyState().then((state) => {
      if (state) progressGate.acceptSnapshot(state);
    });
    // First visit: the installing worker broadcasts precache progress before
    // it controls the page, long before the warm-up can pump.
    const stopPrecacheProgress = listenForOfflinePrecacheProgress(progressGate.acceptPrecache);
    // The worker logs to a console the exported page log never sees, so relay
    // its lines here for the whole life of the page.
    const stopWorkerLog = listenForServiceWorkerLog();
    const cancelWarmup = scheduleOfflineWarmup({ onProgress: progressGate.acceptLive });
    return () => {
      stopPrecacheProgress();
      stopWorkerLog();
      cancelWarmup();
    };
  }, [onWarmupProgress]);
  return {
    changePreviewRuntimeState,
    previewOfflineProgress,
    previewRuntimeState,
    previewUpdateDismissed,
    setPreviewUpdateDismissed,
  };
};

export { useOfflineStatus };
