import { describe, expect, it, vi } from "vitest";
import { createCheatClassifiers } from "../../src/public/react/cheat-classifier.ts";
import type { CheatDatabaseRecord, ClassifiedCheatRecord } from "../../src/lib/cheats/index.ts";

const classified: ClassifiedCheatRecord = {
  detectedKind: "game-genie",
  record: {
    description: "Infinite lives",
    gameId: "game",
    id: "manual-nes-code",
    rawCode: "SXIOPO",
    rawFields: { code: "SXIOPO" },
    sourceFile: "manual",
    sourceIndex: 0,
    sourceRevision: "manual",
    system: "nes",
  },
  resolution: { type: "romBakeable", writes: [{ offset: 0x4000, value: 0x12, width: 1 }] },
};

const databaseRecord: CheatDatabaseRecord = {
  description: "Infinite lives",
  gameId: "game",
  id: "database-code",
  rawCode: "SXIOPO",
  rawFields: { code: "SXIOPO" },
  sourceFile: "game.cht",
  sourceIndex: 0,
  sourceRevision: "test",
  system: "nes",
};

describe("createCheatClassifiers", () => {
  it("loads lazily and forwards the selected ROM source for database records", async () => {
    let source = new Blob(["rom"]);
    const getCheatSource = vi.fn(() => source);
    const nextSource = new Blob(["next-rom"]);
    const runBrowserCheats = vi.fn(async () => ({ records: [classified] }));
    const loadApi = vi.fn(async () => ({ runBrowserCheats }));
    const { classifyDatabaseCheats } = createCheatClassifiers(getCheatSource, loadApi);

    expect(loadApi).not.toHaveBeenCalled();
    await expect(classifyDatabaseCheats([databaseRecord], "nes")).resolves.toEqual([classified]);
    expect(loadApi).toHaveBeenCalledOnce();
    expect(runBrowserCheats).toHaveBeenCalledWith({ records: [databaseRecord], rom: source });

    source = nextSource;
    await classifyDatabaseCheats([databaseRecord], "nes");
    expect(runBrowserCheats).toHaveBeenLastCalledWith({ records: [databaseRecord], rom: nextSource });
    expect(getCheatSource).toHaveBeenCalledTimes(2);
  });

  it("builds a manual record and reports its detected type", async () => {
    const source = new Blob(["rom"]);
    const runBrowserCheats = vi.fn(async ({ records }: { records: unknown[] }) => ({
      records: [
        { ...classified, record: { ...classified.record, rawCode: (records[0] as { rawCode: string }).rawCode } },
      ],
    }));
    const { classifyManualCode } = createCheatClassifiers(
      () => source,
      async () => ({ runBrowserCheats }),
    );

    await expect(
      classifyManualCode({ code: "SXIOPO", description: "Infinite lives", kind: "auto", system: "nes" }),
    ).resolves.toMatchObject({ detectedSystem: "nes", detectedType: "game-genie", record: classified });
    expect(runBrowserCheats).toHaveBeenCalledWith({
      records: [expect.objectContaining({ gameId: "manual", rawCode: "SXIOPO", system: "nes" })],
      rom: source,
    });
    await classifyManualCode({
      code: "01020304",
      description: "Explicit kind",
      kind: "pro-action-replay",
      system: "nes",
    });
    expect(runBrowserCheats).toHaveBeenLastCalledWith({
      records: [expect.objectContaining({ codeKind: "pro-action-replay", rawCode: "01020304" })],
      rom: source,
    });
    expect(runBrowserCheats.mock.calls[0]?.[0].records[0]).not.toHaveProperty("codeKind");
  });

  it("keeps source readiness errors local and reports missing classifications", async () => {
    const missingSource = vi.fn(() => {
      throw new Error("Wait for ROM staging to finish before checking cheats");
    });
    const loadApi = vi.fn(async () => ({ runBrowserCheats: vi.fn(async () => ({ records: [] })) }));
    const classifiers = createCheatClassifiers(missingSource, loadApi);
    await expect(classifiers.classifyDatabaseCheats([databaseRecord], "nes")).rejects.toThrow(
      "Wait for ROM staging to finish before checking cheats",
    );
    expect(loadApi).toHaveBeenCalledOnce();

    const emptyResult = createCheatClassifiers(
      () => new Blob(["rom"]),
      async () => ({ runBrowserCheats: vi.fn(async () => ({ records: [] })) }),
    );
    await expect(
      emptyResult.classifyManualCode({ code: "SXIOPO", description: "Code", kind: "auto", system: "nes" }),
    ).rejects.toThrow("ROMWeaver did not return a cheat classification");
  });
});
