import { describe, expect, it } from "vitest";
import { pickEmulatorRomOutput } from "../../src/public/react/components/emulator-load-rom.ts";

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
