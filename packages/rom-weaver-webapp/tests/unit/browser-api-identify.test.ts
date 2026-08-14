import { beforeEach, describe, expect, it, vi } from "vitest";

const ingest = vi.fn();
const dispose = vi.fn();

vi.mock("../../src/platform/browser/workflow-runtime.ts", () => ({
  browserRuntime: {
    ingest: { run: ingest },
  },
}));

const { identifyRom } = await import("../../src/platform/browser/browser-api.ts");

beforeEach(() => {
  vi.clearAllMocks();
  dispose.mockResolvedValue(undefined);
  ingest.mockResolvedValue({
    outputs: [{ dispose }],
    patchOutputs: [],
    result: {
      assets: [
        {
          checksumVariants: [],
          checksums: { crc32: "11111111" },
          identification: { matches: [], status: "unknown" },
          path: "unknown.gba",
        },
        {
          checksumVariants: [],
          checksums: { crc32: "22222222" },
          identification: {
            matches: [
              {
                algorithm: "crc32",
                database: "game-boy-advance.pack",
                name: "Known Game (USA)",
                platform: "Game Boy Advance",
                variant: "raw",
              },
            ],
            status: "matched",
          },
          path: "known.gba",
          platform: "Game Boy Advance",
        },
      ],
    },
  });
});

describe("identifyRom", () => {
  it("uses a matched asset when an archive contains multiple ROMs", async () => {
    await expect(identifyRom(new Blob(["archive"]), "games.zip")).resolves.toEqual({
      checksumVariants: [],
      checksums: { crc32: "22222222" },
      detectedPlatform: "Game Boy Advance",
      input: "known.gba",
      matches: [
        {
          algorithm: "crc32",
          database: "game-boy-advance.pack",
          name: "Known Game (USA)",
          platform: "Game Boy Advance",
          variant: "raw",
        },
      ],
      status: "matched",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
