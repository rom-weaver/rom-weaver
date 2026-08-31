import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOfflineWarmup } from "../../src/webapp/offline-warmup.ts";

const SCOPE = "https://example.test/";
const EMULATORJS_CACHE = "emulatorjs-4.2.3";
const IDENTIFY_CACHE = "identify-optional";
const EMULATORJS_VERSION = "4.2.3";

const sha256Hex = async (text: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

class FakeCache {
  entries = new Map<string, Response>();
  keysCallCount = 0;
  matchCallCount = 0;
  async keys() {
    this.keysCallCount += 1;
    return [...this.entries.keys()].map((url) => new Request(url));
  }
  async match(request: RequestInfo | URL) {
    this.matchCallCount += 1;
    const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
    const hit = this.entries.get(url);
    return hit ? hit.clone() : undefined;
  }
  async put(request: RequestInfo | URL, response: Response) {
    const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
    this.entries.set(url, response);
  }
  async delete(request: RequestInfo | URL) {
    const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
    return this.entries.delete(url);
  }
}

class FakeCacheStorage {
  caches = new Map<string, FakeCache>();
  async keys() {
    return [...this.caches.keys()];
  }
  async open(name: string) {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return cache as unknown as Cache;
  }
}

const manifest = {
  version: EMULATORJS_VERSION,
  files: [
    { path: "loader.js", sizeBytes: 3 },
    { path: "cores/core.wasm", sizeBytes: 5 },
    { path: "cores/extra.data", sizeBytes: 7 },
  ],
};

const PACK_BODY = "pack-bytes";

const buildGroups = async () => [
  {
    id: "optional-computers",
    label: "Computers",
    packs: [
      {
        sha256: await sha256Hex(PACK_BODY),
        sizeBytes: PACK_BODY.length,
        url: `assets/identify-computers.pack?sha256=${await sha256Hex(PACK_BODY)}`,
      },
    ],
  },
];

const createFetcher = () =>
  vi.fn(async (input: Request | string) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.endsWith("emulatorjs/manifest.json")) return Response.json(manifest);
    if (url.includes("emulatorjs/data/")) return new Response("emulatorjs-asset");
    if (url.includes("identify-computers.pack")) return new Response(PACK_BODY);
    return new Response("missing", { status: 404 });
  });

/** URLs a fetcher was called with; the warm-up passes a Request for packs. */
const fetchedUrls = (fetcher: ReturnType<typeof createFetcher>) =>
  fetcher.mock.calls.map(([input]) => (typeof input === "string" ? input : input.url));

let cacheStorage: FakeCacheStorage;

