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
  it("labels an uncompressed CHD disc by the bundle it saves, before and after extraction", () => {
    const extracting = createRomInputRow({ chdMode: "cd", id: "rom", info: { fileName: "game.chd" } });
    const extracted = createRomInputRow({
      chdMode: "cd",
      cueText: 'FILE "game.bin" BINARY',
      id: "rom",
      info: { fileName: "game.bin" },
      kind: "track",
    });
    for (const row of [extracting, extracted]) {
      expect(labelsFor(row)).toEqual({ chd: ".chd", none: ".zip (uncompressed)", zip: ".zip" });
    }
  });
});
