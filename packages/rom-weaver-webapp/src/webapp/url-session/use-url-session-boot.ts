import { useCallback, useEffect, useRef, useState } from "react";
import type { BundleApplySession } from "../../lib/bundle/bundle-session-model.ts";
import { createLogger } from "../../lib/logging.ts";
import { sanitizeUrlText } from "../../lib/url-text.ts";
import { getErrorTechnicalDetails } from "../../presentation/errors.ts";
import type { RemoteFetchEntry, RemoteFetchErrorKind } from "../../lib/remote/remote-file-fetch.ts";
import { fetchRemoteFiles, RemoteFetchError } from "../../lib/remote/remote-file-fetch.ts";
import type { UrlSessionRequest } from "./url-session-request.ts";

const logger = createLogger("url-session");
type BundleUrlSessionModule = typeof import("./bundle-url-session.ts");
let bundleUrlSessionModulePromise: Promise<BundleUrlSessionModule> | null = null;
const loadBundleUrlSessionModule = (): Promise<BundleUrlSessionModule> =>
  (bundleUrlSessionModulePromise ??= import("./bundle-url-session.ts"));

type UrlSessionBootState = {
  phase: "idle" | "fetching" | "done" | "error";
  loadedBytes: number;
  totalBytes: number | null;
  /** The bundle's display name once parsed (bundle sessions only). */
  bundleName: string;
  errorKind: RemoteFetchErrorKind | null;
  errorDetail: string;
};

type UrlSessionBootOptions = {
  /** Generation captured when this request starts; stale deliveries are discarded. */
  deliveryGeneration?: number;
  /** Returns false when a newer local session has replaced this request. */
  isDeliveryCurrent?: (generation: number) => boolean;
  initialWarnings?: readonly string[];
  onSessionDelivered?: (warnings: string[], kind: "bundle" | "url", generation: number) => void;
};

const IDLE_STATE: UrlSessionBootState = {
  bundleName: "",
  errorDetail: "",
  errorKind: null,
  loadedBytes: 0,
  phase: "idle",
  totalBytes: null,
};

/**
 * Boot-time URL-session loader: fetches the request's sources once per attempt
 * and delivers them as `File`s into the apply tab's drop pipeline. The direct
 * `rom=`/`patch=` shape fetches verbatim; the `bundle=` shape parses the
 * rom-weaver-bundle.json through the wasm runtime first, acquires its sources, and surfaces
 * the decorated session via `onBundleSession` for the apply form to consume.
 */
