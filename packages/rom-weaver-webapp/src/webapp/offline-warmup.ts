/**
 * Background offline warm-up for the service worker: downloads every
 * EmulatorJS asset and every optional identify pack group into their caches,
 * one unit per "pump" message, so the page controls pacing and a killed
 * worker loses at most one in-flight unit. Completion is derived from cache
 * contents alone (per-file entries plus per-unit markers), never from memory,
 * so it survives worker restarts and browser sessions.
 */

type IdentifyOptionalPack = { sha256: string; sizeBytes?: number; url: string };

type IdentifyOptionalPackGroup = {
  id: string;
  label: string;
  packs: IdentifyOptionalPack[];
};

type WarmupUnit =
  | { kind: "emulatorjs-file"; path: string; sizeBytes: number }
  | { kind: "identify-group"; group: IdentifyOptionalPackGroup };

type WarmupBumpTarget = { kind: "emulatorjs" } | { kind: "identify-groups"; groupIds: string[] };

type OfflineReadyState = {
  cachedBytes: number;
  /** Files already cached, counting EmulatorJS files and identify packs individually. */
  cachedFiles: number;
  pendingUnits: number;
  ready: boolean;
  totalBytes: number;
  totalFiles: number;
};

type OfflineCachedFile = {
  cache: string;
  url: string;
};

/** Human-facing description of the unit a progress event is about. */
type WarmupDetail = { kind: "emulatorjs" | "identify-group"; name: string } | null;

type WarmupProgress = OfflineReadyState & {
  detail: WarmupDetail;
  unit: string | null;
  /** Bytes of the in-flight unit downloaded so far; null outside a download. */
  unitLoadedBytes: number | null;
  /** Expected size of the in-flight unit; null outside a download. */
  unitTotalBytes: number | null;
};

type EmulatorJsManifest = {
  version: string;
  files: Array<{ path: string; sizeBytes: number }>;
};

type WarmupFetcher = (request: Request | string, init?: RequestInit) => Promise<Response>;

type OfflineWarmupOptions = {
  emulatorJsCacheName: string;
  emulatorJsVersion: string;
  /** Low-priority fetch for background warm-up units. */
  fetchForWarmup: WarmupFetcher;
  /** Normal-priority fetch for downloads a user is actively waiting on. Defaults to fetchForWarmup. */
  fetchForInteractive?: WarmupFetcher;
  identifyOptionalCacheName: string;
  identifyOptionalGroups: IdentifyOptionalPackGroup[];
  log: (message: string, details?: Record<string, unknown>) => void;
  scope: string;
};

type OfflineWarmup = {
  bumpPriority: (target: WarmupBumpTarget) => void;
  getCachedFiles: () => Promise<OfflineCachedFile[]>;
  getReadyState: () => Promise<OfflineReadyState>;
  installIdentifyGroup: (groupId: string) => Promise<{ id: string; installed: true; label: string; packs: number }>;
  /** onInterim streams byte-level progress while the unit downloads. */
  runNextUnit: (onInterim?: (progress: WarmupProgress) => void) => Promise<WarmupProgress>;
  serveOptionalIdentifyPack: (request: Request) => Promise<Response>;
};

// Interim progress messages are throttled to this interval so a fast download
// does not flood the message channel.
const INTERIM_PROGRESS_MS = 200;

const EMULATORJS_COMPLETE_MARKER_PATH = "/__rom-weaver-emulatorjs-complete__";

const optionalGroupMarkerUrl = (scope: string, groupId: string) =>
  new URL(`/__rom-weaver-identify-group__/${groupId}`, scope).href;

const optionalGroupRevision = (group: IdentifyOptionalPackGroup) =>
  group.packs.map((pack) => `${pack.url}:${pack.sha256}`).join("\n");

const sha256HexOf = async (bytes: ArrayBuffer) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Read the whole body into memory, reporting per-chunk byte counts as they arrive. */
const readWithByteProgress = async (response: Response, onBytes?: (delta: number) => void): Promise<ArrayBuffer> => {
  if (!(response.body && onBytes)) {
    const buffer = await response.arrayBuffer();
    onBytes?.(buffer.byteLength);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalLength += value.byteLength;
      onBytes(value.byteLength);
    }
  }
  const buffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer.buffer;
};

