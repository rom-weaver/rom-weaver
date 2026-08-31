// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/lib/identify/sha256-hex.ts";

const PACK_BODY = "libretro-pack";
const OPENGOOD_SHA = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const INDEX = {
  format: "rom-weaver-identify-system-pack-v1",
  systems: [
    {
      file: "nintendo-game-boy.pack",
      brotliBytes: 3,
      brotliFile: "nintendo-game-boy.pack.br",
      platform: "Nintendo Game Boy",
      rawBytes: 3,
      sha256: OPENGOOD_SHA,
      slug: "nintendo-game-boy",
      source: "opengood",
    },
  ],
};
const catalogWith = (packSha: string) => ({
  format: "rom-weaver-identify-catalog-v1",
  platforms: [
    {
      aliases: ["psx", "sony playstation"],
      canonicalPlatform: "Sony PlayStation",
      mediaProfiles: ["optical-single-image-v1"],
      packFormat: "RWFP1",
      packSha256: packSha,
      packSlug: "sony-playstation",
      source: "libretro",
    },
  ],
});

const stubFetch = (packSha: string) => {
  const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("identify-index.json")) return new Response(JSON.stringify(INDEX));
    if (url.pathname.endsWith("identify-catalog.json")) return new Response(JSON.stringify(catalogWith(packSha)));
    if (url.pathname.endsWith("sony-playstation.pack")) return new Response(new TextEncoder().encode(PACK_BODY));
    return new Response(new TextEncoder().encode("abc"));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("catalog-aware pack routing", () => {
  it("routes aliases to a same-origin Libretro pack", async () => {
    const packSha = await sha256Hex(new TextEncoder().encode(PACK_BODY).buffer as ArrayBuffer);
    const fetchMock = stubFetch(packSha);
    const packs = await import("../../src/platform/browser/identify-packs.ts");
    packs.resetIdentifyPackCache();
    const selection = await packs.loadIdentifyPackSelection({ fileName: "game.bin", platform: "psx" });
    expect(selection.packs.map((pack) => pack.slug)).toEqual(["sony-playstation"]);
    const request = fetchMock.mock.calls
      .map((call) => new URL(String(call[0])))
      .find((url) => url.pathname.endsWith("sony-playstation.pack"));
    expect(request?.origin).toBe(location.origin);
  });

  it("keeps the generic fallback to the bounded OpenGood set", async () => {
    const packSha = await sha256Hex(new TextEncoder().encode(PACK_BODY).buffer as ArrayBuffer);
    stubFetch(packSha);
    const packs = await import("../../src/platform/browser/identify-packs.ts");
    packs.resetIdentifyPackCache();
    const selection = await packs.loadIdentifyPackSelection({ fileName: "mystery.bin" });
    expect(selection.packs.map((pack) => pack.slug)).toEqual(["nintendo-game-boy"]);
  });
});
