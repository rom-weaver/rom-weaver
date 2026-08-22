// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  createCheatDatabaseClient,
  loadCheatDatabaseManifest,
  sameOriginUrl,
  type CheatDatabaseManifest,
  type CheatSystemShard,
} from "../../src/lib/cheats/index.ts";

const manifest: CheatDatabaseManifest = {
  attributionPath: "/cheats/ATTRIBUTION.md",
  licensePath: "/cheats/LICENSE",
  schemaVersion: 1,
  source: "libretro/libretro-database",
  sourceRevision: "abc123",
  sourceUrl: "https://github.com/libretro/libretro-database",
  license: "CC-BY-SA-4.0",
  systems: {
    snes: {
      path: "/cheats/snes.json?revision=abc123",
      compressedPath: "/cheats/snes.json.br?revision=abc123",
      label: "Super Nintendo Entertainment System",
      games: 1,
      cheats: 1,
      rawBytes: 100,
      compressedBytes: 50,
    },
  },
};

describe("cheat database loader", () => {
  it("rejects third-party asset URLs before any request", async () => {
    expect(() => sameOriginUrl("https://example.com/cheats.json", window.location.origin)).toThrow(
      "must use the app origin",
    );
    const fetcher = vi.fn<typeof fetch>();
    await expect(loadCheatDatabaseManifest("https://example.com/manifest.json", fetcher)).rejects.toThrow(
      "must use the app origin",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requests one same-origin system shard through the dedicated worker", async () => {
    const shard: CheatSystemShard = { schemaVersion: 1, system: "snes", games: [] };
    const listeners = new Map<string, EventListener>();
    const postMessage = vi.fn((message: { id: number }) => {
      listeners.get("message")?.({ data: { id: message.id, shard } } as unknown as Event);
    });
    const terminate = vi.fn();
    const worker = {
      addEventListener: vi.fn((name: string, listener: EventListener) => listeners.set(name, listener)),
      postMessage,
      terminate,
    } as unknown as Worker;
    const client = createCheatDatabaseClient(manifest, () => worker);

    await expect(client.loadSystem("snes")).resolves.toEqual(shard);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ system: "snes", url: expect.stringContaining("/cheats/snes.json?revision=abc123") }),
    );
    client.close();
    expect(terminate).toHaveBeenCalledOnce();
  });
});
