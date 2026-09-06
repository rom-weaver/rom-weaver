import { describe, expect, it } from "vitest";
import { CHEAT_HEADER_STRIP_MESSAGE, getCheatHeaderStripConflict } from "../../src/lib/cheats/header-guard.ts";

describe("getCheatHeaderStripConflict", () => {
  it("stays quiet while no cheat is switched on", () => {
    expect(getCheatHeaderStripConflict({ cheatsOn: false, outputHeader: "strip", patchHeaderModes: ["strip"] })).toBe(
      "",
    );
  });

  it("reports an output header strip", () => {
    expect(getCheatHeaderStripConflict({ cheatsOn: true, outputHeader: "strip" })).toBe(CHEAT_HEADER_STRIP_MESSAGE);
  });

  it("reports a per-patch header strip", () => {
    expect(
      getCheatHeaderStripConflict({ cheatsOn: true, outputHeader: "keep", patchHeaderModes: ["keep", "strip"] }),
    ).toBe(CHEAT_HEADER_STRIP_MESSAGE);
  });

  it("leaves auto and keep alone", () => {
    expect(
      getCheatHeaderStripConflict({ cheatsOn: true, outputHeader: "auto", patchHeaderModes: ["auto", undefined] }),
    ).toBe("");
    expect(getCheatHeaderStripConflict({ cheatsOn: true, outputHeader: "keep", patchHeaderModes: [] })).toBe("");
    expect(getCheatHeaderStripConflict({ cheatsOn: true })).toBe("");
  });
});
