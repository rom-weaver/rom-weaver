import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPbp, buildPbpDiscBytes } from "../wasm/pbp-fixture.mjs";
import type { WorkflowProgress } from "../../src/platform/browser/browser-api.ts";
import {
  loadEmulatorRom,
  pickEmulatorRomOutput,
  renameRomToOutput,
} from "../../src/public/react/components/emulator-load-rom.ts";

const workflowMocks = vi.hoisted(() => ({
  getIngestOutputBlob: vi.fn(async (_output: { fileName: string }) => new Blob(["game"])),
  ingestRom: vi.fn(),
  outputDispose: vi.fn(async () => undefined),
  probeRom: vi.fn(),
  checksumSetInput: vi.fn(),
  checksumGetInput: vi.fn(),
  checksumDispose: vi.fn(async () => undefined),
  checksumOptions: vi.fn(),
  checksumOn: vi.fn(),
  prepareEmulatorPbp: vi.fn(),
}));

vi.mock("../../src/platform/browser/browser-api.ts", () => ({
  ChecksumWorkflow: class {
    constructor(options: unknown) {
      workflowMocks.checksumOptions(options);
    }
    on = workflowMocks.checksumOn;
    setInput = workflowMocks.checksumSetInput;
    getInput = workflowMocks.checksumGetInput;
    dispose = workflowMocks.checksumDispose;
  },
  getIngestOutputBlob: workflowMocks.getIngestOutputBlob,
  ingestRom: workflowMocks.ingestRom,
  probeRom: workflowMocks.probeRom,
  prepareEmulatorPbp: workflowMocks.prepareEmulatorPbp,
}));

type ArchiveOutput = Parameters<typeof pickEmulatorRomOutput>[0][number];

const output = (fileName: string): ArchiveOutput => ({ fileName }) as ArchiveOutput;

