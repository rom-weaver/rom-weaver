import { describe, expect, it } from "vitest";
import { getEmulatorJsCore } from "../../src/public/react/components/emulatorjs.ts";

describe("getEmulatorJsCore", () => {
  it("prefers the detected platform", () => {
    expect(getEmulatorJsCore("Nintendo Entertainment System", "game.sfc")).toBe("nes");
  });

  it("falls back to a supported filename", () => {
    expect(getEmulatorJsCore(undefined, "patched.sfc")).toBe("snes");
  });

  it("does not advertise cores that are not self-hosted", () => {
    expect(getEmulatorJsCore("Sony Playstation Portable", "game.iso")).toBeUndefined();
  });

  it("returns undefined for unknown files", () => {
    expect(getEmulatorJsCore(undefined, "patched.bin")).toBeUndefined();
  });
});