/** A cacheable copy of a fully read response, keeping its headers and status. */
const bufferedResponse = (source: Response, buffer: ArrayBuffer) =>
  new Response(buffer, { headers: source.headers, status: source.status, statusText: source.statusText });

/** Fetch one pack, verify its SHA-256, and return the request/response pair ready to cache. */
const fetchVerifiedPack = async (
  pack: IdentifyOptionalPack,
  scope: string,
  fetcher: WarmupFetcher,
  onBytes?: (delta: number) => void,
) => {
  const request = new Request(new URL(pack.url, scope));
  const response = await fetcher(request);
  if (!response.ok) throw new Error(`ROM identify pack download failed with HTTP ${response.status}`);
  const buffer = await readWithByteProgress(response, onBytes);
  const actualSha256 = await sha256HexOf(buffer);
  if (actualSha256 !== pack.sha256) throw new Error(`ROM identify pack checksum failed: ${pack.url}`);
  return { request, response: bufferedResponse(response, buffer) };
};

/** Relative path with no empty, ".", or ".." segments and no backslashes or leading slash. */
const isSafeAssetPath = (value: unknown): value is string => {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\")) return false;
  return value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
};

/** Validate the fetched manifest so a malformed entry cannot poison URLs or byte totals. */
const parseEmulatorJsManifest = (value: unknown): EmulatorJsManifest => {
  const record = value as { files?: unknown; version?: unknown } | null;
  if (!record || typeof record.version !== "string" || !Array.isArray(record.files)) {
    throw new Error("EmulatorJS manifest is invalid");
  }
  const paths = new Set<string>();
  const isValidSize = (size: unknown): size is number =>
    typeof size === "number" && Number.isSafeInteger(size) && size >= 0;
  const files = record.files.map((entry) => {
    const file = (entry ?? {}) as { path?: unknown; sizeBytes?: unknown };
    if (!(isSafeAssetPath(file.path) && isValidSize(file.sizeBytes)) || paths.has(file.path)) {
      throw new Error("EmulatorJS manifest contains an invalid file");
    }
    paths.add(file.path);
    return { path: file.path, sizeBytes: file.sizeBytes };
  });
  return { files, version: record.version };
};