beforeEach(() => {
  workflowMocks.getIngestOutputBlob.mockClear();
  workflowMocks.ingestRom.mockReset();
  workflowMocks.outputDispose.mockClear();
  workflowMocks.probeRom.mockReset();
  workflowMocks.checksumSetInput.mockReset();
  workflowMocks.checksumGetInput.mockReset();
  workflowMocks.checksumGetInput.mockReturnValue({ files: [{ checksums: { sha1: "f".repeat(40) } }] });
  workflowMocks.checksumDispose.mockClear();
  workflowMocks.checksumOptions.mockClear();
  workflowMocks.checksumOn.mockClear();
  workflowMocks.prepareEmulatorPbp.mockReset();
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
    workflowMocks.probeRom.mockResolvedValueOnce({
      chd: { sha1: "d".repeat(40) },
      entries: [],
      platform: "Sony PlayStation",
    });

    await expect(loadEmulatorRom(new Blob(["chd"]), "game.chd")).resolves.toMatchObject({
      checksum: "d".repeat(40),
    });
  });

  it("extracts a CHD whose core cannot read one", async () => {
    workflowMocks.probeRom.mockResolvedValueOnce({
      chd: { rawSha1: "c".repeat(40) },
      entries: [],
      platform: "Sony Playstation Portable",
    });

    await expect(loadEmulatorRom(new Blob(["chd"]), "game.chd")).resolves.toMatchObject({ fileName: "game.nes" });
    expect(workflowMocks.ingestRom).toHaveBeenCalled();
  });

  it("extracts a Saturn CHD because yabause cannot read one", async () => {
    workflowMocks.probeRom.mockResolvedValueOnce({
      chd: { rawSha1: "c".repeat(40) },
      entries: [],
      platform: "Sega Saturn",
    });

    await loadEmulatorRom(new Blob(["chd"]), "game.chd");
    expect(workflowMocks.ingestRom).toHaveBeenCalled();
  });

  const extractDisc = (cueSheet: string) => {
    workflowMocks.probeRom.mockResolvedValueOnce({
      chd: { rawSha1: "c".repeat(40) },
      entries: [],
      platform: "Sega Saturn",
    });
    const disc = { checksums: { sha1: "e".repeat(40) }, dispose: workflowMocks.outputDispose };
    workflowMocks.ingestRom.mockResolvedValueOnce({
      outputs: [
        { ...disc, fileName: "Game.bin", romType: { platform: "Sega Saturn" } },
        { ...disc, fileName: "Game.cue" },
      ],
      result: { assets: [{ copiedInPlace: false }] },
    });
    workflowMocks.getIngestOutputBlob.mockImplementation(
      async (extracted) => new Blob([extracted.fileName === "Game.cue" ? cueSheet : "disc"]),
    );
  };

  it("names an extracted 2048-byte-sector disc an ISO", async () => {
    extractDisc('FILE "Game.bin" BINARY\r\n  TRACK 01 MODE1/2048\r\n    INDEX 01 00:00:00\r\n');

    await expect(loadEmulatorRom(new Blob(["chd"]), "game.chd")).resolves.toMatchObject({
      checksum: "e".repeat(40),
      fileName: "Game.iso",
      platform: "Sega Saturn",
    });
  });

  it.each([
    ["a raw-sector track", 'FILE "Game.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n'],
    [
      "several tracks",
      'FILE "Game.bin" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:02:00\n',
    ],
    ["a track in another file", 'FILE "Other.bin" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n'],
  ])("keeps the BIN name for a cue with %s", async (_label, cueSheet) => {
    extractDisc(cueSheet);

    await expect(loadEmulatorRom(new Blob(["chd"]), "game.chd")).resolves.toMatchObject({ fileName: "Game.bin" });
  });

  it("extracts a CHD the probe could not name a platform for", async () => {
    workflowMocks.probeRom.mockResolvedValueOnce({ chd: { rawSha1: "c".repeat(40) }, entries: [] });

    await loadEmulatorRom(new Blob(["chd"]), "game.chd");
    expect(workflowMocks.ingestRom).toHaveBeenCalled();
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

describe("complete-disc PS1 PBP loading", () => {
  const disc = { discId: "SLUS12345", iso: buildPbpDiscBytes(32, 7) };

  it.each([1, 2, 5])("bundles all %i compressed discs with validated end offsets", async (discCount) => {
    const blob = new Blob([buildPbp(Array.from({ length: discCount }, () => disc))]);
    const bundle = new Blob(["complete playlist bundle"]);
    const signal = new AbortController().signal;
    const checksum = (discCount === 1 ? "a" : "f").repeat(40);
    workflowMocks.probeRom.mockResolvedValue({
      entries: [],
      pbp: { discCount, storedBlockCount: 0, hasIndexEndOffsets: true },
    });
    workflowMocks.prepareEmulatorPbp.mockResolvedValue({
      blob: bundle,
      checksum,
      expandedSizeBytes: discCount * disc.iso.length,
    });
    await expect(loadEmulatorRom(blob, "Original.PBP", { signal })).resolves.toEqual({
      blob: bundle,
      checksum,
      expandedSizeBytes: discCount * disc.iso.length,
      fileName: "Original.zip",
      platform: "Sony PlayStation",
    });
    expect(workflowMocks.prepareEmulatorPbp).toHaveBeenCalledWith(
      blob,
      "Original.PBP",
      discCount,
      expect.objectContaining({ signal }),
    );
    expect(workflowMocks.ingestRom).not.toHaveBeenCalled();
    expect(workflowMocks.checksumSetInput).not.toHaveBeenCalled();
  });

  it.each([1, 2, 5])("prepares all %i discs when a PBP contains stored blocks", async (discCount) => {
    const blob = new Blob([buildPbp(Array.from({ length: discCount }, () => disc))]);
    const bundle = new Blob(["complete native playlist bundle"]);
    const signal = new AbortController().signal;
    workflowMocks.probeRom.mockResolvedValue({
      entries: [],
      pbp: { discCount, storedBlockCount: 1, hasIndexEndOffsets: true },
    });
    workflowMocks.prepareEmulatorPbp.mockResolvedValue({
      blob: bundle,
      checksum: "a".repeat(40),
      expandedSizeBytes: discCount * disc.iso.length,
    });
    await expect(loadEmulatorRom(blob, "Game.pbp", { signal })).resolves.toEqual({
      blob: bundle,
      checksum: "a".repeat(40),
      expandedSizeBytes: discCount * disc.iso.length,
      fileName: "Game.zip",
      platform: "Sony PlayStation",
    });
    expect(workflowMocks.prepareEmulatorPbp).toHaveBeenCalledWith(
      blob,
      "Game.pbp",
      discCount,
      expect.objectContaining({ signal }),
    );
    expect(workflowMocks.ingestRom).not.toHaveBeenCalled();
    expect(workflowMocks.checksumSetInput).not.toHaveBeenCalled();
  });

  it.each([1, 2, 5])("bundles all %i compressed discs when end offsets are absent", async (discCount) => {
    const blob = new Blob([buildPbp(Array.from({ length: discCount }, () => disc))]);
    const bundle = new Blob(["complete bundle"]);
    workflowMocks.probeRom.mockResolvedValue({
      entries: [],
      pbp: { discCount, storedBlockCount: 0, hasIndexEndOffsets: false },
    });
    workflowMocks.prepareEmulatorPbp.mockResolvedValue({ blob: bundle, checksum: "a".repeat(40) });
    const loaded = await loadEmulatorRom(blob, "Game.pbp");
    expect(loaded.blob).toBe(bundle);
    expect(loaded.fileName).toBe("Game.zip");
    expect(workflowMocks.prepareEmulatorPbp).toHaveBeenCalledWith(blob, "Game.pbp", discCount, expect.anything());
  });

  it("rejects a stored-block bundle without its save checksum", async () => {
    workflowMocks.probeRom.mockResolvedValue({
      entries: [],
      pbp: { discCount: 2, storedBlockCount: 1, hasIndexEndOffsets: true },
    });
    workflowMocks.prepareEmulatorPbp.mockResolvedValue({ blob: new Blob(["zip"]), checksum: undefined });
    await expect(loadEmulatorRom(new Blob([buildPbp([disc, disc])]), "Game.pbp")).rejects.toThrow("PBP SHA-1");
  });

  it("keeps empty-PSAR PSP homebrew on the in-place ingest path", async () => {
    const header = new Uint8Array(40);
    header.set([0, 80, 66, 80]);
    for (let offset = 8; offset < 40; offset += 4) new DataView(header.buffer).setUint32(offset, 40, true);
    const blob = new Blob([header]);
    workflowMocks.probeRom.mockResolvedValue({ entries: [], platform: "Sony Playstation Portable" });
    workflowMocks.ingestRom.mockResolvedValue({
      outputs: [],
      result: {
        assets: [{ copiedInPlace: true, checksums: { sha1: "b".repeat(40) }, platform: "Sony Playstation Portable" }],
      },
    });
    await expect(loadEmulatorRom(blob, "EBOOT.PBP")).resolves.toEqual({
      blob,
      checksum: "b".repeat(40),
      fileName: "EBOOT.PBP",
      platform: "Sony Playstation Portable",
    });
    expect(workflowMocks.checksumSetInput).not.toHaveBeenCalled();
  });

  it.each([
    "does not contain a supported PS1 DATA.PSAR signature",
    "has non-monotonic PBP section offsets",
    "has an out-of-range PBP section offset",
    "is too small to be a pbp container",
  ])("propagates parser validation: %s", async (message) => {
    workflowMocks.probeRom.mockRejectedValue(new Error(message));
    await expect(loadEmulatorRom(new Blob(["invalid"]), "Game.pbp")).rejects.toThrow(message);
    expect(workflowMocks.ingestRom).not.toHaveBeenCalled();
    expect(workflowMocks.checksumSetInput).not.toHaveBeenCalled();
  });

  it("propagates bundle hashing failures", async () => {
    workflowMocks.probeRom.mockResolvedValue({
      entries: [],
      pbp: { discCount: 2, storedBlockCount: 0, hasIndexEndOffsets: true },
    });
    workflowMocks.prepareEmulatorPbp.mockRejectedValue(new Error("hash failed"));
    await expect(loadEmulatorRom(new Blob([buildPbp([disc, disc])]), "Game.pbp")).rejects.toThrow("hash failed");
    expect(workflowMocks.checksumDispose).not.toHaveBeenCalled();
  });

  it("forwards bundle progress and preserves cancellation", async () => {
    const onProgress = vi.fn();
    const signal = new AbortController().signal;
    const error = new DOMException("Cancelled", "AbortError");
    workflowMocks.probeRom.mockResolvedValue({
      entries: [],
      pbp: { discCount: 2, storedBlockCount: 0, hasIndexEndOffsets: true },
    });
    workflowMocks.prepareEmulatorPbp.mockImplementation(async (_blob, _name, _count, options) => {
      options.onProgress({ label: "Preparing discs", percent: 42, stage: "decompress" });
      throw error;
    });
    await expect(loadEmulatorRom(new Blob([buildPbp([disc, disc])]), "Game.pbp", { onProgress, signal })).rejects.toBe(
      error,
    );
    expect(workflowMocks.prepareEmulatorPbp).toHaveBeenCalledWith(
      expect.any(Blob),
      "Game.pbp",
      2,
      expect.objectContaining({ signal, onProgress: expect.any(Function) }),
    );
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ label: "Preparing discs", percent: 42 }));
    expect(workflowMocks.checksumDispose).not.toHaveBeenCalled();
  });

  it("requires a valid whole-PBP save checksum", async () => {
    workflowMocks.probeRom.mockResolvedValue({
      entries: [],
      pbp: { discCount: 2, storedBlockCount: 0, hasIndexEndOffsets: true },
    });
    workflowMocks.prepareEmulatorPbp.mockResolvedValue({ blob: new Blob(["zip"]), checksum: "invalid" });
    await expect(loadEmulatorRom(new Blob([buildPbp([disc, disc])]), "Game.pbp")).rejects.toThrow("PBP SHA-1");
    expect(workflowMocks.checksumDispose).not.toHaveBeenCalled();
  });
});

