/**
 * The service worker caches EmulatorJS assets and required or selected identify groups in page-paced batches.
 * Progress comes from cached files and unit markers so completed downloads survive worker restarts.
 */

import { bufferedResponse, ENCODED_SIZE_HEADER, encodedSizeOf } from "./pwa/response-encoded-size.ts";

type IdentifyOptionalPack = { sha256: string; sizeBytes?: number; url: string };

type IdentifyOptionalPackGroup = {
  id: string;
  label: string;
  packs: IdentifyOptionalPack[];
  /** Always kept offline: part of the base set, so settings never offers it. */
  required?: boolean;
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

/**
 * An optional pack group as settings shows it. The page side mirrors this shape
 * as IdentifyPackGroupState (platform/browser/identify-packs.ts) - the two are
 * separate bundles, so the reply is re-typed there rather than imported.
 */
type IdentifyGroupState = {
  id: string;
  installed: boolean;
  label: string;
  packs: number;
  sizeBytes: number;
  wanted: boolean;
};

type OfflineCachedFile = {
  cache: string;
  /**
   * Transfer (encoded) size from the stored Content-Length header; null when
   * the header is absent. Equals sizeBytes for responses served unencoded.
   */
  compressedBytes: number | null;
  /** Stored (decoded) body size; null when the body cannot be read (opaque response). */
  sizeBytes: number | null;
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
  /**
   * Bytes and entries of the app's own precache, and how much of it is stored.
   * Counted into every readout so the install reports one total across both
   * stages. Omitted (or failing) leaves the precache out of the totals.
   */
  precacheState?: () => Promise<{ cachedBytes: number; cachedFiles: number; totalBytes: number; totalFiles: number }>;
  scope: string;
  /** EmulatorJS files one pump downloads concurrently. Default {@link EMULATORJS_BATCH_SIZE}. */
  emulatorJsBatchSize?: number;
};

type OfflineWarmup = {
  bumpPriority: (target: WarmupBumpTarget) => void;
  getCachedFiles: (onFileMeasured?: () => void) => Promise<OfflineCachedFile[]>;
  getIdentifyGroupState: () => Promise<IdentifyGroupState[]>;
  getReadyState: () => Promise<OfflineReadyState>;
  installIdentifyGroup: (groupId: string) => Promise<{ id: string; installed: true; label: string; packs: number }>;
  /** onInterim streams byte-level progress while the unit downloads. */
  runNextUnit: (onInterim?: (progress: WarmupProgress) => void) => Promise<WarmupProgress>;
  serveOptionalIdentifyPack: (request: Request) => Promise<Response>;
  setIdentifyGroupWanted: (groupId: string, wanted: boolean) => Promise<IdentifyGroupState[]>;
};

// Interim progress messages are throttled to this interval so a fast download
// does not flood the message channel.
const INTERIM_PROGRESS_MS = 200;

// Download small EmulatorJS files in one pump. Identify groups stay sequential
// because their installer limits itself to one pack connection at a time.
const EMULATORJS_BATCH_SIZE = 6;

const EMULATORJS_COMPLETE_MARKER_PATH = "/__rom-weaver-emulatorjs-complete__";

const optionalGroupMarkerUrl = (scope: string, groupId: string) =>
  new URL(`/__rom-weaver-identify-group__/${groupId}`, scope).href;

// Optional groups are opt-in: the background warm-up downloads only the groups
// the user has ticked in settings. An unticked group still serves any single
// pack an identify run asks for (see serveOptionalIdentifyPack), so nothing
// stops working - it just is not held offline.
const optionalGroupsWantedUrl = (scope: string) => new URL("/__rom-weaver-identify-wanted__", scope).href;

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

/** Header value as a byte count, or null when it is absent or not a size. */
const headerBytes = (response: Response, header: string): number | null => {
  if (!response.headers.has(header)) return null;
  const value = Number(response.headers.get(header));
  return Number.isFinite(value) && value >= 0 ? value : null;
};

/**
 * Transfer and stored sizes of one cached entry. The stamped measurement wins,
 * then Content-Length; failing both, a response with no Content-Encoding was
 * transferred exactly as it is stored, so its stored size is also its transfer
 * size. Only a compressed entry that nothing measured is left unknown.
 */
const measureCachedResponse = async (response: Response) => {
  let sizeBytes: number | null = null;
  try {
    sizeBytes = (await response.arrayBuffer()).byteLength;
  } catch {
    // Opaque or unreadable body: report the file without a decoded size.
  }
  const identityBytes = response.headers.has("content-encoding") ? null : sizeBytes;
  const compressedBytes =
    headerBytes(response, ENCODED_SIZE_HEADER) ?? headerBytes(response, "content-length") ?? identityBytes;
  return { compressedBytes, sizeBytes };
};

const cachedRequestUrls = async (cache: Cache) => new Set((await cache.keys()).map((request) => request.url));

/** Fetch one pack, verify its SHA-256, and return the request/response pair ready to cache. */
const fetchVerifiedPack = async (
  pack: IdentifyOptionalPack,
  scope: string,
  fetcher: WarmupFetcher,
  onBytes?: (delta: number) => void,
) => {
  const request = new Request(new URL(pack.url, scope));
  const response = await fetcher(request);
  if (!response.ok) {
    throw new Error(`ROM identify pack download failed with HTTP ${response.status}: ${pack.url}`);
  }
  const buffer = await readWithByteProgress(response, onBytes);
  const actualSha256 = await sha256HexOf(buffer);
  // The digests go in the message because this error is only ever seen through
  // a caller's log line: expected != actual means this worker's baked pack
  // table is a different data revision than the bytes the origin now serves.
  if (actualSha256 !== pack.sha256) {
    throw new Error(
      `ROM identify pack checksum failed: ${pack.url}: expected ${pack.sha256}, got ${actualSha256} (${buffer.byteLength} bytes)`,
    );
  }
  return { request, response: bufferedResponse(response, buffer, encodedSizeOf(request.url)) };
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
  precacheState,
  scope,
  emulatorJsBatchSize = EMULATORJS_BATCH_SIZE,
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

  const wantedUrl = optionalGroupsWantedUrl(scope);

  const isGroupWanted = (group: IdentifyOptionalPackGroup, wanted: ReadonlySet<string>) =>
    group.required === true || wanted.has(group.id);

  /** Store selected group ids in the cache so they survive worker restarts. Seed
   * a missing preference from installed groups so existing offline data remains selected. */
  // getReadyState reads this on every throttled progress update, so cache it in this worker until a write replaces it.
  let wantedPromise: Promise<Set<string>> | null = null;

  const readWantedGroupIds = (cache: Cache, installedGroups?: boolean[]): Promise<Set<string>> => {
    if (!wantedPromise) {
      wantedPromise = loadWantedGroupIds(cache, installedGroups).catch((error) => {
        wantedPromise = null;
        throw error;
      });
    }
    return wantedPromise;
  };

  /** `installedGroups` lets a caller that already checked the markers skip re-reading them. */
  const loadWantedGroupIds = async (cache: Cache, installedGroups?: boolean[]): Promise<Set<string>> => {
    const stored = await cache.match(wantedUrl);
    if (stored) {
      try {
        const parsed: unknown = await stored.json();
        if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
      } catch {
        // A corrupt list is replaced by the seed below rather than failing the pump.
      }
    }
    const installed =
      installedGroups ?? (await Promise.all(identifyOptionalGroups.map((group) => isGroupInstalled(cache, group))));
    const seeded = identifyOptionalGroups.filter((_, index) => installed[index]).map((group) => group.id);
    await writeWantedGroupIds(cache, new Set(seeded));
    return new Set(seeded);
  };

  const writeWantedGroupIds = async (cache: Cache, wanted: Set<string>) => {
    await cache.put(
      wantedUrl,
      new Response(JSON.stringify([...wanted]), { headers: { "content-type": "application/json" } }),
    );
    wantedPromise = Promise.resolve(new Set(wanted));
  };

  /** Remove a group's packs and its completion marker. */
  const removeGroupFromCache = async (cache: Cache, group: IdentifyOptionalPackGroup) => {
    await Promise.all(group.packs.map((pack) => cache.delete(new URL(pack.url, scope).href)));
    await cache.delete(optionalGroupMarkerUrl(scope, group.id));
  };

  const isEmulatorJsComplete = async (cache: Cache) =>
    (await (await cache.match(emulatorJsMarkerUrl))?.text()) === emulatorJsVersion;

  /** Size and count of the emulatorjs manifest files already in the cache. */
  const cachedEmulatorJsState = (cachedUrls: ReadonlySet<string>, manifest: EmulatorJsManifest) => {
    let bytes = 0;
    let files = 0;
    for (const file of manifest.files) {
      if (cachedUrls.has(emulatorJsAssetUrl(file.path))) {
        bytes += file.sizeBytes;
        files += 1;
      }
    }
    return { bytes, files };
  };

  /** Size and count of a not-yet-installed group's packs already in the cache. */
  const cachedGroupState = (cachedUrls: ReadonlySet<string>, group: IdentifyOptionalPackGroup) => {
    let bytes = 0;
    let files = 0;
    for (const pack of group.packs) {
      if (cachedUrls.has(new URL(pack.url, scope).href)) {
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
    const [emulatorJsCache, identifyCache] = await Promise.all([
      caches.open(emulatorJsCacheName),
      caches.open(identifyOptionalCacheName),
    ]);
    const [emulatorJsReady, installedGroups] = await Promise.all([
      isEmulatorJsComplete(emulatorJsCache),
      Promise.all(identifyOptionalGroups.map((group) => isGroupInstalled(identifyCache, group))),
    ]);
    if (!emulatorJsReady) {
      const [manifest, cachedUrls] = await Promise.all([loadEmulatorJsManifest(), cachedRequestUrls(emulatorJsCache)]);
      for (const file of manifest.files) {
        if (!cachedUrls.has(emulatorJsAssetUrl(file.path))) {
          units.push({ kind: "emulatorjs-file", path: file.path, sizeBytes: file.sizeBytes });
        }
      }
      // Runtime requests can cache every file before this marker exists. An empty pump writes the marker.
    }
    const wanted = await readWantedGroupIds(identifyCache, installedGroups);
    for (const [index, group] of identifyOptionalGroups.entries()) {
      if (!installedGroups[index] && isGroupWanted(group, wanted)) units.push({ kind: "identify-group", group });
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
    const [emulatorJsCache, identifyCache] = await Promise.all([
      caches.open(emulatorJsCacheName),
      caches.open(identifyOptionalCacheName),
    ]);
    const [emulatorJsReady, installedGroups] = await Promise.all([
      isEmulatorJsComplete(emulatorJsCache),
      Promise.all(identifyOptionalGroups.map((group) => isGroupInstalled(identifyCache, group))),
    ]);
    const [cachedEmulatorJsUrls, cachedIdentifyUrls] = await Promise.all([
      emulatorJsReady ? null : cachedRequestUrls(emulatorJsCache),
      installedGroups.every(Boolean) ? null : cachedRequestUrls(identifyCache),
    ]);
    let totalBytes = 0;
    let cachedBytes = 0;
    let totalFiles = 0;
    let cachedFiles = 0;
    let pendingUnits = 0;
    if (precacheState) {
      try {
        const precache = await precacheState();
        totalBytes += precache.totalBytes;
        cachedBytes += precache.cachedBytes;
        totalFiles += precache.totalFiles;
        cachedFiles += precache.cachedFiles;
      } catch (error) {
        // The app's own bytes drop out of the totals; the warm-up share still reports.
        log("precache state unavailable for ready state", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      const manifest = await loadEmulatorJsManifest();
      const manifestBytes = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
      totalBytes += manifestBytes;
      totalFiles += manifest.files.length;
      if (emulatorJsReady) {
        cachedBytes += manifestBytes;
        cachedFiles += manifest.files.length;
      } else {
        const cached = cachedEmulatorJsState(cachedEmulatorJsUrls || new Set(), manifest);
        cachedBytes += cached.bytes;
        cachedFiles += cached.files;
        pendingUnits += manifest.files.length;
        // A missing marker remains pending even when every file is cached. The next pump marks the set ready.
      }
    } catch (error) {
      // Offline with no cached manifest: readiness cannot improve right now.
      // Report not-ready without byte totals for the emulatorjs share.
      if (!emulatorJsReady) pendingUnits += 1;
      log("emulatorjs manifest unavailable for ready state", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const wanted = await readWantedGroupIds(identifyCache, installedGroups);
    for (const [index, group] of identifyOptionalGroups.entries()) {
      // Only selected groups count toward offline readiness. On-demand cached packs remain outside these totals.
      if (!isGroupWanted(group, wanted)) continue;
      totalBytes += groupBytes(group);
      totalFiles += group.packs.length;
      if (installedGroups[index]) {
        cachedBytes += groupBytes(group);
        cachedFiles += group.packs.length;
      } else {
        // Count packs cached by an interrupted install or an on-demand fetch.
        const cached = cachedGroupState(cachedIdentifyUrls || new Set(), group);
        cachedBytes += cached.bytes;
        cachedFiles += cached.files;
        pendingUnits += 1;
      }
    }
    const ready = emulatorJsReady && pendingUnits === 0;
    return { cachedBytes, cachedFiles, pendingUnits, ready, totalBytes, totalFiles };
  };

  /**
   * Inventory of every cached file with its sizes. Reads each stored body to
   * measure the decoded size, so the walk is sequential to cap memory and
   * onFileMeasured lets the caller keep its message deadline alive while a
   * large cache set is measured.
   */
  const getCachedFiles = async (onFileMeasured?: () => void): Promise<OfflineCachedFile[]> => {
    const cacheNames = await caches.keys();
    const files: OfflineCachedFile[] = [];
    for (const cacheName of cacheNames) {
      const cache = await caches.open(cacheName);
      const requests = (await cache.keys()).filter(
        (request) => !new URL(request.url).pathname.startsWith("/__rom-weaver-"),
      );
      for (const request of requests) {
        const response = await cache.match(request);
        const sizes = response ? await measureCachedResponse(response) : { compressedBytes: null, sizeBytes: null };
        files.push({ cache: cacheName, ...sizes, url: request.url });
        onFileMeasured?.();
      }
    }
    return files.sort((left, right) => left.url.localeCompare(right.url));
  };

  const installGroupWith = async (fetcher: WarmupFetcher, groupId: string, onBytes?: (delta: number) => void) => {
    const group = identifyOptionalGroups.find((candidate) => candidate.id === groupId);
    if (!group) throw new Error(`Unknown ROM identify pack group: ${groupId}`);
    const cache = await caches.open(identifyOptionalCacheName);
    // Group installs MUST stay sequential so a low-priority warmup does not open one connection per pack.
    for (const pack of group.packs) {
      if (await cache.match(new URL(pack.url, scope).href)) {
        // Credit cached packs so a resumed group reports continuous progress.
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

  // A user-selected group downloads at normal priority and joins the offline set.
  const installIdentifyGroup = async (groupId: string) => {
    const result = await installGroupWith(fetchForInteractive, groupId);
    const cache = await caches.open(identifyOptionalCacheName);
    const wanted = await readWantedGroupIds(cache);
    if (!wanted.has(groupId)) await writeWantedGroupIds(cache, new Set([...wanted, groupId]));
    return result;
  };

  /** Every optional group with whether it is kept offline and already stored. */
  const getIdentifyGroupState = async (): Promise<IdentifyGroupState[]> => {
    const cache = await caches.open(identifyOptionalCacheName);
    const installed = await Promise.all(identifyOptionalGroups.map((group) => isGroupInstalled(cache, group)));
    const wanted = await readWantedGroupIds(cache, installed);
    return identifyOptionalGroups.flatMap((group, index) =>
      group.required
        ? []
        : [
            {
              id: group.id,
              installed: installed[index] ?? false,
              label: group.label,
              packs: group.packs.length,
              sizeBytes: groupBytes(group),
              wanted: wanted.has(group.id),
            },
          ],
    );
  };

  /** Unticking a group deletes its cache to reclaim space. On-demand fetches remain available. */
  const setIdentifyGroupWanted = async (groupId: string, isWanted: boolean): Promise<IdentifyGroupState[]> => {
    const group = identifyOptionalGroups.find((candidate) => candidate.id === groupId);
    if (!group) throw new Error(`Unknown ROM identify pack group: ${groupId}`);
    if (group.required) throw new Error(`ROM identify pack group is always kept offline: ${groupId}`);
    const cache = await caches.open(identifyOptionalCacheName);
    const current = await readWantedGroupIds(cache);
    if (isWanted === current.has(groupId)) return getIdentifyGroupState();
    const wanted = new Set(current);
    if (isWanted) wanted.add(groupId);
    else wanted.delete(groupId);
    await writeWantedGroupIds(cache, wanted);
    if (!isWanted) {
      await removeGroupFromCache(cache, group);
      if (queue) queue = queue.filter((unit) => !(unit.kind === "identify-group" && unit.group.id === groupId));
    } else if (queue && !queue.some((unit) => unit.kind === "identify-group" && unit.group.id === groupId)) {
      queue = [...queue, { group, kind: "identify-group" }];
    }
    log("identify group offline preference changed", { groupId, wanted: isWanted });
    return getIdentifyGroupState();
  };

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
    await cache.put(url, bufferedResponse(response, buffer, encodedSizeOf(url)));
  };

  /** Write the completion marker once no emulatorjs file unit remains. */
  const finishEmulatorJsIfComplete = async () => {
    if (queue?.some((unit) => unit.kind === "emulatorjs-file")) return;
    const cache = await caches.open(emulatorJsCacheName);
    if (await isEmulatorJsComplete(cache)) return;
    const manifest = await loadEmulatorJsManifest();
    const cachedUrls = await cachedRequestUrls(cache);
    for (const file of manifest.files) {
      if (!cachedUrls.has(emulatorJsAssetUrl(file.path))) return;
    }
    await cache.put(
      emulatorJsMarkerUrl,
      new Response(emulatorJsVersion, { headers: { "content-type": "text/plain" } }),
    );
    log("emulatorjs warm-up complete", { version: emulatorJsVersion });
  };

  /** Download callbacks credit cached files through onBytes. Interim math MUST
   * subtract them from its baseline to prevent double counting and percentage overshoot. */
  const cachedUnitBytes = async (units: WarmupUnit[]): Promise<number> => {
    let total = 0;
    if (units.some((unit) => unit.kind === "emulatorjs-file")) {
      const cachedUrls = await cachedRequestUrls(await caches.open(emulatorJsCacheName));
      for (const unit of units) {
        if (unit.kind === "emulatorjs-file" && cachedUrls.has(emulatorJsAssetUrl(unit.path))) total += unit.sizeBytes;
      }
    }
    for (const unit of units) {
      if (unit.kind !== "identify-group") continue;
      const cachedUrls = await cachedRequestUrls(await caches.open(identifyOptionalCacheName));
      total += cachedGroupState(cachedUrls, unit.group).bytes;
    }
    return total;
  };

  const unitLabel = (unit: WarmupUnit) =>
    unit.kind === "emulatorjs-file" ? `emulatorjs:${unit.path}` : `identify-group:${unit.group.id}`;

  const unitDetail = (unit: WarmupUnit, batchSize = 1): WarmupDetail =>
    unit.kind === "emulatorjs-file"
      ? { kind: "emulatorjs", name: batchSize > 1 ? `${unit.path} (+${batchSize - 1})` : unit.path }
      : { kind: "identify-group", name: unit.group.label };

  const unitBytes = (unit: WarmupUnit) => (unit.kind === "emulatorjs-file" ? unit.sizeBytes : groupBytes(unit.group));

  /** A pump downloads one identify group or a bounded EmulatorJS batch. The
   * detail line names the batch's largest file. */
  const nextBatch = (units: WarmupUnit[]): WarmupUnit[] => {
    if (units[0]?.kind !== "emulatorjs-file") return units.slice(0, 1);
    const batch = units.filter((unit) => unit.kind === "emulatorjs-file").slice(0, emulatorJsBatchSize);
    return batch.sort((left, right) => unitBytes(right) - unitBytes(left));
  };

  // Pumps MUST run serially. Concurrent clients can take the same head unit and discard work when one removes it.
  let pumpChain: Promise<unknown> = Promise.resolve();

  const processNextUnit = async (onInterim?: (progress: WarmupProgress) => void): Promise<WarmupUnit | undefined> => {
    const units = await getQueue();
    const unit = units[0];
    if (!unit) {
      // Runtime requests can fill the queue's files before its completion marker exists.
      await finishEmulatorJsIfComplete();
      return unit;
    }
    const batch = nextBatch(units);
    const batchHead = batch[0] ?? unit;
    // Add in-flight bytes to one batch baseline so progress rises during the download.
    let onBytes: ((delta: number) => void) | undefined;
    if (onInterim) {
      const [baseline, batchCachedBytes] = await Promise.all([getReadyState(), cachedUnitBytes(batch)]);
      const detail = unitDetail(batchHead, batch.length);
      const label = unitLabel(batchHead);
      const unitTotalBytes = batch.reduce((sum, batchUnit) => sum + unitBytes(batchUnit), 0);
      // onBytes credits the batch's cached share again. Remove it from the baseline so cachedBytes stays monotonic.
      const baseCachedBytes = Math.max(0, baseline.cachedBytes - batchCachedBytes);
      let loadedBytes = 0;
      let lastEmit = 0;
      const emit = () => {
        const unitLoadedBytes = Math.min(loadedBytes, unitTotalBytes || loadedBytes);
        onInterim({
          ...baseline,
          cachedBytes: Math.min(baseCachedBytes + unitLoadedBytes, baseline.totalBytes || Number.MAX_SAFE_INTEGER),
          detail,
          ready: false,
          unit: label,
          unitLoadedBytes,
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
      // Emit immediately so progress names the unit that started.
      emit();
    }
    // Remove completed files by identity because a priority bump can replace or reorder the live queue.
    await Promise.all(
      batch.map(async (batchUnit) => {
        if (batchUnit.kind === "emulatorjs-file") {
          await downloadEmulatorJsFile(batchUnit, onBytes);
          if (queue) queue = queue.filter((candidate) => candidate !== batchUnit);
        } else {
          await installGroupWith(fetchForWarmup, batchUnit.group.id, onBytes);
        }
      }),
    );
    if (batch.some((batchUnit) => batchUnit.kind === "emulatorjs-file")) await finishEmulatorJsIfComplete();
    return batchHead;
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
      // Build before reordering. The following pump awaits getQueue before it reads the queue.
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
    if (cached) {
      log("identify pack served from cache", { url: requestUrl.pathname });
      return cached;
    }
    const pack = identifyOptionalGroups
      .flatMap((group) => group.packs)
      .find((candidate) => new URL(candidate.url, scope).pathname === requestUrl.pathname);
    if (!pack) {
      log("identify pack is not in this worker's pack table", { url: requestUrl.pathname });
      return Response.error();
    }
    // The table matches by pathname, so log both digests to detect a page and worker revision mismatch.
    log("identify pack fetch", {
      requestedSha256: requestUrl.searchParams.get("sha256") || "none",
      tableSha256: pack.sha256,
      url: requestUrl.pathname,
    });
    // An identify run MAY fetch one pack before group installation. Keep the group marker absent and use interactive priority.
    const { request: packRequest, response } = await fetchVerifiedPack(pack, scope, fetchForInteractive);
    await cache.put(packRequest, response.clone());
    return response;
  };

  return {
    bumpPriority,
    getCachedFiles,
    getIdentifyGroupState,
    getReadyState,
    installIdentifyGroup,
    runNextUnit,
    serveOptionalIdentifyPack,
    setIdentifyGroupWanted,
  };
};

export { createOfflineWarmup };
export type { OfflineCachedFile, OfflineReadyState, WarmupBumpTarget, WarmupProgress };
