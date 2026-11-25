import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  brotliCompressBufferCached,
  brotliCompressFile,
  DEFAULT_BROTLI_CACHE_DIR,
} from "../../../../scripts/wasm/brotli-compress.mjs";
import { sidecarContentType } from "../../functions/assets/content-types.js";
import { MARKDOWN_ROUTES } from "../../functions/markdown-routes.js";
import { mapConcurrently } from "../map-concurrently.mjs";
import { rootDir } from "./paths.mjs";

// Every webapp bundle carries quality-11 brotli sidecars for immutable assets
// where q11 saves at least 2%. Cloudflare's Pages Function uses _routes.json
// to serve those exact URLs; Docker and self-hosters can serve the same static
// siblings directly. Already-compressed formats (woff2, png, zip) fail the
// savings bar and stay on the ordinary static path. Mutable root files (such
// as index.html, the service worker, and changelog.json) stay off this path.
const PAGES_BROTLI_MIN_SAVINGS = 0.02;
// Related assets MUST share wildcard routes to fit the 100-entry Pages include limit.
const PAGES_ROUTES_MAX_INCLUDES = 100;

export const writeBrotliSidecars = () => {
  let outDir = "dist";
  return {
    apply: "build",
    async closeBundle() {
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
      else
        brotliCompressFile({
          inputPath: emittedWasm,
          outputPath: `${emittedWasm}.br`,
          quality: 11,
          parameterProfile: "default",
        });
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
      const identifySidecars = fs
        .readdirSync(assetsDir)
        .filter((name) => /^identify-(?:.*\.pack|cheats-.*\.json)\.br$/u.test(name));
      if (identifySidecars.length > 0) {
        for (const name of identifySidecars) assertSidecarTypeIsKnown(`/assets/${name.slice(0, -3)}`);
        sidecarUrls.push("/assets/identify-*");
      }
      const prebuiltIdentifyAssets = new Set(identifySidecars.map((name) => name.slice(0, -3)));
      // Quality-11 compression is the slow step, so run it on libuv's thread pool
      // with bounded concurrency. Results are kept by index and consumed in sorted
      // name order, so the sidecars and routes never depend on completion order.
      const candidates = fs
        .readdirSync(assetsDir)
        .sort()
        // `.map` sidecars are devtools-only: nothing on a normal page load
        // requests them, so a q11 pass and a _routes.json include each would
        // buy nothing and eat the include budget.
        .filter((name) => !(name.endsWith(".wasm") || name.endsWith(".br") || name.endsWith(".map")))
        .filter((name) => !prebuiltIdentifyAssets.has(name));
      const compressed = await mapConcurrently(
        candidates,
        Math.max(1, Math.min(os.availableParallelism(), 8)),
        async (name) => {
          const source = await fs.promises.readFile(path.join(assetsDir, name));
          const result = await brotliCompressBufferCached(source, {
            cacheDir: DEFAULT_BROTLI_CACHE_DIR,
            quality: 11,
          });
          return { compressed: result.compressed, sourceSize: source.byteLength };
        },
      );
      for (const [index, name] of candidates.entries()) {
        const assetPath = path.join(assetsDir, name);
        const { compressed: sidecar, sourceSize } = compressed[index];
        if (sidecar.byteLength > sourceSize * (1 - PAGES_BROTLI_MIN_SAVINGS)) continue;
        fs.writeFileSync(`${assetPath}.br`, sidecar);
        assertSidecarTypeIsKnown(`/assets/${name}`);
        // Every identify asset rides the one wildcard include staged above. An exact
        // entry per pack, shard, and manifest would be redundant and eat the budget
        // asserted below.
        // JavaScript and CSS MUST share extension routes as documentation adds chunks.
        // The asset function falls back to static serving for missing sidecars.
        const extension = path.extname(name);
        const route = [".js", ".css"].includes(extension) ? `/assets/*${extension}` : `/assets/${name}`;
        if (!sidecarUrls.includes(route)) sidecarUrls.push(route);
      }
      const include = [
        ...sidecarUrls,
        "/",
        "/docs",
        "/docs/*",
        ...MARKDOWN_ROUTES.filter(({ path }) => path !== "/" && !path.startsWith("/docs")).flatMap(({ path }) => [
          path,
          `${path}/`,
        ]),
        "/mcp",
        "/mcp/*",
        "/.well-known/mcp/server-card.json",
        "/.well-known/ai-catalog.json",
        "/.well-known/ard.json",
      ].sort();
      const exclude = ["/docs/*.md"];
      if (include.length + exclude.length > PAGES_ROUTES_MAX_INCLUDES) {
        throw new Error(
          `${include.length + exclude.length} function routes exceed the ${PAGES_ROUTES_MAX_INCLUDES} budget`,
        );
      }
      fs.writeFileSync(
        path.join(distDir, "_routes.json"),
        `${JSON.stringify({ version: 1, include, exclude }, null, 2)}\n`,
      );
    },
    configResolved(config) {
      outDir = config.build.outDir;
    },
    name: "rom-weaver-brotli-sidecars",
  };
};
