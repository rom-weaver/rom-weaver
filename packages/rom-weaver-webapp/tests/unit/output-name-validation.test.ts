import { describe, expect, it } from "vitest";
import {
  detectOutputLikeExtension,
  hasKnownOutputExtension,
  requireOutputName,
  withOutputExtension,
} from "../../src/lib/output/output-name-validation.ts";

describe("detectOutputLikeExtension", () => {
  it("flags archive output extensions", () => {
    expect(detectOutputLikeExtension("game.zip")).toBe("zip");
    expect(detectOutputLikeExtension("game.7z")).toBe("7z");
  });

  it("flags rom-specific container output extensions", () => {
    expect(detectOutputLikeExtension("disc.chd")).toBe("chd");
    expect(detectOutputLikeExtension("disc.rvz")).toBe("rvz");
    expect(detectOutputLikeExtension("cart.z3ds")).toBe("z3ds");
  });

  it("flags z3ds subtype extensions", () => {
    expect(detectOutputLikeExtension("cart.zcia")).toBe("zcia");
  });

  it("is case-insensitive", () => {
    expect(detectOutputLikeExtension("Game.ZIP")).toBe("zip");
  });

  it("ignores non-output extensions and bare names", () => {
    expect(detectOutputLikeExtension("game.sfc")).toBeNull();
    expect(detectOutputLikeExtension("game")).toBeNull();
    expect(detectOutputLikeExtension("")).toBeNull();
    expect(detectOutputLikeExtension(null)).toBeNull();
    expect(detectOutputLikeExtension(undefined)).toBeNull();
  });
});

describe("requireOutputName", () => {
  it("returns the trimmed name", () => {
    expect(requireOutputName("  game  ")).toBe("game");
  });

  it("throws when empty", () => {
    expect(() => requireOutputName("   ")).toThrow("output.outputName is required");
  });
});

describe("withOutputExtension", () => {
  it("appends the source extension after a version segment", () => {
    expect(withOutputExtension("Practice 3.5.1", "nes")).toBe("Practice 3.5.1.nes");
    expect(withOutputExtension("Rev.A", ".nes")).toBe("Rev.A.nes");
  });

  it("keeps the source extension or another known one", () => {
    expect(withOutputExtension("Practice 3.5.1.NES", "nes")).toBe("Practice 3.5.1.NES");
    expect(withOutputExtension("game.sfc", "nes")).toBe("game.sfc");
    expect(withOutputExtension("game.custom", "custom")).toBe("game.custom");
  });

  it("leaves the name alone without a source extension", () => {
    expect(withOutputExtension("Practice 3.5.1", "")).toBe("Practice 3.5.1");
  });
});

describe("hasKnownOutputExtension", () => {
  it("does not treat a version segment as an extension", () => {
    expect(hasKnownOutputExtension("Practice 3.5.1")).toBe(false);
    expect(hasKnownOutputExtension("Practice 3.5.1.nes")).toBe(true);
    expect(hasKnownOutputExtension("Practice")).toBe(false);
  });
});