beforeEach(() => {
  cacheStorage = new FakeCacheStorage();
  vi.stubGlobal("caches", cacheStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const createWarmup = async (
  fetcher = createFetcher(),
  options: Partial<Parameters<typeof createOfflineWarmup>[0]> = {},
) =>
  createOfflineWarmup({
    emulatorJsCacheName: EMULATORJS_CACHE,
    emulatorJsVersion: EMULATORJS_VERSION,
    fetchForWarmup: fetcher,
    identifyOptionalCacheName: IDENTIFY_CACHE,
    identifyOptionalGroups: await buildGroups(),
    log: () => undefined,
    scope: SCOPE,
    ...options,
  });

/** One file per pump, for tests that assert queue ordering. */
const createSerialWarmup = async (fetcher = createFetcher()) => createWarmup(fetcher, { emulatorJsBatchSize: 1 });

/**
 * Optional groups are opt-in, so a test that expects one to download has to
 * tick it first - the same act the settings checkbox performs.
 */
const createWarmupWithOptionalGroup = async (
  fetcher = createFetcher(),
  options: Partial<Parameters<typeof createOfflineWarmup>[0]> = {},
) => {
  const warmup = await createWarmup(fetcher, options);
  await warmup.setIdentifyGroupWanted("optional-computers", true);
  return warmup;
};

describe("offline warm-up (service worker side)", () => {
  it("always warms a required group and never offers it as a choice", async () => {
    const fetcher = createFetcher();
    const warmup = await createWarmup(fetcher, {
      identifyOptionalGroups: [{ ...(await buildGroups())[0], id: "default", label: "Built-in", required: true }],
    });
    // Settings only lists groups a user may actually turn off.
    expect(await warmup.getIdentifyGroupState()).toEqual([]);
    await expect(warmup.setIdentifyGroupWanted("default", false)).rejects.toThrow("always kept offline");

    // It is queued and counted without anyone ticking anything.
    expect((await warmup.getReadyState()).totalBytes).toBe(3 + 5 + 7 + PACK_BODY.length);
    while (!(await warmup.runNextUnit()).ready) {
      // drain
    }
    expect(fetchedUrls(fetcher).some((url) => url.includes("identify-computers.pack"))).toBe(true);
  });

  it("leaves optional groups out of the warm-up until they are ticked", async () => {
    const fetcher = createFetcher();
    const warmup = await createWarmup(fetcher);
    // Drain: only the emulatorjs files are queued, never the optional group.
    const units: Array<string | null> = [];
    for (let pump = 0; pump < 6; pump += 1) units.push((await warmup.runNextUnit()).unit);
    expect(units.filter((unit) => unit?.startsWith("identify-group:"))).toEqual([]);
    expect(fetchedUrls(fetcher).some((url) => url.includes("identify-computers.pack"))).toBe(false);

    // An untouched optional group is not part of the offline set, so a finished
    // emulatorjs warm-up is genuinely ready.
    const state = await warmup.getReadyState();
    expect(state.ready).toBe(true);
    expect(state.totalBytes).toBe(3 + 5 + 7);
  });

  it("downloads a group once it is ticked and forgets it when unticked", async () => {
    const warmup = await createWarmup();
    let groups = await warmup.getIdentifyGroupState();
    expect(groups).toEqual([
      {
        id: "optional-computers",
        installed: false,
        label: "Computers",
        packs: 1,
        sizeBytes: PACK_BODY.length,
        wanted: false,
      },
    ]);

    groups = await warmup.setIdentifyGroupWanted("optional-computers", true);
    expect(groups[0]?.wanted).toBe(true);
    expect((await warmup.getReadyState()).totalBytes).toBe(3 + 5 + 7 + PACK_BODY.length);
    while (!(await warmup.runNextUnit()).ready) {
      // drain
    }
    expect((await warmup.getIdentifyGroupState())[0]?.installed).toBe(true);

    // Unticking deletes the packs and the marker, and drops the group from the totals.
    groups = await warmup.setIdentifyGroupWanted("optional-computers", false);
    expect(groups[0]).toMatchObject({ installed: false, wanted: false });
    const identifyCache = cacheStorage.caches.get(IDENTIFY_CACHE);
    expect([...(identifyCache?.entries.keys() ?? [])].some((url) => url.includes("identify-computers.pack"))).toBe(
      false,
    );
    expect((await warmup.getReadyState()).totalBytes).toBe(3 + 5 + 7);
  });

  it("keeps an already-installed group ticked when the opt-in list is first read", async () => {
    const first = await createWarmup();
    // Simulate the pre-opt-in world: the group was installed with no wanted list.
    await first.installIdentifyGroup("optional-computers");
    const identifyCache = cacheStorage.caches.get(IDENTIFY_CACHE);
    identifyCache?.entries.delete("https://example.test/__rom-weaver-identify-wanted__");

    const second = await createWarmup();
    expect((await second.getIdentifyGroupState())[0]).toMatchObject({ installed: true, wanted: true });
  });

  it("counts the app's own precache into the totals", async () => {
    const warmup = await createWarmupWithOptionalGroup(createFetcher(), {
      precacheState: async () => ({ cachedBytes: 40, cachedFiles: 2, totalBytes: 100, totalFiles: 5 }),
    });
    const state = await warmup.getReadyState();
    expect(state.totalBytes).toBe(100 + 3 + 5 + 7 + PACK_BODY.length);
    expect(state.cachedBytes).toBe(40);
    expect(state.totalFiles).toBe(5 + manifest.files.length + 1);
    expect(state.cachedFiles).toBe(2);
  });

  it("leaves the precache out of the totals when its state cannot be read", async () => {
    const warmup = await createWarmupWithOptionalGroup(createFetcher(), {
      precacheState: async () => {
        throw new Error("sizes unavailable");
      },
    });
    const state = await warmup.getReadyState();
    expect(state.totalBytes).toBe(3 + 5 + 7 + PACK_BODY.length);
    expect(state.cachedBytes).toBe(0);
  });

  it("reports not-ready with full byte totals before any download", async () => {
    const warmup = await createWarmupWithOptionalGroup();
    const state = await warmup.getReadyState();
    expect(state.ready).toBe(false);
    expect(state.totalBytes).toBe(3 + 5 + 7 + PACK_BODY.length);
    expect(state.cachedBytes).toBe(0);
    expect(state.pendingUnits).toBe(4);
  });

  it("reads each partial cache inventory once per ready-state snapshot", async () => {
    const warmup = await createWarmupWithOptionalGroup();
    const identifyCacheBefore = cacheStorage.caches.get(IDENTIFY_CACHE);
    const identifyMatchesBefore = identifyCacheBefore?.matchCallCount ?? 0;
    await warmup.getReadyState();
    const emulatorJsCache = cacheStorage.caches.get(EMULATORJS_CACHE);
    const identifyCache = cacheStorage.caches.get(IDENTIFY_CACHE);
    expect(emulatorJsCache?.keysCallCount).toBe(1);
    expect(emulatorJsCache?.matchCallCount).toBe(1);
    expect(identifyCache?.keysCallCount).toBe(1);
    // One marker read per group. The opt-in list is memoised by the ticking
    // above, so a snapshot does not re-read it.
    expect((identifyCache?.matchCallCount ?? 0) - identifyMatchesBefore).toBe(1);
  });

  it("pumps units to completion, writes markers, and flips ready", async () => {
    const warmup = await createSerialWarmup();
    await warmup.setIdentifyGroupWanted("optional-computers", true);
    let progress = await warmup.runNextUnit();
    expect(progress.unit).toBe("emulatorjs:loader.js");
    expect(progress.ready).toBe(false);
    progress = await warmup.runNextUnit();
    expect(progress.unit).toBe("emulatorjs:cores/core.wasm");
    progress = await warmup.runNextUnit();
    expect(progress.unit).toBe("emulatorjs:cores/extra.data");
    progress = await warmup.runNextUnit();
    expect(progress.unit).toBe("identify-group:optional-computers");
    expect(progress.ready).toBe(true);
    expect(progress.cachedBytes).toBe(progress.totalBytes);

    const emulatorCache = cacheStorage.caches.get(EMULATORJS_CACHE);
    const marker = await emulatorCache?.match(`${SCOPE.replace(/\/$/, "")}/__rom-weaver-emulatorjs-complete__`);
    expect(await marker?.text()).toBe(EMULATORJS_VERSION);
  });

  it("derives ready across a restart from cache contents alone", async () => {
    const first = await createWarmupWithOptionalGroup();
    while (!(await first.runNextUnit()).ready) {
      // drain
    }
    const second = await createWarmup();
    const state = await second.getReadyState();
    expect(state.ready).toBe(true);
    expect(state.pendingUnits).toBe(0);
  });

  it("reports a transfer size for every entry a header or the encoding can settle", async () => {
    const warmup = await createWarmup();
    const cache = await cacheStorage.open("rom-weaver-runtime");
    await cache.put(
      "https://example.test/stamped.html",
      new Response("0123456789", { headers: { "content-encoding": "br", "x-rom-weaver-encoded-size": "4" } }),
    );
    await cache.put(
      "https://example.test/with-length.js",
      new Response("0123456789", { headers: { "content-encoding": "gzip", "content-length": "6" } }),
    );
    await cache.put("https://example.test/identity.css", new Response("0123456789"));
    await cache.put(
      "https://example.test/unmeasured.html",
      new Response("0123456789", { headers: { "content-encoding": "br" } }),
    );

    const sizes = Object.fromEntries(
      (await warmup.getCachedFiles()).map((file) => [new URL(file.url).pathname, file.compressedBytes]),
    );
    expect(sizes).toEqual({
      "/identity.css": 10,
      "/stamped.html": 4,
      "/unmeasured.html": null,
      "/with-length.js": 6,
    });
  });

  it("lists cached files with sizes and without internal completion markers", async () => {
    const warmup = await createSerialWarmup();
    await warmup.runNextUnit();
    await warmup.runNextUnit();
    const runtimeCache = await cacheStorage.open("rom-weaver-runtime");
    await runtimeCache.put("https://example.test/__rom-weaver-coep-mode__", new Response("credentialless"));

    const measured: number[] = [];
    const files = await warmup.getCachedFiles(() => measured.push(1));
    // The fake responses carry no Content-Length and no Content-Encoding, so
    // they were transferred exactly as they are stored.
    expect(files).toEqual([
      {
        cache: EMULATORJS_CACHE,
        compressedBytes: 16,
        sizeBytes: 16,
        url: "https://example.test/emulatorjs/data/cores/core.wasm",
      },
      {
        cache: EMULATORJS_CACHE,
        compressedBytes: 16,
        sizeBytes: 16,
        url: "https://example.test/emulatorjs/data/loader.js",
      },
    ]);
    expect(measured).toHaveLength(2);
  });

  it("treats a new emulatorjs version as not ready", async () => {
    const first = await createWarmup();
    while (!(await first.runNextUnit()).ready) {
      // drain
    }
    const fetcher = createFetcher();
    const upgraded = createOfflineWarmup({
      emulatorJsCacheName: "emulatorjs-5.0.0",
      emulatorJsVersion: "5.0.0",
      fetchForWarmup: fetcher,
      identifyOptionalCacheName: IDENTIFY_CACHE,
      identifyOptionalGroups: await buildGroups(),
      log: () => undefined,
      scope: SCOPE,
    });
    const state = await upgraded.getReadyState();
    expect(state.ready).toBe(false);
  });

  it("bumps identify groups ahead of emulatorjs files", async () => {
    const warmup = await createSerialWarmup();
    await warmup.setIdentifyGroupWanted("optional-computers", true);
    // Build the queue: the first pump takes the first emulatorjs file.
    expect((await warmup.runNextUnit()).unit).toBe("emulatorjs:loader.js");
    warmup.bumpPriority({ groupIds: ["optional-computers"], kind: "identify-groups" });
    // Without the bump the next unit would be emulatorjs:cores/core.wasm.
    expect((await warmup.runNextUnit()).unit).toBe("identify-group:optional-computers");
    expect((await warmup.runNextUnit()).unit).toBe("emulatorjs:cores/core.wasm");
  });

  it("streams interim byte progress with the in-flight unit's name and size", async () => {
    const warmup = await createSerialWarmup();
    await warmup.setIdentifyGroupWanted("optional-computers", true);
    const interims: Array<{ cachedBytes: number; detail: unknown; unitLoadedBytes: number | null }> = [];
    const progress = await warmup.runNextUnit((interim) => {
      interims.push({
        cachedBytes: interim.cachedBytes,
        detail: interim.detail,
        unitLoadedBytes: interim.unitLoadedBytes,
      });
    });
    // At least the immediate start event fires, naming the unit before bytes land.
    expect(interims.length).toBeGreaterThan(0);
    expect(interims[0]).toMatchObject({ detail: { kind: "emulatorjs", name: "loader.js" } });
    expect(progress.detail).toEqual({ kind: "emulatorjs", name: "loader.js" });
    expect(progress.unitLoadedBytes).toBeNull();
    expect(progress.cachedFiles).toBe(1);
    expect(progress.totalFiles).toBe(4);
  });

  it("does not double-count a unit's already-cached bytes in interim progress", async () => {
    const warmup = await createSerialWarmup();
    await warmup.setIdentifyGroupWanted("optional-computers", true);
    const groups = await buildGroups();
    const packUrl = new URL(groups[0].packs[0].url, SCOPE).href;
    // Cache the group's only pack on demand, then warm that group first: its
    // bytes sit in both the baseline and the per-unit credit, and the interim
    // counter must still never exceed what is really cached.
    await warmup.serveOptionalIdentifyPack(new Request(packUrl));
    // Build the queue: the first pump takes the first emulatorjs file.
    expect((await warmup.runNextUnit()).unit).toBe("emulatorjs:loader.js");
    warmup.bumpPriority({ groupIds: ["optional-computers"], kind: "identify-groups" });
    const interimCachedBytes: number[] = [];
    const progress = await warmup.runNextUnit((interim) => {
      interimCachedBytes.push(interim.cachedBytes);
    });
    expect(progress.unit).toBe("identify-group:optional-computers");
    expect(interimCachedBytes.length).toBeGreaterThan(0);
    for (const cachedBytes of interimCachedBytes) {
      expect(cachedBytes).toBeLessThanOrEqual(progress.cachedBytes);
    }
    expect(progress.cachedBytes).toBe(3 + PACK_BODY.length);
  });

  it("counts a partially cached group's packs without its marker", async () => {
    const warmup = await createWarmupWithOptionalGroup();
    const groups = await buildGroups();
    const packUrl = new URL(groups[0].packs[0].url, SCOPE).href;
    await warmup.serveOptionalIdentifyPack(new Request(packUrl));
    const state = await warmup.getReadyState();
    expect(state.ready).toBe(false);
    expect(state.cachedFiles).toBe(1);
    expect(state.cachedBytes).toBe(PACK_BODY.length);
  });

  it("serializes concurrent pumps so no unit is skipped", async () => {
    const warmup = await createSerialWarmup();
    const [first, second] = await Promise.all([warmup.runNextUnit(), warmup.runNextUnit()]);
    expect(first.unit).toBe("emulatorjs:loader.js");
    expect(second.unit).toBe("emulatorjs:cores/core.wasm");
    let progress = await warmup.runNextUnit();
    progress = await warmup.runNextUnit();
    expect(progress.ready).toBe(true);
    expect(progress.cachedBytes).toBe(progress.totalBytes);
  });

  it("downloads a batch of emulatorjs files in one pump, largest first in the label", async () => {
    const warmup = await createWarmup();
    const interims: Array<{ cachedBytes: number; detail: unknown; unitTotalBytes: number | null }> = [];
    const progress = await warmup.runNextUnit((interim) => {
      interims.push({
        cachedBytes: interim.cachedBytes,
        detail: interim.detail,
        unitTotalBytes: interim.unitTotalBytes,
      });
    });
    // One pump caches every emulatorjs file and writes the completion marker.
    expect(progress.unit).toBe("emulatorjs:cores/extra.data");
    expect(progress.cachedFiles).toBe(3);
    expect(interims[0]).toMatchObject({
      detail: { kind: "emulatorjs", name: "cores/extra.data (+2)" },
      unitTotalBytes: 3 + 5 + 7,
    });
    for (const interim of interims) {
      expect(interim.cachedBytes).toBeLessThanOrEqual(progress.cachedBytes);
    }
    const emulatorCache = cacheStorage.caches.get(EMULATORJS_CACHE);
    const marker = await emulatorCache?.match(`${SCOPE.replace(/\/$/, "")}/__rom-weaver-emulatorjs-complete__`);
    expect(await marker?.text()).toBe(EMULATORJS_VERSION);
    // Only the identify group remains.
    expect((await warmup.runNextUnit()).ready).toBe(true);
  });

  it("rejects a manifest with missing sizes or unsafe paths", async () => {
    const badManifests = [
      { files: [{ path: "loader.js" }], version: EMULATORJS_VERSION },
      { files: [{ path: "../../evil.js", sizeBytes: 1 }], version: EMULATORJS_VERSION },
      { files: [{ path: "/abs.js", sizeBytes: 1 }], version: EMULATORJS_VERSION },
    ];
    for (const bad of badManifests) {
      cacheStorage = new FakeCacheStorage();
      vi.stubGlobal("caches", cacheStorage);
      const fetcher = vi.fn(async (input: Request | string) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("emulatorjs/manifest.json")) return Response.json(bad);
        if (url.includes("identify-computers.pack")) return new Response(PACK_BODY);
        return new Response("missing", { status: 404 });
      });
      const warmup = await createWarmup(fetcher);
      // The invalid manifest is rejected: no NaN totals, no fetch outside
      // emulatorjs/data/, and readiness stays false.
      const state = await warmup.getReadyState();
      expect(state.ready).toBe(false);
      expect(Number.isNaN(state.totalBytes)).toBe(false);
      const fetched = fetcher.mock.calls.map(([input]) => (typeof input === "string" ? input : input.url));
      expect(fetched.some((url) => url.includes("evil"))).toBe(false);
    }
  });

  it("serves an optional pack on demand without a group marker and verifies its checksum", async () => {
    const warmup = await createWarmup();
    const groups = await buildGroups();
    const packUrl = new URL(groups[0].packs[0].url, SCOPE).href;
    const response = await warmup.serveOptionalIdentifyPack(new Request(packUrl));
    expect(await response.text()).toBe(PACK_BODY);
    const cache = cacheStorage.caches.get(IDENTIFY_CACHE);
    expect(await cache?.match(packUrl)).toBeDefined();
    // The group marker is written only by a full install, not by on-demand serves.
    const marker = await cache?.match(`${SCOPE.replace(/\/$/, "")}/__rom-weaver-identify-group__/optional-computers`);
    expect(marker).toBeUndefined();
  });

  it("rejects an optional pack whose checksum does not match", async () => {
    const fetcher = vi.fn(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("identify-computers.pack")) return new Response("tampered-bytes");
      return new Response("missing", { status: 404 });
    });
    const warmup = await createWarmup(fetcher);
    const groups = await buildGroups();
    const packUrl = new URL(groups[0].packs[0].url, SCOPE).href;
    await expect(warmup.serveOptionalIdentifyPack(new Request(packUrl))).rejects.toThrow(/checksum/);
  });

  it("installIdentifyGroup writes the group marker with the pack revision", async () => {
    const warmup = await createWarmup();
    const result = await warmup.installIdentifyGroup("optional-computers");
    expect(result).toMatchObject({ id: "optional-computers", installed: true, packs: 1 });
    const cache = cacheStorage.caches.get(IDENTIFY_CACHE);
    const marker = await cache?.match(`${SCOPE.replace(/\/$/, "")}/__rom-weaver-identify-group__/optional-computers`);
    expect(marker).toBeDefined();
  });
});
