// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildPackFilter,
  encodeChecksumRouter,
  parseChecksumRouter,
  routeChecksums,
} from "../../src/lib/identify/checksum-router.mjs";

const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

const system = (slug: string, platform: string) => ({
  file: `${slug}.pack`,
  platform,
  rawBytes: 3,
  brotliBytes: 3,
  brotliFile: `${slug}.pack.br`,
  sha256: SHA256_ABC,
  slug,
  source: "libretro",
});

const INDEX_SYSTEMS = [
  system("sega-32x", "Sega 32X"),
  system("sega-mega-drive-genesis", "Sega Mega Drive _ Genesis"),
  system("nintendo-game-boy", "Nintendo Game Boy"),
  system("nintendo-game-boy-color", "Nintendo Game Boy Color"),
  system("nintendo-game-boy-advance", "Nintendo Game Boy Advance"),
];

const stubFetch = (
  options: {
    index?: unknown;
    indexStatus?: number;
    packStatus?: number;
    packBody?: string;
    routerBytes?: Uint8Array;
  } = {},
) => {
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("checksum-routes.bin")) {
      if (!options.routerBytes) return new Response("nope", { status: 404 });
      return new Response(options.routerBytes);
    }
    if (url.pathname.endsWith("identify-index.json")) {
      expect(init).toEqual({ cache: "no-cache" });
      if (options.indexStatus) return new Response("nope", { status: options.indexStatus });
      return new Response(
        JSON.stringify(options.index ?? { format: "rom-weaver-identify-system-pack-v1", systems: INDEX_SYSTEMS }),
      );
    }
    if (options.packStatus) return new Response("nope", { status: options.packStatus });
    return new Response(new TextEncoder().encode(options.packBody ?? "abc"));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const sha256 = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const PS_CRC32 = "deadbeef";
const routerBytes = (slugs: string[] = ["sony-playstation", "nintendo-game-boy"]) =>
  encodeChecksumRouter(
    slugs.map((slug) =>
      buildPackFilter(
        slug,
        slug === "nintendo-game-boy"
          ? [{ algorithm: "crc32", hex: "0000ffff" }]
          : [{ algorithm: "crc32", hex: PS_CRC32 }],
      ),
    ),
  );

/** A crc32 no filter in `bytes` claims. The 1/256 false-positive rate rules out a fixed literal. */
const missingCrc32 = (bytes: Uint8Array) => {
  const router = parseChecksumRouter(bytes);
  for (let seed = 1; seed < 10_000; seed += 1) {
    const digest = seed.toString(16).padStart(8, "0");
    if (!routeChecksums(router, [digest]).length) return digest;
  }
  throw new Error("no crc32 outside the test router");
};

