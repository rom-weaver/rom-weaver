// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createRomInputRow } from "../../src/public/react/apply-session-inputs.ts";
import { useCompressionResolver } from "../../src/public/react/use-compression-resolver.ts";
import type { ApplyPatchFormSettings } from "../../src/public/react/patcher-form.ts";

const labelsFor = (
  row: ReturnType<typeof createRomInputRow>,
  compressionOptions: string[] = ["none", "zip", "chd"],
  activeSettings = {} as ApplyPatchFormSettings,
) => {
  const hook = renderHook(() =>
    useCompressionResolver({
      activeSettings,
      compressionOptions,
      effectiveInputs: [new File([], row.info.fileName)],
      outputCompressionEdited: false,
      romInputs: [row],
    }),
  );
  return Object.fromEntries(hook.result.current.outputOptions.map(({ label, value }) => [value, label]));
};

describe("compression resolver output options", () => {
  it("labels an uncompressed CHD disc by the files it saves once extracted, not by a guess while extracting", () => {
    // CD mode arrives before the tracks and covers GD-ROMs too, so it alone names no files.
    const extracting = createRomInputRow({ chdMode: "cd", id: "rom", info: { fileName: "game.chd" } });
    const extracted = createRomInputRow({
      chdMode: "cd",
      cueText: 'FILE "game.bin" BINARY',
      id: "rom",
      info: { fileName: "game.bin" },
      kind: "track",
    });
    expect(labelsFor(extracting)).toEqual({ chd: ".chd", none: "None", zip: ".zip" });
    expect(labelsFor(extracted)).toEqual({ chd: ".chd", none: ".bin/.cue", zip: ".zip" });
  });

  it("labels an extracted GD-ROM by its gdi sheet", () => {
    const extracted = createRomInputRow({
      chdMode: "cd",
      gdiText: "1\n1 0 4 2352 track01.bin 0",
      id: "rom",
      info: { fileName: "track01.bin" },
      kind: "track",
    });
    expect(labelsFor(extracted).none).toBe(".gdi");
  });

  describe("RVZ output", () => {
    const allOptions = ["none", "zip", "7z", "chd", "rvz"];
    const rvzIn = (fileName: string, recommendedFormat?: string) =>
      Object.keys(
        labelsFor(
          createRomInputRow({
            id: "rom",
            info: { fileName, ...(recommendedFormat ? { romType: { discFormat: "DVD", recommendedFormat } } : {}) },
          }),
          allOptions,
        ),
      ).includes("rvz");

    it("offers RVZ for a bare .iso only when the engine recognised a GameCube or Wii disc", () => {
      expect(rvzIn("game.iso")).toBe(false);
      expect(rvzIn("dvd.iso", "chd")).toBe(false);
      expect(rvzIn("game.iso", "rvz")).toBe(true);
    });

    it("offers RVZ for extensions that only GameCube and Wii discs use, with no verdict", () => {
      for (const fileName of ["game.gcm", "game.wbfs", "game.rvz", "game.gcz", "game.wia"]) {
        expect(rvzIn(fileName)).toBe(true);
      }
    });

    it("falls back to no compression when the default output is RVZ for a plain DVD ISO", () => {
      const row = createRomInputRow({ id: "rom", info: { fileName: "dvd.iso" } });
      const hook = renderHook(() =>
        useCompressionResolver({
          activeSettings: { output: { compression: "rvz" } } as ApplyPatchFormSettings,
          compressionOptions: allOptions,
          effectiveInputs: [new File([], "dvd.iso")],
          outputCompressionEdited: false,
          romInputs: [row],
        }),
      );
      expect(hook.result.current.requestedCompression).toBe("none");
    });
  });
});
