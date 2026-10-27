// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createRomInputRow } from "../../src/public/react/apply-session-inputs.ts";
import { useCompressionResolver } from "../../src/public/react/use-compression-resolver.ts";
import type { ApplyPatchFormSettings } from "../../src/public/react/patcher-form.ts";

const labelsFor = (row: ReturnType<typeof createRomInputRow>) => {
  const hook = renderHook(() =>
    useCompressionResolver({
      activeSettings: {} as ApplyPatchFormSettings,
      compressionOptions: ["none", "zip", "chd"],
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
});