const routerIndex = async (bytes: Uint8Array, overrides: Record<string, unknown> = {}) => ({
  format: "rom-weaver-identify-system-pack-v1",
  checksumRoutes: {
    file: "checksum-routes.bin",
    format: "rom-weaver-identify-checksum-router-v1",
    rawBytes: bytes.length,
    sha256: await sha256(bytes),
    ...overrides,
  },
  systems: [...INDEX_SYSTEMS, system("sony-playstation", "Sony PlayStation")],
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("selectIdentifySlugs", () => {
  it("maps a ROM extension to its own pack", async () => {
    const { selectIdentifySlugs } = await import("../../src/platform/browser/identify-packs.ts");
    expect(selectIdentifySlugs({ fileName: "game.gba" })).toEqual(["nintendo-game-boy-advance"]);
    expect(selectIdentifySlugs({ fileName: "game.nes" })).toEqual(["nintendo-nintendo-entertainment-system"]);
    expect(selectIdentifySlugs({ fileName: "game.z64" })).toEqual(["nintendo-nintendo-64"]);
    expect(selectIdentifySlugs({ fileName: "game.sms" })).toEqual(["sega-master-system-mark-iii", "sega-game-gear"]);
  });

  it("widens a header-detected platform to its indistinguishable siblings", async () => {
    const { selectIdentifySlugs } = await import("../../src/platform/browser/identify-packs.ts");
    // A Game Boy Color cartridge carries a Game Boy header, so the sibling pack must stay in play.
    expect(selectIdentifySlugs({ fileName: "game.bin", platform: "Nintendo Game Boy" }).sort()).toEqual([
      "nintendo-game-boy",
      "nintendo-game-boy-color",
    ]);
  });

  it("routes a probe-detected disc platform to its pack", async () => {
    const { selectIdentifySlugs } = await import("../../src/platform/browser/identify-packs.ts");
    // The metadata-only probe of an RVZ/GCZ now reports the decoded platform,
    // so an opaque disc container still stages the right pack.
    expect(selectIdentifySlugs({ fileName: "disc.rvz", platform: "Nintendo GameCube" })).toEqual(["nintendo-gamecube"]);
  });

  it("maps every 3DS payload and compressed z3ds extension to the 3DS pack", async () => {
    const { selectIdentifySlugs } = await import("../../src/platform/browser/identify-packs.ts");
    for (const extension of ["3ds", "3dsx", "cci", "cia", "cxi", "z3ds", "z3dsx", "zcci", "zcia", "zcxi"]) {
      expect(selectIdentifySlugs({ fileName: `game.${extension}` })).toEqual(["nintendo-nintendo-3ds"]);
    }
  });

  it("infers the platform from an archive's members", async () => {
    const { selectIdentifySlugs } = await import("../../src/platform/browser/identify-packs.ts");
    expect(selectIdentifySlugs({ entryNames: ["Games/Metroid Fusion (USA).gba"], fileName: "collection.zip" })).toEqual(
      ["nintendo-game-boy-advance"],
    );
  });

  it("returns nothing it cannot narrow, so the caller keeps every pack", async () => {
    const { selectIdentifySlugs } = await import("../../src/platform/browser/identify-packs.ts");
    expect(selectIdentifySlugs({ fileName: "game.bin" })).toEqual([]);
    expect(selectIdentifySlugs({ fileName: "collection.7z" })).toEqual([]);
  });
});

describe("loadIdentifyPacks", () => {
  it("loads the current index and addresses only the selected self-hosted pack", async () => {
    const fetchMock = stubFetch();
    const { loadIdentifyPacks } = await import("../../src/platform/browser/identify-packs.ts");
    const packs = await loadIdentifyPacks({ fileName: "game.32x" });

    // 32X shares its cartridge shape with Mega Drive, so both packs load - and only those two.
    expect(packs.map((pack) => pack.slug).sort()).toEqual(["sega-32x", "sega-mega-drive-genesis"]);
    // index.json + catalog.json + the two selected packs (catalog routing added
    // the catalog fetch; the pack selection is unchanged).
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const packCall = fetchMock.mock.calls.find((call) => String(call[0]).includes(".pack"));
    const packUrl = new URL(String(packCall?.[0]));
    expect(packUrl.pathname).toContain(".pack");
    expect(packUrl.searchParams.get("sha256")).toBe(SHA256_ABC);
  });

  it("falls back to every pack when nothing narrows the input", async () => {
    stubFetch();
    const { loadIdentifyPacks } = await import("../../src/platform/browser/identify-packs.ts");
    expect(await loadIdentifyPacks({ fileName: "game.bin" })).toHaveLength(INDEX_SYSTEMS.length);
  });

  it("reports a failed index request as unavailable data", async () => {
    stubFetch({ indexStatus: 503 });
    const { IdentifyDataUnavailableError, loadIdentifyPacks } =
      await import("../../src/platform/browser/identify-packs.ts");
    await expect(loadIdentifyPacks({ fileName: "game.gba" })).rejects.toBeInstanceOf(IdentifyDataUnavailableError);
  });

  it("reports an invalid index format as unavailable data", async () => {
    stubFetch({ index: { format: "something-else", systems: [] } });
    const { IdentifyDataUnavailableError, loadIdentifyPacks } =
      await import("../../src/platform/browser/identify-packs.ts");
    await expect(loadIdentifyPacks({ fileName: "game.gba" })).rejects.toBeInstanceOf(IdentifyDataUnavailableError);
  });

  it("rejects a pack whose length does not match the index", async () => {
    stubFetch({ packBody: "abcd" });
    const { IdentifyDataUnavailableError, loadIdentifyPacks } =
      await import("../../src/platform/browser/identify-packs.ts");
    await expect(loadIdentifyPacks({ fileName: "game.gba" })).rejects.toBeInstanceOf(IdentifyDataUnavailableError);
  });

  it("rejects a pack whose SHA-256 does not match the index", async () => {
    stubFetch({ packBody: "xyz" });
    const { loadIdentifyPacks } = await import("../../src/platform/browser/identify-packs.ts");
    await expect(loadIdentifyPacks({ fileName: "game.gba" })).rejects.toThrow(/checksum is invalid/u);
  });

  it("refetches after a failure so a retry can succeed", async () => {
    stubFetch({ indexStatus: 503 });
    const { loadIdentifyPacks, resetIdentifyPackCache } = await import("../../src/platform/browser/identify-packs.ts");
    await expect(loadIdentifyPacks({ fileName: "game.gba" })).rejects.toThrow();
    resetIdentifyPackCache();
    stubFetch();
    expect(await loadIdentifyPacks({ fileName: "game.gba" })).toHaveLength(1);
  });
});

describe("optional identify pack groups", () => {
  it("asks the service worker to install the complete optional computer group", async () => {
    stubFetch({
      index: {
        format: "rom-weaver-identify-system-pack-v1",
        groups: [
          {
            default: false,
            id: "optional-computers",
            label: "Computers and DOS",
            systems: ["microsoft-ms-dos"],
          },
        ],
        systems: [...INDEX_SYSTEMS, system("microsoft-ms-dos", "Microsoft MS-DOS")],
      },
    });
    const postMessage = vi.fn((message: unknown, ports: MessagePort[]) => {
      ports[0].postMessage({ action: "identify-pack-group-installed" });
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { controller: { postMessage } },
    });
    const { installIdentifyPackGroup, listOptionalIdentifyPackGroups } =
      await import("../../src/platform/browser/identify-packs.ts");
    expect((await listOptionalIdentifyPackGroups()).map(({ id }) => id)).toEqual(["optional-computers"]);
    await installIdentifyPackGroup("optional-computers");
    expect(postMessage).toHaveBeenCalledWith(
      { action: "install-identify-pack-group", groupId: "optional-computers" },
      expect.any(Array),
    );
  });
});

describe("checksum routing", () => {
  it("routes a bare checksum to the disc pack that may hold it", async () => {
    const bytes = routerBytes();
    const fetchMock = stubFetch({ index: await routerIndex(bytes), routerBytes: bytes });
    const { loadIdentifyPacks } = await import("../../src/platform/browser/identify-packs.ts");

    const packs = await loadIdentifyPacks({ checksums: { crc32: PS_CRC32 } });

    expect(packs.map((pack) => pack.slug)).toEqual(["sony-playstation"]);
    const routerUrl = new URL(String(fetchMock.mock.calls.find((call) => String(call[0]).includes(".bin"))?.[0]));
    expect(routerUrl.pathname).toBe("/assets/identify-checksum-routes.bin");
    expect(routerUrl.searchParams.get("sha256")).toBe(await sha256(bytes));
  });

  it("returns an empty selection when no filter claims the checksum", async () => {
    const bytes = routerBytes();
    stubFetch({ index: await routerIndex(bytes), routerBytes: bytes });
    const { loadIdentifyPackSelection } = await import("../../src/platform/browser/identify-packs.ts");

    expect(await loadIdentifyPackSelection({ checksums: { crc32: missingCrc32(bytes) } })).toEqual({ packs: [] });
  });

  it("keeps the cartridge fallback for a file with no hint and no checksum", async () => {
    const bytes = routerBytes();
    stubFetch({ index: await routerIndex(bytes), routerBytes: bytes });
    const { loadIdentifyPacks } = await import("../../src/platform/browser/identify-packs.ts");

    const packs = await loadIdentifyPacks({ fileName: "game.bin" });

    expect(packs.length).toBe(INDEX_SYSTEMS.length);
    expect(packs.map((pack) => pack.slug)).not.toContain("sony-playstation");
  });

  it("keeps the cartridge fallback for digests the router cannot answer for", async () => {
    const bytes = routerBytes();
    const fetchMock = stubFetch({ index: await routerIndex(bytes), routerBytes: bytes });
    const { loadIdentifyPacks } = await import("../../src/platform/browser/identify-packs.ts");

    const packs = await loadIdentifyPacks({ checksums: { crc32: "1234567", sha256: "ab".repeat(32) } });

    expect(packs.length).toBe(INDEX_SYSTEMS.length);
    const routerFetches = fetchMock.mock.calls.filter(([url]) => String(url).includes("checksum-routes.bin"));
    expect(routerFetches).toHaveLength(0);
  });

  it("reports a router size mismatch as unavailable data", async () => {
    const bytes = routerBytes();
    stubFetch({ index: await routerIndex(bytes, { rawBytes: bytes.length + 1 }), routerBytes: bytes });
    const { IdentifyDataUnavailableError, loadIdentifyPacks } =
      await import("../../src/platform/browser/identify-packs.ts");

    await expect(loadIdentifyPacks({ checksums: { crc32: PS_CRC32 } })).rejects.toBeInstanceOf(
      IdentifyDataUnavailableError,
    );
  });

  it("reports a router with an unknown format as unavailable data", async () => {
    const bytes = routerBytes();
    stubFetch({
      index: await routerIndex(bytes, { format: "rom-weaver-identify-checksum-router-v0" }),
      routerBytes: bytes,
    });
    const { IdentifyDataUnavailableError, loadIdentifyPacks } =
      await import("../../src/platform/browser/identify-packs.ts");

    await expect(loadIdentifyPacks({ checksums: { crc32: PS_CRC32 } })).rejects.toBeInstanceOf(
      IdentifyDataUnavailableError,
    );
  });

  it("reports a router SHA-256 mismatch as unavailable data", async () => {
    const bytes = routerBytes();
    stubFetch({ index: await routerIndex(bytes, { sha256: SHA256_ABC }), routerBytes: bytes });
    const { loadIdentifyPacks } = await import("../../src/platform/browser/identify-packs.ts");

    await expect(loadIdentifyPacks({ checksums: { crc32: PS_CRC32 } })).rejects.toThrow(/checksum is invalid/u);
  });

  it("reports a router that names an unknown pack as unavailable data", async () => {
    const bytes = routerBytes(["not-a-real-system"]);
    stubFetch({ index: await routerIndex(bytes), routerBytes: bytes });
    const { loadIdentifyPacks } = await import("../../src/platform/browser/identify-packs.ts");

    await expect(loadIdentifyPacks({ checksums: { crc32: PS_CRC32 } })).rejects.toThrow(/unknown packs/u);
  });

  it("reports an index without a checksum router as unavailable data", async () => {
    stubFetch();
    const { loadIdentifyPacks } = await import("../../src/platform/browser/identify-packs.ts");

    await expect(loadIdentifyPacks({ checksums: { crc32: PS_CRC32 } })).rejects.toThrow(/lists no checksum router/u);
  });

  it("refetches the router after resetIdentifyPackCache", async () => {
    const bytes = routerBytes();
    const index = await routerIndex(bytes);
    const first = stubFetch({ index, routerBytes: bytes });
    const { loadIdentifyPacks, resetIdentifyPackCache } = await import("../../src/platform/browser/identify-packs.ts");
    await loadIdentifyPacks({ checksums: { crc32: PS_CRC32 } });
    expect(first.mock.calls.filter((call) => String(call[0]).includes(".bin"))).toHaveLength(1);

    resetIdentifyPackCache();
    const second = stubFetch({ index, routerBytes: bytes });
    await loadIdentifyPacks({ checksums: { crc32: PS_CRC32 } });

    expect(second.mock.calls.filter((call) => String(call[0]).includes(".bin"))).toHaveLength(1);
  });
});
