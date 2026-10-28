import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadIdentifyPackSelection, resetIdentifyPackCache } from "../../src/platform/browser/identify-packs.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { resetRomWeaverRunner, warmupRomWeaverRunner } from "../../src/workers/rom-weaver/rom-weaver-runner.ts";

const PACK = {
  file: "nintendo-game-boy-advance.pack",
  platform: "Nintendo Game Boy Advance",
  rawBytes: 3,
  sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  slug: "nintendo-game-boy-advance",
  source: "opengood",
};
const ROM = new File(["ORIGINAL-ROM\n"], "game.bin");
const PATCH = new File(
  [new Uint8Array([0x50, 0x41, 0x54, 0x43, 0x48, 0, 0, 1, 0, 1, 0x58, 0x45, 0x4f, 0x46])],
  "change.ips",
);
const releases = [];
const BOUND_MS = 5000;
const runs = [];

// Models the service worker too: it returns no headers until the whole pack is downloaded.
const interceptPacks = (mode) => {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const requests = [];
  const fetchMock = vi.fn(async (input, options) => {
    const url = new URL(String(input), location.href);
    if (url.pathname.includes("identify-index")) {
      return Response.json({ format: "rom-weaver-identify-system-pack-v1", systems: [PACK] });
    }
    if (url.pathname.includes("identify-catalog")) {
      return Response.json({ format: "rom-weaver-identify-catalog-v1", platforms: [] });
    }
    if (!url.pathname.endsWith(PACK.file)) return nativeFetch(input, options);
    requests.push(options?.signal);
    if (mode === "headers") {
      return new Promise((resolve) => releases.push(() => resolve(new Response("abc"))));
    }
    if (mode === "slow-headers") {
      return new Promise((resolve) => setTimeout(() => resolve(new Response("abc")), 7000));
    }
    return new Response(
      new ReadableStream({
        start(controller) {
          releases.push(() => {
            controller.enqueue(new TextEncoder().encode("abc"));
            controller.close();
          });
        },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests };
};

const startIngest = () => {
  let ingested;
  const pending = browserRuntime.ingest.run({
    checksumAlgorithms: ["crc32", "sha256"],
    fileName: ROM.name,
    source: ROM,
  });
  runs.push(pending);
  void pending.then(
    (result) => (ingested = result),
    (error) => (ingested = { error }),
  );
  return { result: () => ingested };
};

beforeEach(async () => {
  resetIdentifyPackCache();
  await warmupRomWeaverRunner();
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(runs.splice(0));
  vi.unstubAllGlobals();
  resetIdentifyPackCache();
  await resetRomWeaverRunner();
});

test.each(["headers", "body"])(
  "stalled pack %s cannot block local checksums and Apply",
  async (mode) => {
    const { requests } = interceptPacks(mode);
    const started = performance.now();
    const ingest = startIngest();
    await expect.poll(() => ingest.result(), { timeout: 8000 }).toBeDefined();
    const ingested = ingest.result();
    expect(performance.now() - started).toBeLessThan(BOUND_MS + 3000);
    // The download is not cancelled: the fetch carries no abort signal.
    expect(requests).toEqual([undefined]);
    expect(ingested.identifyUnavailable).toContain("did not finish");
    expect(ingested.result.assets[0].checksums.crc32).toBe("c6fb1252");

    const apply = (options) =>
      browserRuntime.patch.applyPatch({
        input: ROM,
        patches: [{ patchFile: PATCH, patchFileName: PATCH.name }],
        options: { requireInputChecksumMatch: true, ...options },
      });
    const output = await apply({ validateWithChecksums: ["crc32=c6fb1252"] });
    try {
      const blob = await browserRuntime.publicOutput.getBlob(output);
      const bytes = await blob.arrayBuffer();
      expect(new TextDecoder().decode(bytes)).toBe("OXIGINAL-ROM\n");
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      expect(sha256).toBe("43b1cc171d0b795e224072752effd13400f6392d0fab8d0793373cce4b4f46fb");
    } finally {
      await output.dispose();
    }
    await expect(apply({ validateWithChecksums: ["crc32=00000000"] })).rejects.toThrow(/checksum/iu);

    const created = await browserRuntime.patch.createPatch({
      original: ROM,
      modified: new File(["OXIGINAL-ROM\n"], "modified.bin"),
      format: "bps",
      outputName: "change.bps",
    });
    try {
      const patchBlob = await browserRuntime.publicOutput.getBlob(created.output);
      const bytes = new Uint8Array(await patchBlob.arrayBuffer());
      bytes[bytes.length - 1] ^= 1;
      await expect(
        browserRuntime.patch.applyPatch({
          input: ROM,
          options: { requireInputChecksumMatch: true },
          patches: [{ patchFile: new File([bytes], "corrupt.bps"), patchFileName: "corrupt.bps" }],
        }),
      ).rejects.toThrow(/checksum/iu);
    } finally {
      await created.output.dispose();
    }

    // The late download completes after the caller moved on; nothing breaks and a later lookup reuses it.
    for (const release of releases.splice(0)) release();
    const later = await loadIdentifyPackSelection({ fileName: ROM.name });
    expect(later.packs).toHaveLength(1);
    expect(requests).toHaveLength(1);
  },
  30000,
);

test("a slow-header pack (service worker model) does not block ingest and an explicit lookup is not aborted", async () => {
  const { requests } = interceptPacks("slow-headers");
  const started = performance.now();
  const ingest = startIngest();
  await expect.poll(() => ingest.result(), { timeout: 8000 }).toBeDefined();
  expect(performance.now() - started).toBeLessThan(7000);
  expect(ingest.result().identifyUnavailable).toContain("did not finish");
  expect(ingest.result().result.assets[0].checksums.crc32).toBe("c6fb1252");
  const explicit = await loadIdentifyPackSelection({ fileName: ROM.name });
  expect(explicit.packs).toHaveLength(1);
  expect(requests).toHaveLength(1);
}, 30000);

test("an explicit lookup waits past the ingest bound for a slow pack", async () => {
  interceptPacks("slow-headers");
  const started = performance.now();
  const selection = await loadIdentifyPackSelection({ fileName: ROM.name });
  expect(selection.packs).toHaveLength(1);
  expect(performance.now() - started).toBeGreaterThan(BOUND_MS);
}, 30000);

test("Identify-page ingest waits past the bound for slow packs while default ingest stays bounded", async () => {
  interceptPacks("slow-headers");
  const { identifyRom } = await import("../../src/platform/browser/browser-api.ts");
  const started = performance.now();
  // The stub pack is not a real database, so the engine may reject it; what matters is that the
  // lookup was awaited past the bound instead of being reported as an unfinished (unavailable) load.
  const outcome = await identifyRom(ROM, ROM.name).then(
    (identified) => ({ identified }),
    (error) => ({ error }),
  );
  expect(performance.now() - started).toBeGreaterThan(BOUND_MS);
  expect(outcome.identified?.unavailableReason ?? String(outcome.error ?? "")).not.toContain("did not finish");
  resetIdentifyPackCache();
  interceptPacks("slow-headers");
  const bounded = startIngest();
  await expect.poll(() => bounded.result(), { timeout: 8000 }).toBeDefined();
  expect(bounded.result().identifyUnavailable).toContain("did not finish");
}, 40000);

test("a corrupt pack is rejected and a later lookup retries", async () => {
  let body = "xyz";
  stubFetch({
    "identify-index": indexResponse,
    "identify-catalog": catalogResponse,
    [PACK.file]: () => new Response(body),
  });
  await expect(loadIdentifyPackSelection({ fileName: ROM.name })).rejects.toThrow("checksum is invalid");
  body = "abc";
  expect((await loadIdentifyPackSelection({ fileName: ROM.name })).packs).toHaveLength(1);
});

const stall = () => new Promise(() => undefined);

const stubFetch = (handlers) => {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, options) => {
      const url = new URL(String(input), location.href);
      for (const [needle, handler] of Object.entries(handlers)) {
        if (url.pathname.includes(needle)) return handler();
      }
      return nativeFetch(input, options);
    }),
  );
};

const indexResponse = () => Response.json({ format: "rom-weaver-identify-system-pack-v1", systems: [PACK] });
const catalogResponse = () => Response.json({ format: "rom-weaver-identify-catalog-v1", platforms: [] });

test.each(["identify-index", "identify-catalog"])(
  "a stalled %s degrades at ingest without blocking",
  async (stalled) => {
    stubFetch({
      "identify-index": indexResponse,
      "identify-catalog": catalogResponse,
      [PACK.file]: () => new Response("abc"),
      [stalled]: stall,
    });
    const started = performance.now();
    const ingest = startIngest();
    await expect.poll(() => ingest.result(), { timeout: 8000 }).toBeDefined();
    expect(performance.now() - started).toBeLessThan(BOUND_MS + 3000);
    expect(ingest.result().identifyUnavailable).toContain("did not finish");
    expect(ingest.result().result.assets[0].checksums.crc32).toBe("c6fb1252");
  },
  20000,
);

test("a failed catalog is not cached and a later lookup retries it", async () => {
  stubFetch({
    "identify-index": indexResponse,
    "identify-catalog": () => new Response("down", { status: 503 }),
    [PACK.file]: () => new Response("abc"),
  });
  await loadIdentifyPackSelection({ fileName: ROM.name });
  const catalogFetch = vi.fn(catalogResponse);
  stubFetch({
    "identify-index": indexResponse,
    "identify-catalog": catalogFetch,
    [PACK.file]: () => new Response("abc"),
  });
  await loadIdentifyPackSelection({ fileName: ROM.name });
  expect(catalogFetch).toHaveBeenCalledTimes(1);
});
