#!/usr/bin/env node

// Build the publishable @rom-weaver/webapp library into dist/lib:
//   1. src/index.tsx (the public React forms + `ingest`) bundled as one ESM
//      module with every npm dependency external - consumers resolve react,
//      @lingui/core, lucide-react, valibot, and @rom-weaver/wasm from their own
//      install, so nothing third-party is redistributed in this tarball.
//   2. The app stylesheet (style.css + design-system, same cascade order as the
//      site entry) bundled to style.css for consumers that want the stock look.
//   3. `.d.ts` declarations emitted from the same graph via tsconfig.build.json.
//
// The site build (vite build -> dist/) is untouched; `files` in package.json
// publishes dist/lib only. Shared helpers (and esbuild itself) come from the
// @rom-weaver/wasm package's build tooling - see build-shared.mjs for why.

import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  build,
  copyDeclarationSources,
  emitDeclarations,
  rewriteDeclarationExtensions,
} from "../../rom-weaver-wasm/scripts/build-shared.mjs";

const packageRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const srcDir = path.join(packageRoot, "src");
const libDir = path.join(packageRoot, "dist", "lib");

const log = (message) => console.log(`[build:lib] ${message}`);

const run = async () => {
  rmSync(libDir, { recursive: true, force: true });
  mkdirSync(libDir, { recursive: true });

  log("bundling library entry");
  await build({
    absWorkingDir: packageRoot,
    entryPoints: [path.join(srcDir, "index.tsx")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    packages: "external",
    outfile: path.join(libDir, "index.js"),
    sourcemap: true,
    logLevel: "info",
  });

  log("bundling stylesheet");
  await build({
    absWorkingDir: packageRoot,
    stdin: {
      // Same order as src/webapp/vite-entry.ts - @import order is cascade order.
      contents: '@import "./src/webapp/style.css";\n@import "./src/webapp/design-system/index.css";\n',
      resolveDir: packageRoot,
      sourcefile: "style-entry.css",
      loader: "css",
    },
    bundle: true,
    outfile: path.join(libDir, "style.css"),
    loader: { ".woff2": "file" },
    assetNames: "assets/[name]-[hash]",
    logLevel: "info",
  });

  log("emitting type declarations");
  emitDeclarations(packageRoot, "tsconfig.build.json");
  const copied = copyDeclarationSources(srcDir, libDir);
  const rewritten = rewriteDeclarationExtensions(libDir);
  log(`copied ${copied} declaration sources; normalized specifiers in ${rewritten} declarations`);

  log(`done -> ${path.relative(packageRoot, libDir)}`);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
