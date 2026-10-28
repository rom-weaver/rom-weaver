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
const runs = [];

const interceptPacks = (mode) => {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const signals = [];
  let packBody;
  const fetchMock = vi.fn(async (input, options) => {
    const url = new URL(String(input), location.href);
    if (url.pathname.includes("identify-index")) {
      return Response.json({ format: "rom-weaver-identify-system-pack-v1", systems: [PACK] });
    }
    if (url.pathname.includes("identify-catalog")) {
      return Response.json({ format: "rom-weaver-identify-catalog-v1", platforms: [] });
    }
    if (!url.pathname.endsWith(PACK.file)) return nativeFetch(input, options);
    if (packBody !== undefined) return new Response(packBody);
    const signal = options?.signal;
    signals.push(signal);
    if (mode === "headers") {
      return new Promise((resolve, reject) => {
        releases.push(() => resolve(new Response("unavailable", { status: 503 })));
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return new Response(
      new ReadableStream({
        start(controller) {
          let closed = false;
          const fail = (reason) => {
            if (closed) return;
            closed = true;
            controller.error(reason);
          };
          releases.push(() => fail(new Error("test cleanup")));
          signal?.addEventListener("abort", () => fail(signal.reason), { once: true });
        },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return { signals, respondWith: (body) => (packBody = body) };
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

test.each(["headers", "body"])("stalled pack %s cannot block local checksums and Apply", async (mode) => {
  const { signals, respondWith } = interceptPacks(mode);
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
  await expect.poll(() => signals.length).toBe(1);
  const sharedLookup = loadIdentifyPackSelection({ fileName: ROM.name }).catch((error) => error);
  runs.push(sharedLookup);
  await expect.poll(() => ingested, { timeout: 8000 }).toBeDefined();
  expect(await sharedLookup).toHaveProperty("name", "IdentifyDataUnavailableError");
  expect(signals).toHaveLength(1);
  expect(signals[0].aborted).toBe(true);
  expect(ingested.identifyUnavailable).toContain("timed out");
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

  respondWith("xyz");
  await expect(loadIdentifyPackSelection({ fileName: ROM.name })).rejects.toThrow("checksum is invalid");
  respondWith("abc");
  expect((await loadIdentifyPackSelection({ fileName: ROM.name })).packs).toHaveLength(1);
});
