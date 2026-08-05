import { describe, expect, it } from "vitest";
import { createEmulatorDocument } from "../../src/public/react/components/emulatorjs-test.tsx";
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

describe("createEmulatorDocument", () => {
  it("selects the self-hosted non-threaded WebGL 2 core", () => {
    const document = createEmulatorDocument("/emulatorjs/data/", "blob:game", "game.nes", "nes");

    expect(document).toContain("EJS_DEBUG_XX = true");
    expect(document).toContain("webgl2Enabled: 'enabled'");
    expect(document).toContain("ejs_threads: 'disabled'");
    expect(document).toContain("EJS_disableLocalStorage = true");
  });
});
