import { describe, expect, it } from "vitest";
import { getPatchHeaderModes } from "../../src/lib/apply/workflow.ts";

/**
 * What the engine is told about each patch's header. An explicit user choice
 * wins; everything else is `auto` so the engine's own basis inference runs.
 *
 * The first patch used to default to `keep`, which silently discarded that
 * inference for exactly the patches that need it: the checksumless ones (IPS),
 * where nothing on this side can work the basis out.
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
