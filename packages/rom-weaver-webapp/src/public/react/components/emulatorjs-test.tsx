import { useEffect, useState } from "react";
import type { BrowserApplyResult } from "../../../platform/browser/browser-api.ts";
import { Modal } from "./ds/modal.tsx";

type EmulatorJsTestProps = {
  core: string;
  output: Pick<BrowserApplyResult["output"], "fileName" | "getBlob">;
};

type EmulatorGame = {
  fileName: string;
  url: string;
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
      EJS_DEBUG_XX = true;
      EJS_defaultOptions = { webgl2Enabled: 'enabled', ejs_threads: 'disabled' };
      EJS_disableLocalStorage = true;
      EJS_player = '#game';
      EJS_core = ${toScriptString(core)};
      EJS_gameName = ${toScriptString(gameName)};
      EJS_gameUrl = ${toScriptString(gameUrl)};
      EJS_pathtodata = ${toScriptString(dataUrl)};
    </script>
    <script src="${dataUrl}loader.js"></script>
  </body>
</html>`;

const isArchive = (fileName: string) => /\.(?:7z|zip)$/i.test(fileName);

const extractEmulatorGame = async (blob: Blob, fileName: string) => {
  if (!isArchive(fileName)) return { blob, fileName };
  // Imported here, not at module scope: a static import would pull the whole
  // browser API out of its own dynamic chunk for every visitor.
  const { ApplyWorkflow } = await import("../../../platform/browser/browser-api.ts");
  const workflow = new ApplyWorkflow({ settings: { output: { compression: "none" } } });
  let result: BrowserApplyResult | undefined;
  try {
    await workflow.setInput(new File([blob], fileName, { type: blob.type }));
    result = await workflow.run();
    const extracted = await result.output.getBlob?.();
    if (!extracted) throw new Error("The applied ROM could not be extracted for EmulatorJS.");
    return { blob: extracted, fileName: result.output.fileName };
  } finally {
    await Promise.all(result?.outputs.map((output) => output.dispose().catch(() => undefined)) || []);
    await workflow.dispose().catch(() => undefined);
  }
};

const EmulatorJsTest = ({ core, output }: EmulatorJsTestProps) => {
  const dataUrl = new URL("emulatorjs/data/", document.baseURI).href;
  const [game, setGame] = useState<EmulatorGame | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(
    () => () => {
      if (game) URL.revokeObjectURL(game.url);
    },
    [game],
  );

  const open = async () => {
    setLoading(true);
    setError("");
    try {
      if (!document.createElement("canvas").getContext("webgl2"))
        throw new Error("EmulatorJS testing requires a browser with WebGL 2.");
      const blob = await output.getBlob?.();
      if (!blob) throw new Error("The finished output cannot be opened in EmulatorJS.");
      const extracted = await extractEmulatorGame(blob, output.fileName);
      setGame({ fileName: extracted.fileName, url: URL.createObjectURL(extracted.blob) });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not prepare the output for EmulatorJS.");
    } finally {
      setLoading(false);
    }
  };

  const close = () => {
    setGame(null);
    setError("");
  };

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
      <Modal onClose={close} open={!!game} subtitle={game?.fileName} title="EmulatorJS test" variant="emulatorjs-modal">
        {game ? (
          <div className="emulatorjs-frame">
            <iframe
              allow="autoplay; fullscreen; gamepad"
              allowFullScreen
              referrerPolicy="no-referrer"
              srcDoc={createEmulatorDocument(dataUrl, game.url, game.fileName, core)}
              title={`EmulatorJS test for ${game.fileName}`}
            />
          </div>
        ) : null}
      </Modal>
    </div>
  );
};

export { createEmulatorDocument, EmulatorJsTest };
