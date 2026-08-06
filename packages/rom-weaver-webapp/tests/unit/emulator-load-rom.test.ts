import { describe, expect, it } from "vitest";
import { pickEmulatorRomOutput, renameRomToOutput } from "../../src/public/react/components/emulator-load-rom.ts";

type ArchiveOutput = Parameters<typeof pickEmulatorRomOutput>[0][number];

const output = (fileName: string): ArchiveOutput => ({ fileName }) as ArchiveOutput;

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
