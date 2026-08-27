import { describe, expect, it } from "vitest";
import {
  createEmulatorDocument,
  createEmulatorGameIdentity,
} from "../../src/public/react/components/emulator-document.ts";
import { getEmulatorJsAspectRatio, getEmulatorJsCore } from "../../src/public/react/components/emulatorjs.ts";

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

  it("does not override a detected unsupported platform with the file extension", () => {
    expect(getEmulatorJsCore("Nintendo Wii", "game.nes")).toBeUndefined();
  });

  it("returns undefined for unknown files", () => {
    expect(getEmulatorJsCore(undefined, "patched.bin")).toBeUndefined();
  });
});

describe("getEmulatorJsAspectRatio", () => {
  it("gives handhelds their own shape", () => {
    expect(getEmulatorJsAspectRatio("gba")).toBe("3 / 2");
    expect(getEmulatorJsAspectRatio("gb")).toBe("10 / 9");
  });

  it("keeps the stacked DS screens portrait", () => {
    expect(getEmulatorJsAspectRatio("nds")).toBe("2 / 3");
  });

  it("falls back to 4:3 for consoles and unknown cores", () => {
    expect(getEmulatorJsAspectRatio("nes")).toBe("4 / 3");
    expect(getEmulatorJsAspectRatio(undefined)).toBe("4 / 3");
  });

  it("covers every core the app can select", () => {
    const cores = ["atari7800", "gb", "gba", "lynx", "n64", "nds", "nes", "psx"];
    for (const core of cores) expect(getEmulatorJsAspectRatio(core)).toMatch(/^\d+ \/ \d+$/);
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
    expect(document).toContain("navigator.audioSession.type = 'playback'");
    expect(document).toContain("bridge.takePrepared");
    expect(document).toContain("romWeaverHasPreparedAudio");
    expect(document).toContain("EJS_ready");
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

describe("emulator game identity", () => {
  it("uses the ROM SHA-1 as the save key", () => {
    const checksum = "a9993e364706816aba3e25717850c26c9cd0d89d";
    expect(createEmulatorGameIdentity({ checksum }).gameName).toBe(checksum);
  });

  it("rejects a non-SHA-1 identity", () => {
    expect(() => createEmulatorGameIdentity({ checksum: "12345678" })).toThrow(
      "The emulator game identity requires a SHA-1 checksum.",
    );
  });
});
