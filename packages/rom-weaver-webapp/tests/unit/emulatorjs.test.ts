import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { documentNodes, parseDocument } from "../../scripts/html-document.mjs";
import {
  createEmulatorDocument,
  createEmulatorGameIdentity,
} from "../../src/public/react/components/emulator-document.ts";
import {
  coreReadsChd,
  getEmulatorJsAspectRatio,
  getEmulatorJsCore,
} from "../../src/public/react/components/emulatorjs.ts";

describe("getEmulatorJsCore", () => {
  it("maps save editor platform ids to playable cores", () => {
    expect(getEmulatorJsCore("game-boy")).toBe("gb");
    expect(getEmulatorJsCore("game-boy-color")).toBe("gb");
    expect(getEmulatorJsCore("gba")).toBe("gba");
    expect(getEmulatorJsCore("nds")).toBe("nds");
    expect(getEmulatorJsCore("snes")).toBe("snes");
  });
  it("prefers the detected platform", () => {
    expect(getEmulatorJsCore("Nintendo Entertainment System", "game.sfc")).toBe("nes");
  });

  it("falls back to a supported filename", () => {
    expect(getEmulatorJsCore(undefined, "patched.sfc")).toBe("snes");
  });

  it("selects the self-hosted PSP core", () => {
    expect(getEmulatorJsCore("Sony Playstation Portable", "game.iso")).toBe("psp");
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
    expect(getEmulatorJsAspectRatio("psp")).toBe("30 / 17");
  });

  it("keeps the stacked DS screens portrait", () => {
    expect(getEmulatorJsAspectRatio("nds")).toBe("2 / 3");
  });

  it("falls back to 4:3 for consoles and unknown cores", () => {
    expect(getEmulatorJsAspectRatio("nes")).toBe("4 / 3");
    expect(getEmulatorJsAspectRatio(undefined)).toBe("4 / 3");
  });

  it("covers every core the app can select", () => {
    const cores = ["atari7800", "gb", "gba", "lynx", "n64", "nds", "nes", "psp", "psx"];
    for (const core of cores) expect(getEmulatorJsAspectRatio(core)).toMatch(/^\d+ \/ \d+$/);
  });
});

