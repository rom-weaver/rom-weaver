// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { IdentifyCatalog } from "../../src/lib/identify/identify-catalog.ts";
import {
  createIdentifyDatabaseManager,
  IdentifyConsentRequiredError,
} from "../../src/lib/identify/identify-database-manager.ts";
import { createMemoryIdentifyPackStore } from "../../src/lib/identify/identify-pack-store.ts";
import { sha256Hex } from "../../src/lib/identify/sha256-hex.ts";

const PACK_BYTES = new TextEncoder().encode("pack-v1").buffer as ArrayBuffer;

const catalogWith = (packSha256: string): IdentifyCatalog => ({
  format: "rom-weaver-identify-catalog-v1",
  platforms: [
    {
      aliases: ["psx"],
      canonicalPlatform: "Sony PlayStation",
      mediaProfiles: ["redump-cd-track-v1"],
      packFormat: "RWFP2",
      packSha256,
      packSlug: "sony-playstation",
      source: "hasheous",
    },
    {
      aliases: [],
      canonicalPlatform: "Nintendo Game Boy",
      mediaProfiles: ["opengood-cartridge-v1"],
      packFormat: "RWFP1",
      packSha256: "",
      packSlug: "nintendo-game-boy",
      source: "opengood",
    },
  ],
});

const setup = async (options: { body?: ArrayBuffer; consent?: boolean; failFetch?: boolean; status?: number } = {}) => {
  const packSha = await sha256Hex(PACK_BYTES);
  const store = createMemoryIdentifyPackStore();
  const fetchImpl = vi.fn(async () => {
    if (options.failFetch) throw new TypeError("Failed to fetch");
    if (options.status) return new Response("nope", { status: options.status });
    return new Response(options.body ?? PACK_BYTES.slice(0));
  });
  const manager = createIdentifyDatabaseManager({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    loadCatalogIndex: async () => ({ catalog: catalogWith(packSha), systems: [] }),
    readConsent: () => options.consent === true,
    resolvePackUrl: (entry) => `https://example.test/${entry.fileName}`,
    store,
  });
  await manager.refresh();
  return { fetchImpl, manager, packSha, store };
};

describe("identify database manager", () => {
  it("lists catalog platforms with their state", async () => {
    const { manager } = await setup();
    const { entries } = manager.getSnapshot();
    expect(entries.map((entry) => [entry.slug, entry.source, entry.state])).toEqual([
      ["sony-playstation", "hasheous", "not-downloaded"],
      ["nintendo-game-boy", "opengood", "not-downloaded"],
    ]);
  });

  it("never fetches a Hasheous pack without consent", async () => {
    const { fetchImpl, manager } = await setup({ consent: false });
    await expect(manager.download("sony-playstation")).rejects.toBeInstanceOf(IdentifyConsentRequiredError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("downloads, verifies, and stores a pack after consent", async () => {
    const { fetchImpl, manager, packSha, store } = await setup({ consent: true });
    await manager.download("sony-playstation");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot().entries[0]?.state).toBe("cached");
    expect(await store.keys()).toEqual([{ fileName: "sony-playstation.pack", sha256: packSha }]);
  });

  it("rejects a checksum mismatch and keeps the previously good pack", async () => {
    const { manager, packSha, store } = await setup({ consent: true });
    await manager.download("sony-playstation");
    const bad = createIdentifyDatabaseManager({
      fetchImpl: (async () => new Response(new TextEncoder().encode("evil bytes"))) as unknown as typeof fetch,
      loadCatalogIndex: async () => ({ catalog: catalogWith(packSha), systems: [] }),
      readConsent: () => true,
      store,
    });
    await bad.refresh();
    expect(bad.getSnapshot().entries[0]?.state).toBe("cached");
    await expect(bad.download("sony-playstation")).rejects.toThrow(/checksum/u);
    expect(bad.getSnapshot().entries[0]?.state).toBe("error");
    expect(bad.getSnapshot().entries[0]?.errorKind).toBe("integrity");
    // The good copy survives the failed update.
    expect((await store.get("sony-playstation.pack"))?.sha256).toBe(packSha);
  });

  it("recovers to an error state when the response body fails mid-read", async () => {
    const packSha = await sha256Hex(PACK_BYTES);
    const store = createMemoryIdentifyPackStore();
    const body = {
      arrayBuffer: async () => {
        throw new TypeError("network dropped mid-body");
      },
      ok: true,
      status: 200,
    } as unknown as Response;
    const manager = createIdentifyDatabaseManager({
      fetchImpl: (async () => body) as unknown as typeof fetch,
      loadCatalogIndex: async () => ({ catalog: catalogWith(packSha), systems: [] }),
      readConsent: () => true,
      store,
    });
    await manager.refresh();
    await expect(manager.download("sony-playstation")).rejects.toThrow(/mid-body/u);
    // The row must never stay stuck in "downloading" after a mid-body failure.
    expect(manager.getSnapshot().entries[0]?.state).toBe("error");
    expect(manager.getSnapshot().entries[0]?.errorKind).toBe("network");
  });

  it("names CORS as a possible cause of a failed cross-origin fetch, and retry recovers", async () => {
    const { manager, packSha, store } = await setup({ consent: true, failFetch: true });
    await expect(manager.download("sony-playstation")).rejects.toThrow(/CORS/u);
    expect(manager.getSnapshot().entries[0]?.errorKind).toBe("network");
    const retry = createIdentifyDatabaseManager({
      fetchImpl: (async () => new Response(PACK_BYTES.slice(0))) as unknown as typeof fetch,
      loadCatalogIndex: async () => ({ catalog: catalogWith(packSha), systems: [] }),
      readConsent: () => true,
      store,
    });
    await retry.refresh();
    await retry.download("sony-playstation");
    expect(retry.getSnapshot().entries[0]?.state).toBe("cached");
  });

  it("reports a stale state when the catalog advertises a new pack hash", async () => {
    const { manager, packSha, store } = await setup({ consent: true });
    await manager.download("sony-playstation");
    const next = createIdentifyDatabaseManager({
      fetchImpl: (async () => new Response(PACK_BYTES.slice(0))) as unknown as typeof fetch,
      loadCatalogIndex: async () => ({ catalog: catalogWith("0".repeat(64)), systems: [] }),
      readConsent: () => true,
      store,
    });
    void packSha;
    await next.refresh();
    expect(next.getSnapshot().entries[0]?.state).toBe("stale");
  });

  it("removes a stored pack", async () => {
    const { manager, store } = await setup({ consent: true });
    await manager.download("sony-playstation");
    await manager.remove("sony-playstation");
    expect(manager.getSnapshot().entries[0]?.state).toBe("not-downloaded");
    expect(await store.keys()).toEqual([]);
  });

  it("reports an HTTP failure without storing anything", async () => {
    const { manager, store } = await setup({ consent: true, status: 503 });
    await expect(manager.download("sony-playstation")).rejects.toThrow(/HTTP 503/u);
    expect(manager.getSnapshot().entries[0]?.errorKind).toBe("http");
    expect(await store.keys()).toEqual([]);
  });
});
