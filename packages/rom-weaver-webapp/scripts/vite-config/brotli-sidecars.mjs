import fs from "node:fs";
import path from "node:path";
import { brotliCompressFile } from "../../../../scripts/wasm/brotli-compress.mjs";
import { sidecarContentType } from "../../functions/assets/content-types.js";
import { rootDir } from "./paths.mjs";

// Every webapp bundle carries quality-11 brotli sidecars for immutable assets
// where q11 saves at least 2%. Cloudflare's Pages Function uses _routes.json
// to serve those exact URLs; Docker and self-hosters can serve the same static
// siblings directly. Already-compressed formats (woff2, png, zip) fail the
// savings bar and stay on the ordinary static path. Mutable root files (such
// as index.html, the service worker, and changelog.json) stay off this path.
const PAGES_BROTLI_MIN_SAVINGS = 0.02;
// Pages limits _routes.json to 100 include/exclude entries; identify assets
// share one wildcard route to stay within that limit.
const PAGES_ROUTES_MAX_INCLUDES = 100;

export const writeBrotliSidecars = () => {
  let outDir = "dist";
  return {
    apply: "build",
    closeBundle() {
      const distDir = path.resolve(rootDir, outDir);
      const assetsDir = path.join(distDir, "assets");
      const allWasmNames = fs.readdirSync(assetsDir).filter((name) => name.endsWith(".wasm"));
      const wasmNames = allWasmNames.filter((name) => name.startsWith("rom-weaver-app-"));
      if (wasmNames.length !== 1) {
        throw new Error(
          `expected exactly one rom-weaver app WASM asset in ${assetsDir}, found: ${wasmNames.join(", ") || "none"}`,
        );
      }
      const sourceWasm = path.join(rootDir, "src", "wasm", "rom-weaver-app.wasm");
      const sourceSidecar = `${sourceWasm}.br`;
      const emittedWasm = path.join(assetsDir, wasmNames[0]);
      if (!fs.readFileSync(emittedWasm).equals(fs.readFileSync(sourceWasm))) {
        throw new Error(`${emittedWasm} does not match ${sourceWasm}; refusing to stage a mismatched brotli sidecar`);
      }
      if (fs.existsSync(sourceSidecar)) fs.copyFileSync(sourceSidecar, `${emittedWasm}.br`);
      else brotliCompressFile({ inputPath: emittedWasm, outputPath: `${emittedWasm}.br`, quality: 11 });
      // The Pages Function reads the type from SIDECAR_CONTENT_TYPES instead of probing
      // the static asset, so a staged sidecar whose extension is missing there would
      // silently fall back to Pages' own compression. Fail the build instead.
      const assertSidecarTypeIsKnown = (assetUrl) => {
        if (sidecarContentType(assetUrl)) return;
        throw new Error(
          `${assetUrl} has a brotli sidecar but no entry in SIDECAR_CONTENT_TYPES (functions/assets/content-types.js); add its content type there`,
        );
      };
      const sidecarUrls = [`/assets/${wasmNames[0]}`];
      assertSidecarTypeIsKnown(sidecarUrls[0]);
      // Packs and cheat shards are staged as `.br`-only sidecars, all under one
      // wildcard include; each still needs a known content type.
      const identifySidecars = fs
        .readdirSync(assetsDir)
        .filter((name) => name.startsWith("identify-") && (name.endsWith(".pack.br") || name.endsWith(".json.br")));
      if (identifySidecars.length > 0) {
        for (const name of identifySidecars) assertSidecarTypeIsKnown(`/assets/${name.slice(0, -3)}`);
        sidecarUrls.push("/assets/identify-*");
      }
      for (const name of fs.readdirSync(assetsDir)) {
        // `.map` sidecars are devtools-only: nothing on a normal page load
        // requests them, so a q11 pass and a _routes.json include each would
        // buy nothing and eat the include budget.
        if (name.endsWith(".wasm") || name.endsWith(".br") || name.endsWith(".map")) continue;
        const assetPath = path.join(assetsDir, name);
        const { compressedSize, sourceSize } = brotliCompressFile({
          inputPath: assetPath,
          outputPath: `${assetPath}.br`,
          quality: 11,
        });
        if (compressedSize > sourceSize * (1 - PAGES_BROTLI_MIN_SAVINGS)) {
          fs.rmSync(`${assetPath}.br`);
          continue;
        }
        assertSidecarTypeIsKnown(`/assets/${name}`);
        // Every identify asset rides the one wildcard include staged above. An exact
        // entry per pack, shard, and manifest would be redundant and eat the budget
        // asserted below.
        const route = name.startsWith("identify-") ? "/assets/identify-*" : `/assets/${name}`;
        if (!sidecarUrls.includes(route)) sidecarUrls.push(route);
      }
      if (sidecarUrls.length > PAGES_ROUTES_MAX_INCLUDES) {
        throw new Error(`${sidecarUrls.length} sidecar routes exceed the ${PAGES_ROUTES_MAX_INCLUDES} budget`);
      }
      fs.writeFileSync(
        path.join(distDir, "_routes.json"),
        `${JSON.stringify({ version: 1, include: sidecarUrls.sort(), exclude: [] }, null, 2)}\n`,
      );
    },
    configResolved(config) {
      outDir = config.build.outDir;
    },
    name: "rom-weaver-brotli-sidecars",
  };
};