describe("createEmulatorDocument", () => {
  it("sends CHD saves and load requests under the canonical checksum", () => {
    const checksum = "a".repeat(40);
    const document = createEmulatorDocument("/data/", "blob:game", `${checksum}.chd`, "psx", { saveId: checksum });
    expect(document).toContain(`EJS_gameName = "${checksum}.chd"`);
    const source = document.indexOf('const source = "rom-weaver-emulator"');
    const script = document.slice(document.lastIndexOf("(() => {", source), document.indexOf("})();", source) + 5);
    const messages: unknown[] = [];
    const window = {
      parent: { postMessage: (message: unknown) => messages.push(message) },
      addEventListener: () => undefined,
    };
    const handlers = runInNewContext(`${script}; [EJS_onSaveSave, EJS_onLoadSave];`, {
      window,
      Uint8Array,
      ArrayBuffer,
    }) as [(payload: unknown) => void, () => void];
    handlers[0]({ save: new Uint8Array([1, 2]) });
    handlers[1]();
    expect(messages).toEqual([
      {
        source: "rom-weaver-emulator",
        kind: "save-sram",
        gameId: checksum,
        gameName: checksum,
        gameLabel: `${checksum}.chd`,
        data: new Uint8Array([1, 2]),
      },
      { source: "rom-weaver-emulator", kind: "request-load-sram", gameId: checksum, gameName: checksum },
    ]);
  });

  it("keeps an ISO's saves under the bare checksum written before the name kept its extension", () => {
    const checksum = "b".repeat(40);
    const identity = createEmulatorGameIdentity({ checksum, fileName: "Game.iso" });
    const document = createEmulatorDocument("/data/", "blob:game", identity.gameName, "segaSaturn", {
      gameId: identity.gameId,
      saveId: identity.saveId,
    });
    expect(document).toContain(`EJS_gameName = "${checksum}.iso"`);
    expect(document).toContain(`const gameId = "${checksum}"`);
    expect(document).toContain(`EJS_gameID = ${identity.gameId}`);
  });

  it.each([
    ["lowercase", "<script>", "</script>"],
    ["uppercase", "<SCRIPT>", "</SCRIPT>"],
    ["mixed case with attributes", '<ScRiPt type="text/javascript">', "</sCrIpT >"],
  ])("resolves a denied screen wake lock with %s script tags", async (_label, openingTag, closingTag) => {
    const document = createEmulatorDocument("/emulatorjs/data/", "blob:game", "game.nes", "nes")
      .replaceAll("<script>", openingTag)
      .replaceAll("</script>", closingTag);
    const script = [...documentNodes(parseDocument(document))]
      .filter((node) => node.tagName === "script" && node.sourceCodeLocation?.startTag)
      .map((node) => {
        const location = node.sourceCodeLocation;
        return document.slice(location.startTag.endOffset, location.endTag?.startOffset ?? location.endOffset);
      })
      .find((body) => body.includes("wakeLock"));
    expect(script).toBeDefined();
    const wakeLock = { request: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")) };
    runInNewContext(script ?? "", { navigator: { wakeLock } });

    const sentinel = await wakeLock.request("screen");
    expect(sentinel.released).toBe(true);
    await expect(sentinel.release()).resolves.toBeUndefined();
  });

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
    expect(document).toContain('request("sram-loaded");');
    expect(document).toContain('request("sram-load-failed");');
    expect(document).toContain(
      "if (emulator.gameManager.FS.analyzePath(path).exists) emulator.gameManager.FS.unlink(path);",
    );
  });

  it("reports playback only after the emulator starts", () => {
    const document = createEmulatorDocument("/emulatorjs/data/", "blob:game", "game.nes", "nes");
    const script = document.slice(
      document.indexOf("window.__romWeaverGameStarted = false"),
      document.indexOf("window.__romWeaverVisibilityPaused"),
    );
    const window: { __romWeaverGameStarted?: boolean } = {};
    const requests: string[] = [];
    const start = runInNewContext(`${script}; EJS_onGameStart;`, {
      window,
      request: (kind: string) => requests.push(kind),
    }) as () => void;
    expect(window.__romWeaverGameStarted).toBe(false);
    start();
    expect(window.__romWeaverGameStarted).toBe(true);
    expect(requests).toEqual(["request-load-sram"]);
  });

  it("restarts the game after importing SRAM before reporting success", () => {
    const document = createEmulatorDocument("/emulatorjs/data/", "blob:game", "game.gba", "gba");
    const source = document.indexOf('const source = "rom-weaver-emulator"');
    const script = document.slice(document.lastIndexOf("(() => {", source), document.indexOf("})();", source) + 5);
    const calls: string[] = [];
    let onMessage: ((event: { source: unknown; data: unknown }) => void) | undefined;
    const parent = { postMessage: (message: { kind: string }) => calls.push(message.kind) };
    const manager = {
      FS: {
        analyzePath: (path: string) => ({ exists: path === "/data" || path === "/data/saves" }),
        mkdir: () => calls.push("mkdir"),
        writeFile: () => calls.push("write"),
      },
      getSaveFilePath: () => "/data/saves/game.srm",
      loadSaveFiles: () => calls.push("load"),
      restart: () => calls.push("restart"),
    };
    const window = {
      EJS_emulator: { gameManager: manager },
      addEventListener: (_kind: string, listener: typeof onMessage) => {
        onMessage = listener;
      },
      parent,
    };

    runInNewContext(script, { window });
    onMessage?.({
      source: parent,
      data: {
        data: new Uint8Array([1, 2, 3]),
        gameId: "game.gba",
        kind: "load-sram",
        source: "rom-weaver-emulator",
      },
    });

    expect(calls).toEqual(["write", "load", "restart", "sram-loaded"]);
  });

  it("neutralizes the EmulatorJS version check before the loader runs", () => {
    const document = createEmulatorDocument("/emulatorjs/data/", "blob:game", "game.nes", "nes");
    const start = document.indexOf("Object.defineProperty(window, 'EmulatorJS'");
    const script = document.slice(document.lastIndexOf("(() => {", start), document.indexOf("})();", start) + 5);
    const scope: { EmulatorJS?: typeof FakeEmulatorJS } = {};
    let checked = false;

    class FakeEmulatorJS {
      constructor() {
        this.checkForUpdates();
      }
      checkForUpdates() {
        checked = true;
      }
    }

    runInNewContext(script, { window: scope });
    scope.EmulatorJS = FakeEmulatorJS;
    new (scope.EmulatorJS as typeof FakeEmulatorJS)();

    expect(checked).toBe(false);
    expect(scope.EmulatorJS).toBe(FakeEmulatorJS);
    expect(start).toBeLessThan(document.indexOf("loader.js"));
  });
});

