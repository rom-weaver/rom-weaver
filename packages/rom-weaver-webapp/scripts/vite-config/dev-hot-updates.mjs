import os from "node:os";
import path from "node:path";
import { rootDir } from "./paths.mjs";

export const runtimeScratchIgnorePatterns = [
  "**/dist/**",
  "**/.rpjs-vfs",
  "**/.rpjs-vfs/**",
  "**/src/wasm/*.wasm",
  "**/src/wasm/*.wasm.br",
  path.join(os.tmpdir(), "rpjs-vfs*").replace(/\\/g, "/"),
];
const getHotUpdateLabel = (filePath) => path.relative(rootDir, filePath) || path.basename(filePath);

export const deferDevHotUpdates = () => ({
  apply: "serve",
  handleHotUpdate(ctx) {
    ctx.server.ws.send({
      data: {
        label: getHotUpdateLabel(ctx.file),
        source: "vite",
      },
      event: "rom-weaver:reload-available",
      type: "custom",
    });
    return [];
  },
  name: "rom-weaver-defer-dev-hot-updates",
});
