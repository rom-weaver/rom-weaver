import { beforeEach, describe, expect, it, vi } from "vitest";

const stageSource = vi.fn();
const invokeRomWeaverSaveIdentifyWorker = vi.fn();
const invokeRomWeaverSaveListGamesWorker = vi.fn();

vi.mock("../../src/platform/browser/workflow-runtime.ts", () => ({
  browserRuntime: { workerIo: { stageSource } },
}));
vi.mock("../../src/lib/runtime/wasm-command-runtime.ts", () => ({
  invokeRomWeaverSaveCreateWorker: vi.fn(),
  invokeRomWeaverSaveIdentifyWorker,
  invokeRomWeaverSaveInspectWorker: vi.fn(),
  invokeRomWeaverSaveListGamesWorker,
  invokeRomWeaverSaveSetWorker: vi.fn(),
}));

const { identifySave, listSaveGames } = await import("../../src/platform/browser/browser-save-api.ts");

beforeEach(() => vi.clearAllMocks());

describe("browser save API", () => {
  it("forwards the staged save path and cleans the input after success", async () => {
    const cleanupSave = vi.fn().mockResolvedValue(undefined);
    stageSource.mockResolvedValueOnce({ cleanup: cleanupSave, filePath: "/work/save.sav" });
    invokeRomWeaverSaveIdentifyWorker.mockResolvedValue({ parsed: { saveSize: 64 } });

    await expect(identifySave({ source: new File(["save"], "save.sav") })).resolves.toEqual({
      saveSize: 64,
    });
    expect(invokeRomWeaverSaveIdentifyWorker).toHaveBeenCalledWith(
      expect.objectContaining({ inputPath: "/work/save.sav" }),
    );
    expect(invokeRomWeaverSaveIdentifyWorker.mock.calls[0][0]).not.toHaveProperty("schemaPath");
    expect(cleanupSave).toHaveBeenCalledOnce();
  });

  it("lists compiled catalog games without staging a source", async () => {
    invokeRomWeaverSaveListGamesWorker.mockResolvedValue({ parsed: { games: [], generationGames: [] } });
    await expect(listSaveGames()).resolves.toEqual({ games: [], generationGames: [] });
    expect(invokeRomWeaverSaveListGamesWorker).toHaveBeenCalledWith({ signal: undefined });
    expect(stageSource).not.toHaveBeenCalled();
  });
});
