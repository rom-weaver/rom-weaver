// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/lib/identify/sha256-hex.ts";

const PACK_BODY = "hasheous-pack";
const OPENGOOD_SHA = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; // sha256("abc")

const INDEX = {
  format: "rom-weaver-identify-system-pack-v1",
  systems: [
    {
      file: "nintendo-game-boy.pack",
      platform: "Nintendo Game Boy",
      rawBytes: 3,
      sha256: OPENGOOD_SHA,
      slug: "nintendo-game-boy",
      source: "opengood",
    },
    {
      file: "nintendo-game-boy-color.pack",
      platform: "Nintendo Game Boy Color",
      rawBytes: 3,
      sha256: OPENGOOD_SHA,
      slug: "nintendo-game-boy-color",
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
      mediaProfiles: ["redump-cd-track-v1"],
      packFormat: "RWFP2",
      packSha256: packSha,
      packSlug: "sony-playstation",
      source: "hasheous",
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

const setConsent = (consent: boolean) => {
  localStorage.setItem(
    "rom-weaver-identify-database-v1",
    JSON.stringify({ hasheousConsent: consent, identifyDatabaseOrigin: "" }),
  );
};

const loadModules = async () => {
  const stores = await import("../../src/lib/identify/identify-pack-store.ts");
  const store = stores.createMemoryIdentifyPackStore();
  stores.setDefaultIdentifyPackStore(store);
  const packs = await import("../../src/platform/browser/identify-packs.ts");
  packs.resetIdentifyPackCache();
  return { packs, store };
};

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("catalog-aware pack routing", () => {
  it("routes a detected platform through catalog aliases to the Hasheous pack", async () => {
    const packSha = await sha256Hex(new TextEncoder().encode(PACK_BODY).buffer as ArrayBuffer);
    const fetchMock = stubFetch(packSha);
    setConsent(true);
    const { packs } = await loadModules();
    const selection = await packs.loadIdentifyPackSelection({ fileName: "game.bin", platform: "psx" });
    expect(selection.databaseRequired).toBeUndefined();
    expect(selection.packs.map((pack) => pack.slug)).toEqual(["sony-playstation"]);
    const fetchedPaths = fetchMock.mock.calls.map((call) => new URL(String(call[0])).pathname);
    expect(fetchedPaths.some((pathname) => pathname.endsWith("sony-playstation.pack"))).toBe(true);
  });

  it("reports database_required instead of fetching when consent is missing", async () => {
    const packSha = await sha256Hex(new TextEncoder().encode(PACK_BODY).buffer as ArrayBuffer);
    const fetchMock = stubFetch(packSha);
    setConsent(false);
    const { packs } = await loadModules();
    const selection = await packs.loadIdentifyPackSelection({ fileName: "game.bin", platform: "Sony PlayStation" });
    expect(selection.packs).toEqual([]);
    expect(selection.databaseRequired?.platform).toBe("Sony PlayStation");
    expect(selection.databaseRequired?.hint).toMatch(/database/u);
    const fetchedPaths = fetchMock.mock.calls.map((call) => new URL(String(call[0])).pathname);
    expect(fetchedPaths.some((pathname) => pathname.endsWith(".pack"))).toBe(false);
  });

  it("uses a stored verified pack offline, without consent and without a network fetch", async () => {
    const bytes = new TextEncoder().encode(PACK_BODY).buffer as ArrayBuffer;
    const packSha = await sha256Hex(bytes);
    const fetchMock = stubFetch(packSha);
    setConsent(false);
    const { packs, store } = await loadModules();
    await store.put("sony-playstation.pack", packSha, bytes);
    const selection = await packs.loadIdentifyPackSelection({ fileName: "game.bin", platform: "psx" });
    expect(selection.databaseRequired).toBeUndefined();
    expect(selection.packs.map((pack) => pack.slug)).toEqual(["sony-playstation"]);
    const fetchedPaths = fetchMock.mock.calls.map((call) => new URL(String(call[0])).pathname);
    expect(fetchedPaths.some((pathname) => pathname.endsWith(".pack"))).toBe(false);
  });

  it("treats a stale stored pack without consent as database_required, not unavailable", async () => {
    const bytes = new TextEncoder().encode(PACK_BODY).buffer as ArrayBuffer;
    const packSha = await sha256Hex(bytes);
    stubFetch(packSha);
    setConsent(false);
    const { packs, store } = await loadModules();
    // The stored copy matches an older catalog hash; the current catalog ships a new one.
    await store.put("sony-playstation.pack", "0".repeat(64), bytes);
    const selection = await packs.loadIdentifyPackSelection({ fileName: "game.bin", platform: "Sony PlayStation" });
    expect(selection.packs).toEqual([]);
    expect(selection.databaseRequired?.platform).toBe("Sony PlayStation");
  });

  it("never bulk-downloads Hasheous packs in the unnarrowed fallback", async () => {
    const packSha = await sha256Hex(new TextEncoder().encode(PACK_BODY).buffer as ArrayBuffer);
    const fetchMock = stubFetch(packSha);
    setConsent(true);
    const { packs } = await loadModules();
    const selection = await packs.loadIdentifyPackSelection({ fileName: "mystery.bin" });
    expect(selection.packs.map((pack) => pack.slug).sort()).toEqual(["nintendo-game-boy", "nintendo-game-boy-color"]);
    const fetchedPaths = fetchMock.mock.calls.map((call) => new URL(String(call[0])).pathname);
    expect(fetchedPaths.some((pathname) => pathname.endsWith("sony-playstation.pack"))).toBe(false);
  });
});
