import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowProgress } from "../../src/platform/browser/browser-api.ts";
import {
  loadEmulatorRom,
  pickEmulatorRomOutput,
  renameRomToOutput,
} from "../../src/public/react/components/emulator-load-rom.ts";

const workflowMocks = vi.hoisted(() => ({
  getIngestOutputBlob: vi.fn(async () => new Blob(["game"])),
  ingestRom: vi.fn(),
  outputDispose: vi.fn(async () => undefined),
  probeRom: vi.fn(),
}));

vi.mock("../../src/platform/browser/browser-api.ts", () => ({
  getIngestOutputBlob: workflowMocks.getIngestOutputBlob,
  ingestRom: workflowMocks.ingestRom,
  probeRom: workflowMocks.probeRom,
}));

type ArchiveOutput = Parameters<typeof pickEmulatorRomOutput>[0][number];

const output = (fileName: string): ArchiveOutput => ({ fileName }) as ArchiveOutput;

beforeEach(() => {
  workflowMocks.getIngestOutputBlob.mockClear();
  workflowMocks.ingestRom.mockReset();
  workflowMocks.outputDispose.mockClear();
  workflowMocks.probeRom.mockReset();
  workflowMocks.ingestRom.mockImplementation(async (_blob, _fileName, options) => {
    options.onProgress?.({
      id: "extract",
      label: "Extracting games.zip...",
      percent: 42,
      role: "input",
      sequence: 1,
      stage: "decompress",
      workflow: "apply",
    } satisfies WorkflowProgress);
    return {
      outputs: [
        {
          checksums: { sha1: "a".repeat(40) },
          dispose: workflowMocks.outputDispose,
          fileName: "game.nes",
        },
      ],
      result: { assets: [{ copiedInPlace: false }] },
    };
  });
});

it("forwards archive extraction progress and releases the workflow", async () => {
  const onProgress = vi.fn();
  const abortController = new AbortController();

  const loaded = await loadEmulatorRom(new Blob(["archive"]), "games.zip", {
    onProgress,
    signal: abortController.signal,
  });

  expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ label: "Extracting games.zip...", percent: 42 }));
  expect(workflowMocks.ingestRom).toHaveBeenCalledWith(
    expect.any(Blob),
    "games.zip",
    expect.objectContaining({ signal: abortController.signal }),
  );
  expect(loaded.fileName).toBe("game.nes");
  expect(loaded.checksum).toBe("a".repeat(40));
  expect(workflowMocks.outputDispose).toHaveBeenCalledOnce();
});

it("uses ingest to checksum a bare playable ROM in place", async () => {
  workflowMocks.ingestRom.mockResolvedValueOnce({
    outputs: [],
    result: { assets: [{ checksums: { sha1: "b".repeat(40) }, copiedInPlace: true }] },
  });
  const blob = new Blob(["game"]);

  await expect(loadEmulatorRom(blob, "game.nes")).resolves.toEqual({
    blob,
    checksum: "b".repeat(40),
    fileName: "game.nes",
  });
});

it("keeps the detected platform for a bare disc image", async () => {
  workflowMocks.ingestRom.mockResolvedValueOnce({
    outputs: [],
    result: {
      assets: [
        {
          checksums: { sha1: "b".repeat(40) },
          copiedInPlace: true,
          platform: "Sony Playstation Portable",
        },
      ],
    },
  });

  await expect(loadEmulatorRom(new Blob(["game"]), "game.iso")).resolves.toMatchObject({
    platform: "Sony Playstation Portable",
  });
});

describe("CHD disc images", () => {
  it("hands the CHD to the emulator unextracted with the header's payload SHA-1", async () => {
    workflowMocks.probeRom.mockImplementation(async (_blob, _fileName, options) => {
      options.onProgress?.({ label: "Reading game.chd...", percent: 10, stage: "input" });
      return { chd: { rawSha1: "C".repeat(40), sha1: "d".repeat(40) }, entries: [], platform: "Sony PlayStation" };
    });
    const onProgress = vi.fn();
    const blob = new Blob(["chd"]);

    await expect(loadEmulatorRom(blob, "Game.CHD", { onProgress })).resolves.toEqual({
      blob,
      checksum: "c".repeat(40),
      fileName: "Game.CHD",
      platform: "Sony PlayStation",
    });
    expect(workflowMocks.ingestRom).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Reading game.chd...", percent: 10, stage: "input" }),
    );
  });

  it("falls back to the header's combined SHA-1", async () => {
    workflowMocks.probeRom.mockResolvedValueOnce({ chd: { sha1: "d".repeat(40) }, entries: [] });

    await expect(loadEmulatorRom(new Blob(["chd"]), "game.chd")).resolves.toMatchObject({
      checksum: "d".repeat(40),
    });
  });

  it("rejects a CHD whose header has no SHA-1", async () => {
    workflowMocks.probeRom.mockResolvedValueOnce({ entries: [], platform: "Sony PlayStation" });

    await expect(loadEmulatorRom(new Blob(["chd"]), "game.chd")).rejects.toThrow("carries no SHA-1");
  });
});

describe("pickEmulatorRomOutput", () => {
  it("throws when the archive produced no files", () => {
    expect(() => pickEmulatorRomOutput([])).toThrow("did not produce any files");
  });

  it("prefers a ROM-extension output over an earlier non-ROM file", () => {
    const rom = output("game.nes");
    expect(pickEmulatorRomOutput([output("readme.txt"), rom])).toBe(rom);
  });

  it("prefers a ROM with an emulator core over one without", () => {
    const withCore = output("game.nes");
    expect(pickEmulatorRomOutput([output("disc.iso"), withCore])).toBe(withCore);
  });

  it("falls back to the first ROM when no output has a core", () => {
    const first = output("disc.iso");
    expect(pickEmulatorRomOutput([output("notes.txt"), first, output("disc2.iso")])).toBe(first);
  });

  it("falls back to the first output when nothing matches a ROM extension", () => {
    const first = output("readme.txt");
    expect(pickEmulatorRomOutput([first, output("cover.png")])).toBe(first);
  });
});

describe("renameRomToOutput", () => {
  it("keeps the output stem and takes the ROM's extension", () => {
    expect(renameRomToOutput("my-hack.zip", "Legend of Zelda, The (U).nes")).toBe("my-hack.nes");
  });

  it("is the identity when the output was not an archive", () => {
    expect(renameRomToOutput("my-hack.nes", "my-hack.nes")).toBe("my-hack.nes");
  });

  it("handles a ROM without an extension", () => {
    expect(renameRomToOutput("my-hack.zip", "ROMFILE")).toBe("my-hack");
  });
});
