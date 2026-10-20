const toScriptString = (value: string) => JSON.stringify(value).replace(/</g, "\\u003c");

type EmulatorDocumentOptions = {
  gameId?: number;
  gameLabel?: string;
  saveId?: string;
};

type EmulatorGameIdentityInput = {
  checksum: string;
  core?: string;
  fileName?: string;
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
 * Disc image extensions the vendored disc cores (pcsx_rearmed, yabause,
 * genesis_plus_gx, ppsspp) read or EmulatorJS acts on. EmulatorJS names the
 * file it writes into the core after `EJS_gameName`, picks its loader and
 * invents a `MODE1/2352` cue sheet from that name, so a disc MUST keep its
 * real extension or a 2048-byte-sector ISO is misread.
 */
const DISC_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ccd",
  "chd",
  "cso",
  "cue",
  "gdi",
  "img",
  "iso",
  "m3u",
  "mdf",
  "mds",
  "pbp",
  "toc",
]);

/**
 * `.bin` is a raw CD track on these cores but a cartridge ROM on every other
 * one (Mega Drive, Atari 7800). A cartridge keeps the bare checksum so its
 * saved settings, which EmulatorJS keys on the game name, stay where they were.
 */
const BIN_DISC_CORES: ReadonlySet<string> = new Set(["psx", "segaSaturn"]);

const discImageSuffix = (fileName: string | undefined, core: string | undefined): string => {
  const extension = (fileName || "")
    .trim()
    .match(/\.([a-z0-9]+)$/i)?.[1]
    ?.toLowerCase();
  if (!extension) return "";
  if (extension === "bin") return core && BIN_DISC_CORES.has(core) ? ".bin" : "";
  return DISC_IMAGE_EXTENSIONS.has(extension) ? `.${extension}` : "";
};

/**
 * Disc image filenames MUST retain their extension for core dispatch.
 * App saves use the payload checksum independently of that filename.
 */
const createEmulatorGameIdentity = ({ checksum, core, fileName }: EmulatorGameIdentityInput) => {
  const normalizedChecksum = checksum.replace(/[^a-f0-9]/gi, "").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(normalizedChecksum)) {
    throw new Error("The emulator game identity requires a SHA-1 checksum.");
  }
  return {
    gameId: hashString(normalizedChecksum),
    saveId: normalizedChecksum,
    gameName: `${normalizedChecksum}${discImageSuffix(fileName, core)}`,
  };
};

/**
 * Systems whose single-threaded core is vendored instead of the threaded one.
 * The threaded yabause build starts 13 pthreads from a 4-worker pool, then its
 * renderer spins on the main thread for layer threads whose workers can only
 * start once that thread yields, so the page hangs.
 */
const SINGLE_THREADED_CORES: ReadonlySet<string> = new Set(["segaSaturn"]);

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

/**
 * A disc image's game name gained its extension after settings were already
 * saved under the bare checksum, and EmulatorJS keys settings on the name
 * (`ejs-<gameID>-<core>-<gameName>-settings`) with no separate option. Copy
 * the old entry to the new key once so remaps, settings, and cheats survive.
 * Safe to delete once no such saved setting can be in the wild.
 */
const createMigrateBareSettings = (gameId: number, saveId: string, gameName: string) => `
      (() => {
        const bare = ${toScriptString(saveId)};
        const named = ${toScriptString(gameName)};
        if (named === bare) return;
        const prefix = 'ejs-' + ${gameId} + '-';
        const oldTail = '-' + bare + '-settings';
        try {
          for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (!key || !key.startsWith(prefix) || !key.endsWith(oldTail)) continue;
            const next = key.slice(0, key.length - oldTail.length) + '-' + named + '-settings';
            if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key));
          }
        } catch (error) {
          console.warn('Could not migrate the EmulatorJS settings for ' + bare, error);
        }
      })();`;

