import fs from "node:fs";
import path from "node:path";
import { parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import avifEncode, { init as initAvif } from "@jsquash/avif/encode.js";
import { decodeRgba } from "./optimize-png.mjs";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ready = WebAssembly.compile(
  fs.readFileSync(path.join(PACKAGE_DIR, "node_modules/@jsquash/avif/codec/enc/avif_enc.wasm")),
).then((module) => initAvif(module));
// A failed init is reported to the first request instead of crashing the worker.
ready.catch(() => {
  // The message handler awaits `ready` again and reports the error.
});

parentPort.on("message", async ({ png, quality }) => {
  try {
    await ready;
    const avif = await avifEncode(decodeRgba(Buffer.from(png)), { quality });
    parentPort.postMessage({ avif: new Uint8Array(avif) });
  } catch (error) {
    parentPort.postMessage({ error: error?.stack || String(error) });
  }
});
