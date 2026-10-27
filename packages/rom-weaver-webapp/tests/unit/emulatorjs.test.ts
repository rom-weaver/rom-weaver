import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { documentNodes, parseDocument } from "../../scripts/html-document.mjs";
import {
  createEmulatorDocument,
  createEmulatorGameIdentity,
} from "../../src/public/react/components/emulator-document.ts";
import { createEmulatorGameUrl, revokeEmulatorGameUrl } from "../../src/public/react/emulator-game-urls.ts";
import {
  coreReadsChd,
  getEmulatorJsAspectRatio,
  getEmulatorJsCore,
  hasFdsDiskSignature,
  requiresUnsuppliedBios,
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

/** The libretro core EmulatorJS 4.2.3 picks first for each system the app can select. */
const EMULATORJS_SYSTEM_CORES: Readonly<Record<string, string>> = {
  atari7800: "prosystem",
  gb: "gambatte",
  gba: "mgba",
  lynx: "handy",
  n64: "mupen64plus_next",
  nds: "melonds",
  nes: "fceumm",
  psp: "ppsspp",
  psx: "pcsx_rearmed",
  segaGG: "genesis_plus_gx",
  segaMD: "genesis_plus_gx",
  segaMS: "smsplus",
  segaSaturn: "yabause",
  snes: "snes9x",
};

const vendoredEmulatorFiles = Object.keys(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../vendor/emulatorjs.lock.json", import.meta.url)), "utf8")).files,
);

const readEmulatorConfig = (system: string) => {
  const document = createEmulatorDocument("/emulatorjs/data/", "blob:game", "game", system);
  const script = document.slice(document.indexOf("<script>") + "<script>".length, document.indexOf("</script>"));
  const window: Record<string, unknown> = {};
  window.parent = window;
  const context: Record<string, unknown> = { navigator: { maxTouchPoints: 0 }, window };
  runInNewContext(script, context);
  return context as { EJS_threads: boolean; EJS_defaultOptions: Record<string, string> };
};

describe("createEmulatorDocument", () => {
  it("runs Saturn on the single-threaded yabause build", () => {
    const config = readEmulatorConfig("segaSaturn");

    expect(config.EJS_threads).toBe(false);
    expect(config.EJS_defaultOptions.ejs_threads).toBe("disabled");
  });

  it.each(Object.entries(EMULATORJS_SYSTEM_CORES))("requests a vendored WebGL 2 build for %s", (system, core) => {
    const config = readEmulatorConfig(system);
    const threads = config.EJS_defaultOptions.ejs_threads === "enabled";

    expect(config.EJS_threads).toBe(threads);
    expect(config.EJS_defaultOptions.webgl2Enabled).toBe("enabled");
    expect(vendoredEmulatorFiles).toContain(`cores/${core}${threads ? "-thread" : ""}-wasm.data`);
  });

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

  it("copies settings saved under the bare checksum to the extension-bearing key", () => {
    const checksum = "b".repeat(40);
    const identity = createEmulatorGameIdentity({ checksum, fileName: "Game.iso" });
    const document = createEmulatorDocument("/data/", "blob:game", identity.gameName, "segaSaturn", {
      gameId: identity.gameId,
      saveId: identity.saveId,
    });
    const script = document.split("<script>").find((part) => part.includes("const bare ="));
    const store = new Map([[`ejs-${identity.gameId}-saturn-${checksum}-settings`, "saved"]]);
    const localStorage = {
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    runInNewContext(script?.split("</script>")[0] ?? "", { console, localStorage });
    expect(store.get(`ejs-${identity.gameId}-saturn-${checksum}.iso-settings`)).toBe("saved");
    expect(store.get(`ejs-${identity.gameId}-saturn-${checksum}-settings`)).toBe("saved");
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

  it("names every EmulatorJS bar button from its own text", () => {
    const document = createEmulatorDocument("/emulatorjs/data/", "blob:game", "game.nes", "nes");
    const script = document.slice(
      document.indexOf("const label = () => {"),
      document.indexOf("new MutationObserver(label)"),
    );
    const attributes = new Map<string, string>();
    const mute = {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      hasAttribute: (name: string) => attributes.has(name),
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      textContent: " Mute ",
    };
    runInNewContext(`${script}; label();`, { document: { querySelectorAll: () => [mute] } });
    expect(attributes.get("aria-label")).toBe("Mute");
    expect(document.indexOf("new MutationObserver(label)")).toBeLessThan(document.indexOf("loader.js"));
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

  it("writes the in-game save when the hidden Test view pauses a started game", () => {
    const document = createEmulatorDocument("/emulatorjs/data/", "blob:game", "game.gba", "gba");
    const source = document.indexOf('const source = "rom-weaver-emulator"');
    const script = document.slice(document.lastIndexOf("(() => {", source), document.indexOf("})();", source) + 5);
    const calls: string[] = [];
    let onMessage: ((event: { source: unknown; data: unknown }) => void) | undefined;
    const parent = { postMessage: (message: { kind: string }) => calls.push(message.kind) };
    const emulator = {
      gameManager: { saveSaveFiles: () => calls.push("save") },
      pause: () => {
        calls.push("pause");
        emulator.paused = true;
      },
      paused: false,
      started: true,
    };
    const window = {
      EJS_emulator: emulator,
      addEventListener: (_kind: string, listener: typeof onMessage) => {
        onMessage = listener;
      },
      parent,
    };
    const pause = { gameId: "game.gba", kind: "visibility-pause", source: "rom-weaver-emulator" };

    runInNewContext(script, { window });
    onMessage?.({ source: parent, data: pause });
    emulator.started = false;
    onMessage?.({ source: parent, data: pause });

    // A hidden disc-sized game can be unloaded, and EmulatorJS writes its save only every five minutes by default.
    expect(calls).toEqual(["save", "pause"]);
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

  const readGameBufferScript = (gameUrl: string) => {
    const document = createEmulatorDocument("/emulatorjs/data/", gameUrl, "game.chd", "psx");
    const start = document.indexOf("Object.defineProperty(window, 'EJS_emulator'");
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(document.indexOf("loader.js"));
    return document.slice(document.lastIndexOf("(() => {", start), document.indexOf("})();", start) + 5);
  };

  it("reads the game Blob once and lets the EmulatorJS file system keep that buffer", async () => {
    const game = new Blob([new Uint8Array([1, 2, 3])]);
    const gameUrl = createEmulatorGameUrl(game);
    const nativeFetch = vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }));
    const listeners = new Map<string, (fs: unknown) => void>();
    const window: Record<string, unknown> = { EJS_gameUrl: gameUrl, fetch: nativeFetch };
    window.parent = globalThis;

    try {
      runInNewContext(readGameBufferScript(gameUrl), { window });
      const buffer = await (await (window.fetch as typeof fetch)(gameUrl)).arrayBuffer();
      await (window.fetch as typeof fetch)("/emulatorjs/data/cores/pcsx_rearmed-thread-wasm.data");
      window.EJS_emulator = { on: (event: string, listener: (fs: unknown) => void) => listeners.set(event, listener) };
      const writeFile = vi.fn();
      const FS = { writeFile };
      listeners.get("saveDatabaseLoaded")?.(FS);
      FS.writeFile("game.chd", new Uint8Array(buffer));
      FS.writeFile("bios.bin", new Uint8Array(4), { flags: "w" });

      expect(new Uint8Array(buffer)).toEqual(new Uint8Array([1, 2, 3]));
      expect(nativeFetch).toHaveBeenCalledOnce();
      expect(writeFile.mock.calls[0]?.[2]).toEqual({ canOwn: true });
      expect(writeFile.mock.calls[1]?.[2]).toEqual({ flags: "w" });
    } finally {
      revokeEmulatorGameUrl(gameUrl);
    }
  });

  it("leaves EmulatorJS loading alone for a game URL the app no longer holds", () => {
    const gameUrl = createEmulatorGameUrl(new Blob([new Uint8Array([1])]));
    revokeEmulatorGameUrl(gameUrl);
    const nativeFetch = vi.fn();
    const window: Record<string, unknown> = { EJS_gameUrl: gameUrl, fetch: nativeFetch };
    window.parent = globalThis;

    runInNewContext(readGameBufferScript(gameUrl), { window });

    expect(window.fetch).toBe(nativeFetch);
    expect(Object.getOwnPropertyDescriptor(window, "EJS_emulator")).toBeUndefined();
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

  it.each(["iso", "cue", "img", "mds", "ccd", "cso", "pbp", "m3u", "gdi", "toc", "mdf"])(
    "keeps the .%s extension of a disc image",
    (extension) => {
      const checksum = "a9993e364706816aba3e25717850c26c9cd0d89d";
      const identity = createEmulatorGameIdentity({ checksum, fileName: `Game.${extension.toUpperCase()}` });
      expect(identity.gameName).toBe(`${checksum}.${extension}`);
      expect(identity.saveId).toBe(checksum);
      expect(identity.gameId).toBe(createEmulatorGameIdentity({ checksum }).gameId);
    },
  );

  it.each(["psx", "segaSaturn"])("keeps the .bin extension of a %s disc track", (core) => {
    const checksum = "a9993e364706816aba3e25717850c26c9cd0d89d";
    expect(createEmulatorGameIdentity({ checksum, core, fileName: "Game.bin" }).gameName).toBe(`${checksum}.bin`);
  });

  it.each(["segaMD", "atari7800", undefined])(
    "keeps a .bin cartridge on the bare checksum so its saved settings survive (%s)",
    (core) => {
      const checksum = "a9993e364706816aba3e25717850c26c9cd0d89d";
      expect(createEmulatorGameIdentity({ checksum, core, fileName: "Game.bin" }).gameName).toBe(checksum);
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

describe("requiresUnsuppliedBios", () => {
  it("flags Famicom Disk System images by platform or extension", () => {
    expect(requiresUnsuppliedBios({ fileName: "game.bin", platform: "Nintendo Famicom Disk System" })).toBe(true);
    expect(requiresUnsuppliedBios({ fileName: "GAME.FDS" })).toBe(true);
  });

  it("leaves cartridge systems alone", () => {
    expect(requiresUnsuppliedBios({ fileName: "game.nes", platform: "Nintendo Entertainment System" })).toBe(false);
    expect(requiresUnsuppliedBios({ fileName: "game.sfc" })).toBe(false);
  });
});

describe("hasFdsDiskSignature", () => {
  const disk = (headerBytes: number) => {
    const bytes = new Uint8Array(headerBytes + 64);
    bytes.set([1, ...new TextEncoder().encode("*NINTENDO-HVC*")], headerBytes);
    return new Blob([bytes]);
  };

  it("finds the disk marker with and without the FDS header", async () => {
    expect(await hasFdsDiskSignature(disk(0))).toBe(true);
    expect(await hasFdsDiskSignature(disk(16))).toBe(true);
  });

  it("ignores other images", async () => {
    expect(await hasFdsDiskSignature(new Blob([new Uint8Array(128)]))).toBe(false);
    expect(await hasFdsDiskSignature(new Blob(["NES\x1a"]))).toBe(false);
  });
});
