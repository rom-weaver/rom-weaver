import { describe, expect, it } from "vitest";
import { sanitizeFileNamePart, sanitizeTypedOutputName } from "../../src/lib/path-utils.ts";
import {
  getApplyExecutionOutputName,
  createApplyOutputState,
} from "../../src/lib/workflow/apply-output-state-machine.ts";
import { requireOutputName } from "../../src/lib/output/output-name-validation.ts";
import { getGeneratedOutputName } from "../../src/public/react/output-view-model.ts";
import { resolveCreateExecutionOutputName } from "../../src/public/react/create-patch-output-model.ts";

describe("sanitizeTypedOutputName", () => {
  it("replaces reserved characters with a space and collapses whitespace", () => {
    expect(sanitizeTypedOutputName("Zelda: Hack")).toBe("Zelda Hack");
    expect(sanitizeTypedOutputName("Red/Blue Hack")).toBe("Red Blue Hack");
    expect(sanitizeTypedOutputName('a<b>c"d|e?f*g\\h')).toBe("a b c d e f g h");
  });

  it("strips control characters", () => {
    expect(sanitizeTypedOutputName("Zel\u0000da\n Hack")).toBe("Zelda Hack");
  });

  it("keeps non-ASCII, brackets, parentheses and dots", () => {
    expect(sanitizeTypedOutputName("Pokémon (Rev 1) [!] v2.2.bin")).toBe("Pokémon (Rev 1) [!] v2.2.bin");
  });

  it("returns empty for names that sanitize to nothing or non-strings", () => {
    expect(sanitizeTypedOutputName(" : / ")).toBe("");
    expect(sanitizeTypedOutputName(undefined)).toBe("");
    expect(sanitizeFileNamePart("???", "fallback")).toBe("fallback");
  });
});

describe("typed names across workflows", () => {
  it("apply: generated output name sanitizes a typed name and falls back when empty", () => {
    expect(getGeneratedOutputName("rom.sfc", ["p.bps"], { outputName: "Zelda: Hack" })).toBe("Zelda Hack");
    expect(getGeneratedOutputName("rom.sfc", ["p.bps"], { outputName: "Red/Blue Hack" })).toBe("Red Blue Hack");
    expect(getGeneratedOutputName("rom.sfc", ["p.bps"], { outputName: ":/" })).toBe(
      getGeneratedOutputName("rom.sfc", ["p.bps"], {}),
    );
  });

  it("apply: execution output name of a manual name is sanitized", () => {
    const state = createApplyOutputState({ output: { outputName: "Zelda: Hack" } });
    expect(getApplyExecutionOutputName(state, {}, "rom.sfc")).toBe("Zelda Hack");
  });

  it("create: execution output name is sanitized and keeps extension handling", () => {
    expect(resolveCreateExecutionOutputName("Zelda: Hack", "bps")).toBe("Zelda Hack.bps");
    expect(resolveCreateExecutionOutputName("Red/Blue Hack.bps", "bps")).toBe("Red Blue Hack.bps");
    expect(resolveCreateExecutionOutputName("Game 2.2", "xdelta")).toBe("Game 2.2.xdelta");
    expect(resolveCreateExecutionOutputName(":/", "bps")).toBe("");
  });

  it("create/trim: requireOutputName returns the sanitized name and rejects empty results", () => {
    expect(requireOutputName("Zelda: Hack.bps")).toBe("Zelda Hack.bps");
    expect(() => requireOutputName(" / ")).toThrow("output.outputName is required");
  });
});
