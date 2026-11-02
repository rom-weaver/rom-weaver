import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  compressEmulatorSaveExport,
  exportAllEmulatorSaves,
  extractEmulatorSaveExport,
  getCompressedFileName,
} from "../../src/storage/browser/emulator-save-export.ts";

const saveMocks = vi.hoisted(() => ({ listEmulatorSaves: vi.fn() }));
vi.mock("../../src/storage/browser/emulator-saves.ts", async (original) => ({
  ...(await original<typeof import("../../src/storage/browser/emulator-saves.ts")>()),
  listEmulatorSaves: saveMocks.listEmulatorSaves,
}));

const create = vi.fn();
const probe = vi.fn();
const extract = vi.fn();
const getBlob = vi.fn();
const dispose = vi.fn();

vi.mock("../../src/platform/browser/workflow-runtime.ts", () => ({
  browserRuntime: {
    compression: { create, extract, probe },
    publicOutput: { getBlob },
  },
}));

const output = { dispose, fileName: "save.rw-emulator-save.zip" };

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ output });
  probe.mockResolvedValue({ entries: [{ fileName: "save.rw-emulator-save.json" }] });
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

    expect(probe).toHaveBeenCalledWith({
      format: "zip",
      options: { interactiveSelectionEnabled: false },
      source: expect.any(Blob),
    });
    expect(extract).toHaveBeenCalledWith({
      entries: ["save.rw-emulator-save.json"],
      format: "zip",
      options: { directExtract: true },
      source: expect.any(Blob),
    });
    expect(result).toBeInstanceOf(Blob);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

it("exports every save as a separately restorable JSON, with unique SHA-1 filenames", async () => {
  saveMocks.listEmulatorSaves.mockResolvedValue(
    ["a", "b"].map((letter) => ({
      gameId: letter.repeat(40),
      gameName: letter.repeat(40),
      label: "same name.nes",
      sram: new Uint8Array([1, 2]),
      updatedAt: 1,
    })),
  );
  await exportAllEmulatorSaves();
  const request = create.mock.calls[0]?.[0];
  if (!request) throw new Error("The backup did not call the ZIP runtime");
  expect(request.options.outputName).toBe("rom-weaver-all-saves.zip");
  expect(request.entries).toHaveLength(2);
  for (const [index, entry] of request.entries.entries()) {
    const json = JSON.parse(new TextDecoder().decode(entry.arrayBuffer));
    const gameId = String.fromCharCode(97 + index).repeat(40);
    expect(json).toMatchObject({ gameId, sram: "AQI=" });
    expect(entry.fileName).toBe(`${gameId}.rw-emulator-save.json`);
  }
});