it.each([1, 2, 5])("prepares the selected archived %i-disc PBP and disposes all outputs", async (discCount) => {
  const snapshot = new Blob(["inner PBP"]);
  const disposeOther = vi.fn(async () => undefined);
  workflowMocks.getIngestOutputBlob.mockResolvedValueOnce(snapshot);
  workflowMocks.ingestRom.mockResolvedValueOnce({
    outputs: [
      { checksums: { sha1: "a".repeat(40) }, dispose: workflowMocks.outputDispose, fileName: "Game.pbp" },
      { checksums: { sha1: "b".repeat(40) }, dispose: disposeOther, fileName: "Other.pbp" },
    ],
    result: { assets: [] },
  });
  workflowMocks.probeRom.mockResolvedValueOnce({ pbp: { discCount } });
  const bundle = new Blob(["bundle"]);
  workflowMocks.prepareEmulatorPbp.mockResolvedValueOnce({
    blob: bundle,
    checksum: "c".repeat(40),
    expandedSizeBytes: 123,
  });
  const loaded = await loadEmulatorRom(new Blob(["outer ZIP"]), "Outer.zip");
  expect(workflowMocks.ingestRom).toHaveBeenCalledWith(
    expect.any(Blob),
    "Outer.zip",
    expect.objectContaining({ preserveNestedFormats: ["pbp"] }),
  );
  expect(workflowMocks.probeRom).toHaveBeenCalledWith(snapshot, "Game.pbp", expect.any(Object));
  expect(workflowMocks.prepareEmulatorPbp).toHaveBeenCalledWith(snapshot, "Game.pbp", discCount, expect.any(Object));
  expect(loaded).toEqual({
    blob: bundle,
    checksum: "c".repeat(40),
    expandedSizeBytes: 123,
    fileName: "Game.zip",
    platform: "Sony PlayStation",
  });
  expect(workflowMocks.outputDispose).toHaveBeenCalledOnce();
  expect(disposeOther).toHaveBeenCalledOnce();
  expect(workflowMocks.outputDispose.mock.invocationCallOrder[0]).toBeLessThan(
    workflowMocks.prepareEmulatorPbp.mock.invocationCallOrder[0] ?? 0,
  );
});