const createOfflineWarmup = ({
  emulatorJsCacheName,
  emulatorJsVersion,
  fetchForWarmup,
  fetchForInteractive = fetchForWarmup,
  identifyOptionalCacheName,
  identifyOptionalGroups,
  log,
  scope,
}: OfflineWarmupOptions): OfflineWarmup => {
  const emulatorJsManifestUrl = new URL("emulatorjs/manifest.json", scope).href;
  const emulatorJsMarkerUrl = new URL(EMULATORJS_COMPLETE_MARKER_PATH, scope).href;
  const emulatorJsAssetUrl = (path: string) =>
    new URL(`emulatorjs/data/${path.split("/").map(encodeURIComponent).join("/")}`, scope).href;

  let manifestPromise: Promise<EmulatorJsManifest> | null = null;
  // Queue of incomplete units in download order. Rebuilt from cache contents
  // after a worker restart; bumps reorder it in place.
  let queue: WarmupUnit[] | null = null;
  let queuePromise: Promise<WarmupUnit[]> | null = null;

  const loadEmulatorJsManifest = (): Promise<EmulatorJsManifest> => {
    if (!manifestPromise) {
      manifestPromise = (async () => {
        const response = await fetchForWarmup(emulatorJsManifestUrl);
        if (!response.ok) throw new Error(`EmulatorJS manifest request failed with HTTP ${response.status}`);
        return parseEmulatorJsManifest(await response.json());
      })().catch((error) => {
        manifestPromise = null;
        throw error;
      });
    }
    return manifestPromise;
  };

  const isGroupInstalled = async (cache: Cache, group: IdentifyOptionalPackGroup) =>
    (await (await cache.match(optionalGroupMarkerUrl(scope, group.id)))?.text()) === optionalGroupRevision(group);

  const isEmulatorJsComplete = async (cache: Cache) =>
    (await (await cache.match(emulatorJsMarkerUrl))?.text()) === emulatorJsVersion;

  /** Size and count of the emulatorjs manifest files already in the cache. */
  const cachedEmulatorJsState = async (cache: Cache, manifest: EmulatorJsManifest) => {
    let bytes = 0;
    let files = 0;
    for (const file of manifest.files) {
      if (await cache.match(emulatorJsAssetUrl(file.path))) {
        bytes += file.sizeBytes;
        files += 1;
      }
    }
    return { bytes, files };
  };

  /** Size and count of a not-yet-installed group's packs already in the cache. */
  const cachedGroupState = async (cache: Cache, group: IdentifyOptionalPackGroup) => {
    let bytes = 0;
    let files = 0;
    for (const pack of group.packs) {
      if (await cache.match(new URL(pack.url, scope).href)) {
        bytes += pack.sizeBytes || 0;
        files += 1;
      }
    }
    return { bytes, files };
  };

  const groupBytes = (group: IdentifyOptionalPackGroup) =>
    group.packs.reduce((sum, pack) => sum + (pack.sizeBytes || 0), 0);

  const buildQueue = async (): Promise<WarmupUnit[]> => {
    const units: WarmupUnit[] = [];
    const emulatorJsCache = await caches.open(emulatorJsCacheName);
    if (!(await isEmulatorJsComplete(emulatorJsCache))) {
      const manifest = await loadEmulatorJsManifest();
      for (const file of manifest.files) {
        if (!(await emulatorJsCache.match(emulatorJsAssetUrl(file.path)))) {
          units.push({ kind: "emulatorjs-file", path: file.path, sizeBytes: file.sizeBytes });
        }
      }
      // All files can already be cached (filled by the runtime route) with the
      // marker still missing; runNextUnit writes the marker on an empty queue.
    }
    const identifyCache = await caches.open(identifyOptionalCacheName);
    for (const group of identifyOptionalGroups) {
      if (!(await isGroupInstalled(identifyCache, group))) units.push({ kind: "identify-group", group });
    }
    return units;
  };

  const getQueue = (): Promise<WarmupUnit[]> => {
    if (queue) return Promise.resolve(queue);
    if (!queuePromise) {
      queuePromise = buildQueue()
        .then((units) => {
          queue = units;
          queuePromise = null;
          return units;
        })
        .catch((error) => {
          queuePromise = null;
          throw error;
        });
    }
    return queuePromise;
  };

  const getReadyState = async (): Promise<OfflineReadyState> => {
    const emulatorJsCache = await caches.open(emulatorJsCacheName);
    const identifyCache = await caches.open(identifyOptionalCacheName);
    let totalBytes = 0;
    let cachedBytes = 0;
    let totalFiles = 0;
    let cachedFiles = 0;
    let pendingUnits = 0;
    let emulatorJsReady = await isEmulatorJsComplete(emulatorJsCache);
    try {
      const manifest = await loadEmulatorJsManifest();
      const manifestBytes = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
      totalBytes += manifestBytes;
      totalFiles += manifest.files.length;
      if (emulatorJsReady) {
        cachedBytes += manifestBytes;
        cachedFiles += manifest.files.length;
      } else {
        const cached = await cachedEmulatorJsState(emulatorJsCache, manifest);
        cachedBytes += cached.bytes;
        cachedFiles += cached.files;
        pendingUnits += manifest.files.length;
        // Marker missing but every byte present still counts as pending: the
        // next pump writes the marker and flips ready.
      }
    } catch (error) {
      // Offline with no cached manifest: readiness cannot improve right now.
      // Report not-ready without byte totals for the emulatorjs share.
      if (!emulatorJsReady) pendingUnits += 1;
      log("emulatorjs manifest unavailable for ready state", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    for (const group of identifyOptionalGroups) {
      const bytes = groupBytes(group);
      totalBytes += bytes;
      totalFiles += group.packs.length;
      if (await isGroupInstalled(identifyCache, group)) {
        cachedBytes += bytes;
        cachedFiles += group.packs.length;
      } else {
        // Partially cached groups (on-demand pack fetches, an interrupted
        // install) still credit their cached packs to the counters.
        const cached = await cachedGroupState(identifyCache, group);
        cachedBytes += cached.bytes;
        cachedFiles += cached.files;
        pendingUnits += 1;
      }
    }
    const ready = emulatorJsReady && pendingUnits === 0;
    return { cachedBytes, cachedFiles, pendingUnits, ready, totalBytes, totalFiles };
  };

  const getCachedFiles = async (): Promise<OfflineCachedFile[]> => {
    const cacheNames = await caches.keys();
    const files = await Promise.all(
      cacheNames.map(async (cacheName) => {
        const requests = await caches.open(cacheName).then((cache) => cache.keys());
        return requests
          .filter((request) => {
            const path = new URL(request.url).pathname;
            return !path.startsWith("/__rom-weaver-");
          })
          .map((request) => ({ cache: cacheName, url: request.url }));
      }),
    );
    return files.flat().sort((left, right) => left.url.localeCompare(right.url));
  };

  const installGroupWith = async (fetcher: WarmupFetcher, groupId: string, onBytes?: (delta: number) => void) => {
    const group = identifyOptionalGroups.find((candidate) => candidate.id === groupId);
    if (!group) throw new Error(`Unknown ROM identify pack group: ${groupId}`);
    const cache = await caches.open(identifyOptionalCacheName);
    // Sequential on purpose: group installs also run as low-priority warm-up
    // units and MUST NOT open one connection per pack.
    for (const pack of group.packs) {
      if (await cache.match(new URL(pack.url, scope).href)) {
        // Already-cached packs still advance the byte counter, or the bar
        // would stall through a group resumed after a restart.
        onBytes?.(pack.sizeBytes || 0);
        continue;
      }
      const { request, response } = await fetchVerifiedPack(pack, scope, fetcher, onBytes);
      await cache.put(request, response);
    }
    await cache.put(optionalGroupMarkerUrl(scope, group.id), new Response(optionalGroupRevision(group)));
    if (queue) queue = queue.filter((unit) => !(unit.kind === "identify-group" && unit.group.id === group.id));
    return { id: group.id, installed: true as const, label: group.label, packs: group.packs.length };
  };

  // A user clicked Install in settings, so this one downloads at normal priority.
  const installIdentifyGroup = (groupId: string) => installGroupWith(fetchForInteractive, groupId);

  const downloadEmulatorJsFile = async (
    unit: Extract<WarmupUnit, { kind: "emulatorjs-file" }>,
    onBytes?: (delta: number) => void,
  ) => {
    const cache = await caches.open(emulatorJsCacheName);
    const url = emulatorJsAssetUrl(unit.path);
    if (await cache.match(url)) {
      onBytes?.(unit.sizeBytes);
      return;
    }
    const response = await fetchForWarmup(url);
    if (!response.ok) throw new Error(`EmulatorJS warm-up download failed with HTTP ${response.status}: ${unit.path}`);
    const buffer = await readWithByteProgress(response, onBytes);
    await cache.put(url, bufferedResponse(response, buffer));
  };

  /** Write the completion marker once no emulatorjs file unit remains. */
  const finishEmulatorJsIfComplete = async () => {
    if (queue?.some((unit) => unit.kind === "emulatorjs-file")) return;
    const cache = await caches.open(emulatorJsCacheName);
    if (await isEmulatorJsComplete(cache)) return;
    const manifest = await loadEmulatorJsManifest();
    for (const file of manifest.files) {
      if (!(await cache.match(emulatorJsAssetUrl(file.path)))) return;
    }
    await cache.put(
      emulatorJsMarkerUrl,
      new Response(emulatorJsVersion, { headers: { "content-type": "text/plain" } }),
    );
    log("emulatorjs warm-up complete", { version: emulatorJsVersion });
  };

  const unitLabel = (unit: WarmupUnit) =>
    unit.kind === "emulatorjs-file" ? `emulatorjs:${unit.path}` : `identify-group:${unit.group.id}`;

  const unitDetail = (unit: WarmupUnit): WarmupDetail =>
    unit.kind === "emulatorjs-file"
      ? { kind: "emulatorjs", name: unit.path }
      : { kind: "identify-group", name: unit.group.label };

  // Serializes pumps: two clients (two open tabs, or a page retrying after its
  // pump timeout) MUST NOT process the queue concurrently, or both would take
  // the same head unit and the second removal would discard an unprocessed one.
  let pumpChain: Promise<unknown> = Promise.resolve();

  const processNextUnit = async (onInterim?: (progress: WarmupProgress) => void): Promise<WarmupUnit | undefined> => {
    const units = await getQueue();
    const unit = units[0];
    if (!unit) {
      // Empty queue can still mean a missing emulatorjs marker (files were
      // filled by the runtime route before the queue was built).
      await finishEmulatorJsIfComplete();
      return unit;
    }
    // Interim events add the in-flight bytes onto a baseline taken once per
    // unit, so the counter rises smoothly during the download instead of
    // jumping once when the whole unit lands.
    let onBytes: ((delta: number) => void) | undefined;
    if (onInterim) {
      const baseline = await getReadyState();
      const detail = unitDetail(unit);
      const label = unitLabel(unit);
      const unitTotalBytes = unit.kind === "emulatorjs-file" ? unit.sizeBytes : groupBytes(unit.group);
      let loadedBytes = 0;
      let lastEmit = 0;
      const emit = () => {
        onInterim({
          ...baseline,
          // Capped: a pack that was cached between the baseline read and the
          // download reports its bytes twice, once in each half.
          cachedBytes: Math.min(baseline.cachedBytes + loadedBytes, baseline.totalBytes || Number.MAX_SAFE_INTEGER),
          detail,
          ready: false,
          unit: label,
          unitLoadedBytes: Math.min(loadedBytes, unitTotalBytes || loadedBytes),
          unitTotalBytes,
        });
      };
      onBytes = (delta) => {
        loadedBytes += delta;
        const now = Date.now();
        if (now - lastEmit < INTERIM_PROGRESS_MS) return;
        lastEmit = now;
        emit();
      };
      // One immediate event names the unit that just started downloading.
      emit();
    }
    if (unit.kind === "emulatorjs-file") {
      await downloadEmulatorJsFile(unit, onBytes);
      // Remove by identity from the live queue: a bump may have replaced the
      // array (or reordered it) while the download ran.
      if (queue) queue = queue.filter((candidate) => candidate !== unit);
      await finishEmulatorJsIfComplete();
    } else {
      await installGroupWith(fetchForWarmup, unit.group.id, onBytes);
    }
    return unit;
  };

  const runNextUnit = (onInterim?: (progress: WarmupProgress) => void): Promise<WarmupProgress> => {
    const process = () => processNextUnit(onInterim);
    const run = pumpChain.then(process, process);
    pumpChain = run.catch(() => undefined);
    return run.then(async (unit) => {
      const state = await getReadyState();
      return {
        ...state,
        detail: unit ? unitDetail(unit) : null,
        unit: unit ? unitLabel(unit) : null,
        unitLoadedBytes: null,
        unitTotalBytes: null,
      };
    });
  };

  const bumpPriority = (target: WarmupBumpTarget) => {
    if (!queue) {
      // Queue not built yet: build it, then reorder. Fire-and-forget is fine -
      // the follow-up pump awaits getQueue() before reading it.
      getQueue()
        .then(() => bumpPriority(target))
        .catch((error) => {
          log("warm-up bump dropped; queue build failed", {
            error: error instanceof Error ? error.message : String(error),
            target: target.kind,
          });
        });
      return;
    }
    const matches = (unit: WarmupUnit) =>
      target.kind === "emulatorjs"
        ? unit.kind === "emulatorjs-file"
        : unit.kind === "identify-group" && target.groupIds.includes(unit.group.id);
    const bumped = queue.filter(matches);
    if (!bumped.length) return;
    queue = [...bumped, ...queue.filter((unit) => !matches(unit))];
    log("warm-up priority bumped", { target: target.kind, units: bumped.length });
  };

  const serveOptionalIdentifyPack = async (request: Request): Promise<Response> => {
    const requestUrl = new URL(request.url);
    const cache = await caches.open(identifyOptionalCacheName);
    const cached = await cache.match(request.url);
    if (cached) return cached;
    const pack = identifyOptionalGroups
      .flatMap((group) => group.packs)
      .find((candidate) => new URL(candidate.url, scope).pathname === requestUrl.pathname);
    if (!pack) return Response.error();
    // On-demand single-pack fetch: an identify run must never fail because the
    // group install has not happened yet. The group marker stays absent until
    // a full install, so settings semantics are unchanged. The user is waiting
    // on this response, so it fetches at normal priority.
    const { request: packRequest, response } = await fetchVerifiedPack(pack, scope, fetchForInteractive);
    await cache.put(packRequest, response.clone());
    return response;
  };

  return { bumpPriority, getCachedFiles, getReadyState, installIdentifyGroup, runNextUnit, serveOptionalIdentifyPack };
};

export { createOfflineWarmup };
export type { OfflineCachedFile, OfflineReadyState, WarmupBumpTarget, WarmupProgress };
