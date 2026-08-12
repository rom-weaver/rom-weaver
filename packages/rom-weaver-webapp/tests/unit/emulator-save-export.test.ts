import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  compressEmulatorSaveExport,
  extractEmulatorSaveExport,
  getCompressedFileName,
} from "../../src/storage/browser/emulator-save-export.ts";

const create = vi.fn();
const extract = vi.fn();
const getBlob = vi.fn();
const dispose = vi.fn();

vi.mock("../../src/platform/browser/workflow-runtime.ts", () => ({
  browserRuntime: {
    compression: { create, extract },
    publicOutput: { getBlob },
  },
}));

const output = { dispose, fileName: "save.rw-emulator-save.zip" };

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ output });
  extract.mockResolvedValue({ outputs: [output] });
  getBlob.mockResolvedValue(new Blob(["compressed"]));
  dispose.mockResolvedValue(undefined);
});

describe("emulator save export compression", () => {
  it("changes the JSON export name to a ZIP name", () => {
    expect(getCompressedFileName("game.rw-emulator-save.json")).toBe("game.rw-emulator-save.zip");
    expect(getCompressedFileName("")).toBe("emulator-save.rw-emulator-save.zip");
  });

  it("compresses the JSON export with rom-weaver's ZIP runtime", async () => {
    const result = await compressEmulatorSaveExport({
      blob: new Blob(["save"]),
      fileName: "game.rw-emulator-save.json",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "zip",
        options: { outputName: "game.rw-emulator-save.zip" },
      }),
    );
    expect(result).toEqual({ blob: expect.any(Blob), fileName: output.fileName });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("extracts the exported JSON entry from a ZIP with rom-weaver", async () => {
    const result = await extractEmulatorSaveExport(new Blob(["zip"]));

    expect(extract).toHaveBeenCalledWith(
      expect.objectContaining({ descendSinglePayload: true, entries: [], format: "zip" }),
    );
    expect(result).toBeInstanceOf(Blob);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
