import { describe, expect, it } from "vitest";
import { getPatchHeaderModes } from "../../src/lib/apply/workflow.ts";

/**
 * Explicit header choices reach the engine unchanged; all other patches use Auto so engine inference can run.
 */
describe("getPatchHeaderModes", () => {
  it("sends auto for a first patch the user did not choose for", () => {
    expect(getPatchHeaderModes([0], undefined)).toEqual(["auto"]);
    expect(getPatchHeaderModes([0], [{}])).toEqual(["auto"]);
  });

  it("keeps an explicit choice at any position", () => {
    expect(getPatchHeaderModes([0, 1], [{ header: "strip" }, { header: "keep" }])).toEqual(["strip", "keep"]);
  });

  it("sends auto for later patches too", () => {
    expect(getPatchHeaderModes([0, 1, 2], [{ header: "keep" }])).toEqual(["keep", "auto", "auto"]);
  });

  it("maps each index through its own options entry", () => {
    expect(getPatchHeaderModes([2, 0], [{ header: "keep" }, {}, { header: "strip" }])).toEqual(["strip", "keep"]);
  });
});
