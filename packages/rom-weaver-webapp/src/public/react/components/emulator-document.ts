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

export { createEmulatorDocument };
