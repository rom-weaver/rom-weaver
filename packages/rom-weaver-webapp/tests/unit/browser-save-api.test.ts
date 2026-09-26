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

describe("browser save schema staging", () => {
  it("forwards the staged schema path and cleans both inputs after success", async () => {
    const cleanupSave = vi.fn().mockResolvedValue(undefined);
    const cleanupSchema = vi.fn().mockResolvedValue(undefined);
    stageSource
      .mockResolvedValueOnce({ cleanup: cleanupSave, filePath: "/work/save.sav" })
      .mockResolvedValueOnce({ cleanup: cleanupSchema, filePath: "/work/schema.json" });
    invokeRomWeaverSaveIdentifyWorker.mockResolvedValue({ parsed: { saveSize: 64 } });
    const schema = new File(["{}"], "schema.json");

    await expect(identifySave({ schema, source: new File(["save"], "save.sav") })).resolves.toEqual({
      saveSize: 64,
    });
    expect(invokeRomWeaverSaveIdentifyWorker).toHaveBeenCalledWith(
      expect.objectContaining({ inputPath: "/work/save.sav", schemaPath: "/work/schema.json" }),
    );
    expect(cleanupSave).toHaveBeenCalledOnce();
    expect(cleanupSchema).toHaveBeenCalledOnce();
  });

  it("cleans the staged schema when validation fails", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    stageSource.mockResolvedValueOnce({ cleanup, filePath: "/work/schema.json" });
    invokeRomWeaverSaveListGamesWorker.mockRejectedValueOnce(new Error("invalid schema"));

    await expect(listSaveGames(undefined, new File(["{}"], "schema.json"))).rejects.toThrow("invalid schema");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("rejects schema packs larger than 2 MiB before staging", async () => {
    const schema = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "large.json");
    await expect(listSaveGames(undefined, schema)).rejects.toThrow("larger than 2 MiB");
    expect(stageSource).not.toHaveBeenCalled();
  });
});
