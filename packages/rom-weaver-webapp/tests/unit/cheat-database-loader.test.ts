// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  cheatShardUrl,
  createCheatDatabaseClient,
  parseCheatDatabaseIndex,
  type CheatDatabaseEntry,
  type CheatSystemShard,
} from "../../src/lib/cheats/index.ts";

const entry: CheatDatabaseEntry = {
  platform: "Nintendo - Super Nintendo Entertainment System",
  slug: "nintendo-super-nintendo-entertainment-system",
  cheatSystem: "snes",
  file: "cheats-nintendo-super-nintendo-entertainment-system.json",
  rawBytes: 100,
  sha256: "c".repeat(64),
  games: 1,
  cheats: 1,
};

const identifyIndex = {
  format: "rom-weaver-identify-system-pack-v1",
  sources: {
    libretro: { url: "https://github.com/libretro/libretro-database", revision: "abc123", license: "CC-BY-SA-4.0" },
  },
  systems: [],
  cheats: [entry],
};

describe("cheat database index", () => {
  it("reads the cheat rows and the Libretro source out of the identify index", () => {
    expect(parseCheatDatabaseIndex(identifyIndex)).toEqual({
      sourceRevision: "abc123",
      sourceUrl: "https://github.com/libretro/libretro-database",
      license: "CC-BY-SA-4.0",
      entries: [entry],
    });
  });

  it("treats an index without cheat rows or with a malformed row as unavailable", () => {
    expect(parseCheatDatabaseIndex({ ...identifyIndex, cheats: undefined })).toBeUndefined();
    expect(parseCheatDatabaseIndex({ ...identifyIndex, cheats: [{ ...entry, sha256: "short" }] })).toBeUndefined();
    expect(parseCheatDatabaseIndex({ ...identifyIndex, cheats: [{ ...entry, cheatSystem: "n64" }] })).toBeUndefined();
    expect(parseCheatDatabaseIndex({ ...identifyIndex, cheats: [{ ...entry, file: "../x.json" }] })).toBeUndefined();
    expect(parseCheatDatabaseIndex({ ...identifyIndex, sources: {} })).toBeUndefined();
  });
});

describe("cheat database loader", () => {
  it("builds the same identify asset URL the service worker's pack table carries", () => {
    const url = cheatShardUrl(entry, "https://rom-weaver.test/apply");
    expect(url.href).toBe(`https://rom-weaver.test/assets/identify-${entry.file}?sha256=${entry.sha256}`);
  });

  it("requests one same-origin shard through the dedicated worker", async () => {
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
    const client = createCheatDatabaseClient(() => worker, "https://rom-weaver.test/");

    await expect(client.loadShard(entry)).resolves.toEqual(shard);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        entry,
        url: `https://rom-weaver.test/assets/identify-${entry.file}?sha256=${entry.sha256}`,
      }),
    );
    client.close();
    expect(terminate).toHaveBeenCalledOnce();
  });
});
