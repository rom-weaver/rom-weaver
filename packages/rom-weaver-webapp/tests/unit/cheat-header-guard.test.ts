import { describe, expect, it } from "vitest";
import { CHEAT_HEADER_STRIP_MESSAGE, getCheatHeaderStripConflict } from "../../src/lib/cheats/header-guard.ts";

describe("getCheatHeaderStripConflict", () => {
  it("stays quiet while no cheat is switched on", () => {
    expect(getCheatHeaderStripConflict({ cheatsOn: false, patchHeaderModes: ["strip"] })).toBe("");
  });

  it("reports a per-patch header strip", () => {
    expect(getCheatHeaderStripConflict({ cheatsOn: true, patchHeaderModes: ["keep", "strip"] })).toBe(
      CHEAT_HEADER_STRIP_MESSAGE,
    );
  });

  it("reports a decided auto resolution the caller passed as strip", () => {
    const headerChoice = undefined;
    const headerAutoDecided = true;
    const headerAutoMode = "strip" as const;
    const sent = headerChoice ?? (headerAutoDecided ? headerAutoMode : undefined);
    expect(getCheatHeaderStripConflict({ cheatsOn: true, patchHeaderModes: [sent] })).toBe(CHEAT_HEADER_STRIP_MESSAGE);
  });

  it("leaves auto and keep alone", () => {
    expect(getCheatHeaderStripConflict({ cheatsOn: true, patchHeaderModes: ["auto", undefined] })).toBe("");
    expect(getCheatHeaderStripConflict({ cheatsOn: true, patchHeaderModes: [] })).toBe("");
    expect(getCheatHeaderStripConflict({ cheatsOn: true })).toBe("");
  });
});
