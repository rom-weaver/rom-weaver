import { describe, expect, it } from "vitest";
import { formatHeaderAutoLabel } from "../../src/public/react/patcher-view-models.ts";

/**
 * The page can only predict the header outcome when a checksum decided it.
 * Otherwise the engine decides during the apply, from where the patch's records
 * land, so the label must not name an outcome the run can contradict.
 */
describe("formatHeaderAutoLabel", () => {
  it("names the outcome when a checksum decided it", () => {
    expect(formatHeaderAutoLabel(true, "strip")).toBe("header auto (strip)");
    expect(formatHeaderAutoLabel(true, "keep")).toBe("header auto (keep)");
  });

  it("names no outcome when nothing decided it", () => {
    // An IPS patch has no source checksum, so the engine may still strip. The
    // old label claimed "keep" here and could be contradicted by the run.
    expect(formatHeaderAutoLabel(false, undefined)).toBe("header auto");
    expect(formatHeaderAutoLabel(false, "keep")).toBe("header auto");
  });

  it("falls back to keep only when a decided mode is missing", () => {
    expect(formatHeaderAutoLabel(true, undefined)).toBe("header auto (keep)");
  });
});

describe("formatHeaderAutoLabel with a missing decided flag", () => {
  it("treats undefined as undecided", () => {
    expect(formatHeaderAutoLabel(undefined, "strip")).toBe("header auto");
  });
});
