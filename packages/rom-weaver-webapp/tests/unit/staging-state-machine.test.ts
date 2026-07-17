import { describe, expect, it } from "vitest";
import { hasSameRecordValues } from "../../src/public/react/apply-session-staging-state-machine.ts";

// Guards the shallow record comparison used to skip re-staging when the patch
// info/progress maps are effectively unchanged.
describe("hasSameRecordValues", () => {
  it("is true for the same keys and reference-equal values", () => {
    const value = { a: 1 };
    expect(hasSameRecordValues({ x: value }, { x: value })).toBe(true);
  });

  it("is false when key counts differ", () => {
    expect(hasSameRecordValues({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("is false when a value reference changes", () => {
    expect(hasSameRecordValues({ a: { n: 1 } }, { a: { n: 1 } })).toBe(false);
  });

  it("is true for two empty records", () => {
    expect(hasSameRecordValues({}, {})).toBe(true);
  });
});
