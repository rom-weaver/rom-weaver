import { describe, expect, it } from "vitest";
import { patchInputOverridesForRuntime, resolvePatchInputBases } from "../../src/public/react/patch-input-basis.ts";

describe("patch input rules", () => {
  it("maps the shared base, previous, and automatic modes", () => {
    expect(resolvePatchInputBases({ mode: "base", overrides: [undefined, undefined] })).toEqual(["base", "base"]);
    expect(resolvePatchInputBases({ mode: "previous", overrides: [undefined, undefined] })).toEqual([
      "base",
      "previous",
    ]);
    expect(resolvePatchInputBases({ mode: "auto", overrides: [undefined, undefined] })).toEqual(["base", "auto"]);
  });

  it("skips disabled patches when it resolves previous output", () => {
    expect(resolvePatchInputBases({ disabled: [true, false, false], mode: "previous", overrides: [] })).toEqual([
      "base",
      "base",
      "previous",
    ]);
  });

  it("always resolves the first enabled patch against the original ROM", () => {
    expect(resolvePatchInputBases({ mode: "base", overrides: ["previous", undefined] })).toEqual(["base", "base"]);
    expect(
      resolvePatchInputBases({ disabled: [true, false], mode: "auto", overrides: ["previous", "previous"] }),
    ).toEqual(["base", "base"]);
  });

  it("sends a concrete vector only when an override differs from the shared rule", () => {
    expect(patchInputOverridesForRuntime({ mode: "base", overrides: [undefined, "previous"] })).toEqual([
      "base",
      "previous",
    ]);
    expect(patchInputOverridesForRuntime({ mode: "auto", overrides: [undefined, "base"] })).toEqual(["auto", "base"]);
    expect(patchInputOverridesForRuntime({ mode: "previous", overrides: [undefined, undefined] })).toBeUndefined();
  });
});