it("disposes archived outputs when retained PBP validation fails", async () => {
  workflowMocks.ingestRom.mockResolvedValueOnce({
    outputs: [{ checksums: { sha1: "a".repeat(40) }, dispose: workflowMocks.outputDispose, fileName: "Invalid.pbp" }],
    result: { assets: [] },
  });
  workflowMocks.probeRom.mockRejectedValueOnce(new Error("invalid PBP"));
  await expect(loadEmulatorRom(new Blob(["zip"]), "Outer.zip")).rejects.toThrow("invalid PBP");
  expect(workflowMocks.outputDispose).toHaveBeenCalledOnce();
});

it("keeps archived PSP PBP bytes and whole-file identity", async () => {
  const snapshot = new Blob(["PSP"]);
  workflowMocks.getIngestOutputBlob.mockResolvedValueOnce(snapshot);
  workflowMocks.ingestRom
    .mockResolvedValueOnce({
      outputs: [{ checksums: { sha1: "a".repeat(40) }, dispose: workflowMocks.outputDispose, fileName: "EBOOT.PBP" }],
      result: { assets: [] },
    })
    .mockResolvedValueOnce({
      outputs: [],
      result: {
        assets: [{ copiedInPlace: true, checksums: { sha1: "a".repeat(40) }, platform: "Sony PlayStation Portable" }],
      },
    });
  workflowMocks.probeRom.mockResolvedValueOnce({ platform: "Sony PlayStation Portable" });
  const loaded = await loadEmulatorRom(new Blob(["zip"]), "Outer.zip");
  expect(loaded.blob).toBe(snapshot);
  expect(loaded.checksum).toBe("a".repeat(40));
  expect(workflowMocks.prepareEmulatorPbp).not.toHaveBeenCalled();
  expect(workflowMocks.outputDispose).toHaveBeenCalledOnce();
});

it("leaves archive ROM selection interactive and uses the first returned ROM", async () => {
  const disposeOther = vi.fn(async () => undefined);
  workflowMocks.ingestRom.mockImplementationOnce(async (_blob, _fileName, options) => {
    expect(options.interactiveSelectionEnabled).not.toBe(false);
    return {
      outputs: [
        { checksums: { sha1: "a".repeat(40) }, dispose: workflowMocks.outputDispose, fileName: "First.nes" },
        { checksums: { sha1: "b".repeat(40) }, dispose: disposeOther, fileName: "Second.nes" },
      ],
      result: { assets: [] },
    };
  });
  const loaded = await loadEmulatorRom(new Blob(["archive"]), "Games.zip");
  expect(loaded.fileName).toBe("First.nes");
  expect(workflowMocks.getIngestOutputBlob).toHaveBeenCalledOnce();
  expect(workflowMocks.outputDispose).toHaveBeenCalledOnce();
  expect(disposeOther).toHaveBeenCalledOnce();
});
