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
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
  async match(request: RequestInfo | URL) {
    const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
    const hit = this.entries.get(url);
    return hit ? hit.clone() : undefined;
  }
  async put(request: RequestInfo | URL, response: Response) {
    const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
    this.entries.set(url, response);
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

let cacheStorage: FakeCacheStorage;

beforeEach(() => {
  cacheStorage = new FakeCacheStorage();
  vi.stubGlobal("caches", cacheStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const createWarmup = async (fetcher = createFetcher()) =>
  createOfflineWarmup({
    emulatorJsCacheName: EMULATORJS_CACHE,
    emulatorJsVersion: EMULATORJS_VERSION,
    fetchForWarmup: fetcher,
    identifyOptionalCacheName: IDENTIFY_CACHE,
    identifyOptionalGroups: await buildGroups(),
    log: () => undefined,
    scope: SCOPE,
  });

describe("offline warm-up (service worker side)", () => {
  it("reports not-ready with full byte totals before any download", async () => {
    const warmup = await createWarmup();
    const state = await warmup.getReadyState();
    expect(state.ready).toBe(false);
    expect(state.totalBytes).toBe(3 + 5 + 7 + PACK_BODY.length);
    expect(state.cachedBytes).toBe(0);
    expect(state.pendingUnits).toBe(4);
  });

  it("pumps units to completion, writes markers, and flips ready", async () => {
    const warmup = await createWarmup();
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
    const first = await createWarmup();
    while (!(await first.runNextUnit()).ready) {
      // drain
    }
    const second = await createWarmup();
    const state = await second.getReadyState();
    expect(state.ready).toBe(true);
    expect(state.pendingUnits).toBe(0);
  });

  it("lists cached files without internal completion markers", async () => {
    const warmup = await createWarmup();
    await warmup.runNextUnit();
    await warmup.runNextUnit();
    const runtimeCache = await cacheStorage.open("rom-weaver-runtime");
    await runtimeCache.put("https://example.test/__rom-weaver-coep-mode__", new Response("credentialless"));

    expect(await warmup.getCachedFiles()).toEqual([
      { cache: EMULATORJS_CACHE, url: "https://example.test/emulatorjs/data/cores/core.wasm" },
      { cache: EMULATORJS_CACHE, url: "https://example.test/emulatorjs/data/loader.js" },
    ]);
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
    const warmup = await createWarmup();
    // Build the queue: the first pump takes the first emulatorjs file.
    expect((await warmup.runNextUnit()).unit).toBe("emulatorjs:loader.js");
    warmup.bumpPriority({ groupIds: ["optional-computers"], kind: "identify-groups" });
    // Without the bump the next unit would be emulatorjs:cores/core.wasm.
    expect((await warmup.runNextUnit()).unit).toBe("identify-group:optional-computers");
    expect((await warmup.runNextUnit()).unit).toBe("emulatorjs:cores/core.wasm");
  });

  it("streams interim byte progress with the in-flight unit's name and size", async () => {
    const warmup = await createWarmup();
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

  it("counts a partially cached group's packs without its marker", async () => {
    const warmup = await createWarmup();
    const groups = await buildGroups();
    const packUrl = new URL(groups[0].packs[0].url, SCOPE).href;
    await warmup.serveOptionalIdentifyPack(new Request(packUrl));
    const state = await warmup.getReadyState();
    expect(state.ready).toBe(false);
    expect(state.cachedFiles).toBe(1);
    expect(state.cachedBytes).toBe(PACK_BODY.length);
  });

  it("serializes concurrent pumps so no unit is skipped", async () => {
    const warmup = await createWarmup();
    const [first, second] = await Promise.all([warmup.runNextUnit(), warmup.runNextUnit()]);
    expect(first.unit).toBe("emulatorjs:loader.js");
    expect(second.unit).toBe("emulatorjs:cores/core.wasm");
    let progress = await warmup.runNextUnit();
    progress = await warmup.runNextUnit();
    expect(progress.ready).toBe(true);
    expect(progress.cachedBytes).toBe(progress.totalBytes);
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
