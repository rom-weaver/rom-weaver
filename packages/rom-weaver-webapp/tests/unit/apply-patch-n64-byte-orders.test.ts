import { describe, expect, it } from "vitest";
import { getPatchN64ByteOrders } from "../../src/lib/apply/workflow.ts";

/**
 * Use an explicit N64 byte order first, then a checksum-proven order; otherwise leave the engine on Auto.
 */
describe("getPatchN64ByteOrders", () => {
  it("sends auto for a first patch nothing decided", () => {
    expect(getPatchN64ByteOrders([0], undefined)).toEqual(["auto"]);
    expect(getPatchN64ByteOrders([0], [{}])).toEqual(["auto"]);
  });

  it("keeps an explicit choice at any position", () => {
    expect(getPatchN64ByteOrders([0, 1], [{ n64ByteOrder: "byte-swapped" }, { n64ByteOrder: "keep" }])).toEqual([
      "byte-swapped",
      "keep",
    ]);
  });

  it("sends a checksum-proven order", () => {
    expect(getPatchN64ByteOrders([0], [{ resolvedN64ByteOrder: "big-endian" }])).toEqual(["big-endian"]);
  });

  it("lets an explicit choice override a proven order", () => {
    expect(getPatchN64ByteOrders([0], [{ n64ByteOrder: "keep", resolvedN64ByteOrder: "big-endian" }])).toEqual([
      "keep",
    ]);
  });

  it("sends auto for later patches too", () => {
    expect(getPatchN64ByteOrders([0, 1, 2], [{ n64ByteOrder: "keep" }])).toEqual(["keep", "auto", "auto"]);
  });

  it("maps each index through its own options entry", () => {
    expect(getPatchN64ByteOrders([2, 0], [{ n64ByteOrder: "keep" }, {}, { n64ByteOrder: "little-endian" }])).toEqual([
      "little-endian",
      "keep",
    ]);
  });
});
