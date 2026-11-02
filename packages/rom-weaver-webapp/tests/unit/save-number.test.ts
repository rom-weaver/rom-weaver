import { describe, expect, it } from "vitest";
import {
  normalizeSaveNumberText,
  parseSaveNumber,
  saveNumberFraction,
  saveNumberKeyTarget,
  snapSaveNumber,
} from "../../src/lib/runtime/save-number.ts";

describe("normalizeSaveNumberText", () => {
  it("drops grouping characters", () => {
    expect(normalizeSaveNumberText(" 48,200 ")).toBe("48200");
    expect(normalizeSaveNumberText("1 284_930")).toBe("1284930");
  });

  it("expands k, m and b shorthand", () => {
    expect(normalizeSaveNumberText("50k")).toBe("50000");
    expect(normalizeSaveNumberText("1.5M")).toBe("1500000");
    expect(normalizeSaveNumberText("4b")).toBe("4000000000");
    expect(normalizeSaveNumberText("-2k")).toBe("-2000");
  });

  it("reads the grouping and decimal marks of the locale", () => {
    expect(normalizeSaveNumberText("48.200", "de-DE")).toBe("48200");
    expect(normalizeSaveNumberText("1,5m", "de-DE")).toBe("1500000");
    expect(normalizeSaveNumberText("48.200", "es-ES")).toBe("48200");
    expect(normalizeSaveNumberText("48,200", "en-US")).toBe("48200");
  });

  it("rejects grouping marks that do not split digits in threes", () => {
    expect(normalizeSaveNumberText("1.5k", "de-DE")).toBe("1.5k");
    expect(normalizeSaveNumberText("1.5k", "es-ES")).toBe("1.5k");
    expect(normalizeSaveNumberText("1,5k", "en-US")).toBe("1,5k");
    expect(normalizeSaveNumberText("12,34", "en-US")).toBe("12,34");
    expect(normalizeSaveNumberText("1.234.567", "de-DE")).toBe("1234567");
  });

  it("falls back to English marks for an unknown locale", () => {
    expect(normalizeSaveNumberText("48,200", "not a locale")).toBe("48200");
  });

  it("passes text that is not a number through for validation to reject", () => {
    expect(normalizeSaveNumberText("abc")).toBe("abc");
    expect(normalizeSaveNumberText("12x")).toBe("12x");
    expect(normalizeSaveNumberText("")).toBe("");
  });
});

describe("parseSaveNumber", () => {
  it("returns null for empty or non-numeric text", () => {
    expect(parseSaveNumber("")).toBeNull();
    expect(parseSaveNumber("  ")).toBeNull();
    expect(parseSaveNumber("12x")).toBeNull();
    expect(parseSaveNumber("Infinity")).toBeNull();
  });

  it("reads integers, negatives, and values above 32 bits", () => {
    expect(parseSaveNumber("5000")).toBe(5000);
    expect(parseSaveNumber("-3")).toBe(-3);
    expect(parseSaveNumber("4294967295")).toBe(4_294_967_295);
  });
});

describe("snapSaveNumber", () => {
  it("rounds to the step grid anchored at the minimum", () => {
    expect(snapSaveNumber(1049, 0, 9999, 100)).toBe(1000);
    expect(snapSaveNumber(1051, 0, 9999, 100)).toBe(1100);
    expect(snapSaveNumber(7, 3, 99, 5)).toBe(8);
  });

  it("stays inside the range when the maximum is off the step grid", () => {
    expect(snapSaveNumber(9999, 0, 9999, 100)).toBe(9900);
    expect(snapSaveNumber(-50, 0, 9999, 100)).toBe(0);
  });

  it("treats a zero or missing step as one", () => {
    expect(snapSaveNumber(41.6, 0, 100, 0)).toBe(42);
  });
});

describe("saveNumberFraction", () => {
  it("places a value between the ends and clamps outside them", () => {
    expect(saveNumberFraction(50, 0, 100)).toBe(0.5);
    expect(saveNumberFraction(-5, 0, 100)).toBe(0);
    expect(saveNumberFraction(500, 0, 100)).toBe(1);
  });

  it("returns 0 for an empty range", () => {
    expect(saveNumberFraction(5, 5, 5)).toBe(0);
  });
});

describe("saveNumberKeyTarget", () => {
  const range = { max: 999_999, min: 0, step: 1000 };

  it("steps with the arrows, ten steps with Shift", () => {
    expect(saveNumberKeyTarget("ArrowRight", false, 5000, range)).toBe(6000);
    expect(saveNumberKeyTarget("ArrowUp", true, 5000, range)).toBe(15_000);
    expect(saveNumberKeyTarget("ArrowLeft", false, 5000, range)).toBe(4000);
    expect(saveNumberKeyTarget("ArrowDown", true, 5000, range)).toBe(-5000);
  });

  it("steps by ten with Page Up and Page Down", () => {
    expect(saveNumberKeyTarget("PageUp", false, 0, range)).toBe(10_000);
    expect(saveNumberKeyTarget("PageDown", false, 20_000, range)).toBe(10_000);
  });

  it("jumps to the ends with Home and End and ignores other keys", () => {
    expect(saveNumberKeyTarget("Home", false, 5000, range)).toBe(0);
    expect(saveNumberKeyTarget("End", false, 5000, range)).toBe(999_999);
    expect(saveNumberKeyTarget("a", false, 5000, range)).toBeNull();
  });
});