function useUrlSessionBoot(
  request: UrlSessionRequest | null,
  deliverFiles: (files: File[], generation?: number) => void,
  onBundleSession?: (session: BundleApplySession, generation?: number) => void,
  options: UrlSessionBootOptions = {},
): { cancel: () => void; retry: () => void; state: UrlSessionBootState } {
  const [state, setState] = useState<UrlSessionBootState>(IDLE_STATE);
  const [attempt, setAttempt] = useState(0);
  const deliverRef = useRef(deliverFiles);
  deliverRef.current = deliverFiles;
  const bundleSessionRef = useRef(onBundleSession);
  bundleSessionRef.current = onBundleSession;
  const sessionDeliveredRef = useRef(options.onSessionDelivered);
  sessionDeliveredRef.current = options.onSessionDelivered;
  const isDeliveryCurrentRef = useRef(options.isDeliveryCurrent);
  isDeliveryCurrentRef.current = options.isDeliveryCurrent;
  const deliveryGenerationRef = useRef(options.deliveryGeneration ?? 0);
  deliveryGenerationRef.current = options.deliveryGeneration ?? 0;
  const cancelRunRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!request) return undefined;
    let cancelled = false;
    let cleanupSessionFiles: (() => Promise<void>) | undefined;
    let cleanupPromise: Promise<void> | null = null;
    const controller = new AbortController();
    const runGeneration = deliveryGenerationRef.current;
    const isCurrent = () => !cancelled && (isDeliveryCurrentRef.current?.(runGeneration) ?? true);
    const cancelRun = () => {
      cancelled = true;
      controller.abort();
      void cleanupFiles();
    };
    const cleanupFiles = () => {
      if (!cleanupSessionFiles) return Promise.resolve();
      cleanupPromise ??= cleanupSessionFiles();
      return cleanupPromise;
    };
    cancelRunRef.current = cancelRun;
    const loadedByEntry = new Map<number | string, number>();
    const totalsByEntry = new Map<number | string, number | null>();
    const reportProgress = () => {
      if (!isCurrent()) return;
      let loadedBytes = 0;
      for (const value of loadedByEntry.values()) loadedBytes += value;
      let totalBytes: number | null = 0;
      for (const value of totalsByEntry.values()) {
        if (value === null) {
          totalBytes = null;
          break;
        }
        totalBytes += value;
      }
      setState((previous) => ({ ...previous, loadedBytes, phase: "fetching", totalBytes }));
    };

    setState({ ...IDLE_STATE, phase: "fetching" });
    let run: Promise<void>;
    if (request.kind === "direct") {
      const urls = [...(request.romUrl ? [request.romUrl] : []), ...request.patchUrls];
      const entries: RemoteFetchEntry[] = urls.map((url, index) => ({
        onProgress: (progress) => {
          loadedByEntry.set(index, progress.loadedBytes);
          totalsByEntry.set(index, progress.totalBytes);
          reportProgress();
        },
        url,
      }));
      logger.info(`loading url session (${entries.length} file(s))`);
      run = fetchRemoteFiles(entries, controller.signal).then(async (files) => {
        cleanupSessionFiles = async () => {
          await Promise.all(files.map((entry) => entry.cleanup()));
        };
        if (!isCurrent()) {
          await cleanupFiles();
          return;
        }
        // One delivery preserves patch order through the drop router.
        deliverRef.current(
          files.map((entry) => entry.file),
          runGeneration,
        );
        if (!isCurrent()) {
          await cleanupFiles();
          return;
        }
        sessionDeliveredRef.current?.([...(options.initialWarnings || [])], "url", runGeneration);
      });
    } else {
      run = loadBundleUrlSessionModule()
        .then(({ loadBundleUrlSession }) =>
          loadBundleUrlSession(request.bundleUrl, {
            onBundleName: (name) => {
              if (!cancelled) setState((previous) => ({ ...previous, bundleName: name }));
            },
            onProgress: (id, progress) => {
              loadedByEntry.set(id, progress.loadedBytes);
              totalsByEntry.set(id, progress.totalBytes);
              reportProgress();
            },
            signal: controller.signal,
          }),
        )
        .then(async ({ cleanup, files, session }) => {
          cleanupSessionFiles = cleanup;
          if (!isCurrent()) {
            await cleanupFiles();
            return;
          }
          deliverRef.current(files, runGeneration);
          if (!isCurrent()) {
            await cleanupFiles();
            return;
          }
          // A retry after failure must re-seed the form, so the session identity carries the attempt.
          const deliveredSession = { ...session, key: `${session.key}#${attempt}` };
          bundleSessionRef.current?.(deliveredSession, runGeneration);
          sessionDeliveredRef.current?.(
            [...(options.initialWarnings || []), ...deliveredSession.warnings],
            "bundle",
            runGeneration,
          );
        });
    }
    run
      .then(() => {
        if (!isCurrent()) return;
        setState((previous) => ({ ...previous, phase: "done" }));
        logger.info("url session loaded");
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        const kind = error instanceof RemoteFetchError ? error.kind : null;
        if (kind === "aborted" || controller.signal.aborted) return;
        logger.error("url session failed", {
          message: sanitizeUrlText(error instanceof Error ? error.message : error),
        });
        setState((previous) => ({
          ...previous,
          errorDetail: getErrorTechnicalDetails(error),
          errorKind: kind,
          phase: "error",
        }));
      });
    return () => {
      if (cancelRunRef.current === cancelRun) cancelRunRef.current = null;
      cancelRun();
    };
  }, [attempt, options.initialWarnings, request]);

  const retry = useCallback(() => setAttempt((previous) => previous + 1), []);
  const cancel = useCallback(() => {
    cancelRunRef.current?.();
    setState(IDLE_STATE);
  }, []);
  return { cancel, retry, state };
}

export type { UrlSessionBootState };
export { useUrlSessionBoot };
