import { describe, expect, it } from "vitest";
import {
  fillPlaceholders,
  findPlaceholders,
  isPlaceholderValueComplete,
  placeholderDecimal,
  placeholderHint,
  placeholderMaximum,
} from "../../src/lib/cheats/parameter.ts";

describe("findPlaceholders", () => {
  it("finds a question-mark run of any width", () => {
    expect(findPlaceholders("0010?")).toEqual([{ index: 4, width: 1, character: "?" }]);
    expect(findPlaceholders("00??:??")).toEqual([
      { index: 2, width: 2, character: "?" },
      { index: 5, width: 2, character: "?" },
    ]);
  });

  it("finds letter runs of two or more, and ignores a lone hex X", () => {
    expect(findPlaceholders("7E0DBEXX")).toEqual([{ index: 6, width: 2, character: "X" }]);
    expect(findPlaceholders("80309437 XXXX")).toEqual([{ index: 9, width: 4, character: "X" }]);
    expect(findPlaceholders("0010X0")).toEqual([]);
  });

  it("normalizes a lowercase run and keeps runs of different characters apart", () => {
    expect(findPlaceholders("00xx?")).toEqual([
      { index: 2, width: 2, character: "X" },
      { index: 4, width: 1, character: "?" },
    ]);
  });

  it("returns nothing for a plain code or a missing code", () => {
    expect(findPlaceholders("7E0DBE3F")).toEqual([]);
    expect(findPlaceholders(null)).toEqual([]);
    expect(findPlaceholders(undefined)).toEqual([]);
  });
});

describe("fillPlaceholders", () => {
  it("substitutes each run, uppercased", () => {
    expect(fillPlaceholders("7E0DBEXX", ["3f"])).toBe("7E0DBE3F");
    expect(fillPlaceholders("00??:??", ["1a", "02"])).toBe("001A:02");
  });

  it("returns undefined until every run holds its full width of hex", () => {
    expect(fillPlaceholders("00??:??", ["1a"])).toBeUndefined();
    expect(fillPlaceholders("7E0DBEXX", ["ZZ"])).toBeUndefined();
    expect(fillPlaceholders("7E0DBEXX", ["1234"])).toBeUndefined();
    expect(fillPlaceholders("7E0DBEXX", ["7"])).toBeUndefined();
    expect(fillPlaceholders("7E0DBEXX", [""])).toBeUndefined();
    expect(fillPlaceholders("7E0DBE3F", ["01"])).toBeUndefined();
    expect(fillPlaceholders(null, ["01"])).toBeUndefined();
  });
});

describe("value readouts", () => {
  it("states the range for the run width", () => {
    expect(placeholderMaximum(1)).toBe("F");
    expect(placeholderMaximum(2)).toBe("FF");
    expect(placeholderHint(1)).toBe("hex · 1 digit · 0 to F");
    expect(placeholderHint(4)).toBe("hex · 4 digits · 0 to FFFF");
  });

  it("reads a hex value as decimal", () => {
    expect(placeholderDecimal("63")).toBe(99);
    expect(placeholderDecimal(" ff ")).toBe(255);
    expect(placeholderDecimal("zz")).toBeUndefined();
    expect(placeholderDecimal("")).toBeUndefined();
  });

  it("accepts a value only at the run's full width", () => {
    const run = { index: 6, width: 2, character: "X" } as const;
    expect(isPlaceholderValueComplete(run, "3F")).toBe(true);
    expect(isPlaceholderValueComplete(run, "3")).toBe(false);
    expect(isPlaceholderValueComplete(run, "3FF")).toBe(false);
    expect(isPlaceholderValueComplete(run, undefined)).toBe(false);
  });
});
