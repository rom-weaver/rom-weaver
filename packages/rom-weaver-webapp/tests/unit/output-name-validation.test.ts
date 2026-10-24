import { describe, expect, it } from "vitest";
import {
  detectMismatchedExtension,
  detectOutputLikeExtension,
  getLiteralFileNameExtension,
  hasKnownOutputExtension,
  removeKnownOutputExtension,
  getOutputExtensions,
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

describe("detectMismatchedExtension", () => {
  it("flags a supported extension the output is not saved with", () => {
    expect(detectMismatchedExtension("game.gba", ["sfc"])).toBe("gba");
    expect(detectMismatchedExtension("Game.IPS", ["bps"])).toBe("ips");
    expect(detectMismatchedExtension("game.gba", ["sfc", "zip"])).toBe("gba");
  });

  it("accepts any extension the output is saved with, case-insensitively", () => {
    expect(detectMismatchedExtension("game.SFC", ["sfc"])).toBeNull();
    expect(detectMismatchedExtension("game.zip", ["sfc", ".zip"])).toBeNull();
  });

  it("ignores dotted base names and unknown output extensions", () => {
    expect(detectMismatchedExtension("Hack v1.2", ["sfc"])).toBeNull();
    expect(detectMismatchedExtension("Mario.Bros", ["sfc"])).toBeNull();
    expect(detectMismatchedExtension("game", ["sfc"])).toBeNull();
    expect(detectMismatchedExtension("game.gba", [])).toBeNull();
    expect(detectMismatchedExtension("game.gba", null)).toBeNull();
  });
});

describe("getOutputExtensions", () => {
  it("keeps the content extension first for raw and archive outputs", () => {
    expect(getOutputExtensions([".SFC"], "none")).toEqual(["sfc"]);
    expect(getOutputExtensions(["sfc"], "zip")).toEqual(["sfc", "zip"]);
    expect(getOutputExtensions(["sfc", "", null], "7z")).toEqual(["sfc", "7z"]);
  });

  it("puts a disc container first because it replaces the content extension", () => {
    expect(getOutputExtensions(["iso"], "chd")).toEqual(["chd", "iso"]);
  });

  it("ignores values that are not compression formats", () => {
    expect(getOutputExtensions(["bps"], undefined)).toEqual(["bps"]);
    expect(getOutputExtensions(["bps"], "auto")).toEqual(["bps"]);
  });

  it("reads # and ? as literal filename characters", () => {
    expect(detectOutputLikeExtension("Kaizo Mario #2.zip")).toBe("zip");
    expect(detectOutputLikeExtension("Why?.7z")).toBe("7z");
  });

  it("never reads a dotted segment with whitespace as an extension", () => {
    expect(getLiteralFileNameExtension("Super Mario Bros. 3")).toBe("");
    expect(getLiteralFileNameExtension("Dr. Mario (USA)")).toBe("");
    expect(getLiteralFileNameExtension("Dr. Mario (USA).nes")).toBe("nes");
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

  it("keeps an extension after a literal # or ?", () => {
    expect(withOutputExtension("Kaizo Mario #2.sfc", "sfc")).toBe("Kaizo Mario #2.sfc");
    expect(withOutputExtension("Hack.v2#2.nes", "nes")).toBe("Hack.v2#2.nes");
    expect(withOutputExtension("Why?.SFC", "sfc")).toBe("Why?.SFC");
  });

  it("appends the source extension after a dot before a literal # or ?", () => {
    expect(withOutputExtension("Hack.v2#2", "nes")).toBe("Hack.v2#2.nes");
    expect(withOutputExtension("Hack.nes#2", "nes")).toBe("Hack.nes#2.nes");
    expect(withOutputExtension("Hack.nes?v=2", "nes")).toBe("Hack.nes?v=2.nes");
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

  it("reads the suffix after a literal # or ?", () => {
    expect(hasKnownOutputExtension("Kaizo Mario #2.sfc")).toBe(true);
    expect(hasKnownOutputExtension("Hack.v2#2.nes")).toBe(true);
    expect(hasKnownOutputExtension("Hack.nes#2")).toBe(false);
    expect(hasKnownOutputExtension("Hack.nes?v=2")).toBe(false);
  });
});

describe("removeKnownOutputExtension", () => {
  it("removes only a known trailing extension", () => {
    expect(removeKnownOutputExtension("Practice 3.5.1.NES")).toBe("Practice 3.5.1");
    expect(removeKnownOutputExtension("Practice 3.5.1")).toBe("Practice 3.5.1");
    expect(removeKnownOutputExtension("game.zip")).toBe("game");
  });

  it("keeps the whole stem around a literal # or ?", () => {
    expect(removeKnownOutputExtension("Hack #2.nes")).toBe("Hack #2");
    expect(removeKnownOutputExtension("Hack.v2#2.nes")).toBe("Hack.v2#2");
    expect(removeKnownOutputExtension("Hack.nes#2")).toBe("Hack.nes#2");
    expect(removeKnownOutputExtension("Why?.sfc")).toBe("Why?");
  });
});
