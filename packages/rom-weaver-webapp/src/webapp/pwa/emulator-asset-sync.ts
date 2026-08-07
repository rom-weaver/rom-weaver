export type EmulatorAsset = {
  readonly path: string;
  readonly sizeBytes: number;
};

export type EmulatorAssetManifest = {
  readonly version: string;
  readonly files: readonly EmulatorAsset[];
};

export type EmulatorAssetSyncProgress = {
  bytesDone: number;
  currentFile?: string;
  failedFiles: number;
  filesDone: number;
  skippedFiles: number;
  totalBytes: number;
  totalFiles: number;
};

export type EmulatorAssetSyncFailure = {
  readonly message: string;
  readonly path: string;
};

export type EmulatorAssetSyncResult = {
  readonly cancelled: boolean;
  readonly failures: readonly EmulatorAssetSyncFailure[];
  readonly progress: EmulatorAssetSyncProgress;
};

export type EmulatorAssetCache = {
  match(request: RequestInfo): Promise<Response | undefined>;
  put(request: RequestInfo, response: Response): Promise<void>;
};

export type EmulatorAssetFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type EmulatorAssetSyncOptions = {
  readonly baseUrl: string | URL;
  readonly cache: EmulatorAssetCache;
  readonly fetch: EmulatorAssetFetch;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: EmulatorAssetSyncProgress) => void;
};

const isSafeAssetPath = (path: unknown): path is string => {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((segment) => segment && segment !== "." && segment !== "..");
};

const normalizeBaseUrl = (baseUrl: string | URL): URL => {
  const normalized = new URL(baseUrl);
  if (!normalized.pathname.endsWith("/")) normalized.pathname += "/";
  return normalized;
};

const getAssetUrl = (baseUrl: URL, path: string): string => {
  if (!isSafeAssetPath(path)) throw new Error("EmulatorJS asset path is invalid");
  try {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    return new URL(`emulatorjs/data/${encodedPath}`, baseUrl).href;
  } catch {
    throw new Error("EmulatorJS asset path is invalid");
  }
};

export function validateEmulatorAssetManifest(value: unknown): asserts value is EmulatorAssetManifest {
  if (!value || typeof value !== "object") throw new Error("EmulatorJS asset manifest is invalid");
  const manifest = value as { files?: unknown; version?: unknown };
  if (typeof manifest.version !== "string" || !Array.isArray(manifest.files)) {
    throw new Error("EmulatorJS asset manifest is invalid");
  }

  const paths = new Set<string>();
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== "object") {
      throw new Error("EmulatorJS asset manifest contains an invalid file");
    }
    const file = entry as { path?: unknown; sizeBytes?: unknown };
    if (
      !isSafeAssetPath(file.path) ||
      typeof file.sizeBytes !== "number" ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      paths.has(file.path)
    ) {
      throw new Error("EmulatorJS asset manifest contains an invalid file");
    }
    paths.add(file.path);
  }
}

const createProgress = (
  manifest: EmulatorAssetManifest,
  cachedPaths: ReadonlySet<string>,
): EmulatorAssetSyncProgress => {
  const cachedFiles = manifest.files.filter((file) => cachedPaths.has(file.path));
  return {
    bytesDone: cachedFiles.reduce((total, file) => total + file.sizeBytes, 0),
    failedFiles: 0,
    filesDone: cachedFiles.length,
    skippedFiles: cachedFiles.length,
    totalBytes: manifest.files.reduce((total, file) => total + file.sizeBytes, 0),
    totalFiles: manifest.files.length,
  };
};

const cancelledResult = (
  failures: readonly EmulatorAssetSyncFailure[],
  progress: EmulatorAssetSyncProgress,
): EmulatorAssetSyncResult => ({
  cancelled: true,
  failures,
  progress: { ...progress },
});

export const syncEmulatorAssets = async (
  manifest: EmulatorAssetManifest,
  options: EmulatorAssetSyncOptions,
): Promise<EmulatorAssetSyncResult> => {
  validateEmulatorAssetManifest(manifest);
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const assets = manifest.files.map((file) => ({ file, url: getAssetUrl(baseUrl, file.path) }));
  const cachedPaths = new Set<string>();

  for (const { file, url } of assets) {
    if (await options.cache.match(url)) cachedPaths.add(file.path);
  }

  const progress = createProgress(manifest, cachedPaths);
  const failures: EmulatorAssetSyncFailure[] = [];
  const reportProgress = () => options.onProgress?.({ ...progress });
  reportProgress();

  for (const { file, url } of assets) {
    if (cachedPaths.has(file.path)) continue;
    if (options.signal?.aborted) return cancelledResult(failures, progress);

    progress.currentFile = file.path;
    reportProgress();
    if (options.signal?.aborted) return cancelledResult(failures, progress);

    try {
      const response = await options.fetch(url, {
        credentials: "same-origin",
        signal: options.signal,
      });
      if (options.signal?.aborted) return cancelledResult(failures, progress);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      await options.cache.put(url, response.clone());
      if (options.signal?.aborted) return cancelledResult(failures, progress);

      progress.bytesDone += file.sizeBytes;
      progress.filesDone += 1;
      progress.currentFile = undefined;
      reportProgress();
    } catch (error) {
      if (options.signal?.aborted) return cancelledResult(failures, progress);
      progress.failedFiles += 1;
      progress.currentFile = undefined;
      failures.push({
        message: error instanceof Error ? error.message : String(error),
        path: file.path,
      });
      reportProgress();
    }
  }

  return { cancelled: false, failures, progress: { ...progress } };
};
