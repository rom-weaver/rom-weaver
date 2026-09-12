/**
 * WebP and AVIF encoders for the social card.
 *
 * jSquash ships its codecs as wasm that it fetches relative to the page when it
 * is not initialized first, which has no meaning under Node. Compile each
 * module from node_modules and hand it over explicitly.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import avifEncode, { init as initAvif } from "@jsquash/avif/encode.js";
import webpEncode, { init as initWebp } from "@jsquash/webp/encode.js";
import { simd } from "wasm-feature-detect";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Quality settings are a size/fidelity compromise for a 2560x1280 card that is
// only ever seen as a link thumbnail. Raising them costs bytes on every crawl.
const WEBP_QUALITY = 82;
const AVIF_QUALITY = 32;

const compile = (relativePath) =>
  WebAssembly.compile(fs.readFileSync(path.join(packageDir, "node_modules", relativePath)));

let ready;
const initCodecs = async () => {
  ready ||= (async () => {
    // The WebP entry point picks its glue by the same SIMD probe, and feeding
    // it the other build's module fails to instantiate.
    const webpWasm = (await simd()) ? "webp_enc_simd.wasm" : "webp_enc.wasm";
    await Promise.all([
      compile(`@jsquash/webp/codec/enc/${webpWasm}`).then(initWebp),
      compile("@jsquash/avif/codec/enc/avif_enc.wasm").then(initAvif),
    ]);
  })();
  await ready;
};

export const encodeWebp = async (image) => {
  await initCodecs();
  return Buffer.from(await webpEncode(image, { quality: WEBP_QUALITY }));
};

export const encodeAvif = async (image) => {
  await initCodecs();
  return Buffer.from(await avifEncode(image, { cqLevel: AVIF_QUALITY }));
};
