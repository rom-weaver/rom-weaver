// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

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

const stubFetch = (options: { index?: unknown; indexStatus?: number; packStatus?: number; packBody?: string } = {}) => {
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("identify-index.json")) {
      expect(init).toEqual({ cache: "no-cache" });
      if (options.indexStatus) return new Response("nope", { status: options.indexStatus });
      return new Response(
        JSON.stringify(options.index ?? { format: "rom-weaver-identify-system-pack-v5", systems: INDEX_SYSTEMS }),
      );
    }
    if (options.packStatus) return new Response("nope", { status: options.packStatus });
    return new Response(new TextEncoder().encode(options.packBody ?? "abc"));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

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
        format: "rom-weaver-identify-system-pack-v5",
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