/**
 * EmulatorJS requests a screen wake lock without handling a refusal, which
 * surfaces as an unhandled rejection whenever the browser denies it (headless
 * browsers, battery saver, an unfocused tab). The lock is best-effort, so a
 * denied request resolves to an already-released sentinel instead. The script
 * MUST run before `loader.js`.
 */
const TOLERATE_WAKE_LOCK_DENIAL = `{const w=navigator.wakeLock,r=w?.request?.bind(w);if(r)w.request=t=>Promise.resolve().then(()=>r(t)).catch(()=>({released:!0,type:t,addEventListener(){},removeEventListener(){},release:()=>Promise.resolve()}))}`;

/**
 * Stop EmulatorJS from calling home to `cdn.emulatorjs.org` for a version
 * check. Its constructor runs the check whenever `EJS_DEBUG_XX` is true or the
 * hostname is `localhost`/`127.0.0.1`, so the dev server, the browser tests,
 * and every self-hosted deployment on a loopback address make a third-party
 * request that this app promises never to make. There is no config flag for
 * it, so the method itself is replaced on the prototype: `emulator.min.js`
 * assigns `window.EmulatorJS` before `loader.js` constructs the instance,
 * which gives this accessor the one window in which to neutralize it. The
 * script MUST run before `loader.js`.
 */
const DISABLE_UPDATE_CHECK = `
      (() => {
        let EmulatorJS;
        Object.defineProperty(window, 'EmulatorJS', {
          configurable: true,
          get: () => EmulatorJS,
          set: (value) => {
            if (value && value.prototype) value.prototype.checkForUpdates = () => {};
            EmulatorJS = value;
          },
        });
      })();`;

/**
 * EmulatorJS builds its bar buttons from an icon plus a text span that its
 * stylesheet hides for some of them (mute/unmute), which leaves a button with
 * no accessible name. The bar is the core's own markup, so the wrapper names
 * each button from its own text as the bar is built.
 */
const LABEL_MENU_BUTTONS = `
      (() => {
        const label = () => {
          for (const button of document.querySelectorAll('.ejs_menu_button')) {
            if (button.hasAttribute('aria-label')) continue;
            const text = (button.textContent || '').trim() || button.getAttribute('title');
            if (text) button.setAttribute('aria-label', text);
          }
        };
        new MutationObserver(label).observe(document.documentElement, { childList: true, subtree: true });
        label();
      })();`;

const createEmulatorAudioContextBridgeScript = (gameName: string) => `
      (() => {
        const bridge = window.parent !== window ? window.parent.__romWeaverEmulatorAudio : null;
        const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
        if (!bridge || !NativeAudioContext) return;
        function RomWeaverAudioContext(options) {
          const prepared = bridge.takePrepared(${toScriptString(gameName)}, options);
          if (prepared) return prepared;
          return arguments.length ? new NativeAudioContext(options) : new NativeAudioContext();
        }
        RomWeaverAudioContext.prototype = NativeAudioContext.prototype;
        Object.setPrototypeOf(RomWeaverAudioContext, NativeAudioContext);
        window.AudioContext = RomWeaverAudioContext;
        window.webkitAudioContext = RomWeaverAudioContext;
      })();`;

const createEmulatorBridgeScript = (gameName: string, gameLabel: string, saveId: string) => `
      (() => {
        const source = "rom-weaver-emulator";
        const gameId = ${toScriptString(saveId)};
        const gameName = gameId;
        const gameLabel = ${toScriptString(gameLabel)};
        const toBytes = (value) => {
          if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
          if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
          return null;
        };
        const send = (kind, data) => {
          const bytes = toBytes(data);
          if (!bytes) return;
          window.parent.postMessage({ source, kind, gameId, gameName, gameLabel, data: bytes }, "*");
        };
        const request = (kind) => window.parent.postMessage({ source, kind, gameId, gameName }, "*");
        EJS_onSaveState = (payload) => send("save-state", payload && payload.state);
        EJS_onLoadState = () => request("request-load-state");
        EJS_onSaveSave = (payload) => send("save-sram", payload && payload.save);
        EJS_onLoadSave = () => request("request-load-sram");
        EJS_ready = () => {
          const bridge = window.parent !== window ? window.parent.__romWeaverEmulatorAudio : null;
          if (!bridge || !bridge.hasPrepared(${toScriptString(gameName)})) return;
          const button = document.querySelector('.ejs_start_button');
          if (button && typeof button.click === "function") button.click();
        };
        window.__romWeaverGameStarted = false;
        EJS_onGameStart = () => {
          window.__romWeaverGameStarted = true;
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
            try {
              const path = emulator.gameManager.getSaveFilePath();
              if (!path) throw new Error("EmulatorJS did not provide a save file path.");
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
              // EmulatorJS starts the core before it asks us for SRAM. The game MUST reset so its boot menu reads the imported save.
              emulator.gameManager.restart();
              request("sram-loaded");
            } catch (error) {
              console.error("Could not load SRAM into EmulatorJS", error);
              request("sram-load-failed");
            }
          }
        });
      })();`;

