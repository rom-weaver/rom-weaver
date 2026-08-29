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
  pendingUnits: number;
  ready: boolean;
  totalBytes: number;
};

type WarmupProgress = OfflineReadyState & {
  unit: string | null;
};

type EmulatorJsManifest = {
  version: string;
  files: Array<{ path: string; sizeBytes: number }>;
};

type OfflineWarmupOptions = {
  emulatorJsCacheName: string;
  emulatorJsVersion: string;
  fetchForWarmup: (request: Request | string, init?: RequestInit) => Promise<Response>;
  identifyOptionalCacheName: string;
  identifyOptionalGroups: IdentifyOptionalPackGroup[];
  log: (message: string, details?: Record<string, unknown>) => void;
  scope: string;
};

type OfflineWarmup = {
  bumpPriority: (target: WarmupBumpTarget) => void;
  getReadyState: () => Promise<OfflineReadyState>;
  installIdentifyGroup: (groupId: string) => Promise<{ id: string; installed: true; label: string; packs: number }>;
  runNextUnit: () => Promise<WarmupProgress>;
  serveOptionalIdentifyPack: (request: Request) => Promise<Response>;
};

const EMULATORJS_COMPLETE_MARKER_PATH = "/__rom-weaver-emulatorjs-complete__";

const optionalGroupMarkerUrl = (scope: string, groupId: string) =>
  new URL(`/__rom-weaver-identify-group__/${groupId}`, scope).href;

const optionalGroupRevision = (group: IdentifyOptionalPackGroup) =>
  group.packs.map((pack) => `${pack.url}:${pack.sha256}`).join("\n");

const sha256HexOf = async (bytes: ArrayBuffer) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Fetch one pack, verify its SHA-256, and return the request/response pair ready to cache. */
const fetchVerifiedPack = async (
  pack: IdentifyOptionalPack,
  scope: string,
  fetchForWarmup: OfflineWarmupOptions["fetchForWarmup"],
) => {
  const request = new Request(new URL(pack.url, scope));
  const response = await fetchForWarmup(request);
  if (!response.ok) throw new Error(`ROM identify pack download failed with HTTP ${response.status}`);
  const actualSha256 = await sha256HexOf(await response.clone().arrayBuffer());
  if (actualSha256 !== pack.sha256) throw new Error(`ROM identify pack checksum failed: ${pack.url}`);
  return { request, response };
};

const createOfflineWarmup = ({
  emulatorJsCacheName,
  emulatorJsVersion,
  fetchForWarmup,
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
        const manifest = (await response.json()) as EmulatorJsManifest;
        if (typeof manifest?.version !== "string" || !Array.isArray(manifest.files)) {
          throw new Error("EmulatorJS manifest is invalid");
        }
        return manifest;
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

  /** Sum of sizeBytes for emulatorjs manifest files already in the cache. */
  const cachedEmulatorJsBytes = async (cache: Cache, manifest: EmulatorJsManifest) => {
    let bytes = 0;
    for (const file of manifest.files) {
      if (await cache.match(emulatorJsAssetUrl(file.path))) bytes += file.sizeBytes;
    }
    return bytes;
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
    let pendingUnits = 0;
    let emulatorJsReady = await isEmulatorJsComplete(emulatorJsCache);
    try {
      const manifest = await loadEmulatorJsManifest();
      const manifestBytes = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
      totalBytes += manifestBytes;
      if (emulatorJsReady) cachedBytes += manifestBytes;
      else {
        const cached = await cachedEmulatorJsBytes(emulatorJsCache, manifest);
        cachedBytes += cached;
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
      if (await isGroupInstalled(identifyCache, group)) cachedBytes += bytes;
      else pendingUnits += 1;
    }
    const ready = emulatorJsReady && pendingUnits === 0;
    return { cachedBytes, pendingUnits, ready, totalBytes };
  };

  const installIdentifyGroup = async (groupId: string) => {
    const group = identifyOptionalGroups.find((candidate) => candidate.id === groupId);
    if (!group) throw new Error(`Unknown ROM identify pack group: ${groupId}`);
    const cache = await caches.open(identifyOptionalCacheName);
    // Sequential on purpose: group installs also run as low-priority warm-up
    // units and MUST NOT open one connection per pack.
    for (const pack of group.packs) {
      if (await cache.match(new URL(pack.url, scope).href)) continue;
      const { request, response } = await fetchVerifiedPack(pack, scope, fetchForWarmup);
      await cache.put(request, response);
    }
    await cache.put(optionalGroupMarkerUrl(scope, group.id), new Response(optionalGroupRevision(group)));
    if (queue) queue = queue.filter((unit) => !(unit.kind === "identify-group" && unit.group.id === group.id));
    return { id: group.id, installed: true as const, label: group.label, packs: group.packs.length };
  };

  const downloadEmulatorJsFile = async (unit: Extract<WarmupUnit, { kind: "emulatorjs-file" }>) => {
    const cache = await caches.open(emulatorJsCacheName);
    const url = emulatorJsAssetUrl(unit.path);
    if (!(await cache.match(url))) {
      const response = await fetchForWarmup(url);
      if (!response.ok)
        throw new Error(`EmulatorJS warm-up download failed with HTTP ${response.status}: ${unit.path}`);
      await cache.put(url, response);
    }
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

  const runNextUnit = async (): Promise<WarmupProgress> => {
    const units = await getQueue();
    const unit = units[0];
    if (unit) {
      if (unit.kind === "emulatorjs-file") {
        await downloadEmulatorJsFile(unit);
        units.shift();
        await finishEmulatorJsIfComplete();
      } else {
        await installIdentifyGroup(unit.group.id);
      }
    } else {
      // Empty queue can still mean a missing emulatorjs marker (files were
      // filled by the runtime route before the queue was built).
      await finishEmulatorJsIfComplete();
    }
    const state = await getReadyState();
    return { ...state, unit: unit ? unitLabel(unit) : null };
  };

  const bumpPriority = (target: WarmupBumpTarget) => {
    if (!queue) {
      // Queue not built yet: build it, then reorder. Fire-and-forget is fine -
      // the follow-up pump awaits getQueue() before reading it.
      void getQueue().then(() => bumpPriority(target));
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
    // a full install, so settings semantics are unchanged.
    const { request: packRequest, response } = await fetchVerifiedPack(pack, scope, fetchForWarmup);
    await cache.put(packRequest, response.clone());
    return response;
  };

  return { bumpPriority, getReadyState, installIdentifyGroup, runNextUnit, serveOptionalIdentifyPack };
};

export { createOfflineWarmup };
export type { OfflineReadyState, WarmupBumpTarget, WarmupProgress };
