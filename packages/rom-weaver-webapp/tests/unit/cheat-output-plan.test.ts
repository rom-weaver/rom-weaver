import { describe, expect, it } from "vitest";
import { getCheatOutputMode } from "../../src/lib/apply/workflow.ts";

describe("cheat output planning", () => {
  it("keeps the normal ROM output when no runtime cheat is selected", () => {
    expect(getCheatOutputMode(1, 0, 0)).toBe("rom");
    expect(getCheatOutputMode(0, 1, 0)).toBe("rom");
  });

  it("creates only a cheat file for a runtime-only workflow", () => {
    expect(getCheatOutputMode(0, 0, 1)).toBe("runtime-only");
  });

  it("packages ROM work and runtime cheats together", () => {
    expect(getCheatOutputMode(1, 0, 1)).toBe("rom-and-runtime");
    expect(getCheatOutputMode(0, 1, 1)).toBe("rom-and-runtime");
  });
});
