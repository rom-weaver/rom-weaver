import { describe, expect, it } from "vitest";
import { createEmulatorDocument } from "../../src/public/react/components/emulator-document.ts";
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
  it("selects the self-hosted threaded WebGL 2 core", () => {
    const document = createEmulatorDocument("/emulatorjs/data/", "blob:game", "game.nes", "nes");

    expect(document).toContain("EJS_DEBUG_XX = false");
    expect(document).toContain("EJS_threads = true");
    expect(document).toContain("webgl2Enabled: 'enabled'");
    expect(document).toContain("ejs_threads: 'enabled'");
    expect(document).toContain("EJS_hideSettings = ['ejs_threads', 'webgl2Enabled']");
    expect(document).toContain("EJS_disableLocalStorage = false");
    expect(document).toContain("EJS_onSaveState");
    expect(document).toContain("EJS_onSaveSave");
  });

  it("clears both hidden settings before the loader runs", () => {
    const document = createEmulatorDocument("/emulatorjs/data/", "blob:game", "game.nes", "nes");

    expect(document).toContain("const hidden = ['ejs_threads', 'webgl2Enabled'];");
    expect(document).toContain("for (const name of stale) delete stored.settings[name];");
    expect(document.indexOf("const hidden = [")).toBeLessThan(document.indexOf("loader.js"));
  });

  it("requests app-owned SRAM when the emulator starts", () => {
    const document = createEmulatorDocument("/emulatorjs/data/", "blob:game", "game.nes", "nes");
    const gameStart = document.slice(
      document.indexOf("EJS_onGameStart"),
      document.indexOf("window.__romWeaverVisibilityPaused"),
    );

    expect(gameStart).toContain('request("request-load-sram");');
    expect(document).toContain(
      "if (emulator.gameManager.FS.analyzePath(path).exists) emulator.gameManager.FS.unlink(path);",
    );
  });
});