describe("emulator game identity", () => {
  it("uses the ROM SHA-1 as the save key", () => {
    const checksum = "a9993e364706816aba3e25717850c26c9cd0d89d";
    expect(createEmulatorGameIdentity({ checksum }).gameName).toBe(checksum);
  });

  it("keeps the .chd extension on the name EmulatorJS writes into the core", () => {
    const checksum = "a9993e364706816aba3e25717850c26c9cd0d89d";
    const identity = createEmulatorGameIdentity({ checksum, fileName: "Game.CHD" });
    expect(identity.gameName).toBe(`${checksum}.chd`);
    expect(identity.saveId).toBe(checksum);
    expect(identity.gameId).toBe(createEmulatorGameIdentity({ checksum }).gameId);
  });

  it.each(["iso", "cue", "bin", "img", "mds", "ccd", "cso", "pbp", "m3u", "gdi", "toc", "mdf"])(
    "keeps the .%s extension of a disc image",
    (extension) => {
      const checksum = "a9993e364706816aba3e25717850c26c9cd0d89d";
      const identity = createEmulatorGameIdentity({ checksum, fileName: `Game.${extension.toUpperCase()}` });
      expect(identity.gameName).toBe(`${checksum}.${extension}`);
      expect(identity.saveId).toBe(checksum);
      expect(identity.gameId).toBe(createEmulatorGameIdentity({ checksum }).gameId);
    },
  );

  it("leaves cartridge ROMs and extensionless names on the bare checksum", () => {
    const checksum = "a9993e364706816aba3e25717850c26c9cd0d89d";
    expect(createEmulatorGameIdentity({ checksum, fileName: "game.nes" }).gameName).toBe(checksum);
    expect(createEmulatorGameIdentity({ checksum, fileName: "game.iso.txt" }).gameName).toBe(checksum);
    expect(createEmulatorGameIdentity({ checksum, fileName: "game" }).gameName).toBe(checksum);
  });

  it("rejects a non-SHA-1 identity", () => {
    expect(() => createEmulatorGameIdentity({ checksum: "12345678" })).toThrow(
      "The emulator game identity requires a SHA-1 checksum.",
    );
  });
});

describe("CHD pass-through cores", () => {
  it("passes a CHD to the cores whose reader handles it", () => {
    expect(coreReadsChd("psx")).toBe(true);
    expect(coreReadsChd("segaMD")).toBe(true);
  });

  it("extracts a Saturn CHD because yabause has no CHD reader", () => {
    expect(coreReadsChd("segaSaturn")).toBe(false);
  });

  it("extracts a CHD for every other core", () => {
    expect(coreReadsChd("psp")).toBe(false);
    expect(coreReadsChd(undefined)).toBe(false);
  });
});
