import { useEffect, useState } from "react";
import type { BrowserApplyResult } from "../../../platform/browser/browser-api.ts";

type EmulatorJsTestProps = {
  core: string;
  output: Pick<BrowserApplyResult["output"], "fileName" | "getBlob">;
};

const toScriptString = (value: string) => JSON.stringify(value).replace(/</g, "\\u003c");

const createEmulatorDocument = (dataUrl: string, gameUrl: string, gameName: string, core: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>html,body,#game{width:100%;height:100%;margin:0;background:#000;overflow:hidden}#game{display:block}</style>
  </head>
  <body>
    <div id="game"></div>
    <script>
      EJS_player = '#game';
      EJS_core = ${toScriptString(core)};
      EJS_gameName = ${toScriptString(gameName)};
      EJS_gameUrl = ${toScriptString(gameUrl)};
      EJS_pathtodata = ${toScriptString(dataUrl)};
    </script>
    <script src="${dataUrl}loader.js"></script>
  </body>
</html>`;

const EmulatorJsTest = ({ core, output }: EmulatorJsTestProps) => {
  const dataUrl = new URL("emulatorjs/data/", document.baseURI).href;
  const [gameUrl, setGameUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(
    () => () => {
      if (gameUrl) URL.revokeObjectURL(gameUrl);
    },
    [gameUrl],
  );

  const open = async () => {
    setLoading(true);
    setError("");
    try {
      const blob = await output.getBlob?.();
      if (!blob) throw new Error("The finished output cannot be opened in EmulatorJS.");
      setGameUrl(URL.createObjectURL(blob));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not prepare the output for EmulatorJS.");
    } finally {
      setLoading(false);
    }
  };

  const close = () => {
    setGameUrl(null);
    setError("");
  };

  if (!gameUrl) {
    return (
      <div className="emulatorjs-test">
        <button
          aria-busy={loading}
          className="btn ghost slim"
          disabled={loading}
          id="rom-weaver-button-test-emulator"
          onClick={() => void open()}
          type="button"
        >
          {loading ? "Preparing EmulatorJS…" : "Test in EmulatorJS"}
        </button>
        <span className="emulatorjs-note">Loads the emulator only when you choose to test.</span>
        {error ? (
          <p className="emulatorjs-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="emulatorjs-test">
      <div className="emulatorjs-header">
        <span>EmulatorJS test</span>
        <button className="btn ghost slim" onClick={close} type="button">
          Close test
        </button>
      </div>
      <div className="emulatorjs-frame">
        <iframe
          allow="autoplay; fullscreen; gamepad"
          allowFullScreen
          loading="lazy"
          referrerPolicy="no-referrer"
          srcDoc={createEmulatorDocument(dataUrl, gameUrl, output.fileName, core)}
          title={`EmulatorJS test for ${output.fileName}`}
        />
      </div>
      <span className="emulatorjs-note">Loads the matching EmulatorJS core from this app when opened.</span>
    </div>
  );
};

export { EmulatorJsTest };
