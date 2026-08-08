const toScriptString = (value: string) => JSON.stringify(value).replace(/</g, "\\u003c");

type EmulatorDocumentOptions = {
  gameId?: number;
};

type EmulatorGameIdentityInput = {
  checksum?: string;
  fileName: string;
  sizeBytes: number;
};

const hashString = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 1;
};

/**
 * The identity is derived, never descriptive: nothing that names the game
 * leaves this function. The file name only seeds a hash when no checksum is
 * available, so the emulator and the save store see an opaque key.
 */
const createEmulatorGameIdentity = ({ checksum, fileName, sizeBytes }: EmulatorGameIdentityInput) => {
  const seed = checksum ? `checksum:${checksum}` : `file:${fileName}:${sizeBytes}`;
  const normalizedChecksum = checksum?.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const key = normalizedChecksum || hashString(seed).toString(16).padStart(8, "0");
  return {
    gameId: hashString(seed),
    gameName: `rom-weaver-${key.slice(0, 64)}`,
  };
};

/**
 * Drop a previously saved "Disabled" choice for either hidden setting.
 * EmulatorJS stores per game settings under `ejs-<id>-settings` and a stored
 * value beats `EJS_defaultOptions`, so hiding a row does not undo a choice
 * already made in it. Safe to delete once no such saved setting can be in the
 * wild.
 */
const CLEAR_HIDDEN_SETTINGS = `
      (() => {
        const hidden = ['ejs_threads', 'webgl2Enabled'];
        // One try per key: a single unparseable or hand-edited entry must not
        // stop the other games from being cleaned up.
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (!key || !/^ejs-.+-settings$/.test(key)) continue;
          try {
            const stored = JSON.parse(localStorage.getItem(key));
            if (!stored || !(stored.settings instanceof Object)) continue;
            const stale = hidden.filter((name) => name in stored.settings);
            if (!stale.length) continue;
            for (const name of stale) delete stored.settings[name];
            localStorage.setItem(key, JSON.stringify(stored));
          } catch (error) {
            console.warn('Could not clear the hidden EmulatorJS settings for ' + key, error);
          }
        }
      })();`;

const createEmulatorBridgeScript = (gameName: string) => `
      (() => {
        const source = "rom-weaver-emulator";
        const gameId = ${toScriptString(gameName)};
        const gameName = gameId;
        const toBytes = (value) => {
          if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
          if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
          return null;
        };
        const send = (kind, data) => {
          const bytes = toBytes(data);
          if (!bytes) return;
          window.parent.postMessage({ source, kind, gameId, gameName, data: bytes }, "*");
        };
        const request = (kind) => window.parent.postMessage({ source, kind, gameId, gameName }, "*");
        EJS_onSaveState = (payload) => send("save-state", payload && payload.state);
        EJS_onLoadState = () => request("request-load-state");
        EJS_onSaveSave = (payload) => send("save-sram", payload && payload.save);
        EJS_onLoadSave = () => request("request-load-sram");
        EJS_onGameStart = () => {
          const emulator = window.EJS_emulator;
          if (emulator && typeof emulator.on === "function") emulator.on("saveSaveFiles", (data) => send("save-sram", data));
          // The core opens its menu bar as part of starting and leaves it up for
          // three seconds. Closing it here means the game is the first thing on
          // screen; the menu button still opens it on demand.
          if (emulator && emulator.menu && typeof emulator.menu.close === "function") emulator.menu.close();
          request("request-load-sram");
        };
        window.__romWeaverVisibilityPaused = false;
        window.addEventListener("message", (event) => {
          if (event.source !== window.parent || !event.data || event.data.source !== source || event.data.gameId !== gameId) return;
          const emulator = window.EJS_emulator;
          if (!emulator) return;
          if (event.data.kind === "visibility-pause") {
            if (!emulator.paused && typeof emulator.pause === "function") {
              emulator.pause();
              window.__romWeaverVisibilityPaused = true;
            }
            return;
          }
          if (event.data.kind === "visibility-resume") {
            if (window.__romWeaverVisibilityPaused && typeof emulator.play === "function") emulator.play();
            window.__romWeaverVisibilityPaused = false;
            return;
          }
          const bytes = toBytes(event.data.data);
          if (!bytes || !emulator.gameManager) return;
          if (event.data.kind === "load-state") {
            emulator.gameManager.loadState(bytes);
          } else if (event.data.kind === "load-sram") {
            const path = emulator.gameManager.getSaveFilePath();
            const parts = path.split("/");
            let current = "";
            for (let index = 0; index < parts.length - 1; index += 1) {
              if (!parts[index]) continue;
              current += "/" + parts[index];
              if (!emulator.gameManager.FS.analyzePath(current).exists) emulator.gameManager.FS.mkdir(current);
            }
            if (emulator.gameManager.FS.analyzePath(path).exists) emulator.gameManager.FS.unlink(path);
            emulator.gameManager.FS.writeFile(path, bytes);
            emulator.gameManager.loadSaveFiles();
          }
        });
      })();`;

const createEmulatorDocument = (
  dataUrl: string,
  gameUrl: string,
  gameName: string,
  core: string,
  options: EmulatorDocumentOptions = {},
) => `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>html,body,#game{width:100%;height:100%;margin:0;background:#000;overflow:hidden}#game{display:block}</style>
  </head>
  <body>
    <div id="game"></div>
    <script>
      EJS_DEBUG_XX = false;
      EJS_threads = true;
      EJS_defaultOptions = { webgl2Enabled: 'enabled', ejs_threads: 'enabled' };
      // Only the threaded WebGL 2 cores are vendored, so both in-emulator
      // toggles that rename the core have to go: switching either off asks for
      // a <core>-wasm.data or <core>-legacy-wasm.data that does not exist and
      // the game dies on a 404.
      EJS_hideSettings = ['ejs_threads', 'webgl2Enabled'];
      EJS_disableLocalStorage = false;
      EJS_startOnLoaded = true;
      EJS_gameID = ${options.gameId ?? hashString(gameName)};
      EJS_player = '#game';
      EJS_core = ${toScriptString(core)};
      EJS_gameName = ${toScriptString(gameName)};
      EJS_gameUrl = ${toScriptString(gameUrl)};
      EJS_pathtodata = ${toScriptString(dataUrl)};
    </script>
    <script>${CLEAR_HIDDEN_SETTINGS}</script>
    <script>${createEmulatorBridgeScript(gameName)}</script>
    <script src="${dataUrl}loader.js"></script>
  </body>
</html>`;

export { createEmulatorDocument, createEmulatorGameIdentity };
