import { beforeEach, describe, expect, it, vi } from "vitest";

const ingest = vi.fn();
const dispose = vi.fn();

vi.mock("../../src/platform/browser/workflow-runtime.ts", () => ({
  browserRuntime: {
    ingest: { run: ingest },
  },
}));

const { identifyRom } = await import("../../src/platform/browser/browser-api.ts");

const match = (name: string) => ({
  algorithm: "crc32",
  database: "nintendo-game-boy-advance.pack",
  name,
  platform: "Nintendo Game Boy Advance",
  variant: "raw",
});

const archiveAssets = (): Array<{
  checksums: { crc32: string };
  checksumVariants: never[];
  copiedInPlace: boolean;
  extractTimeMs?: number;
  fileName: string;
  identification: { matches: ReturnType<typeof match>[]; status: string };
  memberPath: string;
  path: string;
  platform?: string;
}> => [
  {
    checksums: { crc32: "11111111" },
    checksumVariants: [],
    copiedInPlace: false,
    fileName: "unknown.gba",
    identification: { matches: [], status: "unknown" },
    memberPath: "Games/unknown.gba",
    path: "/work/operations/x/Games/unknown.gba",
  },
  {
    checksums: { crc32: "22222222" },
    checksumVariants: [],
    copiedInPlace: false,
    fileName: "known.gba",
    identification: { matches: [match("Known Game (USA)")], status: "matched" },
    memberPath: "Games/known.gba",
    path: "/work/operations/x/Games/known.gba",
    platform: "Nintendo Game Boy Advance",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  dispose.mockResolvedValue(undefined);
});

describe("identifyRom", () => {
  it("reports one candidate per archive member instead of picking a winner", async () => {
    ingest.mockImplementation(async (options) => {
      options.onProgress({
        details: { extract_step: { extract_time_ms: 80, status: "succeeded" } },
      });
      options.onProgress({
        details: { extract_step: { extract_time_ms: 40, status: "succeeded" } },
      });
      return {
        outputs: [{ dispose }],
        patchOutputs: [],
        result: { assets: archiveAssets(), identifyTimeMs: 45 },
      };
    });

    const result = await identifyRom(new Blob(["archive"]), "games.zip");

    expect(result.archiveName).toBe("games.zip");
    expect(result.input).toBe("games.zip");
    expect(result.candidates.map((candidate) => candidate.path)).toEqual(["Games/unknown.gba", "Games/known.gba"]);
    expect(result.candidates[0]?.status).toBe("unknown");
    expect(result.candidates[1]?.status).toBe("matched");
    expect(result.candidates[1]?.matches).toEqual([match("Known Game (USA)")]);
    // One matched member plus one unmatched member is not "ambiguous": each is reported on its own.
    expect(result.status).toBe("matched");
    expect(result.extractTimeMs).toBe(120);
    expect(result.identifyTimeMs).toBe(45);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("reports a single bare ROM without an archive name", async () => {
    ingest.mockResolvedValue({
      outputs: [],
      patchOutputs: [],
      result: {
        assets: [
          {
            checksums: { crc32: "22222222" },
            checksumVariants: [],
            copiedInPlace: true,
            fileName: "known.gba",
            identification: { matches: [match("Known Game (USA)")], status: "matched" },
            path: "/work/staged/known.gba",
            platform: "Nintendo Game Boy Advance",
          },
        ],
      },
    });

    const result = await identifyRom(new Blob(["rom"]), "known.gba");

    expect(result.archiveName).toBeUndefined();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.path).toBe("known.gba");
    expect(result.candidates[0]?.detectedPlatform).toBe("Nintendo Game Boy Advance");
    expect(result.status).toBe("matched");
  });

  it("reports ambiguous when a member resolves to several records", async () => {
    ingest.mockResolvedValue({
      outputs: [],
      patchOutputs: [],
      result: {
        assets: [
          {
            checksums: { crc32: "33333333" },
            checksumVariants: [],
            copiedInPlace: true,
            fileName: "twin.gba",
            identification: {
              matches: [match("Twin Game (USA)"), match("Twin Game (Europe)")],
              status: "ambiguous",
            },
            path: "/work/staged/twin.gba",
          },
        ],
      },
    });

    const result = await identifyRom(new Blob(["rom"]), "twin.gba");

    expect(result.status).toBe("ambiguous");
    expect(result.candidates[0]?.matches).toHaveLength(2);
  });

  it("reports unavailable, not unknown, when the identify packs never loaded", async () => {
    ingest.mockResolvedValue({
      identifyUnavailable: "ROM identify index request failed with HTTP 503",
      outputs: [],
      patchOutputs: [],
      result: {
        assets: [
          {
            checksums: { crc32: "22222222" },
            checksumVariants: [],
            copiedInPlace: true,
            fileName: "known.gba",
            path: "/work/staged/known.gba",
          },
        ],
      },
    });

    const result = await identifyRom(new Blob(["rom"]), "known.gba");

    expect(result.status).toBe("unavailable");
    expect(result.unavailableReason).toBe("ROM identify index request failed with HTTP 503");
    expect(result.candidates[0]?.status).toBe("unavailable");
    expect(result.candidates[0]?.checksums).toEqual({ crc32: "22222222" });
  });
});
