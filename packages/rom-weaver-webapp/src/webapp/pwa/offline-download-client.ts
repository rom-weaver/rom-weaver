import { createResumableDownloader } from "./resumable-download.ts";

type Fetcher = (request: Request | string, init?: RequestInit) => Promise<Response>;
type DownloadPlan = {
  revision: string;
  sizeBytes: number;
  contentType: string;
  chunks: Array<{ url: string; sizeBytes: number; sha256: string; encoding: "gzip" }>;
};

const createOfflineDownloadClient = ({
  cacheName,
  manifestUrl,
  scope,
  fetcher,
  matchManifest,
  log,
}: {
  cacheName: string;
  manifestUrl?: string;
  scope: string;
  fetcher: Fetcher;
  matchManifest: (url: string) => Promise<Response | undefined>;
  log: (message: string, details?: Record<string, unknown>) => void;
}) => {
  let plansPromise: Promise<Map<string, DownloadPlan>> | undefined;
  const downloaders = new Map<Fetcher, ReturnType<typeof createResumableDownloader>>();
  const inFlight = new Map<string, Promise<Response>>();
  const downloaderFor = (fetchFile: Fetcher) => {
    let downloader = downloaders.get(fetchFile);
    if (!downloader) {
      downloader = createResumableDownloader({ cacheName, fetcher: fetchFile, log });
      downloaders.set(fetchFile, downloader);
    }
    return downloader;
  };

  const loadPlans = () => {
    if (!plansPromise) {
      plansPromise = (async () => {
        const plans = new Map<string, DownloadPlan>();
        if (!manifestUrl) return plans;
        const response = (await matchManifest(manifestUrl)) ?? (await fetcher(new URL(manifestUrl, scope).href));
        if (!response.ok) throw new Error(`Offline download manifest failed with HTTP ${response.status}`);
        const parsed: unknown = await response.json();
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("Invalid offline download manifest");
        for (const [url, value] of Object.entries(parsed)) {
          const plan = value as DownloadPlan | null;
          if (
            !plan ||
            typeof plan.revision !== "string" ||
            !Number.isSafeInteger(plan.sizeBytes) ||
            plan.sizeBytes <= 0 ||
            typeof plan.contentType !== "string" ||
            !Array.isArray(plan.chunks) ||
            plan.chunks.length === 0
          ) {
            throw new Error(`Invalid offline download plan: ${url}`);
          }
          const target = new URL(url, scope);
          if (target.origin !== new URL(scope).origin) throw new Error(`Cross-origin offline download plan: ${url}`);
          const chunks = plan.chunks.map((chunk) => {
            if (
              !chunk ||
              typeof chunk.url !== "string" ||
              chunk.encoding !== "gzip" ||
              typeof chunk.sha256 !== "string" ||
              !/^[a-f0-9]{64}$/.test(chunk.sha256) ||
              !Number.isSafeInteger(chunk.sizeBytes) ||
              chunk.sizeBytes <= 0
            ) {
              throw new Error(`Invalid offline download chunk: ${url}`);
            }
            const chunkUrl = new URL(chunk.url, scope);
            if (chunkUrl.origin !== target.origin) throw new Error(`Cross-origin offline download chunk: ${url}`);
            return { ...chunk, url: chunkUrl.href };
          });
          if (chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0) !== plan.sizeBytes) {
            throw new Error(`Offline download size mismatch: ${url}`);
          }
          plans.set(target.href, { ...plan, chunks });
        }
        return plans;
      })().catch((error) => {
        plansPromise = undefined;
        throw error;
      });
    }
    return plansPromise;
  };

  const download = async (request: Request, onBytes?: (delta: number) => void, fetchFile = fetcher) => {
    const current = inFlight.get(request.url);
    if (current) return (await current).clone();
    const pending = downloadFile(request, onBytes, fetchFile)
      .then(async (response) => {
        if (!(response.ok && (await loadPlans()).has(request.url))) inFlight.delete(request.url);
        return response;
      })
      .catch((error) => {
        inFlight.delete(request.url);
        throw error;
      });
    inFlight.set(request.url, pending);
    return (await pending).clone();
  };

  const downloadFile = async (request: Request, onBytes: ((delta: number) => void) | undefined, fetchFile: Fetcher) => {
    const plan = (await loadPlans()).get(request.url);
    let credited = 0;
    return downloaderFor(fetchFile).download(request, {
      ...plan,
      headers: plan ? { "content-type": plan.contentType } : undefined,
      onBytes: (loaded) => {
        onBytes?.(loaded - credited);
        credited = loaded;
      },
    });
  };

  const release = async (request: Request) => {
    try {
      await downloaderFor(fetcher).release(request);
    } catch (error) {
      log("offline download chunk cleanup failed", { error: String(error), url: request.url });
    } finally {
      inFlight.delete(request.url);
    }
  };

  const cleanup = async () => {
    const plans = await loadPlans();
    const cache = await caches.open(cacheName);
    const stale = (await cache.keys()).filter((request) => {
      const asset = new URL(request.url).searchParams.get("asset");
      return asset !== null && !plans.has(asset);
    });
    await Promise.all(stale.map((request) => cache.delete(request)));
  };

  return { cleanup, download, release };
};

export { createOfflineDownloadClient };
