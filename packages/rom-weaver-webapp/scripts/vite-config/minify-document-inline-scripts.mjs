import fs from "node:fs";
import path from "node:path";
import { minifyInlineScripts } from "../minify-inline-scripts.mjs";
import { rootDir } from "./paths.mjs";

// Every route document is derived from dist/index.html after the bundle is
// written, and PRERENDER_ROOT injects two more inline scripts on the way, so
// the minifier runs over the finished files rather than through
// transformIndexHtml. It must stay ahead of VitePWA in the plugin list: the
// precache manifest hashes these documents from disk.
export const minifyDocumentInlineScripts = () => {
  let outDir = "dist";
  return {
    apply: "build",
    closeBundle() {
      const distDir = path.resolve(rootDir, outDir);
      for (const name of fs.readdirSync(distDir, { recursive: true })) {
        const relativePath = String(name);
        if (!relativePath.endsWith(".html")) continue;
        const filePath = path.join(distDir, relativePath);
        const html = fs.readFileSync(filePath, "utf8");
        const minified = minifyInlineScripts(html, relativePath);
        if (minified !== html) fs.writeFileSync(filePath, minified);
      }
    },
    configResolved(config) {
      outDir = config.build.outDir;
    },
    name: "rom-weaver-minify-inline-scripts",
  };
};