const createEmulatorDocument = (
  dataUrl: string,
  gameUrl: string,
  gameName: string,
  core: string,
  options: EmulatorDocumentOptions = {},
) => {
  const threads = !SINGLE_THREADED_CORES.has(core);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>html,body,#game{width:100%;height:100%;margin:0;background:#000;overflow:hidden}#game{display:block}</style>
  </head>
  <body>
    <div id="game"></div>
    <script>
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch (error) {
        console.warn('Could not configure the EmulatorJS audio session', error);
      }
      EJS_DEBUG_XX = false;
      EJS_threads = ${threads};
      EJS_defaultOptions = { webgl2Enabled: 'enabled', ejs_threads: '${threads ? "enabled" : "disabled"}' };
      // Only one WebGL 2 build of each core is vendored, so both in-emulator
      // toggles that rename the core have to go: flipping either asks for a
      // <core>-wasm.data, <core>-thread-wasm.data, or <core>-legacy-wasm.data
      // that does not exist and the game dies on a 404.
      EJS_hideSettings = ['ejs_threads', 'webgl2Enabled'];
      // The core's context menu opens on the contextmenu event, which a touch
      // long-press fires. Holding the d-pad therefore covers the game with the
      // Restart/Save State panel, so touch keeps the menu button as its only
      // route in.
      if (navigator.maxTouchPoints > 0) EJS_Buttons = { rightClick: false };
      EJS_disableLocalStorage = false;
      // WebKit MUST receive the context created by the parent user action.
      // EmulatorJS creates its own context after the activation has expired.
      const romWeaverAudioBridge = window.parent !== window ? window.parent.__romWeaverEmulatorAudio : null;
      const romWeaverHasPreparedAudio = !!romWeaverAudioBridge && romWeaverAudioBridge.hasPrepared(${toScriptString(gameName)});
      EJS_startOnLoaded = !(navigator.maxTouchPoints > 0) || romWeaverHasPreparedAudio;
      EJS_gameID = ${options.gameId ?? hashString(gameName)};
      EJS_player = '#game';
      EJS_core = ${toScriptString(core)};
      EJS_gameName = ${toScriptString(gameName)};
      EJS_gameUrl = ${toScriptString(gameUrl)};
      EJS_pathtodata = ${toScriptString(dataUrl)};
    </script>
    <script>${createEmulatorAudioContextBridgeScript(gameName)}</script>
    <script>${DISABLE_UPDATE_CHECK}</script>
    <script>${LABEL_MENU_BUTTONS}</script>
    <script>${TOLERATE_WAKE_LOCK_DENIAL}</script>
    <script>${createMigrateBareSettings(options.gameId ?? hashString(gameName), options.saveId || gameName, gameName)}</script>
    <script>${CLEAR_HIDDEN_SETTINGS}</script>
    <script>${createEmulatorBridgeScript(gameName, options.gameLabel || gameName, options.saveId || gameName)}</script>
    <script src="${dataUrl}loader.js"></script>
  </body>
</html>`;
};

export { createEmulatorDocument, createEmulatorGameIdentity };
